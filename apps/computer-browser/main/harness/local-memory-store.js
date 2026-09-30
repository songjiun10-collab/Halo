"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VERSION = 1;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_ENTRY_BYTES = 4096;
const DEFAULT_MAX_CONTEXT_BYTES = 8192;

class LocalMemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalMemoryError";
    this.code = code;
  }
}

function normalizeOrigin(value) {
  if (value == null) return null;
  if (typeof value !== "string") throw new LocalMemoryError("invalid_memory_entry", "origin must be a URL string");
  let url;
  try { url = new URL(value); } catch { throw new LocalMemoryError("invalid_memory_entry", "origin must be a valid URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new LocalMemoryError("invalid_memory_entry", "origin must be an http(s) URL without credentials");
  }
  return url.origin;
}

function validateEntries(value, maxEntryBytes, maxEntries) {
  if (!value || typeof value !== "object" || value.version !== VERSION || !Array.isArray(value.entries) || value.entries.length > maxEntries) {
    throw new LocalMemoryError("memory_corrupt", "custom memory file has an unsupported shape or version");
  }
  const ids = new Set();
  return value.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" ||
        typeof entry.text !== "string" || !entry.text.trim() ||
        Buffer.byteLength(entry.text, "utf8") > maxEntryBytes ||
        typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt)) ||
        typeof entry.updatedAt !== "string" || Number.isNaN(Date.parse(entry.updatedAt)) ||
        !(entry.origin === null || typeof entry.origin === "string")) {
      throw new LocalMemoryError("memory_corrupt", "custom memory entry is malformed");
    }
    if (ids.has(entry.id)) throw new LocalMemoryError("memory_corrupt", "custom memory IDs must be unique");
    ids.add(entry.id);
    if (entry.origin !== null && normalizeOrigin(entry.origin) !== entry.origin) {
      throw new LocalMemoryError("memory_corrupt", "custom memory origin is not canonical");
    }
    return { id: entry.id, text: entry.text, origin: entry.origin, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  });
}

class LocalMemoryStore {
  constructor({ storageRoot, safeStorage, now, maxEntries = DEFAULT_MAX_ENTRIES, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, maxContextBytes = DEFAULT_MAX_CONTEXT_BYTES } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new LocalMemoryError("invalid_config", "storageRoot is required");
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxEntryBytes) || maxEntryBytes < 1 ||
        !Number.isInteger(maxContextBytes) || maxContextBytes < 1) throw new LocalMemoryError("invalid_config", "memory size limits must be positive integers");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "custom-memory.enc");
    this._safeStorage = safeStorage || null;
    this._now = typeof now === "function" ? now : () => new Date().toISOString();
    this._maxEntries = maxEntries;
    this._maxEntryBytes = maxEntryBytes;
    this._maxContextBytes = maxContextBytes;
    this._writeChain = Promise.resolve();
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LocalMemoryError("unsafe_path", "memory directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }

  _assertEncryption() {
    if (!this._safeStorage || typeof this._safeStorage.isEncryptionAvailable !== "function" ||
        !this._safeStorage.isEncryptionAvailable() || typeof this._safeStorage.encryptString !== "function" ||
        typeof this._safeStorage.decryptString !== "function") {
      throw new LocalMemoryError("encryption_unavailable", "secure local encryption is unavailable");
    }
    if (this._safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new LocalMemoryError("encryption_unavailable", "selected operating-system storage backend is not encrypted");
    }
  }

  async _readEntries() {
    this._assertEncryption();
    await this._ensureDirectory();
    let ciphertext;
    try {
      const handle = await fs.open(this._file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { ciphertext = await handle.readFile(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return [];
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new LocalMemoryError("unsafe_path", "memory file must not be a symlink");
      throw error;
    }
    try {
      const plaintext = this._safeStorage.decryptString(ciphertext);
      return validateEntries(JSON.parse(plaintext), this._maxEntryBytes, this._maxEntries);
    } catch (error) {
      if (error instanceof LocalMemoryError) throw error;
      throw new LocalMemoryError("memory_corrupt", "custom memory could not be decrypted or validated");
    }
  }

  async list() {
    return (await this._readEntries()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((entry) => ({ ...entry }));
  }

  put(input) {
    return this._mutate(async (entries) => {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["id", "text", "origin"].includes(key)) ||
          typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > this._maxEntryBytes) {
        throw new LocalMemoryError("invalid_memory_entry", "memory entry must contain bounded non-empty text and optional origin/id");
      }
      const id = input.id == null ? randomUUID() : input.id;
      if (typeof id !== "string" || !id || id.length > 80) throw new LocalMemoryError("invalid_memory_entry", "memory ID is invalid");
      const origin = normalizeOrigin(input.origin);
      const index = entries.findIndex((entry) => entry.id === id);
      const now = this._now();
      const entry = { id, text: input.text.trim(), origin, createdAt: index < 0 ? now : entries[index].createdAt, updatedAt: now };
      if (index < 0) entries.push(entry); else entries[index] = entry;
      if (entries.length > this._maxEntries) throw new LocalMemoryError("memory_limit", "custom memory entry limit reached");
      return { entries, result: { ...entry } };
    });
  }

  remove(id) {
    return this._mutate(async (entries) => {
      if (typeof id !== "string" || !id) throw new LocalMemoryError("invalid_memory_entry", "memory ID is required");
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return { entries, result: false };
      entries.splice(index, 1);
      return { entries, result: true };
    });
  }

  async forContext(pageUrl) {
    let origin = null;
    try { origin = normalizeOrigin(pageUrl); } catch { /* Non-web pages receive only global memories. */ }
    const entries = await this._readEntries();
    const selected = entries.filter((entry) => entry.origin === null || entry.origin === origin)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ id, text, origin: scope }) => ({ id, text, origin: scope }));
    const bytes = Buffer.byteLength(JSON.stringify(selected), "utf8");
    if (bytes > this._maxContextBytes) throw new LocalMemoryError("memory_context_overflow", "selected custom memory exceeds the planner context budget");
    return { entries: selected, bytes, overflow: false };
  }

  _mutate(mutator) {
    const operation = this._writeChain.then(async () => {
      this._assertEncryption();
      const entries = await this._readEntries();
      const { entries: next, result } = await mutator(entries);
      await this._writeEntries(next);
      return result;
    });
    this._writeChain = operation.catch(() => {});
    return operation;
  }

  async _writeEntries(entries) {
    this._assertEncryption();
    await this._ensureDirectory();
    const plaintext = JSON.stringify({ version: VERSION, entries: validateEntries({ version: VERSION, entries }, this._maxEntryBytes, this._maxEntries) });
    const ciphertext = this._safeStorage.encryptString(plaintext);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) throw new LocalMemoryError("encryption_failed", "secure storage returned no ciphertext");
    try {
      const current = await fs.lstat(this._file);
      if (current.isSymbolicLink() || !current.isFile()) throw new LocalMemoryError("unsafe_path", "memory file must be a regular file");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(this._directory, `.custom-memory-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.rename(temporary, this._file);
      const dir = await fs.open(this._directory, fsConstants.O_RDONLY);
      try { await dir.sync(); } catch (error) { if (!new Set(["EINVAL", "EISDIR"]).has(error.code)) throw error; } finally { await dir.close(); }
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

module.exports = { LocalMemoryError, LocalMemoryStore, normalizeOrigin };
