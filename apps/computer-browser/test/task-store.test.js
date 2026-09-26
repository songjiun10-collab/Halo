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
  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");

  const savedContent = await fs.readFile(journalPath, "utf8").catch(() => "");
  await fs.rm(journalPath, { force: true });
  await fs.mkdir(journalPath); // any open() on this path now fails, regardless of uid

  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "x" } }),
    (err) => err.code === "journal_write_failed",
  );

  await fs.rmdir(journalPath);
  await fs.writeFile(journalPath, savedContent, { mode: 0o600 });

  // Still blocked even though the underlying problem is now fixed -- a
  // failed writer must not silently start accepting actions again.
  await assert.rejects(
    () => store.append({ type: "note", payload: { msg: "y" } }),
    (err) => err.code === "journal_write_failed",
  );
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
