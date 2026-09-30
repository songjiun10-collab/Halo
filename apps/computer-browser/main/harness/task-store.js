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
const { performance } = require("node:perf_hooks");

const contracts = require("../../shared/harness-contracts");
const routineContracts = require("../../shared/routine-contracts");
const profileContracts = require("../../shared/task-profile-contracts");
const MAX_EVENTS_PER_PAGE = 200;

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

function freezeProfile(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeProfile(child);
  return Object.freeze(value);
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

// Multi-agent background runtime plan, Task 3: a child's TaskStore lives
// under its PARENT's own directory (`<parent task dir>/children/<childId>`),
// never under the top-level tasks/ root -- this is what keeps children
// structurally absent from listTaskIds()/listTasks()/resumeSavedTask()
// without any extra filtering. Same symlink/escape defenses as
// resolveTaskDir() above, just rooted at the parent's directory instead of
// storageRoot.
async function resolveChildDir(parentTaskDir, childId) {
  if (typeof childId !== "string" || !contracts.UUID_RE.test(childId)) {
    throw new TaskStoreError("invalid_task_id", `childId must be a UUID: ${JSON.stringify(childId)}`);
  }
  const resolvedParentDir = await fsp.realpath(parentTaskDir);
  const childrenRoot = path.join(resolvedParentDir, "children");
  if (await pathIsSymlink(childrenRoot)) {
    throw new TaskStoreError("unsafe_path", "children root must not be a symlink");
  }
  const childDir = path.join(childrenRoot, childId);
  if (path.dirname(childDir) !== childrenRoot) {
    throw new TaskStoreError("invalid_task_id", "childId resolves outside the children root");
  }
  if (await pathIsSymlink(childDir)) {
    throw new TaskStoreError("unsafe_path", "child directory must not be a symlink");
  }
  return { childrenRoot, childDir };
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

// Reclaiming a stale lock cannot be unlink-then-create: two concurrent
// reclaimers can each pass the isPidAlive check, then each unlink and
// recreate in turn, leaving both believing they are the sole writer. Instead
// the stale lock is moved aside with fs.rename() -- POSIX guarantees at most
// one concurrent rename() of a given source path succeeds; every other
// racer gets ENOENT and simply retries the whole acquisition from the top.
async function acquireLock(taskDir) {
  const lockPath = path.join(taskDir, "writer.lock");
  const record = { pid: process.pid, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 50; attempt += 1) {
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
    } catch (err) {
      if (err.code === "ENOENT") continue; // another racer already reclaimed and moved it; retry
      throw new TaskStoreError("storage_corrupt", "writer.lock is unreadable or corrupt");
    }
    const ownerAlive = isPidAlive(existing.pid);
    if (ownerAlive) {
      throw new TaskStoreError("writer_conflict", `task is already open by pid ${existing.pid}`);
    }
    const staleAway = `${lockPath}.stale-${crypto.randomUUID()}`;
    try {
      await fsp.rename(lockPath, staleAway);
    } catch (err) {
      if (err.code === "ENOENT") continue; // a different racer already claimed the rename; retry
      throw err;
    }
    await fsp.unlink(staleAway).catch(() => {});
    // Loop back to the O_EXCL create: another racer may have already
    // recreated the lock in the narrow window between this rename and now.
  }
  throw new TaskStoreError("writer_conflict", "could not acquire writer.lock after repeated contention");
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
function makeRoutineRecovery(checkpointRoutineRun) {
  if (checkpointRoutineRun == null) return null;
  if (!checkpointRoutineRun || typeof checkpointRoutineRun !== "object" ||
      typeof checkpointRoutineRun.routineId !== "string" || !routineContracts.UUID_RE.test(checkpointRoutineRun.routineId) ||
      !Number.isInteger(checkpointRoutineRun.revision) || checkpointRoutineRun.revision < 1 ||
      typeof checkpointRoutineRun.digest !== "string" || !/^[0-9a-f]{64}$/.test(checkpointRoutineRun.digest) ||
      !Number.isInteger(checkpointRoutineRun.cursor) || checkpointRoutineRun.cursor < 0 ||
      (checkpointRoutineRun.blocked !== undefined && checkpointRoutineRun.blocked !== null &&
        !["denied", "failed"].includes(checkpointRoutineRun.blocked))) {
    throw new TaskStoreError("storage_corrupt", "checkpoint routine pin is malformed");
  }
  return {
    routineId: checkpointRoutineRun.routineId,
    revision: checkpointRoutineRun.revision,
    digest: checkpointRoutineRun.digest,
    cursor: checkpointRoutineRun.cursor,
    incomplete: false,
    blocked: checkpointRoutineRun.blocked || null,
    // Consecutive advancements may follow a checkpoint (the controller only
    // checkpoints at pause/stop/finish); each is durable and binding-checked
    // during replay, and at most one blocked-step decision may end the run.
    // The list is bounded by the routine step cap, not journal length.
    transition: null,
    transitions: [],
    pendingActionId: null,
    pendingOutcome: null,
  };
}

function assertRoutineEventBinding(recovery, payload, label) {
  if (recovery.transition && recovery.transition.type !== "advanced") {
    throw new TaskStoreError("storage_corrupt", "routine contains multiple transitions without an intervening checkpoint");
  }
  if (!recovery || payload.routineId !== recovery.routineId || payload.revision !== recovery.revision || payload.stepIndex !== recovery.cursor) {
    throw new TaskStoreError("storage_corrupt", `${label} does not match the pinned routine cursor`);
  }
}

async function streamJournalReplay(journalPath, checkpointSeq, pageOptions, checkpointRoutineRun = null, expectedTaskId = null) {
  let routineRecovery = makeRoutineRecovery(checkpointRoutineRun);
  let fh;
  try {
    fh = await fsp.open(journalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === "ENOENT") {
      if (!pageOptions) throw new TaskStoreError("storage_corrupt", "task journal is missing");
      return { nextSeq: 1, bytesKept: 0, tornTailDropped: false, recentEvents: [], openActionId: null, routineRecovery };
    }
    throw err;
  }

  let lastSeq = 0;
  let bytesKept = 0;
  let openActionId = null;
  const recentEvents = [];
  const events = [];
  let profileState = "unseen";
  let profileGoalVersion = null;
  let taskProfile;
  let residual = "";
  let tornTailDropped = false;

  function commitLine(line) {
    if (pageOptions && Buffer.byteLength(line, "utf8") > contracts.MAX_EVENT_BYTES) {
      throw new TaskStoreError("storage_corrupt", "journal line exceeds the event size limit");
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
      contracts.validateJournalEvent(parsed);
    } catch (err) {
      throw new TaskStoreError("storage_corrupt", `journal line is invalid: ${err.message}`);
    }
    if (pageOptions && parsed.taskId !== pageOptions.taskId) {
      throw new TaskStoreError("storage_corrupt", "journal event belongs to a different task");
    }
    if (parsed.seq !== lastSeq + 1) {
      throw new TaskStoreError("storage_corrupt", `journal seq out of order: expected ${lastSeq + 1}, got ${parsed.seq}`);
    }
    if (expectedTaskId && parsed.taskId !== expectedTaskId) {
      throw new TaskStoreError("storage_corrupt", "journal event belongs to a different task");
    }
    if (lastSeq === 0 && parsed.type !== "goal_created") {
      throw new TaskStoreError("storage_corrupt", "journal must begin with goal_created");
    }
    if (parsed.type === "goal_created" && parsed.seq === 1) {
      profileState = parsed.payload.profileRequired === true ? "awaiting_profile" : "legacy";
      profileGoalVersion = parsed.goalVersion;
      if (profileState === "awaiting_profile" && parsed.goalVersion !== 1) {
        throw new TaskStoreError("profile_corrupt", "initial profile-required goal must use goalVersion 1");
      }
    } else if (parsed.type === "task_profile_selected") {
      if (profileState !== "awaiting_profile" || parsed.seq !== 2) {
        throw new TaskStoreError("profile_corrupt", "task_profile_selected must appear exactly once immediately after a profile-required goal_created");
      }
      if (parsed.goalVersion !== profileGoalVersion) {
        throw new TaskStoreError("profile_corrupt", "task_profile_selected goalVersion does not match goal_created");
      }
      if (parsed.taskId !== (expectedTaskId || pageOptions?.taskId || parsed.taskId)) {
        throw new TaskStoreError("profile_corrupt", "task_profile_selected belongs to a different task");
      }
      profileState = "selected";
      taskProfile = parsed.payload;
    } else if (profileState === "awaiting_profile") {
      throw new TaskStoreError("profile_corrupt", "profile-required task has an event before task_profile_selected");
    }
    if (parsed.type === "action_started") {
      if (routineRecovery?.blocked && parsed.seq > checkpointSeq) {
        throw new TaskStoreError("storage_corrupt", "routine action started after a durable blocked-step decision");
      }
      if (openActionId !== null) {
        throw new TaskStoreError(
          "storage_corrupt",
          `action_started for "${parsed.payload.actionId}" arrived while "${openActionId}" was still open`,
        );
      }
      openActionId = parsed.payload.actionId;
      if (routineRecovery && parsed.seq > checkpointSeq) {
        routineRecovery.pendingActionId = parsed.payload.actionId;
        routineRecovery.pendingOutcome = null;
      }
    } else if (parsed.type === "action_outcome") {
      if (openActionId !== parsed.payload.actionId) {
        throw new TaskStoreError(
          "storage_corrupt",
          `action_outcome for "${parsed.payload.actionId}" does not match the open action "${openActionId}"`,
        );
      }
      openActionId = null;
      if (routineRecovery && parsed.seq > checkpointSeq) {
        routineRecovery.pendingOutcome = { actionId: parsed.payload.actionId, status: parsed.payload.status };
      }
    } else if (!pageOptions && ["routine_step_advanced", "routine_step_denied", "routine_step_failed"].includes(parsed.type) && !routineRecovery) {
      throw new TaskStoreError("storage_corrupt", "routine transition exists without a pinned routine checkpoint");
    } else if (routineRecovery && parsed.seq > checkpointSeq && parsed.type === "routine_step_advanced") {
      assertRoutineEventBinding(routineRecovery, parsed.payload, parsed.type);
      if (!routineRecovery.pendingOutcome || routineRecovery.pendingOutcome.actionId !== parsed.payload.actionId || routineRecovery.pendingOutcome.status !== "ok") {
        throw new TaskStoreError("storage_corrupt", "routine advancement has no matching successful action outcome");
      }
      routineRecovery.cursor += 1;
      routineRecovery.transition = {
        type: "advanced",
        stepIndex: parsed.payload.stepIndex,
        stepDigest: parsed.payload.stepDigest,
        actionId: parsed.payload.actionId,
      };
      routineRecovery.transitions.push(routineRecovery.transition);
      routineRecovery.pendingActionId = null;
      routineRecovery.pendingOutcome = null;
    } else if (routineRecovery && parsed.seq > checkpointSeq && parsed.type === "routine_step_denied") {
      assertRoutineEventBinding(routineRecovery, parsed.payload, parsed.type);
      if (routineRecovery.blocked) throw new TaskStoreError("storage_corrupt", "routine contains a duplicate blocked-step event");
      if (routineRecovery.pendingActionId || routineRecovery.pendingOutcome) {
        throw new TaskStoreError("storage_corrupt", "routine denial follows a dispatched action");
      }
      routineRecovery.blocked = "denied";
      routineRecovery.transition = {
        type: "denied",
        stepIndex: parsed.payload.stepIndex,
        stepDigest: parsed.payload.stepDigest,
        decision: parsed.payload.decision,
      };
      routineRecovery.transitions.push(routineRecovery.transition);
    } else if (routineRecovery && parsed.seq > checkpointSeq && parsed.type === "routine_step_failed") {
      assertRoutineEventBinding(routineRecovery, parsed.payload, parsed.type);
      if (!routineRecovery.pendingOutcome || routineRecovery.pendingOutcome.actionId !== parsed.payload.actionId ||
          routineRecovery.pendingOutcome.status !== parsed.payload.status) {
        throw new TaskStoreError("storage_corrupt", "routine failure has no matching action outcome");
      }
      if (routineRecovery.blocked) throw new TaskStoreError("storage_corrupt", "routine contains a duplicate blocked-step event");
      routineRecovery.blocked = "failed";
      routineRecovery.transition = {
        type: "failed",
        stepIndex: parsed.payload.stepIndex,
        stepDigest: parsed.payload.stepDigest,
        actionId: parsed.payload.actionId,
        status: parsed.payload.status,
      };
      routineRecovery.transitions.push(routineRecovery.transition);
      routineRecovery.pendingActionId = null;
      routineRecovery.pendingOutcome = null;
    }
    lastSeq = parsed.seq;
    bytesKept += Buffer.byteLength(line, "utf8") + 1;
    if (parsed.seq > checkpointSeq) {
      recentEvents.push(parsed);
      if (recentEvents.length > contracts.MAX_RECENT_EVENTS_IN_CONTEXT) recentEvents.shift();
    }
    if (pageOptions && parsed.seq > pageOptions.since && events.length < MAX_EVENTS_PER_PAGE) {
      events.push(parsed);
    }
  }

  try {
    // A timeline query reads a fixed prefix even if another writer keeps
    // appending. It has the same validation as recovery, but never repairs
    // the journal or acquires its writer lock.
    const streamOptions = { encoding: "utf8", highWaterMark: 64 * 1024 };
    if (pageOptions) {
      const stat = await fh.stat();
      if (!stat.isFile() || stat.size > contracts.MAX_TASK_STORE_BYTES) {
        throw new TaskStoreError("storage_corrupt", "journal is not a bounded regular file");
      }
      if (stat.size === 0) return { events: [] };
      streamOptions.end = stat.size - 1;
    }
    const stream = fh.createReadStream(streamOptions);
    for await (const chunk of stream) {
      residual += chunk;
      let idx;
      while ((idx = residual.indexOf("\n")) !== -1) {
        const line = residual.slice(0, idx);
        residual = residual.slice(idx + 1);
        commitLine(line);
      }
      if (pageOptions && Buffer.byteLength(residual, "utf8") > contracts.MAX_EVENT_BYTES) {
        throw new TaskStoreError("storage_corrupt", "journal line exceeds the event size limit");
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

  if (!pageOptions && lastSeq === 0) {
    throw new TaskStoreError("storage_corrupt", "task journal has no complete goal_created event");
  }
  if (profileState === "awaiting_profile") {
      throw new TaskStoreError("profile_incomplete", "profile-required task is missing its initial task_profile_selected event");
  }
  if (routineRecovery && routineRecovery.pendingOutcome) routineRecovery.incomplete = true;
  if (routineRecovery) {
    delete routineRecovery.pendingActionId;
    delete routineRecovery.pendingOutcome;
  }
  return { nextSeq: lastSeq + 1, bytesKept, tornTailDropped, recentEvents, openActionId, events, routineRecovery, taskProfile };
}

// Shared body of TaskStore.create()/createChild(): both already resolved a
// safe, not-yet-existing directory for `id` (under tasks/ or under a
// parent's children/); this just materializes a brand-new store there.
async function createStoreInDir(taskDir, id, goalInput, storageRoot, onTiming, resolvedProfile = null, workGoalBinding = null) {
  await fsp.mkdir(taskDir, { recursive: false, mode: 0o700 });
  const lockPath = await acquireLock(taskDir);

  let store = null;
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

    store = new TaskStore({
      taskId: id,
      storageRoot,
      taskDir,
      lockPath,
      journalPath,
      goal,
      nextSeq: 1,
      totalBytes: 0,
      onTiming,
    });

    if (resolvedProfile) {
      const profilePayload = profileContracts.validateTaskProfileSelectedPayload({
        profileSchemaVersion: resolvedProfile.schemaVersion,
        classifierVersion: resolvedProfile.classifierVersion,
        ...(resolvedProfile.parentBinding ? { parentBinding: { ...resolvedProfile.parentBinding } } : {}),
        duration: {
          ...resolvedProfile.duration,
          effectiveLimits: { ...goal.limits },
        },
        capability: {
          ...resolvedProfile.capability,
          dependencies: [...resolvedProfile.capability.dependencies],
          adapters: resolvedProfile.capability.adapters.map((adapter) => ({ ...adapter })),
        },
        selection: {
          duration: { ...resolvedProfile.selection.duration },
          capability: { ...resolvedProfile.selection.capability },
        },
        ...(workGoalBinding ? { workGoalBinding: { ...workGoalBinding } } : {}),
      });
      await store.append({ type: "goal_created", payload: { goalVersion: 1, profileRequired: true }, goalVersion: 1 });
      await store.append({ type: "task_profile_selected", payload: profilePayload, goalVersion: 1 });
      store.taskProfile = freezeProfile(profilePayload);
    } else {
      await store.append({ type: "goal_created", payload: { goalVersion: 1 }, goalVersion: 1 });
    }
    store.recoveryReason = "created";
    return store;
  } catch (err) {
    if (store) await store.close().catch(() => {});
    else await releaseLock(lockPath);
    throw wrapContractError(err);
  }
}

// Shared body of TaskStore.load()/loadChild(): both already resolved the
// directory for `taskId` (under tasks/ or under a parent's children/); this
// just recovers a store from whatever is on disk there.
async function loadStoreFromDir(taskDir, taskId, storageRoot) {
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
    const { nextSeq, bytesKept, tornTailDropped, recentEvents, openActionId, routineRecovery, taskProfile } = await streamJournalReplay(
      journalPath,
      checkpointSeq,
      undefined,
      checkpoint?.payload?.routineRun || null,
      taskId,
    );

    if (taskProfile) {
      const initialGoalPath = path.join(taskDir, goalFileName(1));
      let initialGoal;
      try { initialGoal = contracts.validateGoalSpec(JSON.parse(await readFileNoFollow(initialGoalPath))); }
      catch (err) { throw new TaskStoreError("profile_corrupt", `initial goal required for profile validation is invalid: ${err.message}`); }
      if (JSON.stringify(taskProfile.duration.effectiveLimits) !== JSON.stringify(initialGoal.limits)) {
        throw new TaskStoreError("profile_corrupt", "profile effective limits differ from the initial normalized GoalSpec");
      }
    }

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
      storageRoot,
      taskDir,
      lockPath,
      journalPath,
      goal,
      nextSeq,
      totalBytes: bytesKept,
    });
    store.lastCheckpoint = checkpoint;
    store.eventsSinceCheckpoint = recentEvents;
    store.routineRecovery = routineRecovery;
    store.taskProfile = freezeProfile(taskProfile);
    store.recoveryReason = openActionId !== null ? "execution_uncertain" : "recovered";
    return store;
  } catch (err) {
    await releaseLock(lockPath);
    throw err;
  }
}

function eventCursor(options) {
  if (!contracts.isPlainObject(options) || Object.keys(options).some((key) => key !== "since")) {
    throw new TaskStoreError("invalid_field", "event options must contain only an optional since sequence");
  }
  const since = options.since === undefined ? 0 : options.since;
  if (!Number.isSafeInteger(since) || since < 0) {
    throw new TaskStoreError("invalid_field", "since must be a non-negative safe integer");
  }
  return since;
}

class TaskStore {
  constructor({ taskId, storageRoot, taskDir, lockPath, journalPath, goal, nextSeq, totalBytes, onTiming, taskProfile }) {
    this.taskId = taskId;
    this._storageRoot = storageRoot;
    this._taskDir = taskDir;
    this._lockPath = lockPath;
    this._journalPath = journalPath;
    this._goal = goal;
    this.taskProfile = freezeProfile(taskProfile);
    this._nextSeq = nextSeq;
    this._totalBytes = totalBytes;
    this._onTiming = typeof onTiming === "function" ? onTiming : null;
    this._writeBlocked = false;
    this._closed = false;
    // Perf: append() used to open+write+fsync+close the journal file on
    // EVERY event (4 syscalls plus a fresh fsync each time). The fsync
    // itself must stay per-append -- that is the durability guarantee
    // action_started-before-execute and fail-closed recovery both depend
    // on -- but the open/close pair does not need to happen every time.
    // This handle is opened lazily (see _openJournalFh()) on the first
    // append() so it is always opened AFTER load()'s torn-tail truncation
    // (which runs on its own short-lived fd before a TaskStore even
    // exists), never held open across a truncate.
    this._journalFh = null;
    // True when the journal fd has bytes written via appendFile() that have
    // not yet been handed to fsync() -- i.e. a non-durable append() (see
    // below) landed but nothing since has forced a sync. Cleared by any
    // durable append, and by _flushJournal() (called from checkpoint()/
    // close() so neither ever commits state built on a non-durable write
    // that isn't actually on disk yet).
    this._dirty = false;

    // append()'s critical section (seq assignment -> validate -> write ->
    // fsync -> _nextSeq/_totalBytes update) spans several await points. Two
    // append() calls issued without awaiting one before starting the next
    // would otherwise both read the same this._nextSeq before either had a
    // chance to advance it -- the very first await inside the critical
    // section (opening/writing the journal fd) yields control back to the
    // event loop, so a second, concurrently-issued call resumes synchronous
    // execution from the top and computes the SAME candidateSeq. That
    // produces a duplicate seq and, on replay, storage_corrupt. This chain
    // makes the critical section a strict FIFO queue: each append() call's
    // seq-assign-through-state-update runs to completion, in call order,
    // before the next one starts, regardless of how many callers overlap.
    this._appendChain = Promise.resolve();

    // Recovery metadata, set by load(); undefined on a freshly created store.
    this.lastCheckpoint = null;
    this.eventsSinceCheckpoint = [];
    this.recoveryReason = undefined;
  }

  getGoal() {
    return this._goal;
  }

  // Optional diagnostic timing sink used by local benchmarks. Names are a
  // fixed low-cardinality enum and samples contain durations only. Sink
  // errors are swallowed so observation never changes storage semantics.
  _recordTiming(operation, startedAt) {
    if (!this._onTiming || startedAt === null) return;
    try {
      this._onTiming({ operation, elapsedMs: Math.max(0, performance.now() - startedAt) });
    } catch {
      // Diagnostics must not change the result of a durable operation.
    }
  }

  async getEvents(options = {}) {
    const since = eventCursor(options);
    await this._appendChain;
    const { events = [] } = await streamJournalReplay(this._journalPath, 0, { since, taskId: this.taskId });
    return events;
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
    // Each goal version embeds every prior amendment, so repeated amendments
    // grow these immutable files quadratically. Applying the same task-store
    // cap here that append() already applies to journal bytes keeps the
    // store from exhausting disk while still reporting itself under its
    // limit.
    const goalJson = JSON.stringify(nextGoal);
    const goalBytes = Buffer.byteLength(goalJson, "utf8");
    if (this._totalBytes + goalBytes > contracts.MAX_TASK_STORE_BYTES) {
      throw new TaskStoreError("storage_limit", "amending this goal would exceed the task storage limit");
    }
    const filePath = path.join(this._taskDir, goalFileName(nextGoal.goalVersion));
    await writeFileDurable(filePath, goalJson, 0o600);
    await fsyncDir(this._taskDir);
    this._totalBytes += goalBytes;
    this._goal = nextGoal;

    await this.append({
      type: "goal_amended",
      payload: { goalVersion: nextGoal.goalVersion, amendmentId: nextGoal.amendments[nextGoal.amendments.length - 1].id },
      goalVersion: nextGoal.goalVersion,
    });
    return nextGoal;
  }

  // options.durable (default true) controls whether this specific event's
  // write is fsync'd before append() resolves. action_started must always
  // stay durable (the caller relies on it landing before execute() runs),
  // but a handful of hot-path events that a LATER durable write or
  // checkpoint()/close() is guaranteed to flush anyway (action_outcome,
  // evidence_recorded from the autonomous loop, approval_cancelled) can pass
  // { durable: false } to skip their own fsync and ride the next one --
  // sequential writes to the same fd land in program order, so a single
  // later fsync flushes every non-durable write queued ahead of it too.
  async append(input, options) {
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
    let durable = true;
    if (options !== undefined) {
      if (!contracts.isPlainObject(options) || Object.keys(options).some((key) => key !== "durable")) {
        throw new TaskStoreError("invalid_field", "append() options must contain only an optional durable boolean");
      }
      if (options.durable !== undefined) {
        if (typeof options.durable !== "boolean") {
          throw new TaskStoreError("invalid_field", "append() options.durable must be a boolean");
        }
        durable = options.durable;
      }
    }
    let inputSnapshot;
    try {
      // Work may queue behind an earlier fsync. Capture the caller-owned
      // object before yielding so the persisted event reflects the input at
      // invocation time, not any mutation that happens while it waits.
      inputSnapshot = structuredClone(input);
    } catch (err) {
      throw new TaskStoreError("invalid_event", `append() input cannot be snapshotted: ${err.message}`);
    }

    // Chain this call's critical section onto the tail synchronously (no
    // await between reading and reassigning this._appendChain), so the
    // order callers become queued in exactly matches the order append() was
    // actually invoked. The chain link always resolves (its own rejection
    // handled) so one caller's failure never wedges callers queued behind
    // it -- each caller instead observes success/failure via `result`,
    // which is this specific call's own outcome.
    const runOne = () => this._appendOne(inputSnapshot, durable);
    const result = this._appendChain.then(runOne, runOne);
    this._appendChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async _appendOne(input, durable) {
    // A call queued behind one that just failed must not silently write
    // past that failure.
    if (this._writeBlocked) {
      throw new TaskStoreError("journal_write_failed", "this task store's journal is blocked after a prior write failure");
    }

    const prepareStartedAt = this._onTiming ? performance.now() : null;
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
    this._recordTiming("journal_prepare", prepareStartedAt);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this._totalBytes + lineBytes > contracts.MAX_TASK_STORE_BYTES) {
      throw new TaskStoreError("storage_limit", "task store has reached its storage limit");
    }

    try {
      const fh = await this._openJournalFh();
      const appendStartedAt = this._onTiming ? performance.now() : null;
      try {
        await fh.appendFile(line, "utf8");
      } finally {
        this._recordTiming("journal_append_write", appendStartedAt);
      }
      if (durable) {
        const syncStartedAt = this._onTiming ? performance.now() : null;
        try {
          await fh.sync();
        } finally {
          this._recordTiming("journal_fsync", syncStartedAt);
        }
        this._dirty = false;
      } else {
        this._dirty = true;
      }
    } catch (err) {
      this._writeBlocked = true;
      throw new TaskStoreError("journal_write_failed", `journal append failed: ${err.message}`);
    }

    this._nextSeq = candidateSeq + 1;
    this._totalBytes += lineBytes;
    return validated;
  }

  // Flushes any journal bytes written by a non-durable append() that no
  // later durable append has flushed yet. A no-op when there is nothing
  // pending. Must run (and succeed) before ANY state derived from those
  // bytes is committed durably elsewhere -- checkpoint()'s criteriaStatus/
  // task snapshot and close()'s lock release both call this first, so
  // neither can persist a state that claims an event which never actually
  // reached disk.
  async _flushJournal() {
    if (!this._dirty || !this._journalFh) return;
    const syncStartedAt = this._onTiming ? performance.now() : null;
    try {
      await this._journalFh.sync();
      this._dirty = false;
    } catch (err) {
      this._writeBlocked = true;
      throw new TaskStoreError("journal_write_failed", `journal flush failed: ${err.message}`);
    } finally {
      this._recordTiming("journal_fsync", syncStartedAt);
    }
  }

  async checkpoint(payload) {
    this._assertOpen();
    if (!contracts.isPlainObject(payload)) {
      throw new TaskStoreError("invalid_field", "checkpoint() payload must be a plain object");
    }
    // Wait for any already-queued append() to finish (it may be the one
    // that just wrote the very state this checkpoint is about to snapshot),
    // then flush anything it left non-durable, BEFORE reading this._nextSeq
    // or building the envelope below -- never checkpoint state that is
    // ahead of what the journal can actually prove happened.
    await this._appendChain;
    if (this._writeBlocked) {
      throw new TaskStoreError("journal_write_failed", "this task store's journal is blocked after a prior write failure");
    }
    await this._flushJournal();

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
      const writeStartedAt = this._onTiming ? performance.now() : null;
      try {
        await fh.writeFile(JSON.stringify(validated), "utf8");
      } finally {
        this._recordTiming("checkpoint_file_write", writeStartedAt);
      }
      const syncStartedAt = this._onTiming ? performance.now() : null;
      try {
        await fh.sync();
      } finally {
        this._recordTiming("checkpoint_file_fsync", syncStartedAt);
      }
    } finally {
      await fh.close();
    }
    const renameStartedAt = this._onTiming ? performance.now() : null;
    try {
      await fsp.rename(tmpPath, finalPath);
    } finally {
      this._recordTiming("checkpoint_rename", renameStartedAt);
    }
    const dirSyncStartedAt = this._onTiming ? performance.now() : null;
    try {
      await fsyncDir(this._taskDir);
    } finally {
      this._recordTiming("checkpoint_directory_fsync", dirSyncStartedAt);
    }
    this.lastCheckpoint = validated;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    // Drain any append() calls already queued in the FIFO chain (invoked
    // before close() started) so they finish running against the
    // still-open handle instead of racing close()'s own fh.close() below.
    // _appendChain always resolves regardless of an individual append's
    // outcome (see append()/_appendOne()), so this never itself throws; a
    // NEW append() arriving after _closed is set above fails immediately at
    // _assertOpen() without ever reaching this chain.
    await this._appendChain;
    let flushError = null;
    if (this._journalFh) {
      try {
        // Same reason as checkpoint(): a non-durable append's bytes must be
        // forced to disk before this store gives up its exclusive lock,
        // otherwise a fresh TaskStore.load() elsewhere could observe a
        // journal missing an event this process believed had happened.
        await this._flushJournal();
      } catch (err) {
        flushError = err;
      }
      const fh = this._journalFh;
      this._journalFh = null;
      try {
        await fh.close();
      } catch {
        // Best-effort, matching releaseLock()'s existing pattern: a close
        // failure here must not prevent the lock release below.
      }
    }
    await releaseLock(this._lockPath);
    // Surfaced only after teardown completes -- the fd is closed and the
    // lock released either way (matching this file's other best-effort
    // teardown steps), but a flush failure means some already-"succeeded"
    // append() never actually reached disk, so the caller must still learn
    // about it rather than the failure being silently swallowed here.
    if (flushError) throw flushError;
  }

  // Opens the journal file handle on first use only. Always called after
  // load()'s torn-tail truncation has already run (that truncation uses its
  // own short-lived fd, before a TaskStore is even constructed), so this
  // handle never straddles a truncate.
  async _openJournalFh() {
    if (!this._journalFh) {
      this._journalFh = await fsp.open(
        this._journalPath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
        0o600,
      );
    }
    return this._journalFh;
  }

  _assertOpen() {
    if (this._closed) throw new TaskStoreError("closed", "this TaskStore instance is closed");
  }

  static async create(goalInput, { storageRoot, taskId, onTiming, resolvedProfile = null, workGoalBinding = null } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    if (onTiming !== undefined && typeof onTiming !== "function") {
      throw new TaskStoreError("invalid_field", "onTiming must be a function when provided");
    }
    if (resolvedProfile !== null) {
      try { profileContracts.validateResolvedTaskProfile(resolvedProfile); }
      catch (err) { throw wrapContractError(err); }
    }
    if (workGoalBinding !== null && resolvedProfile === null) {
      throw new TaskStoreError("invalid_binding", "Work Goal binding requires a resolved Task profile");
    }
    if (workGoalBinding !== null) {
      try { profileContracts.validateWorkGoalBinding(workGoalBinding); }
      catch (err) { throw wrapContractError(err); }
    }
    const id = taskId || crypto.randomUUID();
    if (!contracts.UUID_RE.test(id)) throw new TaskStoreError("invalid_task_id", "taskId must be a UUID");

    const root = path.resolve(storageRoot);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const { tasksRoot, taskDir } = await resolveTaskDir(root, id);
    await fsp.mkdir(tasksRoot, { recursive: true, mode: 0o700 }).catch(() => {});
    return createStoreInDir(taskDir, id, goalInput, root, onTiming, resolvedProfile, workGoalBinding);
  }

  // Multi-agent background runtime plan, Task 3: creates a CHILD task's own
  // store nested under its parent's directory (never under the top-level
  // tasks/ root -- see resolveChildDir()). Behaves exactly like a top-level
  // TaskStore afterwards (same append/checkpoint/close/getEvents); the only
  // difference is where it lives on disk and that ChildAgentCoordinator, not
  // TaskHost, owns its lifecycle.
  static async createChild(goalInput, { storageRoot, parentTaskId, childId, resolvedProfile = null } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    if (resolvedProfile !== null) {
      try { profileContracts.validateResolvedTaskProfile(resolvedProfile); }
      catch (err) { throw wrapContractError(err); }
      if (resolvedProfile.parentBinding?.parentTaskId !== parentTaskId) {
        throw new TaskStoreError("profile_binding_mismatch", "child profile parentTaskId does not match its parent directory");
      }
    }
    const { taskDir: parentTaskDir } = await resolveTaskDir(path.resolve(storageRoot), parentTaskId);
    const id = childId || crypto.randomUUID();
    if (!contracts.UUID_RE.test(id)) throw new TaskStoreError("invalid_task_id", "childId must be a UUID");
    const { childrenRoot, childDir } = await resolveChildDir(parentTaskDir, id);
    await fsp.mkdir(childrenRoot, { recursive: true, mode: 0o700 }).catch(() => {});
    return createStoreInDir(childDir, id, goalInput, path.resolve(storageRoot), undefined, resolvedProfile);
  }

  // listTasks() (Task 5's task-host.js) needs to enumerate saved tasks
  // without loading each one's full journal. Tolerates a storageRoot with
  // no tasks/ directory at all (a fresh install) and ignores any entry that
  // isn't a valid task UUID -- a stray file dropped next to the tasks dir
  // must never be treated as a task id.
  static async listTaskIds({ storageRoot } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    const tasksRoot = path.join(root, "tasks");
    let entries;
    try {
      entries = await fsp.readdir(tasksRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory() && contracts.UUID_RE.test(e.name)).map((e) => e.name);
  }

  static async readEvents(taskId, { storageRoot, parentTaskId } = {}, options = {}) {
    const since = eventCursor(options);
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    // Task 4: a child's journal lives under its parent's children/ dir, not
    // directly under tasks/ -- callers reading a CHILD's events (e.g.
    // ChildAgentCoordinator.verifyChildResult's evidence_recorded scan) pass
    // parentTaskId, exactly like loadChild() already requires for the same
    // reason.
    let taskDir;
    if (parentTaskId !== undefined && parentTaskId !== null) {
      const { taskDir: parentTaskDir } = await resolveTaskDir(root, parentTaskId);
      ({ childDir: taskDir } = await resolveChildDir(parentTaskDir, taskId));
    } else {
      ({ taskDir } = await resolveTaskDir(root, taskId));
    }
    try {
      const stat = await fsp.stat(taskDir);
      if (!stat.isDirectory()) throw new TaskStoreError("not_found", "task store is not a directory");
    } catch (error) {
      if (error.code === "ENOENT") throw new TaskStoreError("not_found", `no task store at ${taskDir}`);
      throw error;
    }
    const { events = [] } = await streamJournalReplay(path.join(taskDir, "events.jsonl"), 0, { since, taskId });
    return events;
  }

  static async load(taskId, { storageRoot } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    const { taskDir } = await resolveTaskDir(root, taskId);
    return loadStoreFromDir(taskDir, taskId, root);
  }

  // Multi-agent background runtime plan, Task 3: recovers a CHILD's store
  // from `<parent task dir>/children/<childId>`. A caller cannot reach a
  // child through TaskStore.load()/listTaskIds() at all -- there is no path
  // under storageRoot/tasks/ for a child id -- so this is the only way to
  // read one back, and it always requires the parentTaskId to do so.
  static async loadChild(childId, { storageRoot, parentTaskId } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    const { taskDir: parentTaskDir } = await resolveTaskDir(root, parentTaskId);
    const { childDir } = await resolveChildDir(parentTaskDir, childId);
    return loadStoreFromDir(childDir, childId, root);
  }

  // Best-effort teardown for ChildAgentCoordinator.acceptParentPlan()'s
  // partial-failure path: when one assignment in a child_plan fails after
  // earlier siblings already got their own on-disk store, this removes an
  // already-created child's directory so a half-formed plan never leaves
  // orphaned child stores behind. Reuses resolveChildDir's own symlink/escape
  // checks rather than duplicating them in the coordinator.
  static async removeChild(childId, { storageRoot, parentTaskId } = {}) {
    if (!storageRoot) throw new TaskStoreError("invalid_field", "storageRoot is required");
    const root = path.resolve(storageRoot);
    const { taskDir: parentTaskDir } = await resolveTaskDir(root, parentTaskId);
    const { childDir } = await resolveChildDir(parentTaskDir, childId);
    await fsp.rm(childDir, { recursive: true, force: true });
  }
}

module.exports = { TaskStore, TaskStoreError };
