"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VERSION = 1;
const MAX_CREDENTIALS = 250;

class CredentialVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new CredentialVaultError("invalid_credential", "origin must be a valid URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new CredentialVaultError("invalid_credential", "credentials are scoped to an https origin without embedded credentials");
  }
  return url.origin;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.version !== VERSION || !Array.isArray(payload.entries) || payload.entries.length > MAX_CREDENTIALS) {
    throw new CredentialVaultError("vault_corrupt", "credential vault has an unsupported shape or version");
  }
  const ids = new Set();
  return payload.entries.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !entry.id ||
        typeof entry.origin !== "string" || canonicalOrigin(entry.origin) !== entry.origin ||
        typeof entry.username !== "string" || Buffer.byteLength(entry.username, "utf8") > 512 ||
        typeof entry.password !== "string" || !entry.password || Buffer.byteLength(entry.password, "utf8") > 4096 ||
        !(entry.label === null || (typeof entry.label === "string" && Buffer.byteLength(entry.label, "utf8") <= 256)) ||
        typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt)) ||
        typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt))) {
      throw new CredentialVaultError("vault_corrupt", "credential record is malformed");
    }
    if (ids.has(entry.id)) throw new CredentialVaultError("vault_corrupt", "credential IDs must be unique");
    ids.add(entry.id);
    return { ...entry };
  });
}

class LocalCredentialVault {
  constructor({ storageRoot, safeStorage, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new CredentialVaultError("invalid_config", "storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "credentials.enc");
    this._safeStorage = safeStorage || null;
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._writeChain = Promise.resolve();
  }

  _assertEncryption() {
    if (!this._safeStorage || typeof this._safeStorage.isEncryptionAvailable !== "function" || !this._safeStorage.isEncryptionAvailable() ||
        typeof this._safeStorage.encryptString !== "function" || typeof this._safeStorage.decryptString !== "function") {
      throw new CredentialVaultError("encryption_unavailable", "secure local encryption is unavailable");
    }
    if (this._safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new CredentialVaultError("encryption_unavailable", "selected operating-system storage backend is not encrypted");
    }
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CredentialVaultError("unsafe_path", "vault directory must be a real directory");
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
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new CredentialVaultError("unsafe_path", "vault file must not be a symlink");
      throw error;
    }
    try { return validatePayload(JSON.parse(this._safeStorage.decryptString(ciphertext))); }
    catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError("vault_corrupt", "credential vault could not be decrypted or validated");
    }
  }

  async list() {
    return (await this._read()).map(({ id, origin, username, label, createdAt, updatedAt }) => ({ id, origin, username, label, createdAt, updatedAt }));
  }

  put(input) {
    return this._mutate(async (entries) => {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["id", "origin", "username", "password", "label"].includes(key)) ||
          typeof input.username !== "string" || Buffer.byteLength(input.username, "utf8") > 512 ||
          typeof input.password !== "string" || !input.password || Buffer.byteLength(input.password, "utf8") > 4096 ||
          !(input.label == null || (typeof input.label === "string" && Buffer.byteLength(input.label, "utf8") <= 256))) {
        throw new CredentialVaultError("invalid_credential", "credential fields are invalid or exceed their size limits");
      }
      const origin = canonicalOrigin(input.origin);
      const id = input.id == null ? randomUUID() : input.id;
      if (typeof id !== "string" || !id || id.length > 80) throw new CredentialVaultError("invalid_credential", "credential ID is invalid");
      const index = entries.findIndex((entry) => entry.id === id);
      const timestamp = this._now();
      const record = { id, origin, username: input.username, password: input.password, label: input.label ?? null,
        createdAt: index < 0 ? timestamp : entries[index].createdAt, updatedAt: timestamp };
      if (index < 0) entries.push(record); else entries[index] = record;
      if (entries.length > MAX_CREDENTIALS) throw new CredentialVaultError("vault_limit", "credential limit reached");
      return { entries, result: { id, origin, username: record.username, label: record.label, createdAt: record.createdAt, updatedAt: record.updatedAt } };
    });
  }

  remove(id) {
    return this._mutate(async (entries) => {
      if (typeof id !== "string" || !id) throw new CredentialVaultError("invalid_credential", "credential ID is required");
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return { entries, result: false };
      entries.splice(index, 1);
      return { entries, result: true };
    });
  }

  fill({ credentialId, origin, approved, fillCredential } = {}) {
    if (approved !== true) return Promise.reject(new CredentialVaultError("approval_required", "human approval is required before autofill"));
    if (typeof fillCredential !== "function") return Promise.reject(new CredentialVaultError("invalid_config", "trusted fill callback is required"));
    const normalizedOrigin = canonicalOrigin(origin);
    return this._read().then(async (entries) => {
      const record = entries.find((entry) => entry.id === credentialId);
      if (!record) throw new CredentialVaultError("credential_not_found", "credential record was not found");
      if (record.origin !== normalizedOrigin) throw new CredentialVaultError("origin_mismatch", "credential origin does not exactly match the current page");
      try {
        const result = await fillCredential({ username: record.username, password: record.password });
        if (!result || result.status !== "ok") throw new Error("credential filler rejected the request");
      }
      catch { throw new CredentialVaultError("autofill_failed", "credential autofill failed"); }
      return { status: "ok" };
    });
  }

  _mutate(mutator) {
    const operation = this._writeChain.then(async () => {
      this._assertEncryption();
      const entries = await this._read();
      const { entries: next, result } = await mutator(entries);
      await this._write(next);
      return result;
    });
    this._writeChain = operation.catch(() => {});
    return operation;
  }

  async _write(entries) {
    this._assertEncryption();
    await this._ensureDirectory();
    const ciphertext = this._safeStorage.encryptString(JSON.stringify({ version: VERSION, entries: validatePayload({ version: VERSION, entries }) }));
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new CredentialVaultError("encryption_failed", "secure storage returned no ciphertext");
    try {
      const existing = await fs.lstat(this._file);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new CredentialVaultError("unsafe_path", "vault file must be a regular file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(this._directory, `.credentials-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.rename(temporary, this._file);
      const dir = await fs.open(this._directory, fsConstants.O_RDONLY);
      try { await dir.sync(); } catch (error) { if (!new Set(["EINVAL", "EISDIR"]).has(error.code)) throw error; } finally { await dir.close(); }
    } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
}

module.exports = { CredentialVaultError, LocalCredentialVault, canonicalOrigin };
