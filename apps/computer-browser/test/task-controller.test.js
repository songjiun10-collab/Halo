"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-task-controller-"));
}

async function makeStore(goalInput) {
  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create(goalInput, { storageRoot });
  return { store, storageRoot };
}

function allowApprove() {
  return async () => ({ decision: "allow", reasons: [] });
}

test("drives 100 actions across at least 10 injected context-reset segments while preserving the goal", async () => {
  const { store } = await makeStore({
    originalRequest: "100단계 작업",
    criteria: [{ id: "C1", text: "done", required: true, verification: "user" }],
  });
  let obsCount = 0;
  const browser = {
    observe: async () => ({ id: `obs-${obsCount++}` }),
    execute: async () => ({ status: "ok" }),
  };
  const ACTION_LIMIT = 100;
  let plannerCalls = 0;
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls > ACTION_LIMIT) {
        return {
          taskId: context.taskId,
          goalVersion: context.goalVersion,
          basedOnObservationId: context.observation.id,
          criterionIds: [],
          kind: "finish",
          evidenceIds: [],
        };
      }
      return {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: context.observation.id,
        criterionIds: [],
        kind: "actions",
        actions: [{ type: "observe", n: plannerCalls }],
      };
    },
  };

  const controller = new TaskController({
    store,
    planner,
    browser,
    approve: allowApprove(),
    hostVerifier: () => true,
    segmentRotationCalls: 10,
  });
  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.budgets.actionsUsed, ACTION_LIMIT);
  assert.ok(snapshot.segment.index >= 10, `expected >=10 segment rotations, got ${snapshot.segment.index}`);
  assert.equal(controller.getGoal().originalRequest, "100단계 작업");
  await store.close();
});

test("keeps budgets accumulating across a segment rotation instead of resetting them", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  let calls = 0;
  const TOTAL = 6;
  const planner = {
    next: async (context) => {
      calls += 1;
      if (calls > TOTAL) {
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      }
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true, segmentRotationCalls: 2 });
  await controller.start();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.budgets.actionsUsed, TOTAL);
  assert.equal(snapshot.segment.index, 3); // 6 calls / 2 per segment = 3 rotations, none of which reset actionsUsed
  await store.close();
});

test("grants one free replan after 3 identical no-progress actions, then pauses no_progress on the second streak", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = {
    observe: async () => ({ id: "same-observation" }), // always identical
    execute: async () => ({ status: "ok" }), // never produces evidence -> never counts as progress
  };
  const planner = {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: context.observation.id,
      criterionIds: [],
      kind: "actions",
      actions: [{ type: "observe" }], // always identical
    }),
  };
  const controller = new TaskController({
    store,
    planner,
    browser,
    approve: allowApprove(),
    hostVerifier: () => true,
    noProgressThreshold: 3,
  });
  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "no_progress");
  assert.equal(snapshot.budgets.actionsUsed, 6); // 3 (first streak, grace replan) + 3 (second streak, pause)
  await store.close();
});

test("does not count time spent in awaiting_approval toward the active-time budget", async () => {
  let t = 1000;
  const now = () => t;
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const approve = async () => ({ decision: "review", reasons: ["needs a human look"] });
  const planner = {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "actions",
      actions: [{ type: "observe" }],
    }),
  };
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true, now });
  await controller.start();

  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  const activeMsBefore = controller.getSnapshot().budgets.activeMs;

  t += 60 * 60 * 1000; // a human takes an hour to review
  const [item] = controller.getSnapshot().approvalQueue;
  await controller.approve(item.id);

  const activeMsAfter = controller.getSnapshot().budgets.activeMs;
  assert.ok(activeMsAfter - activeMsBefore < 5000, `expected the 1h wait excluded from active time, got delta ${activeMsAfter - activeMsBefore}ms`);
  await store.close();
});

test("pauses with planner_error (does not crash or auto-retry) when the planner transport rejects", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  let calls = 0;
  const planner = {
    next: async () => {
      calls += 1;
      throw new Error("simulated transport timeout");
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 1);
  await store.close();
});

test("discards a planner response that resolves after stop() was already called", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let resolvePlanner;
  const plannerGate = new Promise((r) => { resolvePlanner = r; });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const planner = { next: async () => plannerGate };

  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  const startPromise = controller.start();

  await new Promise((r) => setImmediate(r)); // let the loop reach the stuck planner.next() await
  await controller.stop();
  assert.equal(controller.getSnapshot().state, "stopped");

  resolvePlanner({
    taskId: store.taskId,
    goalVersion: 1,
    basedOnObservationId: "obs",
    criterionIds: [],
    kind: "actions",
    actions: [{ type: "observe" }],
  });
  await startPromise;

  assert.equal(controller.getSnapshot().state, "stopped");
  assert.equal(controller.getSnapshot().budgets.actionsUsed, 0);
  await store.close();
});

test("a task recovered as execution_uncertain requires an explicit confirmed resume and never auto-dispatches", async () => {
  const storageRoot = await mkTempRoot();
  const created = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await created.append({ type: "action_started", payload: { actionId: "dangling-1" } });
  const taskId = created.taskId;
  await created.close();

  const reloaded = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reloaded.recoveryReason, "execution_uncertain");

  let executeCalls = 0;
  let plannerCalls = 0;
  const browser = {
    observe: async () => ({ id: "fresh-obs" }),
    execute: async () => {
      executeCalls += 1;
      return { status: "ok" };
    },
  };
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      return {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: context.observation.id,
        criterionIds: [],
        kind: "finish",
        evidenceIds: [],
      };
    },
  };

  const controller = new TaskController({ store: reloaded, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller.getSnapshot().pauseReason, "execution_uncertain");

  await assert.rejects(
    () => controller.resume(),
    (err) => err instanceof TaskControllerError && err.code === "confirmation_required",
  );
  assert.equal(executeCalls, 0);
  assert.equal(plannerCalls, 0);

  await controller.resume({ confirmed: true });
  // The dangling action is never replayed; the loop starts fresh with a new observation.
  assert.equal(executeCalls, 0);
  assert.ok(plannerCalls >= 1);
  await reloaded.close();
});

test("a criterion verified before an amend() does not silently satisfy the amended goal", async () => {
  const { store } = await makeStore({
    originalRequest: "goal",
    criteria: [{ id: "host-check", text: "check", required: true, verification: "host" }],
  });
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => ({ status: "ok", evidenceCandidate: { kind: "host_check" } }),
  };
  const planner = {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: "obs",
      criterionIds: ["host-check"],
      kind: "actions",
      actions: [{ type: "observe" }],
    }),
  };
  // First pass: allow exactly one action through, then ask for a human (so
  // the loop halts instead of racing straight to "finish").
  let dispatches = 0;
  const approve = async () => {
    dispatches += 1;
    return { decision: "allow", reasons: [] };
  };
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true });

  // Manually run one iteration's worth by swapping the planner to need_user
  // right after the first dispatch.
  const originalNext = planner.next;
  planner.next = async (context) => {
    if (dispatches === 0) return originalNext(context);
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "pausing to check with the human" };
  };

  await controller.start();
  assert.equal(controller.getSnapshot().pauseReason, "need_user");
  assert.equal(controller.getSnapshot().criteriaStatus.find((c) => c.criterionId === "host-check").status, "verified");

  await controller.amend({ text: "add a clarifying note" });
  assert.equal(controller.getGoal().goalVersion, 2);

  planner.next = async (context) => ({
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: "obs",
    criterionIds: ["host-check"],
    kind: "finish",
    evidenceIds: [],
  });
  await controller.resume();

  // The v1 verification must not silently satisfy the v2 goal.
  assert.equal(controller.getSnapshot().state, "awaiting_verification");
  await store.close();
});

test("a cleanly recovered task (no dangling action) resumes with a plain resume() call", async () => {
  const storageRoot = await mkTempRoot();
  const created = await TaskStore.create({ originalRequest: "goal" }, { storageRoot });
  await created.append({ type: "action_started", payload: { actionId: "a1" } });
  await created.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  const taskId = created.taskId;
  await created.close();

  const reloaded = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reloaded.recoveryReason, "recovered");

  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const planner = {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "finish",
      evidenceIds: [],
    }),
  };
  const controller = new TaskController({ store: reloaded, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  assert.equal(controller.getSnapshot().pauseReason, "recovered");
  await controller.resume();
  assert.notEqual(controller.getSnapshot().state, "paused");
  await reloaded.close();
});
