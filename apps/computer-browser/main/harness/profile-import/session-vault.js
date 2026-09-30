"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeDomain, normalizeAllowlistEntry, domainMatches, matchingGroupDomain } = require("./domain-utils");

const VERSION = 1;
const MAX_COOKIES = 500;
const SOURCES = new Set(["chrome", "safari"]);
const SAME_SITE = new Set(["lax", "strict", "none", "unspecified"]);
const COOKIE_KEYS = ["domain", "name", "value", "path", "secure", "httpOnly", "sameSite", "expires"];

class SessionVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionVaultError";
    this.code = code;
  }
}

const bytes = (value) => Buffer.byteLength(value, "utf8");

function validateCookie(cookie) {
  const valid = cookie && typeof cookie === "object" && !Array.isArray(cookie) &&
    Object.keys(cookie).every((key) => COOKIE_KEYS.includes(key)) &&
    normalizeDomain(cookie.domain) !== null &&
    typeof cookie.name === "string" && cookie.name && bytes(cookie.name) <= 256 &&
    typeof cookie.value === "string" && bytes(cookie.value) <= 4096 &&
    typeof cookie.path === "string" && cookie.path.startsWith("/") && bytes(cookie.path) <= 512 &&
    typeof cookie.secure === "boolean" && typeof cookie.httpOnly === "boolean" &&
    SAME_SITE.has(cookie.sameSite) &&
    (cookie.expires === null || (Number.isFinite(cookie.expires) && cookie.expires > 0));
  if (!valid) throw new SessionVaultError("invalid_session", "cookie fields are invalid or exceed their size limits");
  return Object.fromEntries(COOKIE_KEYS.map((key) => [key, cookie[key]]));
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.version !== VERSION || !Array.isArray(payload.cookies) || payload.cookies.length > MAX_COOKIES) {
    throw new SessionVaultError("vault_corrupt", "session vault has an unsupported shape or version");
  }
  return payload.cookies.map((entry) => {
    try {
      if (!SOURCES.has(entry.source) || typeof entry.importedAt !== "string" || Number.isNaN(Date.parse(entry.importedAt)) || normalizeDomain(entry.group) === null) throw new Error("bad meta");
      return { ...validateCookie(Object.fromEntries(COOKIE_KEYS.map((key) => [key, entry[key]]))), group: entry.group, source: entry.source, importedAt: entry.importedAt };
    } catch {
      throw new SessionVaultError("vault_corrupt", "session record is malformed");
    }
  });
}

class SessionVault {
  constructor({ storageRoot, safeStorage, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new SessionVaultError("invalid_config", "storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "sessions.enc");
    this._safeStorage = safeStorage || null;
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._writeChain = Promise.resolve();
  }

  _assertEncryption() {
    const s = this._safeStorage;
    if (!s || typeof s.isEncryptionAvailable !== "function" || !s.isEncryptionAvailable() || typeof s.encryptString !== "function" || typeof s.decryptString !== "function") {
      throw new SessionVaultError("encryption_unavailable", "secure local encryption is unavailable");
    }
    if (s.getSelectedStorageBackend?.() === "basic_text") throw new SessionVaultError("encryption_unavailable", "selected operating-system storage backend is not encrypted");
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SessionVaultError("unsafe_path", "vault directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }

  async _read() {
    this._assertEncryption();
    await this._ensureDirectory();
    let ciphertext;
    try {
      const handle = await fs.open(this._file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { ciphertext = await handle.readFile(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return [];
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new SessionVaultError("unsafe_path", "vault file must not be a symlink");
      throw error;
    }
    try { return validatePayload(JSON.parse(this._safeStorage.decryptString(ciphertext))); }
    catch (error) {
      if (error instanceof SessionVaultError) throw error;
      throw new SessionVaultError("vault_corrupt", "session vault could not be decrypted or validated");
    }
  }

  async _write(cookies) {
    this._assertEncryption();
    await this._ensureDirectory();
    const ciphertext = this._safeStorage.encryptString(JSON.stringify({ version: VERSION, cookies: validatePayload({ version: VERSION, cookies }) }));
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new SessionVaultError("encryption_failed", "secure storage returned no ciphertext");
    try {
      const existing = await fs.lstat(this._file);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new SessionVaultError("unsafe_path", "vault file must be a regular file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(this._directory, `.sessions-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, this._file); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }

  _mutate(mutator) {
    const operation = this._writeChain.then(async () => {
      this._assertEncryption();
      const cookies = await this._read();
      const { cookies: next, result } = mutator(cookies);
      await this._write(next);
      return result;
    });
    this._writeChain = operation.catch(() => {});
    return operation;
  }

  // `preserve` lists identities ({ domain, name, path }) of rows the reader
  // could not decrypt this time: their previously stored copies are kept
  // instead of being erased by an otherwise successful re-import.
  replaceFromImport({ source, cookies, replaceDomains, preserve } = {}) {
    return this._mutate((existing) => {
      if (!SOURCES.has(source) || !Array.isArray(cookies)) throw new SessionVaultError("invalid_session", "import source or cookies are invalid");
      const clean = cookies.map(validateCookie);
      if (clean.length > MAX_COOKIES) throw new SessionVaultError("vault_limit", "session cookie limit reached");
      const importedAt = this._now();
      const groups = new Set([...(Array.isArray(replaceDomains) ? replaceDomains.map(normalizeDomain).filter(Boolean) : []), ...clean.map((c) => normalizeDomain(c.domain))]);
      const replace = [...groups];
      const identity = (entry) => `${entry.domain}\u0000${entry.name}\u0000${entry.path}`;
      const protectedKeys = new Set((Array.isArray(preserve) ? preserve : []).filter((item) => item && typeof item.domain === "string" && typeof item.name === "string" && typeof item.path === "string").map(identity));
      const replaced = existing.filter((entry) => replace.includes(entry.group));
      const preserved = replaced.filter((entry) => protectedKeys.has(identity(entry)));
      const kept = existing.filter((entry) => !replace.includes(entry.group));
      const incoming = clean.map((cookie) => ({ ...cookie, group: matchingGroupDomain(cookie.domain, replace), source, importedAt }));
      const next = [...kept, ...preserved, ...incoming];
      if (next.length > MAX_COOKIES) throw new SessionVaultError("vault_limit", "session cookie limit reached");
      return { cookies: next, result: { imported: incoming.length, preserved: preserved.length } };
    });
  }

  async listSessions() {
    const groups = new Map();
    for (const entry of await this._read()) {
      const g = groups.get(entry.group) || { domain: entry.group, cookieCount: 0, source: entry.source, importedAt: entry.importedAt };
      g.cookieCount += 1;
      groups.set(entry.group, g);
    }
    return [...groups.values()];
  }

  async cookiesFor({ domains, nowSeconds = Date.now() / 1000 } = {}) {
    const allowlist = (Array.isArray(domains) ? domains : []).map(normalizeAllowlistEntry).filter(Boolean);
    if (!allowlist.length) return [];
    return (await this._read())
      .filter((entry) => domainMatches(entry.domain, allowlist) && (entry.expires === null || entry.expires > nowSeconds))
      .map((entry) => Object.fromEntries(COOKIE_KEYS.map((key) => [key, entry[key]])));
  }

  removeDomain(domain) {
    return this._mutate((existing) => {
      const group = normalizeDomain(domain);
      if (!group) throw new SessionVaultError("invalid_session", "domain is invalid");
      const next = existing.filter((entry) => entry.group !== group);
      return { cookies: next, result: next.length !== existing.length };
    });
  }
}

module.exports = { SessionVault, SessionVaultError };
