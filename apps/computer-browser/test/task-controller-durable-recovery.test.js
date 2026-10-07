"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

async function fixture(t, spent, tail = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-durable-recovery-"));
  let store = await TaskStore.create({ originalRequest: "keep the original goal" }, { storageRoot: root });
  await store.checkpoint({ recoveryBudget: { version: 1, spent, recent: [] }, plannerEscalations: 0 });
  if (tail) await store.append({ type: "note", payload: { kind: "recovery", reason: "planner_error", step: "retry-planner", attempt: 1, total: 1,
    recoveryBudget: { version: 1, spent: spent + 1, recent: [{ reason: "planner_error", at: Date.now() }] } } });
  const taskId = store.taskId;
  await store.close();
  store = await TaskStore.load(taskId, { storageRoot: root });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return store;
}
const browser = { observe: async () => ({ id: "obs", url: "https://example.test/", elements: [] }), execute: async () => ({ status: "ok" }) };
function controller(store, planner, extra = {}) {
  return new TaskController({ store, browser, planner, hostVerifier: () => false, approve: async () => ({ decision: "allow", reasons: [] }), ...extra });
}

for (const tail of [false, true]) test(`restart preserves exhausted lifetime recovery budget (${tail ? "journal tail" : "checkpoint"})`, async t => {
  const store = await fixture(t, tail ? 29 : 30, tail);
  let calls = 0;
  const run = controller(store, { next: async context => { assert.equal(context.goal.originalRequest, "keep the original goal"); calls++; throw new Error("offline"); } });
  const state = await run.resume({ confirmed: true });
  assert.equal(state.pauseReason, "planner_error");
  assert.equal(calls, 1, "restart must not refill lifetime retries");
});

test("model escalation cannot refill lifetime recovery or happen again after restart", async t => {
  const store = await fixture(t, 30);
  let strongerCalls = 0, escalations = 0;
  const run = controller(store, { next: async () => { throw new Error("offline"); } }, {
    escalatePlanner: async () => { escalations++; return { planner: { next: async () => { strongerCalls++; throw new Error("still offline"); } } }; },
  });
  await run.resume({ confirmed: true });
  assert.equal(strongerCalls, 1);
  assert.equal(escalations, 1);
  const restarted = controller(store, { next: async () => { throw new Error("offline"); } }, {
    escalatePlanner: async () => { escalations++; return null; },
  });
  await restarted.resume({ confirmed: true });
  assert.equal(escalations, 1);
});

test("a recovered planner turn gets bounded host feedback without changing the goal", async t => {
  const store = await fixture(t, 0);
  let calls = 0;
  let feedback;
  const run = controller(store, { next: async context => {
    if (++calls === 1) throw new Error("SECRET raw provider failure must not reach context");
    feedback = context.progress.recoveryFeedback;
    assert.equal(context.goal.originalRequest, "keep the original goal");
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id,
      criterionIds: [], kind: "need_user", reason: "done" };
  } });
  await run.resume({ confirmed: true });
  assert.equal(feedback.reason, "planner_error");
  assert.equal(feedback.recoveryAttemptsSpent, 1);
  assert.equal(feedback.authority, "host_diagnostic_not_permission");
  assert.ok(Buffer.byteLength(JSON.stringify(feedback)) <= 512);
  assert.doesNotMatch(JSON.stringify(feedback), /SECRET/);
  assert.match(feedback.guidance, /uncertain/i);
});

test("a failed recovery journal write pauses without retrying the planner", async t => {
  const store = await fixture(t, 0);
  const append = store.append.bind(store);
  store.append = async event => {
    if (event.payload?.kind === "recovery") throw new Error("injected disk failure");
    return append(event);
  };
  let calls = 0;
  const run = controller(store, { next: async () => { calls++; throw new Error("offline"); } });
  const state = await run.resume({ confirmed: true });
  assert.equal(state.pauseReason, "planner_error");
  assert.equal(calls, 1);
});

test("sixteen real store reloads keep one goal and cannot mint new lifetime retries", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-restart-soak-"));
  let store = await TaskStore.create({ originalRequest: "one durable research goal" }, { storageRoot: root });
  const taskId = store.taskId;
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  let calls = 0;
  for (let cycle = 0; cycle < 16; cycle++) {
    const run = controller(store, { next: async context => {
      calls++;
      assert.equal(context.goal.originalRequest, "one durable research goal");
      throw new Error("controlled offline fixture");
    } });
    const before = calls;
    const state = cycle === 0 ? await run.start() : await run.resume({ confirmed: true });
    assert.equal(state.pauseReason, "planner_error");
    assert.equal(calls - before, cycle < 15 ? 3 : 1);
    await store.close();
    store = await TaskStore.load(taskId, { storageRoot: root });
  }
  assert.equal(calls, 46);
  assert.equal(store.lastCheckpoint.payload.recoveryBudget.spent, 30);
});
