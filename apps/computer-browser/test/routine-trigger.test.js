"use strict";

// goal.trigger (scheduled-occurrence key) and the TaskHost pieces the
// Scheduler depends on: trigger + routinePinned in summaries, idempotent
// runRoutine per occurrence, scheduler lifecycle. See
// docs/superpowers/specs/2026-09-29-routine-scheduler-design.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const contracts = require("../shared/harness-contracts");
const { TaskHost } = require("../main/harness/task-host");
const { TaskStore } = require("../main/harness/task-store");
const { RoutineStore } = require("../main/harness/routine-store");

const SCHEDULE_ID = "22222222-2222-4222-8222-222222222222";
const OCCURRENCE = "2026-09-29T00:00:00.000Z";
const HOST_FIELDS = { taskId: "33333333-3333-4333-8333-333333333333", goalVersion: 1, createdAt: OCCURRENCE };

const hostsToClose = new Set();
test.afterEach(async () => {
  const hosts = [...hostsToClose];
  hostsToClose.clear();
  await Promise.all(hosts.map((host) => host.close()));
});

const mkRoot = () => fs.mkdtemp(path.join(os.tmpdir(), "halo-routine-trigger-"));

function makeHost(storageRoot, overrides = {}) {
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs", url: "about:blank", elements: [] }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async () => { throw new Error("planner must not be used"); } }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...overrides,
  });
  hostsToClose.add(host);
  return host;
}

async function saveRoutine(storageRoot) {
  return new RoutineStore({ storageRoot }).save({
    name: "Visit inbox", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  });
}

test("goal input accepts an optional trigger and stores it on the goal", () => {
  const goal = contracts.normalizeGoalSpec(
    { originalRequest: "x", trigger: { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE } }, HOST_FIELDS);
  assert.deepEqual(goal.trigger, { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE });
  assert.equal(contracts.validateGoalSpec(goal).trigger.scheduleId, SCHEDULE_ID);
});

test("a goal without a trigger has no trigger field, so existing goals are unchanged", () => {
  const goal = contracts.normalizeGoalSpec({ originalRequest: "x" }, HOST_FIELDS);
  assert.equal("trigger" in goal, false);
});

test("goal trigger rejects a malformed schedule id, timestamp or extra field", () => {
  const bad = [
    { scheduleId: "nope", occurrenceAt: OCCURRENCE },
    { scheduleId: SCHEDULE_ID, occurrenceAt: "yesterday" },
    { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE, extra: 1 },
    { scheduleId: SCHEDULE_ID },
    "text",
  ];
  for (const trigger of bad) {
    assert.throws(() => contracts.normalizeGoalSpec({ originalRequest: "x", trigger }, HOST_FIELDS), contracts.ContractError, JSON.stringify(trigger));
  }
});

test("amending a goal keeps its trigger", () => {
  const goal = contracts.normalizeGoalSpec(
    { originalRequest: "x", trigger: { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE } }, HOST_FIELDS);
  const amended = contracts.applyAmendment(goal, { text: "stay on example.com" }, { at: OCCURRENCE, amendmentId: "amend-1" });
  assert.deepEqual(amended.trigger, goal.trigger);
});

test("runRoutine with a trigger writes it into the task goal and summaries expose trigger and routinePinned", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const host = makeHost(storageRoot);
  const trigger = { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE };
  const { taskId } = await host.runRoutine(saved.routineId, saved.revision, { trigger });
  const summary = (await host.listTasks()).find((item) => item.taskId === taskId);
  assert.deepEqual(summary.trigger, trigger);
  assert.equal(summary.routinePinned, true);
  const plain = await host.createTask({ originalRequest: "plain" });
  const plainSummary = (await host.listTasks()).find((item) => item.taskId === plain.taskId);
  assert.equal(plainSummary.trigger, null);
  assert.equal(plainSummary.routinePinned, false);
});

test("summaries of a detached (restarted) routine task still report trigger and routinePinned", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const first = makeHost(storageRoot);
  const trigger = { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE };
  const { taskId } = await first.runRoutine(saved.routineId, saved.revision, { trigger });
  await first.close();
  hostsToClose.delete(first);
  const second = makeHost(storageRoot);
  const summary = (await second.listTasks()).find((item) => item.taskId === taskId);
  assert.equal(summary.active, false);
  assert.deepEqual(summary.trigger, trigger);
  assert.equal(summary.routinePinned, true);
});

test("runRoutine with the same trigger twice returns the existing task and creates no second one", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  let browsers = 0;
  const host = makeHost(storageRoot, {
    makeBrowser: () => { browsers += 1; return { observe: async () => ({ id: "obs", url: "about:blank", elements: [] }), execute: async () => ({ status: "ok" }) }; },
  });
  const trigger = { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE };
  const [a, b] = await Promise.all([
    host.runRoutine(saved.routineId, saved.revision, { trigger }),
    host.runRoutine(saved.routineId, saved.revision, { trigger }),
  ]);
  assert.equal(a.taskId, b.taskId);
  const again = await host.runRoutine(saved.routineId, saved.revision, { trigger });
  assert.equal(again.taskId, a.taskId);
  assert.equal((await host.listTasks()).length, 1);
  assert.equal(browsers, 1);
});

test("a different occurrence of the same schedule creates a new task", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const host = makeHost(storageRoot);
  const a = await host.runRoutine(saved.routineId, saved.revision, { trigger: { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE } });
  const b = await host.runRoutine(saved.routineId, saved.revision, { trigger: { scheduleId: SCHEDULE_ID, occurrenceAt: "2026-09-29T00:01:00.000Z" } });
  assert.notEqual(a.taskId, b.taskId);
});

test("runRoutine rejects a malformed trigger before creating any task", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const host = makeHost(storageRoot);
  await assert.rejects(() => host.runRoutine(saved.routineId, saved.revision, { trigger: { scheduleId: "bad", occurrenceAt: OCCURRENCE } }));
  assert.equal((await host.listTasks()).length, 0);
});

test("a task created with a trigger but no routine pin (crash window) is reported unpinned", async () => {
  const storageRoot = await mkRoot();
  const store = await TaskStore.create(
    { originalRequest: "orphan", trigger: { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE } }, { storageRoot });
  await store.close();
  const host = makeHost(storageRoot);
  const summary = (await host.listTasks()).find((item) => item.taskId === store.taskId);
  assert.deepEqual(summary.trigger, { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE });
  assert.equal(summary.routinePinned, false);
});

// ---- Scheduler lifecycle inside TaskHost ----

const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

function makeClock(startMs = T0) {
  const clock = { nowMs: startMs, timers: [], nextId: 1 };
  clock.now = () => clock.nowMs;
  clock.setTimer = (fn, ms) => { const h = { id: clock.nextId++, at: clock.nowMs + ms, fn }; clock.timers.push(h); return h; };
  clock.clearTimer = (h) => { clock.timers = clock.timers.filter((item) => item !== h); };
  return clock;
}

const finishingBrowser = () => ({ observe: async () => ({ id: "obs", url: "about:blank", elements: [] }), execute: async () => ({ status: "ok" }) });

async function waitFor(predicate, message) {
  for (let i = 0; i < 200; i += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("startScheduler runs a due schedule as a triggered routine task and records it", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const clock = makeClock();
  const events = [];
  const host = makeHost(storageRoot, { scheduler: { ...clock, onEvent: (e) => events.push(e) } });
  const store = host.getScheduleStore();
  const schedule = await store.create({ routineId: saved.routineId, revision: saved.revision, trigger: { kind: "interval", everyMs: MIN, anchor: iso(T0) } });
  const scheduler = await host.startScheduler();
  await scheduler.whenSettled();
  const tasks = await host.listTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].trigger, { scheduleId: schedule.scheduleId, occurrenceAt: iso(T0) });
  assert.equal(tasks[0].routinePinned, true);
  const record = await store.get(schedule.scheduleId);
  assert.equal(record.lastTaskId, tasks[0].taskId);
  assert.equal(record.lastOccurrenceAt, iso(T0));
});

test("schedules due at the same instant are admitted under the parallel cap, extra ones wait in the queue", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const clock = makeClock(T0 - 3);
  let built = 0;
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    maxParallelTasks: 2,
    parallelTaskReserveBytes: 100_000_000,
    memoryMonitor: { getPressureLevel: () => "normal", canAdmitTask: () => ({ allowed: true }) },
    makeBrowser: () => { built += 1; return finishingBrowser(); },
    scheduler: clock,
  });
  const store = host.getScheduleStore();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push((await store.create({ routineId: saved.routineId, revision: saved.revision, trigger: { kind: "interval", everyMs: MIN, anchor: iso(T0 - 2 + i) } })).scheduleId);
    clock.nowMs += 1;
  }
  clock.nowMs = T0;
  const scheduler = await host.startScheduler();
  await scheduler.whenSettled();
  const tasks = await host.listTasks();
  assert.equal(tasks.length, 3);
  assert.deepEqual(new Set(tasks.map((t) => t.trigger.scheduleId)), new Set(ids));
  // A queued routine task is peeked from disk after its pin checkpoint, so its
  // state reads "paused"; queuePosition is the reliable queued signal.
  const waiting = tasks.filter((t) => t.queuePosition !== undefined);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].queuePosition, 1);
  assert.equal(built, 2);
  await host.stopTask(tasks.find((t) => t.active).taskId);
  await waitFor(() => built === 3, "queued scheduled task was never admitted");
  await waitFor(async () => (await host.listTasks()).find((t) => t.taskId === waiting[0].taskId).queuePosition === undefined, "queued task stayed queued");
});

test("deleteRoutine disables that routine's schedules", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const host = makeHost(storageRoot, { scheduler: makeClock() });
  const store = host.getScheduleStore();
  const schedule = await store.create({ routineId: saved.routineId, revision: saved.revision, trigger: { kind: "interval", everyMs: MIN, anchor: iso(T0) } });
  await host.deleteRoutine(saved.routineId);
  const record = await store.get(schedule.scheduleId);
  assert.equal(record.enabled, false);
  assert.equal(record.disabledReason, "routine_deleted");
});

test("close() stops the scheduler: its timer is cleared and no task is stopped or created", async () => {
  const storageRoot = await mkRoot();
  const saved = await saveRoutine(storageRoot);
  const clock = makeClock();
  const host = makeHost(storageRoot, { scheduler: clock });
  await host.getScheduleStore().create({ routineId: saved.routineId, revision: saved.revision, trigger: { kind: "interval", everyMs: MIN, anchor: iso(T0 + MIN) } });
  const scheduler = await host.startScheduler();
  await scheduler.whenSettled();
  assert.equal(clock.timers.length, 1);
  await host.close();
  hostsToClose.delete(host);
  assert.equal(clock.timers.length, 0);
  await assert.rejects(() => host.startScheduler(), (error) => error.code === "host_closed");
});

test("startScheduler twice returns the same scheduler", async () => {
  const storageRoot = await mkRoot();
  const host = makeHost(storageRoot, { scheduler: makeClock() });
  const a = await host.startScheduler();
  const b = await host.startScheduler();
  assert.equal(a, b);
});
