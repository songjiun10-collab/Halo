"use strict";

// Durable FIFO ordering for TaskHost's sequential task queue (Symphony-
// inspired orchestration; see docs/superpowers/specs/2026-09-28-local-agent-
// controls-design.md, "Sequential User Task Queue"). This module owns ONLY
// ordered task IDs plus a small bounded transition history -- never goal
// data, journal events, credentials, or browser/planner instances. TaskHost
// is the sole caller and is solely responsible for actually attaching/
// starting whatever this queue reports as the current head; TaskQueue itself
// never constructs a BrowserAdapter, a planner, or a TaskController.
//
// Manifest layout: `<storageRoot>/queue.json` (0600), written via the same
// tmp+fsync+rename+fsyncDir pattern task-store.js uses for checkpoint.json.

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const crypto = require("node:crypto");
const path = require("node:path");

const { UUID_RE, isPlainObject } = require("../../shared/harness-contracts");

const MANIFEST_VERSION = 1;
const MAX_HISTORY_ENTRIES = 200;

class TaskQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskQueueError";
    this.code = code;
  }
}

async function pathIsSymlink(targetPath) {
  try {
    const st = await fsp.lstat(targetPath);
    return st.isSymbolicLink();
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

async function fsyncDir(dirPath) {
  const fh = await fsp.open(dirPath, fsConstants.O_RDONLY);
  try {
    await fh.sync();
  } catch (err) {
    // Some platforms reject fsync on a directory descriptor; the rename
    // itself is still durable there (same tolerance as task-store.js).
    if (err.code !== "EINVAL" && err.code !== "EISDIR") throw err;
  } finally {
    await fh.close();
  }
}

function validateManifest(parsed) {
  if (!isPlainObject(parsed)) throw new TaskQueueError("queue_corrupt", "queue manifest must be a plain object");
  if (parsed.version !== MANIFEST_VERSION) {
    throw new TaskQueueError("queue_corrupt", `unsupported queue manifest version ${parsed.version}`);
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new TaskQueueError("queue_corrupt", "queue manifest entries must be an array of task UUIDs");
  }
  if (new Set(parsed.entries).size !== parsed.entries.length) {
    throw new TaskQueueError("queue_corrupt", "queue manifest entries must not contain duplicate task ids");
  }
  if (!Array.isArray(parsed.active ?? [] ) || (parsed.active ?? []).some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new TaskQueueError("queue_corrupt", "queue manifest active must be an array of task UUIDs");
  }
  if (new Set(parsed.active ?? []).size !== (parsed.active ?? []).length || (parsed.active ?? []).some((id) => parsed.entries.includes(id))) {
    throw new TaskQueueError("queue_corrupt", "active and pending task ids must be unique");
  }
  if (!Array.isArray(parsed.history)) {
    throw new TaskQueueError("queue_corrupt", "queue manifest history must be an array");
  }
  return parsed;
}

class TaskQueue {
  constructor({ storageRoot }) {
    if (!storageRoot) throw new TaskQueueError("invalid_config", "storageRoot is required");
    this._storageRoot = path.resolve(storageRoot);
    this._manifestPath = path.join(this._storageRoot, "queue.json");
    this._entries = [];
    this._active = [];
    this._history = [];
    this._loaded = false;
    // Serializes enqueue/advance/skip so concurrent callers never race
    // reading/rewriting this._entries or the manifest file -- the same
    // FIFO-chain-survives-individual-failure shape as task-store.js's
    // append() critical section.
    this._writeChain = Promise.resolve();
  }

  // Reads the durable manifest exactly once (idempotent). Safe to call
  // before storageRoot exists at all -- a brand-new install has never
  // enqueued anything, which is treated the same as an empty queue.
  async load() {
    if (this._loaded) return;
    if (await pathIsSymlink(this._manifestPath)) {
      throw new TaskQueueError("unsafe_path", "queue manifest must not be a symlink");
    }
    let raw;
    try {
      const fh = await fsp.open(this._manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        raw = await fh.readFile("utf8");
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        this._entries = [];
        this._active = [];
        this._history = [];
        this._loaded = true;
        return;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = validateManifest(JSON.parse(raw));
    } catch (err) {
      if (err instanceof TaskQueueError) throw err;
      throw new TaskQueueError("queue_corrupt", `queue manifest is not valid JSON: ${err.message}`);
    }
    this._entries = [...parsed.entries];
    this._active = [...(parsed.active ?? [])];
    this._history = [...parsed.history];
    this._loaded = true;
  }

  _assertLoaded() {
    if (!this._loaded) throw new TaskQueueError("not_loaded", "TaskQueue.load() must complete before use");
  }

  peekHead() {
    this._assertLoaded();
    return this._entries.length > 0 ? this._entries[0] : null;
  }

  isLoaded() { return this._loaded; }

  has(taskId) {
    this._assertLoaded();
    return this._entries.includes(taskId);
  }

  entries() {
    this._assertLoaded();
    return [...this._entries];
  }

  pendingIds() { this._assertLoaded(); return [...this._entries]; }
  activeIds() { this._assertLoaded(); return [...this._active]; }
  history() { this._assertLoaded(); return this._history.map((event) => ({ ...event })); }

  async admitNext({ maxActive = 1 } = {}) {
    this._assertLoaded();
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new TaskQueueError("invalid_field", "maxActive must be a positive integer");
    return this._mutate(async () => {
      if (this._active.length >= maxActive || this._entries.length === 0) return null;
      const taskId = this._entries[0];
      await this._persist(this._entries.slice(1), [...this._active, taskId], [...this._history, { type: "admit", taskId, at: new Date().toISOString() }].slice(-MAX_HISTORY_ENTRIES));
      return taskId;
    });
  }

  async complete(taskId, state) {
    this._assertLoaded();
    if (state !== "completed" && state !== "stopped") throw new TaskQueueError("invalid_terminal_state", "only completed or stopped tasks release their queue slot");
    return this._mutate(async () => {
      if (!this._active.includes(taskId)) throw new TaskQueueError("not_active", `task ${taskId} has no admitted slot`);
      await this._persist(this._entries, this._active.filter((id) => id !== taskId), [...this._history, { type: "complete", taskId, state, at: new Date().toISOString() }].slice(-MAX_HISTORY_ENTRIES));
    });
  }

  async reconcile(summaries) {
    this._assertLoaded();
    if (!Array.isArray(summaries)) throw new TaskQueueError("invalid_field", "summaries must be an array");
    return this._mutate(async () => {
      const byId = new Map(summaries.map((item) => [item.taskId, item]));
      for (const taskId of [...this._entries, ...this._active]) {
        if (!byId.has(taskId)) throw new TaskQueueError("queue_reference_missing", `queued task ${taskId} is absent from TaskStore`);
      }
      const terminal = new Set(summaries.filter((item) => item.state === "completed" || item.state === "stopped").map((item) => item.taskId));
      const entries = this._entries.filter((id) => !terminal.has(id));
      const active = this._active.filter((id) => !terminal.has(id));
      // A process restart invalidates all runtime admissions. Recover unfinished
      // active IDs to the FIFO head; they remain paused and need human resume.
      const recovered = active.length ? [...active, ...entries] : entries;
      const recoveredActive = [];
      const known = new Set([...recovered, ...recoveredActive]);
      const orphaned = summaries.filter((item) => !known.has(item.taskId) && !terminal.has(item.taskId))
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.taskId.localeCompare(b.taskId))
        .map((item) => item.taskId);
      const nextEntries = [...recovered, ...orphaned];
      await this._persist(nextEntries, recoveredActive, [...this._history, { type: "reconcile", at: new Date().toISOString(), pruned: terminal.size, recovered: active.length, adopted: orphaned.length }].slice(-MAX_HISTORY_ENTRIES));
    });
  }

  _mutate(fn) {
    const run = () => Promise.resolve().then(fn);
    const result = this._writeChain.then(run, run);
    this._writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Enqueues a brand-new task id at the tail. Returns true iff it became the
  // head (the queue was empty beforehand) -- TaskHost uses this single bit to
  // decide whether to attach a BrowserAdapter/planner immediately or wait.
  async enqueue(taskId) {
    this._assertLoaded();
    if (typeof taskId !== "string" || !UUID_RE.test(taskId)) {
      throw new TaskQueueError("invalid_field", "taskId must be a UUID");
    }
    return this._mutate(async () => {
      if (this._entries.includes(taskId)) {
        throw new TaskQueueError("already_queued", `task ${taskId} is already in the queue`);
      }
      const becameHead = this._entries.length === 0;
      const nextEntries = [...this._entries, taskId];
      const event = { type: "enqueue", taskId, at: new Date().toISOString() };
      await this._persist(nextEntries, this._active, [...this._history, event].slice(-MAX_HISTORY_ENTRIES));
      return becameHead;
    });
  }

  // Compatibility-named terminal transition. State is explicit and
  // allowlisted so callers cannot advance a paused/approval-blocked task.
  async advance(taskId, state) {
    await this.complete(taskId, state);
    return this._entries[0] ?? null;
  }

  // Same removal as advance(), but recorded as a distinct, durable, audited
  // transition -- it never claims the task completed.
  async skip(taskId, { reason, actor } = {}) {
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TaskQueueError("invalid_field", "skip requires a non-empty reason");
    }
    if (actor !== "trusted_host") throw new TaskQueueError("untrusted_skip", "skip is restricted to an explicit trusted host action");
    return this._popHead(taskId, "skip", { reason, actor: actor ?? null });
  }

  async _popHead(taskId, type, extra = {}) {
    this._assertLoaded();
    return this._mutate(async () => {
      if (this._entries[0] !== taskId) {
        throw new TaskQueueError("not_queue_head", `task ${taskId} is not the current queue head`);
      }
      const nextEntries = this._entries.slice(1);
      const event = { type, taskId, at: new Date().toISOString(), ...extra };
      const nextActive = this._active.filter((id) => id !== taskId);
      await this._persist(nextEntries, nextActive, [...this._history, event].slice(-MAX_HISTORY_ENTRIES));
      return nextEntries.length > 0 ? nextEntries[0] : null;
    });
  }

  async _persist(entries, active, history) {
    const manifest = { version: MANIFEST_VERSION, entries, active, history };
    const serialized = JSON.stringify(manifest);
    await fsp.mkdir(this._storageRoot, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(this._storageRoot, `queue.json.tmp-${crypto.randomUUID()}`);
    const fh = await fsp.open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fh.writeFile(serialized, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, this._manifestPath);
    await fsyncDir(this._storageRoot);
    this._entries = entries;
    this._active = active;
    this._history = history;
  }
}

module.exports = { TaskQueue, TaskQueueError };
