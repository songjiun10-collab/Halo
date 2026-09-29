"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { resolveTaskProfile } = require("../shared/task-profile-router");
const {
  ContractError,
  normalizeGoalSpec,
  validateJournalEvent,
  MAX_EVENT_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
} = require("../shared/harness-contracts");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-taskstore-"));
}

test("create() writes an immutable goal-v1 and amendGoal() adds v2 alongside it", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "3페이지를 읽고 요약해줘" }, { storageRoot });
  const taskId = store.taskId;
  assert.equal(store.getGoal().originalRequest, "3페이지를 읽고 요약해줘");
  assert.equal(store.getGoal().goalVersion, 1);
  const v1Path = path.join(storageRoot, "tasks", taskId, "goal-v0001.json");
  const v1Before = await fs.readFile(v1Path, "utf8");

  const v2 = await store.amendGoal({
    text: "PDF는 제외해줘",
    newConstraints: [{ id: "no-pdf", text: "PDF 링크는 따라가지 않는다" }],
  });

  const v1After = await fs.readFile(v1Path, "utf8");
  assert.equal(v1After, v1Before);
  assert.equal(v2.goalVersion, 2);
  assert.equal(v2.originalRequest, "3페이지를 읽고 요약해줘");
  assert.equal(v2.amendments.length, 1);
  assert.equal(v2.amendments[0].text, "PDF는 제외해줘");
  assert.equal(v2.amendments[0].authority, "user");
  assert.equal(
    v2.constraints.some((c) => c.id === "no-pdf"),
    true,
  );

  const v2Path = path.join(storageRoot, "tasks", taskId, "goal-v0002.json");
  const v2OnDisk = JSON.parse(await fs.readFile(v2Path, "utf8"));
  assert.equal(v2OnDisk.goalVersion, 2);
  assert.equal(store.getGoal().goalVersion, 2);

  await store.close();
});

test("amendGoal() drops only the constraints named in supersedesConstraintIds", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create(
    { originalRequest: "goal", constraints: [{ id: "old", text: "이전 제약" }] },
    { storageRoot },
  );
  const v2 = await store.amendGoal({ text: "이전 제약을 대체", supersedesConstraintIds: ["old"] });
  assert.equal(
    v2.constraints.some((c) => c.id === "old"),
    false,
  );
  await store.close();
});

test("rejects a second writer while the first holds the task open", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  await assert.rejects(
    () => TaskStore.load(store.taskId, { storageRoot }),
    (err) => err.code === "writer_conflict",
  );

  await store.close();

  const reopened = await TaskStore.load(store.taskId, { storageRoot });
  assert.equal(reopened.taskId, store.taskId);
  await reopened.close();
});

test("a stale lock from a dead process is reclaimed", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.close();

  const lockPath = path.join(storageRoot, "tasks", taskId, "writer.lock");
  // A pid that (almost certainly) does not exist on this host.
  await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }), { mode: 0o600 });

  const reopened = await TaskStore.load(taskId, { storageRoot });
  await reopened.close();
});

test("rejects invalid taskId and an unknown goal schema version", async () => {
  const storageRoot = await mkTempRoot();
  await assert.rejects(
    () => TaskStore.load("../../etc/passwd", { storageRoot }),
    (err) => err.code === "invalid_task_id",
  );
  await assert.rejects(
    () => TaskStore.load("not-a-uuid", { storageRoot }),
    (err) => err.code === "invalid_task_id",
  );

  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.close();

  const v1Path = path.join(storageRoot, "tasks", taskId, "goal-v0001.json");
  const bad = JSON.parse(await fs.readFile(v1Path, "utf8"));
  bad.schemaVersion = 99;
  await fs.writeFile(v1Path, JSON.stringify(bad));

  await assert.rejects(
    () => TaskStore.load(taskId, { storageRoot }),
    (err) => err.code === "unknown_version",
  );
});

test("refuses to operate on a task directory that is a symlink", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.close();

  const realDir = path.join(storageRoot, "tasks", taskId);
  const decoyDir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-decoy-"));
  const asideDir = `${realDir}.aside`;
  await fs.rename(realDir, asideDir);
  await fs.symlink(decoyDir, realDir);

  await assert.rejects(
    () => TaskStore.load(taskId, { storageRoot }),
    (err) => err.code === "unsafe_path",
  );

  await fs.unlink(realDir);
  await fs.rename(asideDir, realDir);
  await fs.rm(decoyDir, { recursive: true, force: true });
});

test("replays only the events after the last checkpoint", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  await store.checkpoint({ note: "after a1" });
  await store.append({ type: "action_started", payload: { actionId: "a2" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a2", status: "ok" } });
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.lastCheckpoint.payload.note, "after a1");
  assert.equal(reopened.eventsSinceCheckpoint.length, 2);
  assert.equal(reopened.eventsSinceCheckpoint[0].payload.actionId, "a2");
  assert.equal(reopened.recoveryReason, "recovered");

  const appended = await reopened.append({ type: "note", payload: { msg: "continuing" } });
  assert.equal(appended.seq, 6); // 1:goal_created 2:started(a1) 3:outcome(a1) 4:started(a2) 5:outcome(a2)
  await reopened.close();
});

test("drops a torn last journal line left by a mid-write crash and keeps appending", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "note", payload: { msg: "first" } });
  const taskId = store.taskId;
  await store.close();

  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  await fs.appendFile(journalPath, '{"seq":2,"eventId":"broken', "utf8");

  const reopened = await TaskStore.load(taskId, { storageRoot });
  // seq1 is create()'s own goal_created event; seq2 is the "first" note.
  assert.equal(reopened.eventsSinceCheckpoint.length, 2);
  assert.equal(reopened.eventsSinceCheckpoint[1].payload.msg, "first");

  const appended = await reopened.append({ type: "note", payload: { msg: "second" } });
  assert.equal(appended.seq, 3);
  await reopened.close();

  const finalRaw = await fs.readFile(journalPath, "utf8");
  const lines = finalRaw.trim().split("\n");
  assert.equal(lines.length, 3);
  lines.forEach((line) => JSON.parse(line));
});

test("refuses to load when a non-tail journal line is corrupt", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "note", payload: { msg: "first" } });
  await store.append({ type: "note", payload: { msg: "second" } });
  const taskId = store.taskId;
  await store.close();

  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  const raw = await fs.readFile(journalPath, "utf8");
  const lines = raw.trim().split("\n");
  lines[0] = "{not-json-at-all";
  await fs.writeFile(journalPath, `${lines.join("\n")}\n`, "utf8");

  await assert.rejects(
    () => TaskStore.load(taskId, { storageRoot }),
    (err) => err.code === "storage_corrupt",
  );
});

test("a journal write failure blocks all further appends on this store instance", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  // append() keeps one journal file handle open for the store's lifetime
  // (opened lazily on the first append -- create() above already triggered
  // that via its own internal goal_created append) instead of reopening the
  // path on every call, so a path-level failure injection (deleting the file,
  // swapping in a directory) no longer reaches it: an already-open fd keeps
  // writing to its original inode regardless of what the path now points to.
  // Closing that fd out from under the store simulates a real I/O failure
  // (a revoked descriptor, disk error) that the next write will hit instead.
  assert.ok(store._journalFh, "journal handle should already be open after create()'s internal append");
  await store._journalFh.close();

  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "x" } }),
    (err) => err.code === "journal_write_failed",
  );

  // Still blocked even though nothing else is wrong -- a failed writer must
  // not silently start accepting actions again.
  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "y" } }),
    (err) => err.code === "journal_write_failed",
  );
});

test("close() releases the persistent journal handle and is idempotent", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "note", payload: { msg: "first" } });
  assert.ok(store._journalFh, "journal handle should be open after at least one append");

  await store.close();
  assert.equal(store._journalFh, null);

  // Idempotent: closing an already-closed store must not throw or attempt
  // to close the (already-cleared) handle a second time.
  await store.close();
});

test("a persistent journal handle still produces a correctly ordered, fully readable-back journal", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const openedFh = store._journalFh;
  for (let i = 0; i < 5; i++) {
    await store.append({ type: "note", payload: { i } });
    // The same handle is reused across every append -- no reopen per call.
    assert.equal(store._journalFh, openedFh);
  }
  const taskId = store.taskId;
  await store.close();

  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  const raw = await fs.readFile(journalPath, "utf8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 6); // 1 goal_created + 5 notes
  lines.forEach((line, idx) => assert.equal(line.seq, idx + 1));
  assert.deepEqual(
    lines.slice(1).map((line) => line.payload.i),
    [0, 1, 2, 3, 4],
  );
});

test("concurrent append() calls (no await between them) still get unique, gapless seq numbers and replay cleanly", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  // Fire N appends without awaiting one before starting the next -- exactly
  // the pattern that raced before the append chain existed: each call would
  // read the same this._nextSeq before the first call's journal write had a
  // chance to advance it, producing a duplicate seq and, on reload,
  // storage_corrupt.
  const CONCURRENT_COUNT = 20;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_COUNT }, (_, i) => store.append({ type: "note", payload: { i } })),
  );

  const seqs = results.map((r) => r.seq);
  const uniqueSeqs = new Set(seqs);
  assert.equal(uniqueSeqs.size, CONCURRENT_COUNT, "every concurrent append must get a distinct seq");
  const sorted = [...seqs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i], sorted[i - 1] + 1, "seq numbers must be gapless");
  }

  const taskId = store.taskId;
  await store.close();

  // The real proof: the journal on disk must replay without storage_corrupt
  // (streamJournalReplay throws on any out-of-order or duplicate seq), and
  // every one of the CONCURRENT_COUNT payloads must actually be present.
  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  const raw = await fs.readFile(journalPath, "utf8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1 + CONCURRENT_COUNT); // 1 goal_created + N notes
  lines.forEach((line, idx) => assert.equal(line.seq, idx + 1));
  const notePayloads = lines.slice(1).map((line) => line.payload.i).sort((a, b) => a - b);
  assert.deepEqual(notePayloads, Array.from({ length: CONCURRENT_COUNT }, (_, i) => i));

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  await reopened.close();
});

test("append() snapshots caller payload before its queued write runs", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const payload = { msg: "at invocation" };

  const pending = store.append({ type: "note", payload });
  payload.msg = "mutated before queued append ran";
  await pending;

  const taskId = store.taskId;
  await store.close();
  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.eventsSinceCheckpoint.at(-1).payload.msg, "at invocation");
  await reopened.close();
});

test("a mid-batch write failure blocks concurrently-queued appends behind it, not just later calls", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  // Break the shared journal handle first (fully awaited, so it is
  // deterministically broken before any of the concurrent appends below
  // start their own critical section), then fire several appends
  // concurrently in one batch. The first to run the chain hits the break
  // and sets _writeBlocked; every append already queued behind it in the
  // same batch must also fail, not silently succeed past the failure or
  // reopen a fresh handle.
  await store._journalFh.close();

  const calls = Array.from({ length: 5 }, (_, i) => store.append({ type: "note", payload: { i } }));
  const outcomes = await Promise.allSettled(calls);
  assert.ok(
    outcomes.every((o) => o.status === "rejected" && o.reason.code === "journal_write_failed"),
    "every queued append must fail once the shared journal handle is broken",
  );
  assert.equal(store.isWriteBlocked(), true);
});

test("close() drains any already-queued append() calls before closing the persistent journal handle", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  // Fire several appends without awaiting any of them, then close()
  // immediately -- also without awaiting the appends first. This is exactly
  // the race close() must handle: appends already queued in the FIFO chain
  // must finish running against the still-open handle before close() closes
  // it out from under them, not fail or get silently dropped.
  const pending = Array.from({ length: 5 }, (_, i) => store.append({ type: "note", payload: { i } }));
  const closePromise = store.close();

  const results = await Promise.all(pending);
  await closePromise;

  assert.equal(store._journalFh, null);
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [2, 3, 4, 5, 6]); // seq 1 is create()'s own goal_created

  const taskId = store.taskId;
  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  assert.equal(reopened.eventsSinceCheckpoint.length, 6);
  await reopened.close();
});

test("close() rejects a brand-new append() immediately instead of queuing it behind the drain", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  const closePromise = store.close();
  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "too late" } }),
    (err) => err.code === "closed",
  );
  await closePromise;
});

test("recovers as execution_uncertain when an action_started has no matching outcome", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "execution_uncertain");
  await reopened.close();
});

test("a completed action_started/action_outcome pair recovers as recovered, not uncertain", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  await reopened.close();
});

test("append() rejects a caller-assigned seq/eventId/taskId/at", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await assert.rejects(() => store.append({ type: "note", payload: {}, seq: 999 }), (err) => err.code === "invalid_event");
  await store.close();
});

test("harness-contracts rejects unknown fields and unknown enums", () => {
  assert.throws(
    () =>
      normalizeGoalSpec(
        { originalRequest: "x", bogus: 1 },
        { taskId: "11111111-1111-1111-1111-111111111111", goalVersion: 1, createdAt: new Date().toISOString() },
      ),
    (err) => err instanceof ContractError && err.code === "unknown_field",
  );

  assert.throws(
    () =>
      validateJournalEvent({
        seq: 1,
        eventId: "11111111-1111-1111-1111-111111111111",
        taskId: "11111111-1111-1111-1111-111111111111",
        goalVersion: 1,
        type: "not_a_real_type",
        payload: {},
        at: new Date().toISOString(),
      }),
    (err) => err.code === "unknown_enum",
  );
});

test("eventsSinceCheckpoint is capped at the most recent 10 events, never the whole journal since checkpoint", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  for (let i = 0; i < 15; i++) {
    await store.append({ type: "note", payload: { i } });
  }
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  // 1 goal_created + 15 notes = 16 events total, no checkpoint was ever
  // written, but the store must never hand back more than the last 10.
  assert.equal(reopened.eventsSinceCheckpoint.length, 10);
  assert.equal(reopened.eventsSinceCheckpoint[0].payload.i, 5); // the oldest of the kept 10
  assert.equal(reopened.eventsSinceCheckpoint[9].payload.i, 14); // the most recent
  await reopened.close();
});

test("routine recovery summary retains advancement beyond the 10-event context ring", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "routine recovery" }, { storageRoot });
  const routineId = "11111111-1111-4111-8111-111111111111";
  const routineRun = { routineId, revision: 1, digest: "a".repeat(64), cursor: 0 };
  await store.checkpoint({ task: { state: "paused", pauseReason: "recovered" }, routineRun });
  const actionId = "action-1";
  await store.append({ type: "action_started", payload: { actionId } });
  await store.append({ type: "action_outcome", payload: { actionId, status: "ok" } }, { durable: false });
  await store.append({
    type: "routine_step_advanced",
    payload: { routineId, revision: 1, stepIndex: 0, stepDigest: "b".repeat(64), actionId },
  });
  for (let i = 0; i < 12; i += 1) await store.append({ type: "note", payload: { i } });
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.eventsSinceCheckpoint.length, 10);
  assert.equal(reopened.routineRecovery.cursor, 1);
  assert.equal(reopened.routineRecovery.incomplete, false);
  assert.equal(reopened.routineRecovery.blocked, null);
  assert.deepEqual(reopened.routineRecovery.transition, {
    type: "advanced",
    stepIndex: 0,
    stepDigest: "b".repeat(64),
    actionId,
  });
  await reopened.close();
});

test("routine recovery summary marks successful action outcome without advancement as incomplete", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "routine incomplete" }, { storageRoot });
  await store.checkpoint({
    task: { state: "paused", pauseReason: "recovered" },
    routineRun: { routineId: "22222222-2222-4222-8222-222222222222", revision: 1, digest: "a".repeat(64), cursor: 0 },
  });
  await store.append({ type: "action_started", payload: { actionId: "action-1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "action-1", status: "ok" } });
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.routineRecovery.incomplete, true);
  assert.equal(reopened.routineRecovery.cursor, 0);
  await reopened.close();
});

test("routine recovery replays consecutive advancements written without an intervening checkpoint", async () => {
  const storageRoot = await mkTempRoot();
  const routineId = "33333333-3333-4333-8333-333333333333";
  const store = await TaskStore.create({ originalRequest: "routine consecutive advancements" }, { storageRoot });
  await store.checkpoint({
    task: { state: "paused", pauseReason: "recovered" },
    routineRun: { routineId, revision: 1, digest: "a".repeat(64), cursor: 0 },
  });
  for (let index = 0; index < 3; index += 1) {
    const actionId = `action-${index}`;
    await store.append({ type: "action_started", payload: { actionId } });
    await store.append({ type: "action_outcome", payload: { actionId, status: "ok" } }, { durable: false });
    await store.append({ type: "routine_step_advanced", payload: {
      routineId, revision: 1, stepIndex: index, stepDigest: String(index).repeat(64), actionId,
    } });
  }
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.routineRecovery.cursor, 3);
  assert.equal(reopened.routineRecovery.incomplete, false);
  assert.deepEqual(reopened.routineRecovery.transitions.map((entry) => entry.stepIndex), [0, 1, 2]);
  assert.equal(reopened.routineRecovery.transition.stepIndex, 2);
  await reopened.close();
});

test("routine recovery rejects any transition that follows a blocked-step decision without a checkpoint", async () => {
  const storageRoot = await mkTempRoot();
  const routineId = "44444444-4444-4444-8444-444444444444";
  const store = await TaskStore.create({ originalRequest: "routine transition after denial" }, { storageRoot });
  await store.checkpoint({
    task: { state: "paused", pauseReason: "recovered" },
    routineRun: { routineId, revision: 1, digest: "a".repeat(64), cursor: 0 },
  });
  await store.append({ type: "routine_step_denied", payload: {
    routineId, revision: 1, stepIndex: 0, stepDigest: "0".repeat(64), decision: "deny", reasons: ["blocked"],
  } });
  await store.append({ type: "action_started", payload: { actionId: "action-0" } });
  const taskId = store.taskId;
  await store.close();
  await assert.rejects(TaskStore.load(taskId, { storageRoot }), (error) => error.code === "storage_corrupt");
});

test("routine recovery rejects malformed pinned checkpoint metadata", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "bad routine checkpoint" }, { storageRoot });
  await store.checkpoint({
    task: { state: "paused", pauseReason: "recovered" },
    routineRun: { routineId: "not-a-uuid", revision: 0, digest: "A".repeat(64), cursor: -1 },
  });
  const taskId = store.taskId;
  await store.close();
  await assert.rejects(TaskStore.load(taskId, { storageRoot }), (error) => error.code === "storage_corrupt");
});

test("a large journal replays via bounded streaming, not a full in-memory array (functional smoke test)", async () => {
  // This proves the replay path scales structurally (no O(n) array of
  // parsed events survives replay) and stays correct at scale; it is not a
  // real RSS measurement -- see docs/superpowers/specs/2026-09-27-long-
  // horizon-browser-harness-design.md section 10 for that separate evidence.
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const actionCount = 300; // far larger than the bounded ring (10); kept modest so the real per-append fsync stays fast
  for (let i = 0; i < actionCount; i++) {
    await store.append({ type: "action_started", payload: { actionId: `a${i}` } });
    await store.append({ type: "action_outcome", payload: { actionId: `a${i}`, status: "ok" } });
  }
  const taskId = store.taskId;
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  assert.ok(reopened.eventsSinceCheckpoint.length <= 10);
  const appended = await reopened.append({ type: "note", payload: { msg: "still going" } });
  assert.equal(appended.seq, 1 + actionCount * 2 + 1);
  await reopened.close();
});

test("refuses to load a journal where a second action_started overlaps one still open (violates one-in-flight)", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_started", payload: { actionId: "a2" } }); // no outcome for a1 first
  const taskId = store.taskId;
  await store.close();

  await assert.rejects(
    () => TaskStore.load(taskId, { storageRoot }),
    (err) => err.code === "storage_corrupt",
  );
});

test("refuses to load a journal where an action_outcome does not match the open action", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a2", status: "ok" } }); // wrong id
  const taskId = store.taskId;
  await store.close();

  await assert.rejects(
    () => TaskStore.load(taskId, { storageRoot }),
    (err) => err.code === "storage_corrupt",
  );
});

test("harness-contracts rejects an oversized journal event", () => {
  const bigPayload = { blob: "x".repeat(MAX_EVENT_BYTES) };
  assert.throws(
    () =>
      validateJournalEvent({
        seq: 1,
        eventId: "11111111-1111-1111-1111-111111111111",
        taskId: "11111111-1111-1111-1111-111111111111",
        goalVersion: 1,
        type: "note",
        payload: bigPayload,
        at: new Date().toISOString(),
      }),
    (err) => err.code === "event_too_large",
  );
});

// --- Subagent communication protocol Task 1: message_sent/message_turn_consumed
// journal events (spec: docs/superpowers/specs/2026-09-28-subagent-communication-protocol-design.md
// section 6/7). Only envelope SHAPE is validated here; sender/recipient
// authentication and direction are the coordinator's job (Task 4).

const MSG_PARENT_TASK_ID = "11111111-1111-1111-1111-111111111111";
const MSG_CHILD_TASK_ID = "22222222-2222-2222-2222-222222222222";

function baseEvent(overrides = {}) {
  return {
    seq: 1,
    eventId: "11111111-1111-1111-1111-111111111111",
    taskId: "11111111-1111-1111-1111-111111111111",
    goalVersion: 1,
    at: new Date().toISOString(),
    ...overrides,
  };
}

function messageEnvelope(overrides = {}) {
  return {
    messageId: "msg-1",
    conversationId: "conv-1",
    parentTaskId: MSG_PARENT_TASK_ID,
    childTaskId: MSG_CHILD_TASK_ID,
    senderTaskId: MSG_PARENT_TASK_ID,
    recipientTaskId: MSG_CHILD_TASK_ID,
    parentGoalVersion: 1,
    kind: "progress",
    idempotencyKey: "idem-1",
    text: "hello",
    ...overrides,
  };
}

test("append() accepts a well-formed message_sent event and a well-formed message_turn_consumed event, and both replay back", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;

  await store.append({ type: "message_sent", payload: messageEnvelope() });
  await store.append({
    type: "message_turn_consumed",
    payload: { consumedMessageIds: ["msg-1"], observedAtPlannerCall: 3 },
  });
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  const types = reopened.eventsSinceCheckpoint.map((e) => e.type);
  assert.ok(types.includes("message_sent"));
  assert.ok(types.includes("message_turn_consumed"));
  await reopened.close();
});

test("validateJournalEvent rejects a message_sent payload with an unknown field or an unknown message kind", () => {
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_sent", payload: messageEnvelope({ bogus: 1 }) })),
    (err) => err instanceof ContractError && err.code === "unknown_field",
  );
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_sent", payload: messageEnvelope({ kind: "not_a_real_kind" }) })),
    (err) => err instanceof ContractError && err.code === "unknown_enum",
  );
});

test("validateJournalEvent enforces the 8 KiB UTF-8 message text boundary", () => {
  const atBoundary = "a".repeat(MAX_MESSAGE_TEXT_BYTES);
  assert.doesNotThrow(() => validateJournalEvent(baseEvent({ type: "message_sent", payload: messageEnvelope({ text: atBoundary }) })));

  const overBoundary = "a".repeat(MAX_MESSAGE_TEXT_BYTES + 1);
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_sent", payload: messageEnvelope({ text: overBoundary }) })),
    (err) => err instanceof ContractError && err.code === "field_too_large",
  );
});

test("validateJournalEvent rejects a message_sent envelope mixing text and handoff, or a handoff kind with neither", () => {
  const handoff = {
    objective: "obj",
    currentState: "state",
    verifiedResults: [],
    unresolved: [],
    risks: [],
    suggestedNextAction: "next",
  };
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_sent", payload: messageEnvelope({ kind: "handoff", text: "should not coexist", handoff }) })),
    (err) => err instanceof ContractError && err.code === "invalid_field",
  );
  assert.doesNotThrow(() => {
    const p = messageEnvelope({ kind: "handoff", handoff });
    delete p.text;
    validateJournalEvent(baseEvent({ type: "message_sent", payload: p }));
  });
});

test("validateJournalEvent rejects message_turn_consumed with an empty, duplicate, or invalid consumedMessageIds", () => {
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_turn_consumed", payload: { consumedMessageIds: [] } })),
    (err) => err instanceof ContractError && err.code === "invalid_field",
  );
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_turn_consumed", payload: { consumedMessageIds: ["msg-1", "msg-1"] } })),
    (err) => err instanceof ContractError && err.code === "invalid_field",
  );
  assert.throws(
    () => validateJournalEvent(baseEvent({ type: "message_turn_consumed", payload: { consumedMessageIds: ["not a valid id!"] } })),
    (err) => err instanceof ContractError && err.code === "invalid_id",
  );
  assert.doesNotThrow(() =>
    validateJournalEvent(baseEvent({ type: "message_turn_consumed", payload: { consumedMessageIds: ["msg-1", "msg-2"] } })),
  );
});

// --- Task 5: listTaskIds() -- the enumeration listTasks()'s IPC handler
// needs (main/harness/task-host.js). Must return only real task
// directories, tolerate a storageRoot with no tasks/ directory yet at all
// (a fresh install), and never include anything that isn't a valid task
// UUID (e.g. stray files someone dropped next to the tasks dir).

test("listTaskIds() lists every created task's id", async () => {
  const storageRoot = await mkTempRoot();
  const a = await TaskStore.create({ originalRequest: "a" }, { storageRoot });
  const b = await TaskStore.create({ originalRequest: "b" }, { storageRoot });
  await a.close();
  await b.close();

  const ids = await TaskStore.listTaskIds({ storageRoot });

  assert.deepEqual(ids.sort(), [a.taskId, b.taskId].sort());
});

test("listTaskIds() returns an empty array when no task has ever been created", async () => {
  const storageRoot = await mkTempRoot();
  const ids = await TaskStore.listTaskIds({ storageRoot });
  assert.deepEqual(ids, []);
});

test("listTaskIds() ignores non-UUID entries under the tasks directory", async () => {
  const storageRoot = await mkTempRoot();
  const a = await TaskStore.create({ originalRequest: "a" }, { storageRoot });
  await a.close();
  await fs.mkdir(path.join(storageRoot, "tasks", "not-a-task-uuid"));
  await fs.writeFile(path.join(storageRoot, "tasks", "stray-file.txt"), "hello");

  const ids = await TaskStore.listTaskIds({ storageRoot });

  assert.deepEqual(ids, [a.taskId]);
});

// --- append({ durable: false }): the checkpoint/journal fsync-coalescing
// optimization (chat 2026-09-28, Codex's 100-step wall-time profiling).
// Wraps store._journalFh.sync directly (same white-box access already used
// above by "a journal write failure blocks..." and friends) so these tests
// observe the REAL fsync call boundary, not just the in-memory _dirty flag.

function spyOnJournalSync(store) {
  const calls = [];
  const original = store._journalFh.sync.bind(store._journalFh);
  store._journalFh.sync = async () => {
    calls.push(Date.now());
    return original();
  };
  return calls;
}

test("append() rejects a non-boolean or unknown options field", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await assert.rejects(
    () => store.append({ type: "note", payload: {} }, { durable: "yes" }),
    (err) => err.code === "invalid_field",
  );
  await assert.rejects(
    () => store.append({ type: "note", payload: {} }, { durable: true, extra: 1 }),
    (err) => err.code === "invalid_field",
  );
  await store.close();
});

test("a durable:false append does not fsync; the next durable append's single fsync flushes both", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const syncCalls = spyOnJournalSync(store);

  await store.append({ type: "note", payload: { msg: "non-durable" } }, { durable: false });
  assert.equal(syncCalls.length, 0, "durable:false must not call fsync on its own");
  assert.equal(store._dirty, true);

  await store.append({ type: "note", payload: { msg: "durable" } });
  assert.equal(syncCalls.length, 1, "the following durable append must fsync exactly once for both lines");
  assert.equal(store._dirty, false);

  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");
  const lines = (await fs.readFile(journalPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3); // goal_created + the two notes above
  await store.close();
});

test("checkpoint() flushes a pending non-durable append before writing checkpoint.json", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const syncCalls = spyOnJournalSync(store);

  await store.append({ type: "note", payload: { msg: "pending" } }, { durable: false });
  assert.equal(syncCalls.length, 0);

  await store.checkpoint({ task: { state: "paused" } });
  assert.equal(syncCalls.length, 1, "checkpoint() must fsync the dirty journal itself");
  assert.equal(store._dirty, false);

  // Prove the flush actually happened BEFORE the checkpoint file landed, not
  // just that both eventually happened: read the journal from a fresh fd
  // (bypassing the store entirely) and confirm the pending line is there.
  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");
  const lines = (await fs.readFile(journalPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2); // goal_created + the pending note
  assert.equal(JSON.parse(lines[1]).payload.msg, "pending");

  await store.close();
});

test("TaskStore timing observer separates journal writes, fsync, and checkpoint phases without affecting storage", async () => {
  const storageRoot = await mkTempRoot();
  const timings = [];
  const store = await TaskStore.create({ originalRequest: "timing" }, {
    storageRoot,
    onTiming: (sample) => timings.push(sample),
  });
  await store.append({ type: "note", payload: { marker: "timed" } });
  await store.checkpoint({ task: { state: "paused", pauseReason: "test" } });
  const taskId = store.taskId;
  await store.close();

  const operations = timings.map((sample) => sample.operation);
  for (const expected of [
    "journal_prepare", "journal_append_write", "journal_fsync",
    "checkpoint_file_write", "checkpoint_file_fsync", "checkpoint_rename", "checkpoint_directory_fsync",
  ]) assert.ok(operations.includes(expected), `missing timing for ${expected}`);
  assert.ok(timings.every((sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0));

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.ok(reopened.lastCheckpoint);
  assert.ok((await reopened.getEvents()).some((event) => event.type === "note" && event.payload.marker === "timed"));
  await reopened.close();
});

test("TaskStore timing observer failures cannot change append or checkpoint outcomes", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "timing observer failure" }, {
    storageRoot,
    onTiming: () => { throw new Error("telemetry failure"); },
  });
  await store.append({ type: "note", payload: { marker: "still-written" } });
  await store.checkpoint({ task: { state: "paused", pauseReason: "test" } });
  assert.ok(store.lastCheckpoint);
  await store.close();
});

test("checkpoint() does not write checkpoint.json when the pre-checkpoint flush fails, and blocks the store", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await store.append({ type: "note", payload: { msg: "pending" } }, { durable: false });
  store._journalFh.sync = async () => {
    throw new Error("simulated fsync failure");
  };

  await assert.rejects(
    () => store.checkpoint({ task: { state: "paused" } }),
    (err) => err.code === "journal_write_failed",
  );
  assert.equal(store._writeBlocked, true);

  const checkpointPath = path.join(storageRoot, "tasks", store.taskId, "checkpoint.json");
  await assert.rejects(() => fs.stat(checkpointPath), (err) => err.code === "ENOENT");

  // The store must stay refused for both kinds of write from here on.
  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "x" } }),
    (err) => err.code === "journal_write_failed",
  );
  await assert.rejects(
    () => store.checkpoint({ task: { state: "paused" } }),
    (err) => err.code === "journal_write_failed",
  );
});

test("checkpoint() waits for an already-queued append before snapshotting, and flushes it", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });

  // No await between these two calls: append() is still queued in
  // _appendChain when checkpoint() starts, exercising the "await
  // this._appendChain" ordering guard rather than just the already-settled
  // case the tests above cover.
  const appendPromise = store.append({ type: "note", payload: { msg: "racing" } }, { durable: false });
  const checkpointPromise = store.checkpoint({ task: { state: "paused" } });
  await Promise.all([appendPromise, checkpointPromise]);

  assert.equal(store._dirty, false);
  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");
  const lines = (await fs.readFile(journalPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).payload.msg, "racing");

  await store.close();
});

test("close() flushes a pending non-durable append to disk before releasing the writer lock", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  const syncCalls = spyOnJournalSync(store);

  await store.append({ type: "note", payload: { msg: "pending" } }, { durable: false });
  assert.equal(syncCalls.length, 0);
  await store.close();
  assert.equal(syncCalls.length, 1, "close() must fsync a dirty journal before giving up the lock");

  // A fresh load() (which would fail with writer_conflict if the lock had
  // not truly been released) sees the pending line without needing any
  // torn-tail repair, proving it was durably written, not just buffered.
  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  assert.equal(reopened.eventsSinceCheckpoint.at(-1).payload.msg, "pending");
  await reopened.close();
});

test("close() propagates a flush failure but still releases the lock and closes the fd", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.append({ type: "note", payload: { msg: "pending" } }, { durable: false });
  store._journalFh.sync = async () => {
    throw new Error("simulated fsync failure");
  };

  await assert.rejects(() => store.close(), (err) => err.code === "journal_write_failed");

  // Teardown still completed: the lock is gone, so a fresh load() succeeds
  // instead of rejecting with writer_conflict.
  const reopened = await TaskStore.load(taskId, { storageRoot });
  await reopened.close();
});

test("a non-durable action_outcome that a following checkpoint flushes still recovers as 'recovered', not execution_uncertain", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } }, { durable: false });
  await store.checkpoint({ task: { state: "paused" } });
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "recovered");
  await reopened.close();
});

test("a non-durable action_outcome genuinely lost before any flush still recovers as execution_uncertain (fail-closed, unchanged)", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  const taskId = store.taskId;
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } }, { durable: false });
  await store.close(); // real close() flushes it -- now simulate that flush never having happened.

  // A crash strictly before that flush leaves exactly this on disk: the
  // durable action_started line, nothing past it. Truncating post-close is
  // the same technique the existing torn-tail/execution_uncertain tests
  // above already use to model "what a crash leaves behind", just applied
  // to a durable:false write instead of an in-flight one.
  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  const beforeOutcome = (await fs.readFile(journalPath, "utf8")).split("\n").slice(0, 2).join("\n") + "\n";
  await fs.writeFile(journalPath, beforeOutcome, "utf8");

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.recoveryReason, "execution_uncertain");
  await reopened.close();
});

// --- Task 3 (multi-agent background runtime plan): child stores.
// A child's TaskStore must live under its PARENT's own directory
// (children/<childId>), never under the top-level tasks/ root -- this is
// what keeps children structurally invisible to listTaskIds()/load() without
// any extra filtering logic.

test("createChild() creates a store nested under the parent's directory, not under tasks/", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });

  const child = await TaskStore.createChild({ originalRequest: "child subgoal" }, { storageRoot, parentTaskId: parent.taskId });

  assert.equal(child.getGoal().originalRequest, "child subgoal");
  const childDirExists = await fs
    .stat(path.join(storageRoot, "tasks", parent.taskId, "children", child.taskId))
    .then(() => true);
  assert.equal(childDirExists, true);
  await assert.rejects(fs.stat(path.join(storageRoot, "tasks", child.taskId)), { code: "ENOENT" });

  await child.close();
  await parent.close();
});

test("a child's id never appears in listTaskIds()", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const child = await TaskStore.createChild({ originalRequest: "child subgoal" }, { storageRoot, parentTaskId: parent.taskId });
  await child.close();

  const ids = await TaskStore.listTaskIds({ storageRoot });

  assert.deepEqual(ids, [parent.taskId]);
  await parent.close();
});

test("TaskStore.load() (the top-level path) rejects a childId with not_found", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const child = await TaskStore.createChild({ originalRequest: "child subgoal" }, { storageRoot, parentTaskId: parent.taskId });
  await child.close();

  await assert.rejects(TaskStore.load(child.taskId, { storageRoot }), { code: "not_found" });
  await parent.close();
});

test("loadChild() recovers a closed child store given its parentTaskId", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const child = await TaskStore.createChild({ originalRequest: "child subgoal" }, { storageRoot, parentTaskId: parent.taskId });
  const childId = child.taskId;
  await child.append({ type: "note", payload: { text: "child note" } });
  await child.close();

  const reopened = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
  assert.equal(reopened.taskId, childId);
  assert.equal(reopened.getGoal().originalRequest, "child subgoal");
  await reopened.close();
  await parent.close();
});

test("loadChild() rejects a childId that was never created under that parent", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });

  await assert.rejects(
    TaskStore.loadChild("00000000-0000-4000-8000-000000000000", { storageRoot, parentTaskId: parent.taskId }),
    { code: "not_found" },
  );
  await parent.close();
});

test("removeChild() deletes a created child's directory so it no longer loads", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const child = await TaskStore.createChild({ originalRequest: "child subgoal" }, { storageRoot, parentTaskId: parent.taskId });
  const childId = child.taskId;
  await child.close();

  await TaskStore.removeChild(childId, { storageRoot, parentTaskId: parent.taskId });

  await assert.rejects(TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId }), { code: "not_found" });
  await parent.close();
});

function profileFor(goalInput, capability = "browser") {
  return resolveTaskProfile({
    goalInput,
    ...(capability === "browser" ? {} : { requestedCapabilityProfile: capability }),
  });
}

test("profile-required create writes goal_created then one durable profile and reloads the same selection", async () => {
  const storageRoot = await mkTempRoot();
  const goal = { originalRequest: "inspect the page" };
  const resolvedProfile = profileFor(goal);
  const store = await TaskStore.create(goal, { storageRoot, resolvedProfile });
  const taskId = store.taskId;
  const events = await store.getEvents();

  assert.deepEqual(events.map((event) => event.type), ["goal_created", "task_profile_selected"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(events[0].payload, { goalVersion: 1, profileRequired: true });
  assert.deepEqual(events[1].payload.duration.effectiveLimits, store.getGoal().limits);
  assert.deepEqual(store.taskProfile.selection, resolvedProfile.selection);
  await store.close();

  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.deepEqual(reopened.taskProfile, events[1].payload);
  await reopened.close();
});

test("profile-required child store binds its parent, plan, and independently selected Browser route", async () => {
  const storageRoot = await mkTempRoot();
  const parentGoal = { originalRequest: "delegate to agents" };
  const parentProfile = profileFor(parentGoal, "multi_agent");
  const parent = await TaskStore.create(parentGoal, { storageRoot, resolvedProfile: parentProfile });
  const childGoal = { originalRequest: "quickly inspect the assigned page" };
  const resolvedProfile = resolveTaskProfile({
    goalInput: childGoal,
    parentProfile,
    parentBinding: { parentTaskId: parent.taskId, planId: "33333333-3333-4333-8333-333333333333", parentGoalVersion: 1 },
  });
  const child = await TaskStore.createChild(childGoal, {
    storageRoot, parentTaskId: parent.taskId, resolvedProfile,
  });
  const childId = child.taskId;
  assert.equal(child.taskProfile.capability.id, "browser");
  assert.equal(child.taskProfile.parentBinding.parentTaskId, parent.taskId);
  await child.close();

  const reopened = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
  assert.deepEqual(reopened.taskProfile.parentBinding, resolvedProfile.parentBinding);
  await reopened.close();
  await parent.close();
});

test("profile-required replay rejects a missing, non-adjacent, or duplicate profile event", async (t) => {
  const cases = [
    ["missing", "profile_incomplete", (lines) => lines.slice(0, 1)],
    ["non-adjacent", "profile_corrupt", (lines) => {
      const first = JSON.parse(lines[0]);
      const profile = JSON.parse(lines[1]);
      profile.seq = 3;
      const note = { ...profile, seq: 2, eventId: "44444444-4444-4444-8444-444444444444", type: "note", payload: { text: "gap" } };
      return [JSON.stringify(first), JSON.stringify(note), JSON.stringify(profile)];
    }],
    ["duplicate", "profile_corrupt", (lines) => {
      const duplicate = JSON.parse(lines[1]);
      duplicate.seq = 3;
      duplicate.eventId = "55555555-5555-4555-8555-555555555555";
      return [...lines, JSON.stringify(duplicate)];
    }],
  ];

  for (const [name, errorCode, rewrite] of cases) {
    await t.test(name, async () => {
      const storageRoot = await mkTempRoot();
      const store = await TaskStore.create({ originalRequest: "inspect" }, {
        storageRoot, resolvedProfile: profileFor({ originalRequest: "inspect" }),
      });
      const taskId = store.taskId;
      await store.close();
      const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
      const lines = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n");
      await fs.writeFile(journalPath, `${rewrite(lines).join("\n")}\n`);
      await assert.rejects(TaskStore.load(taskId, { storageRoot }), { code: errorCode });
    });
  }
});

test("profile replay rejects corrupt adapter versions and mismatched journal goal versions", async (t) => {
  const cases = [
    ["adapter version", (event) => { event.payload.capability.registryVersion = 99; }],
    ["goal version", (event) => { event.goalVersion = 2; }],
    ["task binding", (event) => { event.taskId = "66666666-6666-4666-8666-666666666666"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const storageRoot = await mkTempRoot();
      const store = await TaskStore.create({ originalRequest: "inspect" }, {
        storageRoot, resolvedProfile: profileFor({ originalRequest: "inspect" }),
      });
      const taskId = store.taskId;
      await store.close();
      const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
      const lines = (await fs.readFile(journalPath, "utf8")).trimEnd().split("\n");
      const event = JSON.parse(lines[1]);
      mutate(event);
      lines[1] = JSON.stringify(event);
      await fs.writeFile(journalPath, `${lines.join("\n")}\n`);
      await assert.rejects(TaskStore.load(taskId, { storageRoot }), { code: name === "goal version" ? "profile_corrupt" : "storage_corrupt" });
    });
  }
});

test("profile append failure after marked goal_created leaves a non-runnable partial store", async (t) => {
  const storageRoot = await mkTempRoot();
  const originalOpen = TaskStore.prototype._openJournalFh;
  t.after(() => { TaskStore.prototype._openJournalFh = originalOpen; });
  TaskStore.prototype._openJournalFh = async function openWithProfileFailure() {
    const fh = await originalOpen.call(this);
    if (this._nextSeq === 2) {
      fh.appendFile = async () => { throw new Error("simulated profile append failure"); };
    }
    return fh;
  };

  await assert.rejects(TaskStore.create({ originalRequest: "inspect" }, {
    storageRoot, resolvedProfile: profileFor({ originalRequest: "inspect" }),
  }), { code: "journal_write_failed" });

  const taskDirs = await fs.readdir(path.join(storageRoot, "tasks"));
  assert.equal(taskDirs.length, 1);
  const taskId = taskDirs[0];
  const lines = (await fs.readFile(path.join(storageRoot, "tasks", taskId, "events.jsonl"), "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).payload, { goalVersion: 1, profileRequired: true });
  await assert.rejects(TaskStore.load(taskId, { storageRoot }), { code: "profile_incomplete" });
});

test("legacy stores remain replayable and are not rewritten or implicitly profiled", async () => {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "historical path" }, { storageRoot });
  const taskId = store.taskId;
  await store.close();
  const journalPath = path.join(storageRoot, "tasks", taskId, "events.jsonl");
  const before = await fs.readFile(journalPath, "utf8");
  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.taskProfile, undefined);
  await reopened.close();
  assert.equal(await fs.readFile(journalPath, "utf8"), before);
});
