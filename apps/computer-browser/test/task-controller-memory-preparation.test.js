"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(t, hooks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-turn-memory-"));
  const store = await TaskStore.create({ originalRequest: "summarize this page" }, { storageRoot: root });
  const contexts = [];
  const controller = new TaskController({ store,
    browser: { observe: async () => ({ id: "obs", url: "https://example.test/" }), execute: async () => ({ status: "ok" }) },
    planner: { next: async (context) => {
      contexts.push(context);
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
    } },
    approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, ...hooks });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { controller, contexts };
}

test("activity recall starts before required memory finishes, while merge order stays stable", async (t) => {
  const memory = deferred();
  const started = deferred();
  let activityStarted = false;
  const { controller, contexts } = await setup(t, {
    memoryStore: { forContext: async (url) => { assert.equal(url, "https://example.test/"); started.resolve(); return memory.promise; } },
    activityRecall: async (request) => { assert.equal(request, "summarize this page"); activityStarted = true; return [{ id: "history", text: "history", origin: null }]; },
  });
  const run = controller.start();
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  const overlapped = activityStarted;
  assert.equal(contexts.length, 0, "planner must still wait for required memory");
  memory.resolve({ entries: [{ id: "memory", text: "memory", origin: null }] });
  await run;
  assert.equal(overlapped, true);
  assert.deepEqual(contexts[0].userMemory.entries.map(entry => entry.id), ["memory", "history"]);
  assert.equal(contexts[0].userMemory.authority, "untrusted_user_memory");
});

test("an early optional recall rejection does not discard required memory", async (t) => {
  const memory = deferred();
  const started = deferred();
  const { controller, contexts } = await setup(t, {
    memoryStore: { forContext: async () => { started.resolve(); return memory.promise; } },
    activityRecall: async () => { throw new Error("optional source unavailable"); },
  });
  const run = controller.start();
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  memory.resolve({ entries: [{ id: "memory", text: "memory", origin: null }] });
  await run;
  assert.deepEqual(contexts[0].userMemory.entries.map(entry => entry.id), ["memory"]);
});

test("required memory failure never submits optional context to the planner", async (t) => {
  const { controller, contexts } = await setup(t, {
    memoryStore: { forContext: async () => { throw new Error("required source failed"); } },
    activityRecall: async () => [{ id: "history", text: "history", origin: null }],
  });
  const state = await controller.start();
  assert.equal(state.pauseReason, "context_error");
  assert.equal(contexts.length, 0);
});

test("late memory and recall results after takeover never reach the planner", async (t) => {
  const memory = deferred(), activity = deferred(), started = deferred();
  const { controller, contexts } = await setup(t, {
    memoryStore: { forContext: async () => { started.resolve(); return memory.promise; } },
    activityRecall: async () => activity.promise,
  });
  const run = controller.start();
  await started.promise;
  await controller.takeOver("user_takeover");
  memory.resolve({ entries: [{ id: "late-memory", text: "late", origin: null }] });
  activity.resolve([{ id: "late-history", text: "late", origin: null }]);
  await run;
  assert.equal(contexts.length, 0);
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
});

test("each turn reads fresh sources instead of caching a prior context", async (t) => {
  const received = [];
  let memoryCalls = 0, recallCalls = 0, observations = 0;
  const { controller } = await setup(t, {
    memoryStore: { forContext: async () => ({ entries: [{ id: `memory-${++memoryCalls}`, text: "memory", origin: null }] }) },
    activityRecall: async () => [{ id: `history-${++recallCalls}`, text: "history", origin: null }],
    browser: { observe: async () => ({ id: `obs-${++observations}`, url: "https://example.test/" }), execute: async () => ({ status: "ok" }) },
    planner: { next: async (context) => {
      received.push(context.userMemory.entries.map(entry => entry.id));
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      return received.length === 1 ? { ...base, kind: "actions", actions: [{ type: "observe" }] } : { ...base, kind: "finish", evidenceIds: [] };
    } },
  });
  await controller.start();
  assert.deepEqual(received, [["memory-1", "history-1"], ["memory-2", "history-2"]]);
  assert.equal(controller.getSnapshot().budgets.plannerCallsUsed, 2);
  assert.equal(controller.getSnapshot().budgets.actionsUsed, 1);
});

test("required failure does not wait for a stalled optional read", { timeout: 2000 }, async (t) => {
  const stalled = deferred();
  const { controller, contexts } = await setup(t, {
    memoryStore: { forContext: async () => { throw new Error("required failed"); } },
    activityRecall: async () => stalled.promise,
  });
  try {
    assert.equal((await controller.start()).pauseReason, "context_error");
    assert.equal(contexts.length, 0);
  } finally { stalled.resolve([]); }
});
