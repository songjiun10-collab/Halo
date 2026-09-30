"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Scheduler } = require("../main/harness/scheduler");
const { ScheduleStore } = require("../main/harness/schedule-store");

const ROUTINE = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-scheduler-"));
}

function makeClock(startMs = T0) {
  const clock = { nowMs: startMs, timers: [], nextId: 1 };
  clock.now = () => clock.nowMs;
  clock.setTimer = (fn, ms) => {
    const handle = { id: clock.nextId++, at: clock.nowMs + ms, fn };
    clock.timers.push(handle);
    return handle;
  };
  clock.clearTimer = (handle) => {
    clock.timers = clock.timers.filter((item) => item !== handle);
  };
  clock.advanceTo = async (targetMs, scheduler) => {
    for (;;) {
      const due = clock.timers.filter((item) => item.at <= targetMs).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.timers = clock.timers.filter((item) => item !== due);
      clock.nowMs = Math.max(clock.nowMs, due.at);
      due.fn();
      await scheduler.whenSettled();
    }
    clock.nowMs = targetMs;
  };
  return clock;
}

class FakeHost {
  constructor() {
    this.tasks = [];
    this.runCalls = [];
    this.stopCalls = [];
    this.closeCalls = 0;
    this.hold = null;
    this.failWith = null;
    this.listFailures = 0;
    this._seq = 0;
  }

  async listTasks() {
    if (this.listFailures > 0) {
      this.listFailures -= 1;
      throw new Error("crash: listTasks");
    }
    return this.tasks.map((task) => ({ ...task }));
  }

  async runRoutine(routineId, revision, options = {}) {
    this.runCalls.push({ routineId, revision, trigger: options.trigger });
    if (this.failWith) throw Object.assign(new Error(this.failWith.message ?? "failed"), { code: this.failWith.code });
    const task = {
      taskId: `task-${++this._seq}`, state: "queued", routinePinned: true,
      trigger: options.trigger ? { ...options.trigger } : null,
    };
    this.tasks.push(task);
    if (this.hold) await this.hold;
    task.state = "awaiting_verification";
    return { taskId: task.taskId, snapshot: { state: task.state } };
  }

  async stopTask(taskId) {
    this.stopCalls.push(taskId);
    const task = this.tasks.find((item) => item.taskId === taskId);
    if (task) task.state = "stopped";
  }

  async cancelTask() { this.closeCalls += 1; }
  async pauseTask() { this.closeCalls += 1; }
}

async function setup(overrides = {}) {
  const root = await mkRoot();
  const clock = makeClock();
  const store = new ScheduleStore({ storageRoot: root, now: clock.now });
  const host = new FakeHost();
  const events = [];
  const scheduler = new Scheduler({
    host, store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: (event) => events.push(event), ...overrides,
  });
  return { root, clock, store, host, events, scheduler };
}

const interval = (everyMs = MIN, anchorMs = T0) => ({ kind: "interval", everyMs, anchor: iso(anchorMs) });
const keyOf = (task) => `${task.trigger.scheduleId}@${task.trigger.occurrenceAt}`;

test("interval schedule runs at each anchored occurrence with the occurrence key as trigger", async () => {
  const { clock, store, host, scheduler } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 4, trigger: interval() });
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(host.runCalls.length, 1);
  assert.deepEqual(host.runCalls[0], {
    routineId: ROUTINE, revision: 4, trigger: { scheduleId: schedule.scheduleId, occurrenceAt: iso(T0) },
  });
  await clock.advanceTo(T0 + 2 * MIN, scheduler);
  assert.deepEqual(host.runCalls.map((call) => call.trigger.occurrenceAt), [iso(T0), iso(T0 + MIN), iso(T0 + 2 * MIN)]);
  const saved = await store.get(schedule.scheduleId);
  assert.equal(saved.lastOccurrenceAt, iso(T0 + 2 * MIN));
  assert.equal(saved.lastTaskId, "task-3");
  assert.equal(saved.nextRunAt, iso(T0 + 3 * MIN));
  await scheduler.stop();
});

test("a once schedule runs once, then disables itself as completed", async () => {
  const { clock, store, host, scheduler } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: { kind: "once", at: iso(T0 + 5 * MIN) } });
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(host.runCalls.length, 0);
  await clock.advanceTo(T0 + 5 * MIN, scheduler);
  assert.equal(host.runCalls.length, 1);
  await clock.advanceTo(T0 + 30 * MIN, scheduler);
  assert.equal(host.runCalls.length, 1);
  const saved = await store.get(schedule.scheduleId);
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, "completed");
  assert.equal(saved.nextRunAt, null);
  await scheduler.stop();
});

test("missed interval occurrences coalesce into one run at start-up", async () => {
  const { clock, store, host, scheduler } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await store.update(schedule.scheduleId, { lastOccurrenceAt: iso(T0) });
  clock.nowMs = T0 + 3 * MIN + 10_000;
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(host.runCalls.length, 1);
  assert.equal(host.runCalls[0].trigger.occurrenceAt, iso(T0 + 3 * MIN));
  await scheduler.stop();
});

test("a stale once schedule is marked missed and not run", async () => {
  const { clock, store, host, scheduler, events } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: { kind: "once", at: iso(T0 + MIN) } });
  clock.nowMs = T0 + MIN + 61 * MIN;
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(host.runCalls.length, 0);
  const saved = await store.get(schedule.scheduleId);
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, "missed");
  assert.ok(events.some((event) => event.type === "missed" && event.scheduleId === schedule.scheduleId));
  await scheduler.stop();
});

test("overlap skip records a skipped occurrence while the previous run is still in flight", async () => {
  const { clock, store, host, scheduler } = await setup();
  let release;
  host.hold = new Promise((resolve) => { release = resolve; });
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await scheduler.start();
  await clock.advanceTo(T0 + MIN, scheduler.trackedIdle ? scheduler : { whenSettled: () => scheduler.settleTicks() });
  assert.equal(host.runCalls.length, 1);
  assert.equal((await store.get(schedule.scheduleId)).skippedCount, 1);
  release();
  await scheduler.whenSettled();
  await clock.advanceTo(T0 + 2 * MIN, scheduler);
  assert.equal(host.runCalls.length, 2);
  await scheduler.stop();
});

test("overlap queue enqueues the next occurrence even while the previous run is in flight", async () => {
  const { clock, store, host, scheduler } = await setup();
  let release;
  host.hold = new Promise((resolve) => { release = resolve; });
  await store.create({ routineId: ROUTINE, revision: 1, overlap: "queue", trigger: interval() });
  await scheduler.start();
  await clock.advanceTo(T0 + MIN, { whenSettled: () => scheduler.settleTicks() });
  assert.equal(host.runCalls.length, 2);
  release();
  await scheduler.whenSettled();
  await scheduler.stop();
});

test("schedules due at the same instant are launched in nextRunAt then creation order", async () => {
  const { clock, store, host, scheduler } = await setup();
  clock.nowMs = T0 - 2;
  const a = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval(MIN, T0 - 2) });
  clock.nowMs = T0 - 1;
  const b = await store.create({ routineId: ROUTINE, revision: 2, trigger: interval(MIN, T0 - 1) });
  clock.nowMs = T0;
  await scheduler.start();
  await scheduler.whenSettled();
  assert.deepEqual(host.runCalls.map((call) => call.trigger.scheduleId), [a.scheduleId, b.scheduleId]);
  await scheduler.stop();
});

test("a routine that was deleted disables the schedule immediately", async () => {
  const { store, host, scheduler } = await setup();
  host.failWith = { code: "routine_deleted", message: "routine has been deleted" };
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await scheduler.start();
  await scheduler.whenSettled();
  const saved = await store.get(schedule.scheduleId);
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, "routine_deleted");
  await scheduler.stop();
});

test("a host_closed error leaves the schedule untouched so the occurrence is retried after restart", async () => {
  const { store, host, events, scheduler } = await setup();
  host.failWith = { code: "host_closed", message: "task host is closed" };
  const once = await store.create({ routineId: ROUTINE, revision: 1, trigger: { kind: "once", at: iso(T0) } });
  const repeat = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await scheduler.start();
  await scheduler.whenSettled();
  for (const schedule of [once, repeat]) {
    const saved = await store.get(schedule.scheduleId);
    assert.equal(saved.enabled, true);
    assert.equal(saved.consecutiveFailures, 0);
    assert.equal(saved.lastOccurrenceAt, null);
    assert.equal(saved.lastError, null);
  }
  assert.ok(events.some((event) => event.type === "host_closed"));
  assert.equal(events.some((event) => event.type === "run_failed"), false);
  await scheduler.stop();
});

test("three consecutive failures disable a schedule and a success resets the counter", async () => {
  const { clock, store, host, scheduler } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  host.failWith = { code: "revision_missing", message: "revision missing" };
  await scheduler.start();
  await scheduler.whenSettled();
  await clock.advanceTo(T0 + MIN, scheduler);
  let saved = await store.get(schedule.scheduleId);
  assert.equal(saved.consecutiveFailures, 2);
  assert.equal(saved.enabled, true);
  assert.equal(saved.lastError, "revision missing");
  host.failWith = null;
  await clock.advanceTo(T0 + 2 * MIN, scheduler);
  saved = await store.get(schedule.scheduleId);
  assert.equal(saved.consecutiveFailures, 0);
  assert.equal(saved.lastError, null);
  host.failWith = { code: "revision_missing", message: "revision missing" };
  await clock.advanceTo(T0 + 5 * MIN, scheduler);
  saved = await store.get(schedule.scheduleId);
  assert.equal(saved.enabled, false);
  assert.equal(saved.disabledReason, "too_many_failures");
  await scheduler.stop();
});

test("stop() clears the timer and never calls any task-control method", async () => {
  const { clock, store, host, scheduler } = await setup();
  await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(clock.timers.length, 1);
  await scheduler.stop();
  assert.equal(clock.timers.length, 0);
  assert.deepEqual(host.stopCalls, []);
  assert.equal(host.closeCalls, 0);
  await clock.advanceTo(T0 + 10 * MIN, scheduler);
  assert.equal(host.runCalls.length, 1);
});

test("crash point (a): a crash before any task exists creates exactly one task on restart", async () => {
  const { store, host, scheduler } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  host.listFailures = 1;
  await assert.rejects(() => scheduler.tick(), /crash: listTasks/);
  assert.equal(host.tasks.length, 0);
  assert.equal((await store.get(schedule.scheduleId)).lastOccurrenceAt, null);
  await scheduler.start();
  await scheduler.whenSettled();
  assert.equal(host.tasks.length, 1);
  await scheduler.stop();
});

test("crash points (b)+(d): a crash after the task exists but before the record is written adopts it, never a second task", async () => {
  const root = await mkRoot();
  const clock = makeClock();
  const realStore = new ScheduleStore({ storageRoot: root, now: clock.now });
  const schedule = await realStore.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  const host = new FakeHost();
  const crashingStore = Object.create(realStore);
  crashingStore.update = async () => { throw new Error("crash: process died before the schedule record was written"); };
  const first = new Scheduler({ host, store: crashingStore, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await first.tick().catch(() => {});
  await first.whenSettled();
  assert.equal(host.tasks.length, 1);
  assert.equal((await realStore.get(schedule.scheduleId)).lastOccurrenceAt, null);

  const second = new Scheduler({ host, store: realStore, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await second.start();
  await second.whenSettled();
  assert.equal(host.tasks.length, 1);
  assert.equal(host.runCalls.length, 1);
  const saved = await realStore.get(schedule.scheduleId);
  assert.equal(saved.lastTaskId, "task-1");
  assert.equal(saved.lastOccurrenceAt, iso(T0));
  await second.tick();
  await second.whenSettled();
  assert.equal(host.tasks.length, 1);
  await second.stop();
});

test("crash point (c): a pin-less task carrying the occurrence key is stopped and exactly one routine task is created", async () => {
  const { store, host, scheduler, events } = await setup();
  const schedule = await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  host.tasks.push({
    taskId: "orphan", state: "queued", routinePinned: false,
    trigger: { scheduleId: schedule.scheduleId, occurrenceAt: iso(T0) },
  });
  await scheduler.start();
  await scheduler.whenSettled();
  assert.deepEqual(host.stopCalls, ["orphan"]);
  const live = host.tasks.filter((task) => task.state !== "stopped");
  assert.equal(live.length, 1);
  assert.equal(live[0].routinePinned, true);
  assert.equal(keyOf(live[0]), `${schedule.scheduleId}@${iso(T0)}`);
  assert.ok(events.some((event) => event.type === "orphan_stopped"));
  await scheduler.stop();
});

test("a slow run does not block a second schedule from launching", async () => {
  const { store, host, scheduler } = await setup();
  let release;
  host.hold = new Promise((resolve) => { release = resolve; });
  await store.create({ routineId: ROUTINE, revision: 1, trigger: interval() });
  await store.create({ routineId: ROUTINE, revision: 2, trigger: interval() });
  await scheduler.start();
  await scheduler.settleTicks();
  assert.equal(host.runCalls.length, 2);
  release();
  await scheduler.whenSettled();
  await scheduler.stop();
});
