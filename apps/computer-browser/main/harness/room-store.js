"use strict";

// Append-only team chat log: <storageRoot>/rooms/<teamId>.jsonl, one JSON
// message per line. The directory is 0700 and each file 0600; a symlinked
// file or directory is refused, and any unparseable or out-of-contract line
// fails the whole read closed (room_corrupt) rather than showing a partial
// conversation. Nothing is ever rewritten or deleted: read() returns only the
// newest MAX_ROOM_MESSAGES, reading just the tail of a long log.
//
// <teamId>.lock marks the one host running that room's round ({pid, owner,
// at}, created with O_EXCL). Windows in local mode each have a TaskHost over
// the same files, so appends are serialized per log path across every store
// in the process, and a lock is taken over only when its process is gone or
// its lease ran out without a refresh.

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { MAX_MESSAGE_CHARS, MAX_ROOM_MESSAGES, MESSAGE_KINDS } = require("../../shared/room-contracts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPTIONAL = ["taskId", "originMessageId", "error"];
const ROUND_LEASE_MS = 15 * 60 * 1000;
const TAIL_CHUNK = 256 * 1024;
const CHAINS = new Map(); // log path -> tail of that log's append chain, shared by every store

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

class RoomStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomStoreError";
    this.code = code;
  }
}

function roomId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new RoomStoreError("invalid_room", "room id must be a team UUID");
  return value;
}

function checkMessage(message, code) {
  const fail = (why) => { throw new RoomStoreError(code, `room message ${why}`); };
  if (!message || typeof message !== "object") fail("must be an object");
  if (typeof message.author !== "string" || !(message.author === "user" || message.author === "host" || UUID_RE.test(message.author))) fail("author must be user, host or an agent id");
  if (!MESSAGE_KINDS.includes(message.kind)) fail("kind is not a room message kind");
  if (typeof message.text !== "string" || message.text.length > MAX_MESSAGE_CHARS) fail(`text must be at most ${MAX_MESSAGE_CHARS} characters`);
  for (const key of OPTIONAL) {
    if (message[key] !== undefined && (typeof message[key] !== "string" || message[key].length === 0 || message[key].length > 128)) fail(`${key} must be a short string`);
  }
}

class RoomStore {
  constructor({ storageRoot, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new RoomStoreError("invalid_config", "storageRoot is required");
    this._directory = path.join(storageRoot, "rooms");
    this._now = typeof now === "function" ? now : () => Date.now();
    this._owner = randomUUID();
  }

  _logPath(teamId) {
    return path.join(this._directory, `${teamId}.jsonl`);
  }

  _chain(teamId) {
    return CHAINS.get(this._logPath(teamId)) ?? Promise.resolve();
  }

  // Serialized per room so concurrent appends keep whole lines in order.
  // unlessTaskNotice: skip (resolve null) when the log already has a notice
  // for input.taskId -- a task result is posted once even when two hosts
  // both see it settle.
  append(teamId, input, { unlessTaskNotice = false } = {}) {
    try {
      roomId(teamId);
      checkMessage(input, "invalid_message");
    } catch (error) {
      return Promise.reject(error);
    }
    const message = {
      messageId: randomUUID(),
      roomId: teamId,
      author: input.author,
      kind: input.kind,
      text: input.text,
      at: new Date(this._now()).toISOString(),
      ...Object.fromEntries(OPTIONAL.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    };
    const key = this._logPath(teamId);
    const operation = this._chain(teamId).then(async () => {
      await this._ensureDirectory();
      if (unlessTaskNotice && input.taskId !== undefined) {
        const existing = await this._readLines(teamId);
        if (existing.some((line) => line.includes(input.taskId) && this._parse(teamId, line).kind === "notice" && this._parse(teamId, line).taskId === input.taskId)) return null;
      }
      const handle = await this._open(teamId, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(message)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { ...message };
    });
    const tail = operation.catch(() => {});
    CHAINS.set(key, tail);
    tail.then(() => { if (CHAINS.get(key) === tail) CHAINS.delete(key); });
    return operation;
  }

  async read(teamId) {
    roomId(teamId);
    await this._chain(teamId);
    await this._ensureDirectory();
    return (await this._readLines(teamId)).map((line) => this._parse(teamId, line));
  }

  _parse(teamId, line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new RoomStoreError("room_corrupt", "room log has an unparseable line"); }
    checkMessage(parsed, "room_corrupt");
    if (parsed.roomId !== teamId || typeof parsed.messageId !== "string" || typeof parsed.at !== "string") throw new RoomStoreError("room_corrupt", "room log line is not a message of this room");
    return parsed;
  }

  // The newest MAX_ROOM_MESSAGES lines, read backwards in chunks so a long
  // log costs only its tail.
  async _readLines(teamId) {
    let handle;
    try {
      handle = await this._open(teamId, fsConstants.O_RDONLY);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      const { size } = await handle.stat();
      let position = size;
      let buffer = Buffer.alloc(0);
      let newlines = 0;
      while (position > 0 && newlines <= MAX_ROOM_MESSAGES) {
        const length = Math.min(TAIL_CHUNK, position);
        position -= length;
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, position);
        for (const byte of chunk) if (byte === 0x0a) newlines += 1;
        buffer = Buffer.concat([chunk, buffer]);
      }
      let lines = buffer.toString("utf8").split("\n");
      if (position > 0) lines = lines.slice(1); // the first piece may be a partial line
      return lines.filter((line) => line.length > 0).slice(-MAX_ROOM_MESSAGES);
    } finally {
      await handle.close();
    }
  }

  // ---- round lock ----

  _lockPath(teamId) {
    return path.join(this._directory, `${teamId}.lock`);
  }

  async _readLock(teamId) {
    let textValue;
    try {
      const handle = await fs.open(this._lockPath(teamId), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { textValue = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new RoomStoreError("unsafe_path", "room lock must not be a symlink");
      throw error;
    }
    let lock = null;
    try { lock = JSON.parse(textValue); } catch { /* unreadable: treated as stale below */ }
    return { raw: textValue, lock };
  }

  _isStale(lock) {
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || typeof lock.owner !== "string" || typeof lock.at !== "string") return true;
    const at = Date.parse(lock.at);
    if (!Number.isFinite(at) || this._now() - at > ROUND_LEASE_MS) return true;
    return !processAlive(lock.pid);
  }

  // {release, refresh} when this store now runs the room's round, null when
  // another live host does.
  async acquireRoundLock(teamId) {
    roomId(teamId);
    await this._ensureDirectory();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = () => JSON.stringify({ pid: process.pid, owner: this._owner, at: new Date(this._now()).toISOString() });
      try {
        const handle = await fs.open(this._lockPath(teamId), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(body(), "utf8"); } finally { await handle.close(); }
        return {
          refresh: async () => {
            const current = await this._readLock(teamId).catch(() => null);
            if (current?.lock?.owner !== this._owner) return;
            await fs.writeFile(this._lockPath(teamId), body(), { flag: fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW });
          },
          release: async () => {
            const current = await this._readLock(teamId).catch(() => null);
            if (current?.lock?.owner === this._owner) await fs.rm(this._lockPath(teamId), { force: true });
          },
        };
      } catch (error) {
        if (["ELOOP", "EMLINK"].includes(error.code)) throw new RoomStoreError("unsafe_path", "room lock must not be a symlink");
        if (error.code !== "EEXIST") throw error;
      }
      const existing = await this._readLock(teamId);
      if (existing && !this._isStale(existing.lock)) return null;
      if (existing) await this._removeIfUnchanged(teamId, existing.raw);
    }
    return null;
  }

  // Removes a lock left by a process that is gone. True only for the caller
  // that actually removed it, so "interrupted" is posted once.
  async clearStaleRoundLock(teamId) {
    roomId(teamId);
    await this._ensureDirectory();
    const existing = await this._readLock(teamId);
    if (!existing || !this._isStale(existing.lock)) return false;
    return this._removeIfUnchanged(teamId, existing.raw);
  }

  // rename() is the atomic claim: of several hosts clearing the same stale
  // lock, only one moves it aside. A lock that turns out to be fresh (taken
  // between the read and the rename) is put back.
  async _removeIfUnchanged(teamId, raw) {
    const aside = `${this._lockPath(teamId)}.${randomUUID()}.stale`;
    try {
      await fs.rename(this._lockPath(teamId), aside);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const moved = await fs.readFile(aside, "utf8").catch(() => null);
    if (moved !== raw) {
      await fs.link(aside, this._lockPath(teamId)).catch(() => {});
      await fs.rm(aside, { force: true });
      return false;
    }
    await fs.rm(aside, { force: true });
    return true;
  }

  async _open(teamId, flags, mode) {
    try {
      return await fs.open(this._logPath(teamId), flags | fsConstants.O_NOFOLLOW, mode);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new RoomStoreError("unsafe_path", "room log must not be a symlink");
      throw error;
    }
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RoomStoreError("unsafe_path", "room directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }
}

module.exports = { RoomStore, RoomStoreError, ROUND_LEASE_MS };
