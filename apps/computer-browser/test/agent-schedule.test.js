"use strict";

// Always-on Agents: a schedule starts an Agent/team conversation unattended.
// The user chooses, per schedule, what happens when an action needs approval
// (pause and wait, or deny and continue) and a bounded planner-call cap.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { AgentScheduleStore, AgentScheduler, MAX_SCHEDULE_PLANNER_CALLS } = require("../main/harness/agent-schedule");

const OWNER = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function input(overrides = {}) {
  return {
    kind: "agent",
    ownerId: OWNER,
    request: "매일 아침 뉴스 요약",
    trigger: { kind: "interval", everyMs: 60 * 60 * 1000, anchor: iso(T0) },
    onApproval: "deny",
    maxPlannerCalls: 20,
    ...overrides,
  };
}

async function makeStore(clock) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-schedule-"));
  return { root, store: new AgentScheduleStore({ storageRoot: root, now: () => clock.now }) };
}

test("AgentScheduleStore validates the user's unattended choices", async () => {
  const clock = { now: T0 };
  const { store } = await makeStore(clock);
  const saved = await store.save(input());
  assert.equal(saved.enabled, true);
  assert.equal(saved.onApproval, "deny");
  assert.equal(saved.maxPlannerCalls, 20);
  assert.equal(saved.lastOccurrenceAt, null);
  for (const bad of [
    { onApproval: "allow" },
    { onApproval: undefined },
    { maxPlannerCalls: 0 },
    { maxPlannerCalls: MAX_SCHEDULE_PLANNER_CALLS + 1 },
    { maxPlannerCalls: 1.5 },
    { request: "" },
    { request: "x".repeat(2001) },
    { kind: "routine" },
    { ownerId: "nope" },
    { trigger: { kind: "interval", everyMs: 1000, anchor: iso(T0) } },
    { extra: true },
  ]) {
    const value = input(bad);
    for (const key of Object.keys(bad)) if (bad[key] === undefined) delete value[key];
    await assert.rejects(store.save(value), { code: "invalid_schedule" }, JSON.stringify(bad));
  }
  const edited = await store.save({ ...input({ onApproval: "pause" }), id: saved.id });
  assert.equal(edited.onApproval, "pause");
  assert.equal((await store.list()).length, 1);
  await store.remove(saved.id);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.remove(saved.id), { code: "not_found" });
});

test("AgentScheduleStore refuses a symlinked file and persists 0600", async () => {
  const clock = { now: T0 };
  const { root, store } = await makeStore(clock);
  await store.save(input());
  const stat = await fs.stat(path.join(root, "schedules.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-schedule-link-"));
  await fs.writeFile(path.join(other, "target.json"), "{}");
  const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-schedule-"));
  await fs.symlink(path.join(other, "target.json"), path.join(linkedRoot, "schedules.json"));
  await assert.rejects(new AgentScheduleStore({ storageRoot: linkedRoot }).list(), { code: "unsafe_path" });
});

function harness(clock, { states = new Map(), fail = null } = {}) {
  const started = [];
  const timers = [];
  return {
    started,
    timers,
    states,
    options: {
      now: () => clock.now,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
      startTask: async (schedule, occurrenceAt) => {
        if (fail) throw fail;
        const taskId = `task-${started.length + 1}`;
        started.push({ scheduleId: schedule.id, occurrenceAt, onApproval: schedule.onApproval, maxPlannerCalls: schedule.maxPlannerCalls });
        states.set(taskId, "running");
        return { taskId };
      },
      getTaskState: async (taskId) => states.get(taskId) ?? null,
    },
  };
}

test("AgentScheduler starts a due occurrence once with the schedule's choices", async () => {
  const clock = { now: T0 };
  const { store } = await makeStore(clock);
  const schedule = await store.save(input());
  clock.now = T0 + 1000;
  const h = harness(clock);
  const scheduler = new AgentScheduler({ store, ...h.options });
  await scheduler.start();
  assert.deepEqual(h.started, [{ scheduleId: schedule.id, occurrenceAt: iso(T0), onApproval: "deny", maxPlannerCalls: 20 }]);
  await scheduler.tick();
  assert.equal(h.started.length, 1, "the same occurrence is never started twice");
  const after = await store.get(schedule.id);
  assert.equal(after.lastTaskId, "task-1");
  assert.equal(after.lastOccurrenceAt, iso(T0));
  assert.equal(h.timers.at(-1).ms, 60 * 60 * 1000 - 1000);
  await scheduler.stop();
});

test("AgentScheduler skips an occurrence while the previous run is still live", async () => {
  const clock = { now: T0 };
  const { store } = await makeStore(clock);
  const schedule = await store.save(input());
  clock.now = T0 + 1000;
  const h = harness(clock);
  const scheduler = new AgentScheduler({ store, ...h.options });
  await scheduler.start();
  h.states.set("task-1", "awaiting_approval");
  clock.now = T0 + 60 * 60 * 1000 + 1000;
  await scheduler.tick();
  assert.equal(h.started.length, 1);
  assert.equal((await store.get(schedule.id)).skippedCount, 1);
  h.states.set("task-1", "completed");
  clock.now = T0 + 2 * 60 * 60 * 1000 + 1000;
  await scheduler.tick();
  assert.equal(h.started.length, 2);
  await scheduler.stop();
});

test("AgentScheduler disables a schedule whose owner is gone, and after repeated failures", async () => {
  const clock = { now: T0 };
  const { store } = await makeStore(clock);
  const gone = await store.save(input());
  clock.now = T0 + 1000;
  const unavailable = Object.assign(new Error("archived"), { code: "agent_unavailable" });
  const scheduler = new AgentScheduler({ store, ...harness(clock, { fail: unavailable }).options });
  await scheduler.start();
  const record = await store.get(gone.id);
  assert.equal(record.enabled, false);
  assert.equal(record.disabledReason, "owner_unavailable");
  await scheduler.stop();

  clock.now = T0;
  const flaky = await store.save(input());
  clock.now = T0 + 1000;
  const boom = Object.assign(new Error("boom"), { code: "planner_unavailable" });
  const retrying = new AgentScheduler({ store, maxConsecutiveFailures: 2, ...harness(clock, { fail: boom }).options });
  await retrying.start();
  assert.equal((await store.get(flaky.id)).enabled, true);
  assert.equal((await store.get(flaky.id)).consecutiveFailures, 1);
  clock.now += 60 * 60 * 1000;
  await retrying.tick();
  const failed = await store.get(flaky.id);
  assert.equal(failed.enabled, false);
  assert.equal(failed.disabledReason, "too_many_failures");
  await retrying.stop();
});

test("a once schedule runs within its grace window and is then finished", async () => {
  const clock = { now: T0 + 1000 };
  const { store } = await makeStore(clock);
  const once = await store.save(input({ trigger: { kind: "once", at: iso(T0) } }));
  const h = harness(clock);
  const scheduler = new AgentScheduler({ store, ...h.options });
  await scheduler.start();
  assert.equal(h.started.length, 1);
  const record = await store.get(once.id);
  assert.equal(record.enabled, false);
  assert.equal(record.disabledReason, "completed");
  await scheduler.stop();
});

test("TaskHost runs an Agent schedule unattended with the chosen approval mode and cap", async () => {
  const { TaskHost } = require("../main/harness/task-host");
  const { AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");
  const clock = { now: T0 };
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-schedule-host-"));
  let calls = 0;
  const host = new TaskHost({
    storageRoot,
    scheduler: { now: () => clock.now, setTimer: () => 1, clearTimer: () => {} },
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => {
        calls += 1;
        const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [] };
        return calls === 1 ? { ...base, kind: "actions", actions: [{ type: "observe" }] } : { ...base, kind: "finish", evidenceIds: [] };
      },
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "review", reasons: ["needs a human look"] }),
  });
  const notices = [];
  host.onAgentRosterEvent((notice) => notices.push(notice));
  try {
    const agent = await host.saveAgent({ name: "A", title: "", description: "", avatar: { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] }, instructions: "", capabilityId: "browser" });
    await assert.rejects(host.saveAgentSchedule(input()), { code: "agent_unavailable" });
    const schedule = await host.saveAgentSchedule(input({ ownerId: agent.id, maxPlannerCalls: 7 }));
    assert.deepEqual((await host.listAgentSchedules()).map((item) => item.id), [schedule.id]);
    clock.now = T0 + 1000;
    await host.startAgentScheduler();
    const record = (await host.listAgentSchedules())[0];
    assert.ok(record.lastTaskId, JSON.stringify(record));
    const [conversation] = await host.listAgentConversations({ agentId: agent.id });
    assert.equal(conversation.taskId, record.lastTaskId);
    for (let i = 0; i < 100; i += 1) {
      const detail = await host.getTaskDetail(record.lastTaskId);
      if (!["idle", "running", "queued"].includes(detail.snapshot?.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const detail = await host.getTaskDetail(record.lastTaskId);
    assert.notEqual(detail.snapshot.state, "awaiting_approval");
    assert.equal(detail.goal.limits.maxPlannerCalls, 7);
    assert.ok(notices.some((notice) => notice.change === "schedule_saved"));
    assert.ok(notices.some((notice) => notice.change === "conversation_started"));
    await host.deleteAgentSchedule(schedule.id);
    assert.deepEqual(await host.listAgentSchedules(), []);
  } finally {
    await host.close();
  }
});
