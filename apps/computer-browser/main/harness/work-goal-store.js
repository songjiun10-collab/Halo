"use strict";

// Project-scoped, host-owned Work Goal journal. The journal is authoritative;
// active.json is only an atomically replaced index rebuilt from valid journals.

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const crypto = require("node:crypto");
const path = require("node:path");

const { UUID_RE, MAX_EVENT_BYTES, MAX_TASK_STORE_BYTES, isPlainObject } = require("../../shared/harness-contracts");
const {
  SCHEMA_VERSION,
  validateWorkGoalInput,
  validateWorkGoalEvent,
  applyWorkGoalEvent,
  replayWorkGoalEvents,
} = require("../../shared/work-goal-contracts");

const POINTER_VERSION = 1;
const NONTERMINAL = new Set(["active", "paused", "blocked"]);

class WorkGoalStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkGoalStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkGoalStoreError(code, message);
}

function copy(value) {
  return structuredClone(value);
}

function validateGoalId(goalId) {
  if (typeof goalId !== "string" || !UUID_RE.test(goalId)) fail("invalid_goal_id", "goalId must be a UUID");
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function assertPrivateDirectory(dirPath, { create = false } = {}) {
  if (create) {
    try { await fsp.mkdir(dirPath, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  let stat;
  try { stat = await fsp.lstat(dirPath); }
  catch (error) {
    if (error.code === "ENOENT") fail("not_found", `Work Goal directory is missing: ${dirPath}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_path", "Work Goal path must be a real directory");
  if ((stat.mode & 0o077) !== 0) fail("unsafe_permissions", "Work Goal directory must be private");
}

async function openRegularNoFollow(filePath, flags) {
  let handle;
  try { handle = await fsp.open(filePath, flags | fsConstants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ELOOP") fail("unsafe_path", "Work Goal file must not be a symlink");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("unsafe_path", "Work Goal file must be regular");
    if ((stat.mode & 0o077) !== 0) fail("unsafe_permissions", "Work Goal file must be private");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readRegularNoFollow(filePath) {
  const handle = await openRegularNoFollow(filePath, fsConstants.O_RDONLY);
  try { return await handle.readFile("utf8"); }
  finally { await handle.close(); }
}

async function writeExclusiveDurable(filePath, contents) {
  const handle = await fsp.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(dirPath) {
  const handle = await fsp.open(dirPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    try { await handle.sync(); }
    catch (error) { if (error.code !== "EINVAL" && error.code !== "EISDIR") throw error; }
  } finally { await handle.close(); }
}

async function atomicWrite(dirPath, fileName, contents) {
  const temporaryPath = path.join(dirPath, `${fileName}.tmp-${crypto.randomUUID()}`);
  try {
    await writeExclusiveDurable(temporaryPath, contents);
    await fsp.rename(temporaryPath, path.join(dirPath, fileName));
    await syncDirectory(dirPath);
  } finally {
    await fsp.unlink(temporaryPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function acquireLock(dirPath, fileName) {
  const lockPath = path.join(dirPath, fileName);
  // Serializes stale-lock replacement. Without this guard two openers can both
  // observe the same dead owner; the slower opener can then rename a fresh
  // lock installed by the winner.
  const reclaimPath = `${lockPath}.reclaim`;
  const owner = { pid: process.pid, token: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fsp.lstat(reclaimPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (await fsp.access(reclaimPath).then(() => true, () => false)) {
      fail("writer_conflict", `Work Goal storage lock ${fileName} is being reclaimed`);
    }
    try {
      await writeExclusiveDurable(lockPath, JSON.stringify(owner));
      await syncDirectory(dirPath);
      // A reclaimer may have started between the preflight and O_EXCL create.
      // It will only remove the exact stale token it inspected; do not proceed
      // if its claim appeared while we were acquiring.
      if (await fsp.access(reclaimPath).then(() => true, () => false)) {
        await releaseLock({ path: lockPath, dirPath, owner });
        fail("writer_conflict", `Work Goal storage lock ${fileName} is being reclaimed`);
      }
      return { path: lockPath, dirPath, owner };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let existing;
    try { existing = JSON.parse(await readRegularNoFollow(lockPath)); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code === "unsafe_path" || error.code === "unsafe_permissions") throw error;
      fail("storage_corrupt", `${fileName} is unreadable or corrupt`);
    }
    if (!isPlainObject(existing) || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 ||
        typeof existing.token !== "string" || !UUID_RE.test(existing.token)) {
      fail("storage_corrupt", `${fileName} has an invalid owner`);
    }
    if (isPidAlive(existing.pid)) fail("writer_conflict", `Work Goal storage is open by pid ${existing.pid}`);
    const reclaimOwner = { pid: process.pid, token: crypto.randomUUID(), staleToken: existing.token };
    try { await writeExclusiveDurable(reclaimPath, JSON.stringify(reclaimOwner)); }
    catch (error) {
      if (error.code === "EEXIST") fail("writer_conflict", `Work Goal storage lock ${fileName} is being reclaimed`);
      throw error;
    }
    try {
      // Re-read under the exclusive reclaim claim. Cooperative acquirers check
      // this claim before creating the canonical lock, so it cannot be a new
      // owner's lock by the time it is removed.
      let confirmed;
      try { confirmed = JSON.parse(await readRegularNoFollow(lockPath)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (confirmed.token !== existing.token || confirmed.pid !== existing.pid) continue;
      await fsp.unlink(lockPath);
      await syncDirectory(dirPath);
    } finally {
      try {
        const claim = JSON.parse(await readRegularNoFollow(reclaimPath));
        if (claim.pid === reclaimOwner.pid && claim.token === reclaimOwner.token) {
          await fsp.unlink(reclaimPath);
          await syncDirectory(dirPath);
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  fail("writer_conflict", `could not acquire ${fileName}`);
}

async function releaseLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(await readRegularNoFollow(lock.path));
    if (owner.pid === lock.owner.pid && owner.token === lock.owner.token) {
      await fsp.unlink(lock.path);
      await syncDirectory(lock.dirPath);
    }
  } catch {
    // Never remove a lock whose ownership cannot be verified.
  }
}

async function readJournal(journalPath) {
  const handle = await openRegularNoFollow(journalPath, fsConstants.O_RDONLY);
  let bytesKept = 0;
  let bytesRead = 0;
  let pending = Buffer.alloc(0);
  let state = null;
  const seenEventIds = new Set();
  try {
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
    for await (const chunk of stream) {
      bytesRead += chunk.length;
      if (bytesRead > MAX_TASK_STORE_BYTES) fail("storage_limit", "Work Goal journal exceeds its size limit");
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let cursor = 0;
      let newline;
      while ((newline = data.indexOf(0x0a, cursor)) !== -1) {
        const line = data.subarray(cursor, newline);
        if (line.length === 0 || line.length > MAX_EVENT_BYTES) fail("storage_corrupt", "Work Goal journal contains an invalid complete line");
        let event;
        try { event = JSON.parse(line.toString("utf8")); }
        catch { fail("storage_corrupt", "Work Goal journal contains malformed JSON"); }
        try {
          state = state === null ? replayWorkGoalEvents([event]) : applyWorkGoalEvent(state, event, seenEventIds);
          seenEventIds.add(event.eventId);
        } catch (error) { fail("storage_corrupt", `Work Goal journal replay failed: ${error.message}`); }
        bytesKept += line.length + 1;
        cursor = newline + 1;
      }
      pending = Buffer.from(data.subarray(cursor));
      if (pending.length > MAX_EVENT_BYTES) fail("storage_corrupt", "Work Goal journal has an oversized final line");
    }
  } finally { await handle.close(); }
  if (state === null) fail("storage_corrupt", "Work Goal journal has no complete creation event");
  if (pending.length > 0) {
    // An incomplete final write is the only journal damage recovery may drop.
    const writer = await openRegularNoFollow(journalPath, fsConstants.O_WRONLY);
    try { await writer.truncate(bytesKept); await writer.sync(); }
    finally { await writer.close(); }
  }
  return { state, seenEventIds, bytesKept };
}

class WorkGoalStore {
  constructor({ storageRoot, now = () => new Date() } = {}) {
    if (typeof storageRoot !== "string" || storageRoot.length === 0) fail("invalid_config", "storageRoot is required");
    if (typeof now !== "function") fail("invalid_config", "now must be a function");
    this._storageRoot = path.resolve(storageRoot);
    this._goalsRoot = path.join(this._storageRoot, "work-goals");
    this._now = now;
    this._states = new Map();
    this._seenEventIds = new Map();
    this._bytes = new Map();
    this._activeGoalId = null;
    this._registryLock = null;
    this._loaded = false;
    this._closed = false;
    this._writeBlocked = false;
    this._writeChain = Promise.resolve();
    this._loadPromise = null;
    this._closePromise = null;
  }

  _timestamp() {
    const time = this._now();
    const at = time instanceof Date ? time.toISOString() : time;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) fail("invalid_config", "now must return a valid timestamp");
    return at;
  }

  _assertLoaded() {
    if (this._closed) fail("closed", "WorkGoalStore is closed");
    if (!this._loaded) fail("not_loaded", "WorkGoalStore.load() must complete first");
    if (this._writeBlocked) fail("storage_uncertain", "Work Goal storage must be reopened after an uncertain write");
  }

  _mutate(fn) {
    this._assertLoaded();
    const run = () => Promise.resolve().then(() => {
      // A writer may fail after earlier calls have already entered the chain.
      // Re-check at execution time so those queued writes cannot mutate an
      // in-memory state whose preceding journal append is uncertain.
      this._assertLoaded();
      return fn();
    });
    const result = this._writeChain.then(run, run);
    this._writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async load() {
    if (this._closed) fail("closed", "WorkGoalStore is closed");
    if (this._loaded) return this;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._load().catch((error) => { this._loadPromise = null; throw error; });
    return this._loadPromise;
  }

  async _load() {
    try {
      await fsp.mkdir(this._storageRoot, { recursive: true, mode: 0o700 });
      const storageStat = await fsp.lstat(this._storageRoot);
      if (storageStat.isSymbolicLink() || !storageStat.isDirectory()) fail("unsafe_path", "storageRoot must be a real directory");
      await assertPrivateDirectory(this._goalsRoot, { create: true });
      this._registryLock = await acquireLock(this._goalsRoot, "registry.lock");
      const entries = await fsp.readdir(this._goalsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!UUID_RE.test(entry.name)) continue;
        if (!entry.isDirectory()) fail("unsafe_path", "Work Goal UUID entry must be a real directory");
        const goalDir = path.join(this._goalsRoot, entry.name);
        await assertPrivateDirectory(goalDir);
        let recovered;
        try { recovered = await readJournal(path.join(goalDir, "events.jsonl")); }
        catch (error) {
          if (error.code === "ENOENT") fail("storage_corrupt", "Work Goal journal is missing");
          throw error;
        }
        if (recovered.state.goalId !== entry.name) fail("storage_corrupt", "Work Goal journal ID differs from its directory");
        this._states.set(entry.name, recovered.state);
        this._seenEventIds.set(entry.name, recovered.seenEventIds);
        this._bytes.set(entry.name, recovered.bytesKept);
        if (NONTERMINAL.has(recovered.state.status)) {
          if (this._activeGoalId !== null) fail("storage_corrupt", "multiple nonterminal Work Goals occupy the project slot");
          this._activeGoalId = entry.name;
        }
      }
      await this._syncActivePointer();
      this._loaded = true;
      return this;
    } catch (error) {
      await releaseLock(this._registryLock);
      this._registryLock = null;
      this._states.clear();
      this._seenEventIds.clear();
      this._bytes.clear();
      this._activeGoalId = null;
      throw error;
    }
  }

  async _syncActivePointer() {
    const pointerPath = path.join(this._goalsRoot, "active.json");
    let valid = false;
    try {
      const pointer = JSON.parse(await readRegularNoFollow(pointerPath));
      valid = isPlainObject(pointer) && Object.keys(pointer).sort().join(",") === "activeGoalId,version" &&
        pointer.version === POINTER_VERSION && pointer.activeGoalId === this._activeGoalId;
    } catch (error) {
      if (error.code === "unsafe_path" || error.code === "unsafe_permissions") throw error;
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (!valid) {
      await atomicWrite(this._goalsRoot, "active.json", JSON.stringify({ version: POINTER_VERSION, activeGoalId: this._activeGoalId }));
    }
  }

  getActive() {
    this._assertLoaded();
    return this._activeGoalId === null ? null : copy(this._states.get(this._activeGoalId));
  }

  get(goalId) {
    this._assertLoaded();
    validateGoalId(goalId);
    const state = this._states.get(goalId);
    return state ? copy(state) : null;
  }

  listHistory() {
    this._assertLoaded();
    return [...this._states.values()]
      .filter((state) => !NONTERMINAL.has(state.status))
      .sort((a, b) => a.goalId.localeCompare(b.goalId))
      .map(copy);
  }

  async create(input) {
    validateWorkGoalInput(input);
    const frozenInput = copy(input);
    return this._mutate(async () => {
      if (this._activeGoalId !== null) fail("active_goal_exists", "this project already has a nonterminal Work Goal");
      const goalId = crypto.randomUUID();
      const spec = { schemaVersion: SCHEMA_VERSION, goalId, version: 1,
        objective: frozenInput.objective, successCriteria: frozenInput.successCriteria, budget: frozenInput.budget ?? {} };
      const event = { seq: 1, eventId: crypto.randomUUID(), goalId, goalVersion: 1,
        type: "work_goal_created", payload: { spec }, at: this._timestamp() };
      validateWorkGoalEvent(event);
      const state = replayWorkGoalEvents([event]);
      const tmpDir = path.join(this._goalsRoot, `tmp-${crypto.randomUUID()}`);
      const goalDir = path.join(this._goalsRoot, goalId);
      await fsp.mkdir(tmpDir, { mode: 0o700 });
      let published = false;
      try {
        await writeExclusiveDurable(path.join(tmpDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
        await syncDirectory(tmpDir);
        await fsp.rename(tmpDir, goalDir);
        published = true;
        await syncDirectory(this._goalsRoot);
      } finally {
        if (!published) await fsp.rm(tmpDir, { recursive: true, force: true });
      }
      this._states.set(goalId, state);
      this._seenEventIds.set(goalId, new Set([event.eventId]));
      this._bytes.set(goalId, Buffer.byteLength(JSON.stringify(event), "utf8") + 1);
      this._activeGoalId = goalId;
      try { await this._syncActivePointer(); }
      catch (error) { this._writeBlocked = true; fail("storage_uncertain", `Work Goal was journaled but its index update failed: ${error.message}`); }
      return copy(state);
    });
  }

  async append(input) {
    if (!isPlainObject(input)) fail("invalid_field", "append input must be an object");
    // The caller may reuse or mutate a request as soon as append() returns.
    // Take ownership before the first await in the serialized write chain.
    const request = copy(input);
    return this._mutate(async () => {
      const allowed = new Set(["goalId", "expectedVersion", "type", "payload", "goalVersion"]);
      if (Object.keys(request).some((key) => !allowed.has(key))) fail("invalid_field", "append input has an unsupported field");
      validateGoalId(request.goalId);
      if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion <= 0) {
        fail("invalid_field", "append requires a positive expectedVersion");
      }
      const current = this._states.get(request.goalId);
      if (!current) fail("not_found", "Work Goal does not exist");
      if (current.spec.version !== request.expectedVersion) fail("stale_goal_version", "Work Goal version changed before append");
      const goalVersion = request.type === "work_goal_amended" ? current.spec.version + 1 : current.spec.version;
      if (request.goalVersion !== undefined && request.goalVersion !== goalVersion) fail("stale_goal_version", "event Goal version is stale");
      const event = { seq: current.seq + 1, eventId: crypto.randomUUID(), goalId: request.goalId,
        goalVersion, type: request.type, payload: request.payload, at: this._timestamp() };
      validateWorkGoalEvent(event);
      const line = `${JSON.stringify(event)}\n`;
      const nextBytes = this._bytes.get(request.goalId) + Buffer.byteLength(line, "utf8");
      if (nextBytes > MAX_TASK_STORE_BYTES) fail("storage_limit", "Work Goal journal exceeds its size limit");
      const goalDir = path.join(this._goalsRoot, request.goalId);
      const lock = await acquireLock(goalDir, "writer.lock");
      try {
        // The reducer's invalid-candidate checks precede mutation. Once it
        // accepts an event, any storage failure makes the in-memory replay
        // uncertain, so this instance must be closed and reloaded.
        const nextState = applyWorkGoalEvent(current, event, this._seenEventIds.get(request.goalId));
        try {
          const handle = await openRegularNoFollow(path.join(goalDir, "events.jsonl"), fsConstants.O_WRONLY | fsConstants.O_APPEND);
          try { await handle.writeFile(line, "utf8"); await handle.sync(); }
          finally { await handle.close(); }
        } catch (error) { this._writeBlocked = true; throw error; }
        this._states.set(request.goalId, nextState);
        this._bytes.set(request.goalId, nextBytes);
        const nextActive = NONTERMINAL.has(nextState.status) ? request.goalId : null;
        if (this._activeGoalId === request.goalId && nextActive === null) this._activeGoalId = null;
        try { await this._syncActivePointer(); }
        catch (error) { this._writeBlocked = true; fail("storage_uncertain", `Work Goal event was journaled but its index update failed: ${error.message}`); }
        return copy(nextState);
      } finally { await releaseLock(lock); }
    });
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._closePromise = (async () => {
      // load() may still be creating work-goals/ or acquiring registry.lock.
      // Wait for it to settle before deciding which lock must be released.
      if (this._loadPromise) await this._loadPromise.catch(() => {});
      await this._writeChain;
      await releaseLock(this._registryLock);
      this._registryLock = null;
      this._loaded = false;
    })();
    return this._closePromise;
  }
}

module.exports = { WorkGoalStore, WorkGoalStoreError };
