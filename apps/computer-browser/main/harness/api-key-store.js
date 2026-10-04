"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Planner API keys the user registered in Settings, encrypted with the OS
// keychain (Electron safeStorage). Only providers whose worker already reads a
// key from its environment can be registered; the key never reaches the
// renderer again -- status() reports presence only.
const VERSION = 1;
const KEY_ENV = Object.freeze({ antigravity: "GEMINI_API_KEY", cursor: "CURSOR_API_KEY", nvidia: "NVIDIA_API_KEY" });
const MAX_KEY_BYTES = 512;

class ApiKeyStoreError extends Error {
  constructor(code, message) { super(message); this.name = "ApiKeyStoreError"; this.code = code; }
}

class ApiKeyStore {
  constructor({ storageRoot, safeStorage } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new ApiKeyStoreError("invalid_config", "storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "api-keys.enc");
    this._safeStorage = safeStorage || null;
    this._keys = {};
    this._loaded = false;
    this._chain = Promise.resolve();
  }

  static get providers() { return Object.keys(KEY_ENV); }

  _assertEncryption() {
    const s = this._safeStorage;
    if (!s || typeof s.isEncryptionAvailable !== "function" || !s.isEncryptionAvailable() || typeof s.encryptString !== "function" || typeof s.decryptString !== "function") {
      throw new ApiKeyStoreError("encryption_unavailable", "secure local encryption is unavailable");
    }
    if (s.getSelectedStorageBackend?.() === "basic_text") throw new ApiKeyStoreError("encryption_unavailable", "selected operating-system storage backend is not encrypted");
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ApiKeyStoreError("unsafe_path", "key directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }

  async load() {
    if (this._loaded) return;
    let ciphertext;
    try {
      const handle = await fs.open(this._file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { ciphertext = await handle.readFile(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") { this._loaded = true; return; }
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new ApiKeyStoreError("unsafe_path", "key file must not be a symlink");
      throw error;
    }
    this._assertEncryption();
    try {
      const payload = JSON.parse(this._safeStorage.decryptString(ciphertext));
      if (!payload || payload.version !== VERSION || typeof payload.keys !== "object" || payload.keys === null) throw new Error("shape");
      this._keys = Object.fromEntries(Object.entries(payload.keys).filter(([id, key]) => Object.hasOwn(KEY_ENV, id) && typeof key === "string" && key));
      this._loaded = true;
    } catch {
      throw new ApiKeyStoreError("store_corrupt", "registered API keys could not be decrypted or validated");
    }
  }

  async status() {
    await this.load();
    return Object.fromEntries(Object.keys(KEY_ENV).map((id) => [id, Boolean(this._keys[id])]));
  }

  /** Sync env view for the planner launcher; empty until load() has run. */
  env() {
    return Object.fromEntries(Object.entries(KEY_ENV).filter(([id]) => this._keys[id]).map(([id, name]) => [name, this._keys[id]]));
  }

  set(provider, key) {
    return this._mutate((keys) => {
      if (!Object.hasOwn(KEY_ENV, provider)) throw new ApiKeyStoreError("invalid_provider", "this provider does not take an API key");
      if (typeof key !== "string" || !key.trim() || /\s/.test(key.trim()) || Buffer.byteLength(key.trim(), "utf8") > MAX_KEY_BYTES) {
        throw new ApiKeyStoreError("invalid_key", "API key must be a single token of at most 512 bytes");
      }
      return { ...keys, [provider]: key.trim() };
    });
  }

  clear(provider) {
    return this._mutate((keys) => {
      if (!Object.hasOwn(KEY_ENV, provider)) throw new ApiKeyStoreError("invalid_provider", "this provider does not take an API key");
      const { [provider]: _removed, ...rest } = keys;
      return rest;
    });
  }

  _mutate(mutator) {
    const operation = this._chain.then(async () => {
      this._assertEncryption();
      await this.load();
      const next = mutator(this._keys);
      await this._write(next);
      this._keys = next;
      return this.status();
    });
    this._chain = operation.catch(() => {});
    return operation;
  }

  async _write(keys) {
    await this._ensureDirectory();
    const ciphertext = this._safeStorage.encryptString(JSON.stringify({ version: VERSION, keys }));
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new ApiKeyStoreError("encryption_failed", "secure storage returned no ciphertext");
    try {
      const existing = await fs.lstat(this._file);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new ApiKeyStoreError("unsafe_path", "key file must be a regular file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(this._directory, `.api-keys-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, this._file); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
}

module.exports = { ApiKeyStore, ApiKeyStoreError };
