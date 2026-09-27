"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { ContractError, normalizeGoalSpec, validateJournalEvent, MAX_EVENT_BYTES } = require("../shared/harness-contracts");

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
