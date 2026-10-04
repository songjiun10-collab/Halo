"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const openStores = new Set();
afterEach(async () => {
  const stores = [...openStores];
  openStores.clear();
  await Promise.all(stores.map((store) => store.close()));
});

const makeStore = async () => {
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-recover-")) });
  openStores.add(store);
  return store;
};
const make = async (planner, browser, extra = {}) => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner, browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1, ...extra });
  return { controller, store };
};
const actions = (context, action) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [], kind: "actions", actions: [action] });
const page = (n) => ({ id: `o${n}`, url: "https://page.test/list", text: `t${n}`, elements: [] });
test("a planner failure is retried automatically and the task carries on", async () => {
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    if (calls <= 2) throw new Error("transport hiccup");
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done here" };
  } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(calls, 3);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("recovery is bounded: a planner that always fails still pauses as planner_error", async () => {
  let calls = 0;
  const planner = { next: async () => { calls += 1; throw new Error("down"); } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 3, "first call plus two recoveries");
});

test("maxRecoveries: 0 turns recovery off", async () => {
  let calls = 0;
  const planner = { next: async () => { calls += 1; throw new Error("down"); } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) }, { maxRecoveries: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 1);
});

test("an observation failure is re-observed once before pausing", async () => {
  let n = 0;
  const browser = { supportsAction: () => true, observe: async () => { n += 1; if (n === 1) throw Object.assign(new Error("boom"), { code: "observe_failed" }); return page(n); }, execute: async () => ({ status: "ok" }) };
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "ask" }) };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(n, 2);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("a page loop is warned about and given another chance before pausing", async () => {
  const warnings = [];
  let n = 0;
  const planner = { next: async (context) => { warnings.push(context.progress.loopWarning === true); return actions(context, { type: "observe" }); } };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return page(n); }, execute: async () => ({ status: "ok" }) };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "no_progress");
  assert.ok(warnings.includes(true), "planner never saw loopWarning");
  assert.ok(warnings.length > 12, `paused without recovering after ${warnings.length} turns`);
});

test("need_user is never auto-recovered", async () => {
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "hi" }; } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(calls, 1);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("recovery policy caps per reason and overall", () => {
  const { createRecoveryPolicy } = require("../main/harness/recovery-policy");
  const policy = createRecoveryPolicy(3);
  assert.deepEqual(policy.tryConsume("a"), { attempt: 1, total: 1 });
  assert.deepEqual(policy.tryConsume("a"), { attempt: 2, total: 2 });
  assert.equal(policy.tryConsume("a"), null, "per-reason cap of two");
  assert.deepEqual(policy.tryConsume("b"), { attempt: 1, total: 3 });
  assert.equal(policy.tryConsume("c"), null, "overall cap");
  assert.equal(createRecoveryPolicy(0).tryConsume("a"), null);
});
