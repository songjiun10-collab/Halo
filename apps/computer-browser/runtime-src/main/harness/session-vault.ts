import nodeFs = require("node:fs");
import nodePath = require("node:path");
import crypto = require("node:crypto");

const PARTITION = /^persist:halo-agent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_BYTES = 1024 * 1024;
const MAX_COOKIES = 1500;
interface Cookie { name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string; [key: string]: unknown }
interface VaultStorage { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string }
interface VaultOptions { dir: string; storage: VaultStorage; fs?: typeof nodeFs }

function validCookie(value: unknown, nowSeconds: number): value is Cookie {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.name !== "string" || !c.name || typeof c.value !== "string") return false;
  if (typeof c.domain !== "string" || !/^\.?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(c.domain)) return false;
  if (c.path !== undefined && typeof c.path !== "string") return false;
  if (c.expires !== undefined) {
    if (typeof c.expires !== "number" || !Number.isFinite(c.expires)) return false;
    if (c.expires !== -1 && c.expires <= nowSeconds) return false;
  }
  return true;
}

function createSessionVault(options: VaultOptions) {
  const fs = (options.fs ?? nodeFs).promises;
  const dir = nodePath.resolve(options.dir);
  const storage = options.storage;
  const uuidOf = (partition: string): string | null => {
    if (typeof partition !== "string") return null;
    const match = PARTITION.exec(partition);
    return match ? match[1] : null;
  };
  const fileFor = (uuid: string) => nodePath.join(dir, `${uuid}.session`);
  // Partitions whose existing file could not be decrypted/read: never overwrite it from this process.
  const unreadable = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();
  const encryptionAvailable = () => { try { return storage.isEncryptionAvailable() === true; } catch { return false; } };
  async function write(uuid: string, cookies: Cookie[]): Promise<boolean> {
    const tmp = nodePath.join(dir, `${uuid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      const encrypted = storage.encryptString(JSON.stringify(cookies));
      if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_BYTES) return false;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      await fs.writeFile(tmp, encrypted, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, fileFor(uuid));
      return true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }
  return Object.freeze({
    isPersistentPartition(partition: string): boolean { return uuidOf(partition) !== null; },
    async load(partition: string): Promise<Cookie[]> {
      const uuid = uuidOf(partition);
      if (!uuid || !encryptionAvailable()) return [];
      const file = fileFor(uuid);
      let text: string;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_BYTES) return [];
        text = storage.decryptString(await fs.readFile(file));
        unreadable.delete(uuid);
      } catch (error) {
        // Missing file is normal; any other failure may be transient (keychain), so protect the file.
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.add(uuid);
        return [];
      }
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        const now = Date.now() / 1000;
        return parsed.slice(0, MAX_COOKIES).filter((c: unknown): c is Cookie => validCookie(c, now));
      } catch { return []; }
    },
    save(partition: string, cookies: Cookie[]): Promise<boolean> {
      const uuid = uuidOf(partition);
      if (!uuid || !Array.isArray(cookies) || cookies.length > MAX_COOKIES || !encryptionAvailable() || unreadable.has(uuid)) return Promise.resolve(false);
      // One write at a time per partition so an older save can never land after a newer one.
      const run = (queues.get(uuid) ?? Promise.resolve()).then(() => write(uuid, cookies));
      queues.set(uuid, run);
      return run.finally(() => { if (queues.get(uuid) === run) queues.delete(uuid); });
    },
    async clear(partition: string): Promise<void> {
      const uuid = uuidOf(partition);
      if (!uuid) return;
      unreadable.delete(uuid);
      await fs.rm(fileFor(uuid), { force: true }).catch(() => {});
    },
  });
}
export = { createSessionVault };
