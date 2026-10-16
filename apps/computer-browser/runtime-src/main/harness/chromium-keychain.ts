import crypto = require("node:crypto");
import childProcess = require("node:child_process");

const PREFIX = Buffer.from("halo-gcm-1\0");
const SERVICE = "Halo Chromium encrypted storage";
const ACCOUNT = "halo-computer-browser";
interface KeychainOptions { readKey?: () => Buffer; readLegacyPassword?: () => string }
function readKeychainKey(): Buffer {
  if (process.platform !== "darwin") throw new Error("keychain_unavailable: this runtime requires macOS Keychain");
  const query = () => childProcess.spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8", timeout: 10_000 });
  let found = query();
  if (found.status !== 0) {
    // 44 is errSecItemNotFound. A locked/denied Keychain must never mint a replacement key.
    if (found.status !== 44) throw new Error("keychain_unavailable: unlock or grant access to Keychain");
    const value = crypto.randomBytes(32).toString("hex");
    const saved = childProcess.spawnSync("/usr/bin/security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", value], { encoding: "utf8", timeout: 10_000 });
    if (saved.status !== 0) throw new Error("keychain_unavailable: encrypted storage key could not be saved");
    found = query();
  }
  if (found.status !== 0 || !/^[a-f0-9]{64}$/.test(found.stdout.trim())) throw new Error("keychain_unavailable: invalid encrypted storage key");
  return Buffer.from(found.stdout.trim(), "hex");
}
function readLegacyPassword(): string {
  // Electron stores "<app> Safe Storage" under the account "<app> Key"; older builds used the bare app name.
  for (const name of ["halo-computer-browser", "Halo", "Electron"]) {
    for (const account of [`${name} Key`, name]) {
      const found = childProcess.spawnSync("/usr/bin/security", ["find-generic-password", "-s", `${name} Safe Storage`, "-a", account, "-w"], { encoding: "utf8", timeout: 10_000 });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
  }
  throw new Error("legacy_key_unavailable: Electron's Keychain entry could not be read");
}
function createKeychainStorage(options: KeychainOptions = {}) {
  let key: Buffer | null = null;
  const getKey = () => {
    key ??= (options.readKey ?? readKeychainKey)();
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("keychain_invalid_key");
    return key;
  };
  return Object.freeze({
    isEncryptionAvailable(): boolean { try { getKey(); return true; } catch { return false; } },
    getSelectedStorageBackend(): string { return "macos_keychain"; },
    encryptString(text: string): Buffer {
      if (typeof text !== "string") throw new TypeError("encryptString requires text");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv); cipher.setAAD(PREFIX);
      const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([PREFIX, iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes: Buffer): string {
      if (!Buffer.isBuffer(bytes)) throw new TypeError("decryptString requires a buffer");
      if (bytes.subarray(0, 3).toString() === "v10") {
        const password = (options.readLegacyPassword ?? readLegacyPassword)();
        const legacyKey = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
        const decipher = crypto.createDecipheriv("aes-128-cbc", legacyKey, Buffer.alloc(16, 32));
        return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString("utf8");
      }
      if (bytes.length < PREFIX.length + 28 || !bytes.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error("unsupported_ciphertext");
      const offset = PREFIX.length;
      const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), bytes.subarray(offset, offset + 12));
      decipher.setAAD(PREFIX); decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
      return Buffer.concat([decipher.update(bytes.subarray(offset + 28)), decipher.final()]).toString("utf8");
    },
  });
}
export = { createKeychainStorage };
