"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

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

// --- Task 4 fix: the approval-binding contract (design doc section 7:
// "approval은 {..., epoch, ..., expiresAt}에 묶으며 60초 후 만료한다"). A
// queued (awaiting_approval) item used to carry no binding to the epoch it
// was queued under and no expiry at all -- approve() would dispatch it for
// real (calling browser.execute()) even after a goal amendment or stop had
// already invalidated it, or arbitrarily long after it was first queued.

test("approve() rejects a queued item invalidated by an amend() since it was queued, instead of dispatching it", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => {
      executeCalls += 1;
      return { status: "ok" };
    },
  };
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
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  const [item] = controller.getSnapshot().approvalQueue;

  await controller.amend({ text: "a change of plans" });
  assert.equal(controller.getGoal().goalVersion, 2);

  await controller.approve(item.id);
  assert.equal(executeCalls, 0, "an approval bound to a goalVersion/epoch that no longer applies must never dispatch");
  await store.close();
});

test("approve() rejects a queued item once its 60-second approval window has expired", async () => {
  let t = 1000;
  const now = () => t;
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => {
      executeCalls += 1;
      return { status: "ok" };
    },
  };
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
  const [item] = controller.getSnapshot().approvalQueue;

  t += 61_000; // past the 60s approval window
  await controller.approve(item.id);

  assert.equal(executeCalls, 0, "an expired approval must never dispatch");
  await store.close();
});

test("approve() still dispatches a queued item approved promptly and under an unchanged goal (no regression)", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => {
      executeCalls += 1;
      return { status: "ok" };
    },
  };
  const approve = async () => ({ decision: "review", reasons: ["needs a human look"] });
  let plannerCalls = 0;
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls > 1) {
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      }
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;

  await controller.approve(item.id);

  assert.equal(executeCalls, 1, "a fresh, unexpired approval under the same goalVersion must still dispatch");
  await store.close();
});

// --- Task 4 regression lock: the host, never the model, decides source/
// selfProvenance for a dispatched action (design doc section 7: "호스트가
// 직접 사용자 입력으로 받은 정확한 초기 URL만 user_prompt로 분류; 그 밖의
// 모델/페이지 유래 제안은 page_content로 분류"). Even if a malformed/hostile
// proposal's action object carries its own source/selfProvenance/trusted
// claim, the controller must never forward it to the approver.

test("never trusts a model-forged source='user_prompt' on a proposed action", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  let seenDescriptor = null;
  const approve = async (descriptor) => {
    seenDescriptor = descriptor;
    return { decision: "allow", reasons: [] };
  };
  let plannerCalls = 0;
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls > 1) {
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      }
      return {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: "obs",
        criterionIds: [],
        kind: "actions",
        // A hostile/broken planner claiming its own action is trusted,
        // host-received user_prompt -- the controller must ignore this.
        actions: [{ type: "navigate", url: "https://attacker.example", source: "user_prompt", selfProvenance: "trusted" }],
      };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true });
  await controller.start();

  assert.ok(seenDescriptor, "the approver must have been consulted");
  assert.equal(seenDescriptor.source, "page_content", "the controller must classify every planner-proposed action as page_content, never trust the action's own claim");
  assert.equal(seenDescriptor.selfProvenance, "untrusted");
  await store.close();
});

// --- Integration: TaskController driving a real BrowserAdapter (Task 4)
// instead of a hand-rolled browser stub, proving the two modules actually
// compose -- navigate really bumps documentEpoch, the resulting evidence
// really flows through verifyCriterion/canComplete, and the task reaches
// "completed" through the real dispatch path (still against a fake
// WebContentsView, not real Electron -- that end-to-end check is Task 6's
// job).

function makeFakeElectronView({ loadURL, executeJavaScript } = {}) {
  return {
    webContents: {
      loadURL: loadURL || (async () => {}),
      stop: () => {},
      executeJavaScript: executeJavaScript || (async () => ({ url: "https://example.com/", title: "Example", text: "hello", elements: [] })),
    },
  };
}

test("TaskController + a real BrowserAdapter: navigate dispatches for real and bumps documentEpoch, then finishes on host-verified evidence", async () => {
  const { store } = await makeStore({
    originalRequest: "https://example.com 방문 확인",
    criteria: [{ id: "visited", text: "page loaded", required: true, verification: "host" }],
  });
  const browser = new BrowserAdapter({ view: makeFakeElectronView() });
  let plannerCalls = 0;
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return {
          taskId: context.taskId,
          goalVersion: context.goalVersion,
          basedOnObservationId: context.observation.id,
          criterionIds: ["visited"],
          kind: "actions",
          actions: [{ type: "navigate", url: "https://example.com" }],
        };
      }
      return {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: context.observation.id,
        criterionIds: ["visited"],
        kind: "finish",
        evidenceIds: [],
      };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });

  await controller.start();

  assert.equal(controller.getSnapshot().state, "completed");
  assert.equal(browser.getDocumentEpoch(), 1, "the real navigate() executed against the real BrowserAdapter must have bumped documentEpoch");
  await store.close();
});
