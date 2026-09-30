"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ScheduleStore, ScheduleStoreError } = require("../main/harness/schedule-store");

const ROUTINE = "11111111-1111-4111-8111-111111111111";
const OTHER_ROUTINE = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-schedulestore-"));
}

function makeStore(root, nowMs = T0) {
  const clock = { nowMs };
  const store = new ScheduleStore({ storageRoot: root, now: () => clock.nowMs });
  return { store, clock };
}

const interval = (everyMs = 60_000, anchorMs = T0) => ({ kind: "interval", everyMs, anchor: iso(anchorMs) });

test("create persists a validated record with nextRunAt, 0600 file mode and a 0700 directory", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  const created = await store.create({ routineId: ROUTINE, revision: 3, trigger: interval() });
  assert.match(created.scheduleId, /^[0-9a-f-]{36}$/);
  assert.equal(created.enabled, true);
  assert.equal(created.overlap, "skip");
  assert.equal(created.nextRunAt, iso(T0));
  assert.equal(created.createdAt, iso(T0));
  const file = path.join(root, "schedules", `${created.scheduleId}.json`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(root, "schedules"))).mode & 0o777, 0o700);
  assert.deepEqual(await store.get(created.scheduleId), created);
  assert.deepEqual(await store.list(), [created]);
});

test("create rejects invalid input and leaves nothing on disk", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  await assert.rejects(() => store.create({ routineId: ROUTINE, revision: 1, trigger: interval(1000) }), (error) => error.code === "interval_too_short");
  assert.deepEqual(await store.list(), []);
});

test("update applies whitelisted fields atomically and refuses identity fields", async () => {
  const root = await mkRoot();
  const { store, clock } = makeStore(root);
  const created = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  clock.nowMs = T0 + 5_000;
  const updated = await store.update(created.scheduleId, {
    lastOccurrenceAt: iso(T0), lastTaskId: "t-1", nextRunAt: iso(T0 + 60_000), consecutiveFailures: 1, lastError: "boom",
  });
  assert.equal(updated.lastTaskId, "t-1");
  assert.equal(updated.updatedAt, iso(T0 + 5_000));
  assert.deepEqual(await store.get(created.scheduleId), updated);
  await assert.rejects(() => store.update(created.scheduleId, { routineId: OTHER_ROUTINE }), ScheduleStoreError);
  await assert.rejects(() => store.update(created.scheduleId, { scheduleId: "x" }), ScheduleStoreError);
  await assert.rejects(() => store.update(created.scheduleId, { consecutiveFailures: -1 }), /consecutiveFailures/);
  assert.equal((await store.get(created.scheduleId)).consecutiveFailures, 1);
});

test("get rejects a corrupt or tampered file and list skips it", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  const good = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  const bad = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await fs.writeFile(path.join(root, "schedules", `${bad.scheduleId}.json`), "{not json");
  await assert.rejects(() => store.get(bad.scheduleId), (error) => error.code === "corrupt_schedule");
  assert.deepEqual((await store.list()).map((item) => item.scheduleId), [good.scheduleId]);

  const other = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  const file = path.join(root, "schedules", `${other.scheduleId}.json`);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...parsed, scheduleId: good.scheduleId }));
  await assert.rejects(() => store.get(other.scheduleId), (error) => error.code === "corrupt_schedule");
});

test("get rejects unknown ids and non-UUID ids, and refuses a symlinked schedule file", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  await assert.rejects(() => store.get("../escape"), (error) => error.code === "invalid_schedule_id");
  await assert.rejects(() => store.get("44444444-4444-4444-8444-444444444444"), (error) => error.code === "not_found");
  const created = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  const file = path.join(root, "schedules", `${created.scheduleId}.json`);
  const target = path.join(root, "elsewhere.json");
  await fs.rename(file, target);
  await fs.symlink(target, file);
  await assert.rejects(() => store.get(created.scheduleId), (error) => error.code === "corrupt_schedule");
});

test("delete removes the schedule and disableForRoutine disables only that routine's schedules", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  const a = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  const b = await store.create({ routineId: OTHER_ROUTINE, revision: 1, trigger: interval() });
  const changed = await store.disableForRoutine(ROUTINE, "routine_deleted");
  assert.deepEqual(changed, [a.scheduleId]);
  const disabled = await store.get(a.scheduleId);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.disabledReason, "routine_deleted");
  assert.equal(disabled.nextRunAt, null);
  assert.equal((await store.get(b.scheduleId)).enabled, true);
  await store.delete(b.scheduleId);
  await assert.rejects(() => store.get(b.scheduleId), (error) => error.code === "not_found");
});

test("concurrent updates to one schedule serialize without losing fields", async () => {
  const root = await mkRoot();
  const { store } = makeStore(root);
  const created = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await Promise.all([
    store.update(created.scheduleId, { lastTaskId: "t-9" }),
    store.update(created.scheduleId, { skippedCount: 4 }),
    store.update(created.scheduleId, { lastError: "x" }),
  ]);
  const final = await store.get(created.scheduleId);
  assert.equal(final.lastTaskId, "t-9");
  assert.equal(final.skippedCount, 4);
  assert.equal(final.lastError, "x");
});

test("a schedules root that is a symlink is refused", async () => {
  const root = await mkRoot();
  const elsewhere = await mkRoot();
  await fs.symlink(elsewhere, path.join(root, "schedules"));
  const { store } = makeStore(root);
  await assert.rejects(() => store.list(), (error) => error.code === "unsafe_path");
});
