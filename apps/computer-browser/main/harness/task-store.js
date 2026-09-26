"use strict";

// Durable, host-owned storage for one long-horizon browser task: immutable
// goal versions, an append-only event journal, and a periodic checkpoint.
// See docs/superpowers/specs/2026-09-27-long-horizon-browser-harness-design.md
// section 4 ("지속 저장과 복구") for the design this file implements.
//
// Layout under `<storageRoot>/tasks/<taskId>/` (0700 dir, 0600 files):
//   goal-vNNNN.json   one immutable file per goal version, never overwritten
//   events.jsonl      append-only journal: {seq,eventId,taskId,goalVersion,type,payload,at}
//   checkpoint.json   {seq,taskId,goalVersion,payload,at}, written via tmp+fsync+rename
//   writer.lock       {pid,acquiredAt}; exclusive, reclaimed only if the pid is dead

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const crypto = require("node:crypto");
const path = require("node:path");

const contracts = require("../../shared/harness-contracts");

class TaskStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

function wrapContractError(err) {
  if (err instanceof contracts.ContractError) {
    return new TaskStoreError(err.code, err.message);
  }
  return err;
}

function goalFileName(version) {
  return `goal-v${String(version).padStart(4, "0")}.json`;
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

async function resolveTaskDir(storageRoot, taskId) {
  if (typeof taskId !== "string" || !contracts.UUID_RE.test(taskId)) {
    throw new TaskStoreError("invalid_task_id", `taskId must be a UUID: ${JSON.stringify(taskId)}`);
  }
  const root = await fsp.realpath(storageRoot);
  const tasksRoot = path.join(root, "tasks");
  if (await pathIsSymlink(tasksRoot)) {
    throw new TaskStoreError("unsafe_path", "tasks root must not be a symlink");
  }
  const taskDir = path.join(tasksRoot, taskId);
  if (path.dirname(taskDir) !== tasksRoot) {
    // Defense in depth: the UUID regex above already forbids "/" and "..",
    // so this should be unreachable, but never let a taskId escape tasksRoot.
    throw new TaskStoreError("invalid_task_id", "taskId resolves outside the tasks root");
  }
  if (await pathIsSymlink(taskDir)) {
    throw new TaskStoreError("unsafe_path", "task directory must not be a symlink");
  }
  return { tasksRoot, taskDir };
}

async function writeFileDurable(filePath, contents, mode) {
  const fh = await fsp.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode,
  );
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readFileNoFollow(filePath) {
  const fh = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

async function fsyncDir(dirPath) {
  const fh = await fsp.open(dirPath, fsConstants.O_RDONLY);
  try {
    await fh.sync();
  } catch (err) {
    // Some platforms (notably certain filesystems) reject fsync on a
    // directory descriptor; the rename itself is still durable there.
    if (err.code !== "EINVAL" && err.code !== "EISDIR") throw err;
  } finally {
    await fh.close();
  }
}

async function acquireLock(taskDir) {
  const lockPath = path.join(taskDir, "writer.lock");
  const record = { pid: process.pid, acquiredAt: new Date().toISOString() };
  try {
    await writeFileDurable(lockPath, JSON.stringify(record), 0o600);
    return lockPath;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  // A lock file already exists: reclaim it only if its owning pid is dead.
  let existing;
  try {
    existing = JSON.parse(await readFileNoFollow(lockPath));
  } catch {
    throw new TaskStoreError("storage_corrupt", "writer.lock is unreadable or corrupt");
  }
  const ownerAlive = isPidAlive(existing.pid);
  if (ownerAlive) {
    throw new TaskStoreError("writer_conflict", `task is already open by pid ${existing.pid}`);
  }
  await fsp.unlink(lockPath);
  await writeFileDurable(lockPath, JSON.stringify(record), 0o600);
  return lockPath;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive, just owned by another user
  }
}

async function releaseLock(lockPath) {
  try {
    const raw = await readFileNoFollow(lockPath);
    const existing = JSON.parse(raw);
    if (existing.pid === process.pid) {
      await fsp.unlink(lockPath);
    }
  } catch {
    // Best-effort: if the lock is already gone or unreadable, there is
    // nothing further this process can safely do about it.
  }
}

async function appendLineDurable(filePath, line) {
  const fh = await fsp.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fh.appendFile(line, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Reads events.jsonl and returns { events, tornTailDropped, bytesKept }.
// Only the FINAL line may be an incomplete write (a crash mid-append); any
// earlier line that fails to parse, or any seq that is out of order or
// duplicated, is storage_corrupt.
async function readJournal(journalPath) {
  let raw;
  try {
    raw = await readFileNoFollow(journalPath);
  } catch (err) {
    if (err.code === "ENOENT") return { events: [], tornTailDropped: false, bytesKept: 0 };
    throw err;
  }
  if (raw.length === 0) return { events: [], tornTailDropped: false, bytesKept: 0 };

  const endsClean = raw.endsWith("\n");
  const rawLines = raw.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();

  const tornTailDropped = !endsClean && rawLines.length > 0;
  const completeLines = tornTailDropped ? rawLines.slice(0, -1) : rawLines;

  const events = [];
  let expectedSeq = 1;
  let bytesKept = 0;
  for (const line of completeLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
      contracts.validateJournalEvent(parsed);
    } catch (err) {
      throw new TaskStoreError("storage_corrupt", `journal line is invalid: ${err.message}`);
    }
    if (parsed.seq !== expectedSeq) {
      throw new TaskStoreError("storage_corrupt", `journal seq out of order: expected ${expectedSeq}, got ${parsed.seq}`);
    }
    events.push(parsed);
    expectedSeq += 1;
    bytesKept += Buffer.byteLength(line, "utf8") + 1;
  }
  return { events, tornTailDropped, bytesKept };
}

function computeRecoveryReason(events) {
  const started = new Map();
  for (const event of events) {
    if (event.type === "action_started") {
      started.set(event.payload.actionId, true);
    } else if (event.type === "action_outcome") {
      started.delete(event.payload.actionId);
    }
  }
  return started.size > 0 ? "execution_uncertain" : "recovered";
}

class TaskStore {
  constructor({ taskId, storageRoot, taskDir, lockPath, journalPath, goal, nextSeq, totalBytes }) {
    this.taskId = taskId;
    this._storageRoot = storageRoot;
    this._taskDir = taskDir;
    this._lockPath = lockPath;
    this._journalPath = journalPath;
    this._goal = goal;
    this._nextSeq = nextSeq;
    this._totalBytes = totalBytes;
    this._writeBlocked = false;
    this._closed = false;

    // Recovery metadata, set by load(); undefined on a freshly created store.
    this.lastCheckpoint = null;
    this.eventsSinceCheckpoint = [];
    this.recoveryReason = undefined;
  }

  getGoal() {
    return this._goal;
  }

  isWriteBlocked() {
    return this._writeBlocked;
  }

  async amendGoal(amendmentInput) {
    this._assertOpen();
    let nextGoal;
    try {
      nextGoal = contracts.applyAmendment(this._goal, amendmentInput, {
        amendmentId: crypto.randomUUID(),
        at: new Date().toISOString(),
      });
    } catch (err) {
      throw wrapContractError(err);
    }
    const filePath = path.join(this._taskDir, goalFileName(nextGoal.goalVersion));
    await writeFileDurable(filePath, JSON.stringify(nextGoal), 0o600);
    await fsyncDir(this._taskDir);
    this._goal = nextGoal;

    await this.append({
      type: "goal_amended",
      payload: { goalVersion: nextGoal.goalVersion, amendmentId: nextGoal.amendments[nextGoal.amendments.length - 1].id },
      goalVersion: nextGoal.goalVersion,
    });
    return nextGoal;
  }

  async append(input) {
    this._assertOpen();
    if (this._writeBlocked) {
      throw new TaskStoreError("journal_write_failed", "this task store's journal is blocked after a prior write failure");
    }
    if (!contracts.isPlainObject(input)) {
      throw new TaskStoreError("invalid_event", "append() input must be a plain object");
    }
    const forbiddenKeys = ["seq", "eventId", "taskId", "at"];
    const offending = forbiddenKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (offending) {
      throw new TaskStoreError("invalid_event", `append() input must not set "${offending}"; the store assigns it`);
    }

    const candidateSeq = this._nextSeq;
    const event = {
      seq: candidateSeq,
      eventId: crypto.randomUUID(),
      taskId: this.taskId,
      goalVersion: input.goalVersion || this._goal.goalVersion,
      type: input.type,
      payload: input.payload,
      at: new Date().toISOString(),
    };

    let validated;
    try {
      validated = contracts.validateJournalEvent(event);
    } catch (err) {
      throw wrapContractError(err);
    }

    const line = `${JSON.stringify(validated)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this._totalBytes + lineBytes > contracts.MAX_TASK_STORE_BYTES) {
      throw new TaskStoreError("storage_limit", "task store has reached its storage limit");
    }

    try {
      await appendLineDurable(this._journalPath, line);
    } catch (err) {
      this._writeBlocked = true;
      throw new TaskStoreError("journal_write_failed", `journal append failed: ${err.message}`);
    }

    this._nextSeq = candidateSeq + 1;
    this._totalBytes += lineBytes;
    return validated;
  }

  async checkpoint(payload) {
    this._assertOpen();
    if (!contracts.isPlainObject(payload)) {
      throw new TaskStoreError("invalid_field", "checkpoint() payload must be a plain object");
    }
    const envelope = {
      seq: this._nextSeq - 1 >= 0 ? this._nextSeq - 1 : 0,
      taskId: this.taskId,
      goalVersion: this._goal.goalVersion,
      payload,
      at: new Date().toISOString(),
    };
    let validated;
    try {
      validated = contracts.validateCheckpointEnvelope(envelope);
    } catch (err) {
      throw wrapContractError(err);
    }

    const finalPath = path.join(this._taskDir, "checkpoint.json");
    const tmpPath = path.join(this._taskDir, `checkpoint.json.tmp-${crypto.randomUUID()}`);
    const fh = await fsp.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(JSON.stringify(validated), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, finalPath);
    await fsyncDir(this._taskDir);
    this.lastCheckpoint = validated;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    await releaseLock(this._lockPath);
  }

  _assertOpen() {
    if (this._closed) throw new TaskStoreError("closed", "this TaskStore instance is closed");
  }

  static async create(goalInput, { storageRoot, taskId } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const id = taskId || crypto.randomUUID();
    if (!contracts.UUID_RE.test(id)) throw new TaskStoreError("invalid_task_id", "taskId must be a UUID");

    const root = path.resolve(storageRoot);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const { tasksRoot, taskDir } = await resolveTaskDir(root, id);
    await fsp.mkdir(tasksRoot, { recursive: true, mode: 0o700 }).catch(() => {});
    await fsp.mkdir(taskDir, { recursive: false, mode: 0o700 });

    const lockPath = await acquireLock(taskDir);

    try {
      const goal = contracts.normalizeGoalSpec(goalInput, {
        taskId: id,
        goalVersion: 1,
        createdAt: new Date().toISOString(),
      });

      const goalPath = path.join(taskDir, goalFileName(1));
      await writeFileDurable(goalPath, JSON.stringify(goal), 0o600);
      await fsyncDir(taskDir);

      const journalPath = path.join(taskDir, "events.jsonl");
      await writeFileDurable(journalPath, "", 0o600);

      const store = new TaskStore({
        taskId: id,
        storageRoot: root,
        taskDir,
        lockPath,
        journalPath,
        goal,
        nextSeq: 1,
        totalBytes: 0,
      });

      await store.append({ type: "goal_created", payload: { goalVersion: 1 }, goalVersion: 1 });
      store.recoveryReason = "created";
      return store;
    } catch (err) {
      await releaseLock(lockPath);
      throw wrapContractError(err);
    }
  }

  static async load(taskId, { storageRoot } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    const { taskDir } = await resolveTaskDir(root, taskId);

    let dirExists = true;
    try {
      await fsp.stat(taskDir);
    } catch (err) {
      if (err.code === "ENOENT") dirExists = false;
      else throw err;
    }
    if (!dirExists) throw new TaskStoreError("not_found", `no task store at ${taskDir}`);

    const lockPath = await acquireLock(taskDir);

    try {
      const entries = await fsp.readdir(taskDir);
      const goalVersions = entries
        .map((name) => /^goal-v(\d+)\.json$/.exec(name))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
      if (goalVersions.length === 0) {
        throw new TaskStoreError("storage_corrupt", "no goal version files found");
      }
      const latestVersion = goalVersions[goalVersions.length - 1];
      const goalRaw = await readFileNoFollow(path.join(taskDir, goalFileName(latestVersion)));
      let goal;
      try {
        goal = contracts.validateGoalSpec(JSON.parse(goalRaw));
      } catch (err) {
        throw wrapContractError(err);
      }

      const journalPath = path.join(taskDir, "events.jsonl");
      const { events, tornTailDropped, bytesKept } = await readJournal(journalPath);

      if (tornTailDropped) {
        // Truncate the journal file to drop the incomplete trailing write so
        // future appends do not accumulate garbage ahead of valid lines.
        const fh = await fsp.open(journalPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
        try {
          await fh.truncate(bytesKept);
          await fh.sync();
        } finally {
          await fh.close();
        }
      }

      let checkpoint = null;
      const checkpointPath = path.join(taskDir, "checkpoint.json");
      try {
        const raw = await readFileNoFollow(checkpointPath);
        checkpoint = contracts.validateCheckpointEnvelope(JSON.parse(raw));
      } catch (err) {
        if (err.code !== "ENOENT") throw wrapContractError(err);
      }

      const checkpointSeq = checkpoint ? checkpoint.seq : 0;
      const eventsSinceCheckpoint = events.filter((e) => e.seq > checkpointSeq);
      const nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 1;

      const store = new TaskStore({
        taskId,
        storageRoot: root,
        taskDir,
        lockPath,
        journalPath,
        goal,
        nextSeq,
        totalBytes: bytesKept,
      });
      store.lastCheckpoint = checkpoint;
      store.eventsSinceCheckpoint = eventsSinceCheckpoint;
      store.recoveryReason = computeRecoveryReason(events);
      return store;
    } catch (err) {
      await releaseLock(lockPath);
      throw err;
    }
  }
}

module.exports = { TaskStore, TaskStoreError };
