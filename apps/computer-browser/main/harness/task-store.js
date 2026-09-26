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

// Replays events.jsonl WITHOUT ever materializing the full file as one
// string or one array (docs/superpowers/specs/2026-09-27-long-horizon-
// browser-harness-design.md section 10: a long-running task's journal must
// not be loaded into RAM in full). The file is read in bounded chunks and
// reduced line-by-line: only a handful of scalars (last seq, the single
// in-flight action id -- Task 3's controller dispatches at most one action
// per task at a time, so recovery never needs more than one) plus a small
// ring buffer of the most recent events are kept, capped at
// MAX_RECENT_EVENTS_IN_CONTEXT regardless of how many events the journal
// actually holds. Only the FINAL line may be an incomplete write (a crash
// mid-append, detected as leftover bytes with no terminating "\n"); any
// earlier line that fails to parse or validate, has an out-of-order seq, or
// violates the one-action-in-flight invariant is storage_corrupt.
async function streamJournalReplay(journalPath, checkpointSeq) {
  let fh;
  try {
    fh = await fsp.open(journalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { nextSeq: 1, bytesKept: 0, tornTailDropped: false, recentEvents: [], openActionId: null };
    }
    throw err;
  }

  let lastSeq = 0;
  let bytesKept = 0;
  let openActionId = null;
  const recentEvents = [];
  let residual = "";
  let tornTailDropped = false;

  function commitLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
      contracts.validateJournalEvent(parsed);
    } catch (err) {
      throw new TaskStoreError("storage_corrupt", `journal line is invalid: ${err.message}`);
    }
    if (parsed.seq !== lastSeq + 1) {
      throw new TaskStoreError("storage_corrupt", `journal seq out of order: expected ${lastSeq + 1}, got ${parsed.seq}`);
    }
    if (parsed.type === "action_started") {
      if (openActionId !== null) {
        throw new TaskStoreError(
          "storage_corrupt",
          `action_started for "${parsed.payload.actionId}" arrived while "${openActionId}" was still open`,
        );
      }
      openActionId = parsed.payload.actionId;
    } else if (parsed.type === "action_outcome") {
      if (openActionId !== parsed.payload.actionId) {
        throw new TaskStoreError(
          "storage_corrupt",
          `action_outcome for "${parsed.payload.actionId}" does not match the open action "${openActionId}"`,
        );
      }
      openActionId = null;
    }
    lastSeq = parsed.seq;
    bytesKept += Buffer.byteLength(line, "utf8") + 1;
    if (parsed.seq > checkpointSeq) {
      recentEvents.push(parsed);
      if (recentEvents.length > contracts.MAX_RECENT_EVENTS_IN_CONTEXT) recentEvents.shift();
    }
  }

  try {
    const stream = fh.createReadStream({ encoding: "utf8", highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      residual += chunk;
      let idx;
      while ((idx = residual.indexOf("\n")) !== -1) {
        const line = residual.slice(0, idx);
        residual = residual.slice(idx + 1);
        commitLine(line);
      }
    }
    if (residual.length > 0) {
      // Leftover bytes with no terminating newline: the last append was cut
      // short by a crash. Drop it silently without ever validating its
      // content -- section 4: "마지막 미완성 JSONL 줄만 잘라낼 수 있다".
      tornTailDropped = true;
    }
  } finally {
    await fh.close();
  }

  return { nextSeq: lastSeq + 1, bytesKept, tornTailDropped, recentEvents, openActionId };
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

      let checkpoint = null;
      const checkpointPath = path.join(taskDir, "checkpoint.json");
      try {
        const raw = await readFileNoFollow(checkpointPath);
        checkpoint = contracts.validateCheckpointEnvelope(JSON.parse(raw));
      } catch (err) {
        if (err.code !== "ENOENT") throw wrapContractError(err);
      }
      const checkpointSeq = checkpoint ? checkpoint.seq : 0;

      const journalPath = path.join(taskDir, "events.jsonl");
      const { nextSeq, bytesKept, tornTailDropped, recentEvents, openActionId } = await streamJournalReplay(
        journalPath,
        checkpointSeq,
      );

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
      store.eventsSinceCheckpoint = recentEvents;
      store.recoveryReason = openActionId !== null ? "execution_uncertain" : "recovered";
      return store;
    } catch (err) {
      await releaseLock(lockPath);
      throw err;
    }
  }
}

module.exports = { TaskStore, TaskStoreError };
