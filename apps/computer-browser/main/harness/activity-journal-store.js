"use strict";

// Encrypted, owner-only file for the Context Awareness journal. Same storage
// rules as local-memory-store (OS-encrypted, no symlinks, atomic replace); the
// rules for what may be recorded and recalled live in activity-journal.
const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { makeEntry, addEntry, prune, recall, MAX_ENTRIES } = require("./activity-journal");

const VERSION = 1;

class ActivityJournalError extends Error {
  constructor(code, message) { super(message); this.name = "ActivityJournalError"; this.code = code; }
}

function validate(value) {
  if (!value || value.version !== VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new ActivityJournalError("journal_corrupt", "activity journal has an unsupported shape or version");
  }
  return value.entries.map((e) => {
    if (!e || typeof e.id !== "string" || typeof e.url !== "string" || typeof e.origin !== "string" || typeof e.title !== "string" ||
        typeof e.excerpt !== "string" || typeof e.visitedAt !== "string" || Number.isNaN(Date.parse(e.visitedAt))) {
      throw new ActivityJournalError("journal_corrupt", "activity journal entry is malformed");
    }
    return { id: e.id, url: e.url, origin: e.origin, title: e.title, excerpt: e.excerpt, visitedAt: e.visitedAt };
  });
}

class ActivityJournalStore {
  constructor({ storageRoot, safeStorage, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new ActivityJournalError("invalid_config", "storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "activity-journal.enc");
    this._safeStorage = safeStorage || null;
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._chain = Promise.resolve();
  }

  _assertEncryption() {
    const s = this._safeStorage;
    if (!s || typeof s.isEncryptionAvailable !== "function" || !s.isEncryptionAvailable() ||
        typeof s.encryptString !== "function" || typeof s.decryptString !== "function" || s.getSelectedStorageBackend?.() === "basic_text") {
      throw new ActivityJournalError("encryption_unavailable", "secure local encryption is unavailable");
    }
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ActivityJournalError("unsafe_path", "journal directory must be a real directory");
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
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new ActivityJournalError("unsafe_path", "journal file must not be a symlink");
      throw error;
    }
    try { return validate(JSON.parse(this._safeStorage.decryptString(ciphertext))); }
    catch (error) {
      if (error instanceof ActivityJournalError) throw error;
      throw new ActivityJournalError("journal_corrupt", "activity journal could not be decrypted or validated");
    }
  }

  async _write(entries) {
    this._assertEncryption();
    await this._ensureDirectory();
    const ciphertext = this._safeStorage.encryptString(JSON.stringify({ version: VERSION, entries: validate({ version: VERSION, entries }) }));
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new ActivityJournalError("encryption_failed", "secure storage returned no ciphertext");
    try {
      const current = await fs.lstat(this._file);
      if (current.isSymbolicLink() || !current.isFile()) throw new ActivityJournalError("unsafe_path", "journal file must be a regular file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(this._directory, `.activity-journal-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, this._file); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }

  _mutate(fn) {
    const operation = this._chain.then(async () => { const { entries, result } = fn(await this._read()); if (entries) await this._write(entries); return result; });
    this._chain = operation.catch(() => {});
    return operation;
  }

  // Returns true when the visit was kept; sensitive or empty pages are dropped.
  record({ url, title, excerpt, hasSensitiveField }) {
    const at = this._now();
    const entry = makeEntry({ url, title, excerpt, at, hasSensitiveField }, randomUUID());
    if (!entry) return Promise.resolve(false);
    return this._mutate((entries) => ({ entries: addEntry(entries, entry), result: true }));
  }

  async recall(query) {
    return recall(prune(await this._read(), this._now()), typeof query === "string" ? query : "");
  }

  async list() {
    return prune(await this._read(), this._now()).sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
  }

  clear() { return this._mutate(() => ({ entries: [], result: true })); }
}

module.exports = { ActivityJournalError, ActivityJournalStore };
