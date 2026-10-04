"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { normalizeAllowlistEntry, domainMatches } = require("./domain-utils");

const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const HASH_PREFIX_MIN_VERSION = 24;
const SAME_SITE = new Map([[0, "none"], [1, "lax"], [2, "strict"]]);

class ProfileImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileImportError";
    this.code = code;
  }
}

function defaultChromeRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

function defaultGetSafeStoragePassword() {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"], { timeout: 60_000 }, (error, stdout) => {
      if (error) reject(new Error("Chrome Safe Storage key was not released by the keychain"));
      else resolve(stdout.replace(/\r?\n$/, ""));
    });
  });
}

function decryptChromeValue(encrypted, { key, hostKey, hasHashPrefix }) {
  try {
    const buffer = Buffer.from(encrypted);
    if (buffer.length < 4 || buffer.subarray(0, 3).toString("latin1") !== "v10") return null;
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
    if (hasHashPrefix) {
      if (plain.length < 32) return null;
      const expected = crypto.createHash("sha256").update(hostKey).digest();
      if (!crypto.timingSafeEqual(plain.subarray(0, 32), expected)) return null;
      plain = plain.subarray(32);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

async function findCookiesFile(chromeRoot, profile) {
  for (const candidate of [path.join(chromeRoot, profile, "Network", "Cookies"), path.join(chromeRoot, profile, "Cookies")]) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch { /* try the next location */ }
  }
  return null;
}

async function copyDatabase(source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "halo-chrome-cookies-"));
  const target = path.join(directory, "Cookies");
  await fs.copyFile(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    await fs.copyFile(source + suffix, target + suffix).catch(() => {});
  }
  return { directory, target };
}

function queryRows(databaseFile, domains) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(databaseFile);
  try {
    let version = 0;
    try { version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value) || 0; } catch { /* no meta table */ }
    // Chrome 114+ stores CHIPS (partitioned) cookies in the same table, keyed
    // additionally by top_frame_site_key. Older schemas have no such column.
    const hasPartitionKey = db.prepare("PRAGMA table_info(cookies)").all().some((column) => column.name === "top_frame_site_key");
    const clauses = domains.map(() => "(host_key = ? OR host_key = ? OR host_key LIKE ?)").join(" OR ");
    const params = domains.flatMap((d) => [d, `.${d}`, `%.${d}`]);
    // expires_utc is microseconds since 1601 (~1.3e16) and exceeds Number.MAX_SAFE_INTEGER.
    const statement = db.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite${hasPartitionKey ? ", top_frame_site_key" : ""} FROM cookies WHERE ${clauses}`);
    statement.setReadBigInts(true);
    const rows = statement.all(...params).map((row) => ({
      ...row,
      expires_utc: row.expires_utc ? Number(BigInt(row.expires_utc) / 1_000_000n) : 0,
      is_secure: Number(row.is_secure), is_httponly: Number(row.is_httponly), samesite: Number(row.samesite),
      partitioned: hasPartitionKey && typeof row.top_frame_site_key === "string" && row.top_frame_site_key !== "",
    }));
    return { version, rows };
  } finally {
    db.close();
  }
}

async function readChromeCookies({ chromeRoot = defaultChromeRoot(), profile = "Default", domains, getSafeStoragePassword = defaultGetSafeStoragePassword, now = Date.now } = {}) {
  if (typeof profile !== "string" || !/^(Default|Profile \d{1,3})$/.test(profile)) throw new ProfileImportError("invalid_config", "profile must be Default or Profile N");
  const allowlist = Array.isArray(domains) ? domains.map(normalizeAllowlistEntry).filter(Boolean) : [];
  if (!allowlist.length) throw new ProfileImportError("invalid_config", "at least one allowlisted domain is required");

  const source = await findCookiesFile(chromeRoot, profile);
  if (!source) return { status: "not_found", cookies: [] };

  let copy;
  try {
    try { copy = await copyDatabase(source); } catch { return { status: "locked", cookies: [] }; }
    let data;
    try { data = queryRows(copy.target, allowlist); } catch { return { status: "locked", cookies: [] }; }

    const matched = data.rows.filter((row) => domainMatches(row.host_key, allowlist));
    // Partitioned cookies are only valid under their original top-level site.
    // The vault and Electron injection have no partition field, so importing
    // them would widen their scope and let different partitions overwrite one
    // another. They are excluded and counted instead.
    const rows = matched.filter((row) => !row.partitioned);
    const partitioned = matched.length - rows.length;
    if (!rows.length) return { status: "ok", cookies: [], partitioned };

    const needsKey = rows.some((row) => row.encrypted_value && row.encrypted_value.length);
    let key = null;
    if (needsKey) {
      let password;
      try { password = await getSafeStoragePassword(); } catch { return { status: "permission_required", cookies: [] }; }
      if (typeof password !== "string" || !password) return { status: "permission_required", cookies: [] };
      key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    }

    const nowSeconds = now() / 1000;
    const cookies = [];
    let encryptedSeen = 0;
    let decryptFailures = 0;
    const failed = [];
    for (const row of rows) {
      const expires = row.expires_utc ? row.expires_utc - WEBKIT_EPOCH_OFFSET_SECONDS : null;
      if (expires !== null && expires <= nowSeconds) continue;
      let value = row.value || "";
      if (row.encrypted_value && row.encrypted_value.length) {
        encryptedSeen += 1;
        value = decryptChromeValue(row.encrypted_value, { key, hostKey: row.host_key, hasHashPrefix: data.version >= HASH_PREFIX_MIN_VERSION });
        if (value === null) { decryptFailures += 1; failed.push({ domain: row.host_key, name: row.name, path: row.path || "/" }); continue; }
      }
      cookies.push({
        domain: row.host_key, name: row.name, value, path: row.path || "/",
        secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly),
        sameSite: SAME_SITE.get(Number(row.samesite)) || "unspecified", expires,
      });
    }
    if (encryptedSeen > 0 && decryptFailures === encryptedSeen && !cookies.length) return { status: "decrypt_failed", cookies: [] };
    return { status: "ok", cookies, skipped: decryptFailures, failed, partitioned };
  } finally {
    if (copy) await fs.rm(copy.directory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { ProfileImportError, readChromeCookies, decryptChromeValue, domainMatches, defaultGetSafeStoragePassword };
