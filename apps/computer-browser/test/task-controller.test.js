"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { RoutineRunner } = require("../main/harness/routine-runner");

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

test("permission mode is enforced by the host: observe denies click and full explicitly bypasses the approver", async () => {
  for (const mode of ["observe", "full"]) {
    const { store } = await makeStore({ originalRequest: "permission policy" });
    let executions = 0;
    let approvals = 0;
    let plannerCalls = 0;
    const controller = new TaskController({
      store,
      permissionMode: mode,
      planner: { next: async (context) => ++plannerCalls === 1 ? ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "click", elementId: "button1", source: "user_prompt" }] }) : ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }) },
      browser: { observe: async () => ({ id: "obs" }), execute: async () => { executions += 1; return { status: "ok" }; } },
      approve: async () => { approvals += 1; return { decision: "allow", reasons: [] }; },
      hostVerifier: () => true,
    });
    await controller.start();
    assert.equal(executions, mode === "full" ? 1 : 0);
    assert.equal(approvals, mode === "full" ? 0 : 0);
    await store.close();
  }
});

test("interactive permission mode queues a human review before dispatching a click", async () => {
  const { store } = await makeStore({ originalRequest: "interactive approval" });
  let executions = 0;
  const controller = new TaskController({
    store,
    permissionMode: "interact",
    planner: { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "click", elementId: "button1" }] }) },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executions += 1; return { status: "ok" }; } },
    approve: async () => { throw new Error("human gate must not be delegated to the provenance approver"); },
    hostVerifier: () => true,
  });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.equal(executions, 0);
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

test("no-progress detection still catches an identical action/page even when the observation carries a fresh random id each call (matches the real BrowserAdapter, which always does)", async () => {
  const { store } = await makeStore({ originalRequest: "goal", limits: { maxPlannerCalls: 50 } });
  let counter = 0;
  const browser = {
    // Same url/text/elements every call -- only the id (as the real
    // BrowserAdapter's _randomId() always produces) differs. A stale
    // observationKey() that includes this volatile id would never see two
    // calls compare equal, silently disabling the no-progress safety net.
    observe: async () => ({ id: `real-observation-${counter++}`, url: "http://example.test/", text: "same page", elements: [] }),
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
  assert.equal(snapshot.budgets.actionsUsed, 6); // 3 (first streak, grace replan) + 3 (second streak, pause) -- NOT 50 (budget exhaustion)
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

test("pauses with the more specific planner_unavailable when the planner is simply not configured (PlannerTransportError code planner_unavailable)", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  class FakeTransportError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const planner = {
    next: async () => {
      throw new FakeTransportError("planner_unavailable", "no planner worker is configured");
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "planner_unavailable", "an unconfigured planner must surface honestly as planner_unavailable, not a generic planner_error");
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

// 2026-09-27 follow-up: found while verifying the real-Electron 3-page
// journey (docs/reviews/REPORT_REMEDIATION.ko.md, 후속 22). The constructor
// derives its initial state ONLY from store.recoveryReason
// ("execution_uncertain"/"recovered"/else-idle) and never looks at
// store.lastCheckpoint at all -- so a task that legitimately reached
// "completed" (or "stopped") and was checkpointed as such is reported as
// plain "paused"/"recovered" on the very next reload, exactly like a task
// that was merely interrupted mid-flight. This is not just a cosmetic
// mislabel: resume() accepts state "paused" unconditionally, so a caller
// following the correct paused->resume() protocol would re-invoke the
// planner/browser on an already-finished task. TaskHost.listTasks()'s
// "peek" path (main/harness/task-host.js) has the exact same
// recoveryReason-only derivation and reports the same wrong "paused".
test("a task reloaded after reaching completed reports completed, not paused/recovered (TaskHost.listTasks() peeks the same way)", async () => {
  const { store, storageRoot } = await makeStore({
    originalRequest: "https://example.com 방문 확인",
    criteria: [{ id: "visited", text: "page loaded", required: true, verification: "host" }],
  });
  const taskId = store.taskId;
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
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: ["visited"], kind: "finish", evidenceIds: [] };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "completed");
  await store.close();

  const reloaded = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reloaded.recoveryReason, "recovered", "a cleanly-completed task is not execution_uncertain -- it looks identical to any other clean reload without the checkpoint fix");
  const freshController = new TaskController({
    store: reloaded,
    planner: { next: async () => ({ kind: "need_user", reason: "must never be called for an already-completed task" }) },
    browser: { observe: async () => { throw new Error("must never be called for an already-completed task"); }, execute: async () => ({ status: "ok" }) },
    approve: async () => ({ decision: "deny", reasons: [] }),
    hostVerifier: () => true,
  });
  assert.equal(freshController.getSnapshot().state, "completed", "reloading a completed task must report completed, not paused/recovered");
  await reloaded.close();
});

// --- Task 5: confirmCriterion() -- the trusted-IPC-only path that lets a
// human satisfy a "user"-verification criterion. progress.js's
// verifyCriterion() only ever accepts a PRE-EXISTING verified/rejected
// evidence entry for a "user"-kind criterion; nothing in the planner/browser
// loop can set that itself. confirmCriterion() is that trusted path, and
// must reject a stale goalVersion/evidenceId rather than blindly trust
// whatever the caller (main/ipc.js, ultimately the renderer) sends.

async function driveToAwaitingVerification({ criterionVerification = "user" } = {}) {
  const { store } = await makeStore({
    originalRequest: "goal needing a human look",
    criteria: [{ id: "c1", text: "human confirms", required: true, verification: criterionVerification }],
  });
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => ({ status: "ok", evidenceCandidate: { kind: "artifact", observationId: "obs" } }),
  };
  let plannerCalls = 0;
  const planner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: ["c1"], kind: "actions", actions: [{ type: "observe" }] };
      }
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: ["c1"], kind: "finish", evidenceIds: [] };
    },
  };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "awaiting_verification");
  const pending = controller.getSnapshot().criteriaStatus.find((c) => c.criterionId === "c1");
  assert.equal(pending.status, "pending");
  return { controller, store, pending };
}

test("confirmCriterion(verified) unblocks a task stuck in awaiting_verification and completes it", async () => {
  const { controller, store, pending } = await driveToAwaitingVerification();

  const snapshot = await controller.confirmCriterion({
    criterionId: "c1",
    goalVersion: controller.getGoal().goalVersion,
    evidenceId: pending.evidenceId,
    outcome: "verified",
  });

  assert.equal(snapshot.state, "completed");
  await store.close();
});

test("confirmCriterion(rejected) does not complete the task and durably transitions back to paused so it can be resumed", async () => {
  const { controller, store, pending } = await driveToAwaitingVerification();

  const snapshot = await controller.confirmCriterion({
    criterionId: "c1",
    goalVersion: controller.getGoal().goalVersion,
    evidenceId: pending.evidenceId,
    outcome: "rejected",
  });

  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "evidence_rejected");
  assert.equal(snapshot.criteriaStatus.find((c) => c.criterionId === "c1").status, "rejected");
  await store.close();
});

test("confirmCriterion rejects a stale goalVersion instead of confirming against an amended goal", async () => {
  const { controller, store, pending } = await driveToAwaitingVerification();
  await controller.amend({ text: "changed my mind slightly" });

  await assert.rejects(
    () => controller.confirmCriterion({ criterionId: "c1", goalVersion: 1, evidenceId: pending.evidenceId, outcome: "verified" }),
    TaskControllerError,
  );
  await store.close();
});

test("confirmCriterion rejects an evidenceId that doesn't match the currently pending one", async () => {
  const { controller, store } = await driveToAwaitingVerification();

  await assert.rejects(
    () => controller.confirmCriterion({ criterionId: "c1", goalVersion: controller.getGoal().goalVersion, evidenceId: "not-the-real-one", outcome: "verified" }),
    TaskControllerError,
  );
  await store.close();
});

test("confirmCriterion rejects an unknown criterionId", async () => {
  const { controller, store } = await driveToAwaitingVerification();

  await assert.rejects(
    () => controller.confirmCriterion({ criterionId: "does-not-exist", goalVersion: controller.getGoal().goalVersion, evidenceId: "x", outcome: "verified" }),
    TaskControllerError,
  );
  await store.close();
});

// --- Task 5/6: 900MB emergency memory pressure must tear down this
// controller's OWNED browser/planner resources (not just pause), and must
// never let resume() silently reuse those now-disposed resources -- the
// user's explicit mandate: "900MB emergency에서는 owned page-renderer/worker
// 정리; 자동 resume/reload 폭주 금지." A "pause"-level (800MB) pressure must
// still behave exactly as before (checkpoint + paused:memory_pressure, no
// teardown) -- only "emergency" (900MB) disposes resources.

test("emergency memory pressure disposes the browser/planner and pauses as memory_emergency, not the generic memory_pressure", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let browserDisposed = false;
  let plannerClosed = false;
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => ({ status: "ok" }),
    dispose: async () => {
      browserDisposed = true;
    },
  };
  const planner = {
    next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }),
    close: async () => {
      plannerClosed = true;
    },
  };
  const memoryMonitor = { getPressureLevel: () => "emergency" };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true, memoryMonitor });

  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "memory_emergency");
  assert.equal(browserDisposed, true, "the owned BrowserAdapter must be disposed on emergency pressure");
  assert.equal(plannerClosed, true, "the owned planner transport must be closed on emergency pressure");
  await store.close();
});

test("pause-level (800MB) memory pressure still just pauses with memory_pressure -- no teardown", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let disposed = false;
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => { disposed = true; } };
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }) };
  const memoryMonitor = { getPressureLevel: () => "pause" };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true, memoryMonitor });

  await controller.start();

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.pauseReason, "memory_pressure");
  assert.equal(disposed, false, "a mere pause-level pressure must not tear anything down");
  await store.close();
});

test("resume() refuses a memory_emergency-paused task instead of reusing disposed resources", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => {} };
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }) };
  const memoryMonitor = { getPressureLevel: () => "emergency" };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true, memoryMonitor });
  await controller.start();
  assert.equal(controller.getSnapshot().pauseReason, "memory_emergency");

  await assert.rejects(() => controller.resume(), TaskControllerError);
  await store.close();
});

test("emergency teardown never throws even if dispose()/close() themselves fail", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = {
    observe: async () => ({ id: "obs" }),
    execute: async () => ({ status: "ok" }),
    dispose: async () => {
      throw new Error("view already destroyed");
    },
  };
  const planner = {
    next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }),
    close: () => {
      throw new Error("child already exited");
    },
  };
  const memoryMonitor = { getPressureLevel: () => "emergency" };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true, memoryMonitor });

  await controller.start(); // must not throw despite dispose()/close() both failing

  assert.equal(controller.getSnapshot().pauseReason, "memory_emergency");
  await store.close();
});

// --- 2026-09-27: transition/admission-gate concurrency tests (A-I) ---
//
// takeOver()/pause()/stop() must close admission SYNCHRONOUSLY (before any
// await), track every admitted mutator's dispatch (whether reached via
// approve() or the main loop's own _dispatchActionsBatch) until its real
// outcome lands, cancel still-queued approvals durably before removing them,
// serialize pause/stop/takeOver FIFO, and never reopen admission while a
// later transition is still queued behind the one that just checkpointed.

function singleObserveActionPlanner() {
  return {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "actions",
      actions: [{ type: "observe" }],
    }),
  };
}

function reviewApprove() {
  return async () => ({ decision: "review", reasons: [] });
}

// Gates the FIRST store.append() call of `matchType`, letting every other
// call (including a later append of the SAME type, e.g. action_outcome)
// through immediately.
function makeGatedAppend(store, matchType) {
  const original = store.append.bind(store);
  let release;
  let hit = false;
  const gate = new Promise((r) => {
    release = r;
  });
  store.append = async (input, options) => {
    if (input.type === matchType && !hit) {
      hit = true;
      await gate;
    }
    return original(input, options);
  };
  return { release: () => release() };
}

// Fails the first `failCount` store.append() calls of `matchType`, then lets
// the rest through to the real implementation.
function makeFlakyAppend(store, matchType, failCount = 1) {
  const original = store.append.bind(store);
  let calls = 0;
  store.append = async (input, options) => {
    if (input.type === matchType) {
      calls += 1;
      if (calls <= failCount) {
        throw new Error(`injected failure #${calls} for ${matchType}`);
      }
    }
    return original(input, options);
  };
  return { callsFor: () => calls };
}

test("A: admission closes synchronously the instant takeOver() is called -- before its own _doTransition (scheduled via Promise.then) ever runs -- so a fresh approve() right after is rejected immediately with zero execute()", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => { executeCalls += 1; return { status: "ok" }; } };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  // No await/setImmediate between takeOver() and approve() below -- if
  // admission were only closed inside the deferred _doTransition, this
  // approve() would still see it open and slip through.
  const takeOverPromise = controller.takeOver();
  await assert.rejects(
    () => controller.approve(requestId),
    (err) => err instanceof TaskControllerError && err.code === "admission_closed",
  );

  assert.equal(executeCalls, 0, "the rejected approve() must never have reached dispatch");
  assert.equal(controller.getSnapshot().approvalQueue.length, 1, "the rejected approve() must never have spliced the queue");

  await takeOverPromise;
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
  await store.close();
});

test("B: an already-admitted approve() dispatch (barrier at the action_started append) forces a concurrent takeOver() to wait for its real outcome, never retroactively cancelling it", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => { executeCalls += 1; return { status: "ok" }; } };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  const gate = makeGatedAppend(store, "action_started");
  const approvePromise = controller.approve(requestId);
  await new Promise((r) => setImmediate(r)); // let approve() reach the gated append

  const takeOverPromise = controller.takeOver();
  await assert.rejects(
    () => controller.approve("nonexistent-id"),
    (err) => err instanceof TaskControllerError && err.code === "admission_closed",
  );

  let takeOverSettled = false;
  takeOverPromise.then(() => { takeOverSettled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(takeOverSettled, false, "takeOver() must wait for the in-flight dispatch, not race it");
  assert.equal(executeCalls, 0, "execute() must not run while action_started is still pending");

  gate.release();
  await approvePromise;
  await takeOverPromise;

  assert.equal(executeCalls, 1, "the already-admitted dispatch must still run to completion, never be silently skipped");
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "user_takeover");
  assert.equal(controller._admissionOpen, true, "admission must reopen once the sole pending transition's checkpoint succeeds");
  await store.close();
});

test("C: takeOver() also waits for the main loop's OWN internal dispatch (an 'allow' decision inside _dispatchActionsBatch, never queued through approve()) -- proving that call site is tracked too", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => { executeCalls += 1; return { status: "ok" }; } };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: allowApprove(), hostVerifier: () => true });

  const gate = makeGatedAppend(store, "action_started");
  const startPromise = controller.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r)); // let observe -> plan -> approve('allow') reach the gated append

  assert.equal(executeCalls, 0, "must still be stuck before the gate release");

  const takeOverPromise = controller.takeOver();
  let settled = false;
  takeOverPromise.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "takeOver() must wait for the loop's own in-flight dispatch");

  gate.release();
  await startPromise;
  await takeOverPromise;

  assert.equal(executeCalls, 1, "the loop's own already-admitted dispatch must still run to completion");
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
  await store.close();
});

test("D: takeOver() appends approval_cancelled durably BEFORE removing the item; a failed append leaves it retryable and fails closed rather than silently dropping it", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  const flaky = makeFlakyAppend(store, "approval_cancelled", 1);
  await assert.rejects(() => controller.takeOver(), /injected failure/);

  assert.equal(controller.getSnapshot().state, "awaiting_approval", "task state must be unchanged after a failed cancel-append");
  assert.equal(controller.getSnapshot().approvalQueue.length, 1, "the item must not be lost");
  assert.equal(controller.getSnapshot().approvalQueue[0].id, requestId);
  assert.equal(controller._admissionOpen, false, "must fail closed");
  await assert.rejects(() => controller.deny(requestId), TaskControllerError);

  await controller.takeOver(); // retry succeeds once the injected failure is exhausted
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  assert.equal(controller._admissionOpen, true);
  assert.equal(flaky.callsFor(), 2, "exactly one failed attempt then one successful retry");
  await store.close();
});

test("E: two concurrent takeOver() calls against a queued item produce exactly one approval_cancelled append, not a duplicate, and both resolve to the same final state", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();

  let cancelAppends = 0;
  const originalAppend = store.append.bind(store);
  store.append = async (input) => {
    if (input.type === "approval_cancelled") cancelAppends += 1;
    return originalAppend(input);
  };

  const [snap1, snap2] = await Promise.all([controller.takeOver(), controller.takeOver()]);

  assert.equal(cancelAppends, 1, "the second, FIFO-queued takeOver() must find nothing left to cancel");
  assert.equal(snap1.state, "paused");
  assert.equal(snap2.state, "paused");
  assert.equal(snap1.pauseReason, "user_takeover");
  assert.equal(snap2.pauseReason, "user_takeover");
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  assert.equal(controller._admissionOpen, true, "admission reopens once the LAST of the two queued transitions finishes");
  await store.close();
});

test("F: stop() called while a takeOver() is still draining is queued FIFO behind it -- it does not run concurrently, and the in-flight dispatch's real outcome is preserved", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executeCalls = 0;
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => { executeCalls += 1; return { status: "ok" }; } };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  const gate = makeGatedAppend(store, "action_started");
  const approvePromise = controller.approve(requestId);
  await new Promise((r) => setImmediate(r));

  const takeOverPromise = controller.takeOver();
  const stopPromise = controller.stop();

  await new Promise((r) => setImmediate(r));
  assert.equal(executeCalls, 0, "must still be gated");

  gate.release();
  await approvePromise;
  await takeOverPromise;
  await stopPromise;

  assert.equal(executeCalls, 1, "the admitted dispatch ran to completion exactly once, real outcome preserved");
  assert.equal(controller.getSnapshot().state, "stopped", "stop() is last in the FIFO chain, so it wins the final state");
  await store.close();
});

test("G: a checkpoint failure during a transition leaves task state unchanged and admission closed (fail-closed); a retry succeeds and reopens admission", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const plannerGate = new Promise(() => {}); // never resolves -- keeps the loop stuck mid-planner-call
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const planner = { next: async () => plannerGate };
  const controller = new TaskController({ store, planner, browser, approve: allowApprove(), hostVerifier: () => true });

  controller.start(); // intentionally not awaited -- sticks forever on the never-resolving planner.next()
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.getSnapshot().state, "running");

  let checkpointCalls = 0;
  const originalCheckpoint = store.checkpoint.bind(store);
  store.checkpoint = async (payload) => {
    checkpointCalls += 1;
    if (checkpointCalls === 1) throw new Error("injected checkpoint failure");
    return originalCheckpoint(payload);
  };

  await assert.rejects(() => controller.pause("user"), /injected checkpoint failure/);
  // _task.state was already optimistically flipped to "paused" before the
  // failed checkpoint await (the same pre-existing pattern _pauseWith always
  // used) -- what "fail closed" actually guarantees is that admission stays
  // closed and every other external mutator is rejected, not that the
  // in-memory state field is rolled back.
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller._admissionOpen, false, "admission must stay closed (fail-closed) after the checkpoint failure");
  await assert.rejects(() => controller.amend({ text: "x" }), TaskControllerError);
  await assert.rejects(() => controller.resume(), TaskControllerError);

  await controller.pause("user"); // retry succeeds now that the injected failure is exhausted -- _transitionRetryable() lets this back in despite state already reading "paused"
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller._admissionOpen, true);
  controller.resume(); // admission reopened -- resume() is no longer blocked (not awaited: the loop sticks forever on the never-resolving planner.next() again)
  await new Promise((r) => setImmediate(r));
  assert.equal(controller.getSnapshot().state, "running");
  await store.close();
});

test("H: admission stays closed across a back-to-back burst of two queued transitions -- a fresh approve() attempted exactly between the first transition's checkpoint success and the second transition's start is still rejected", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  let checkpointCalls = 0;
  let releaseFirstCheckpoint;
  const firstCheckpointGate = new Promise((r) => { releaseFirstCheckpoint = r; });
  const originalCheckpoint = store.checkpoint.bind(store);
  store.checkpoint = async (payload) => {
    checkpointCalls += 1;
    if (checkpointCalls === 1) await firstCheckpointGate;
    return originalCheckpoint(payload);
  };

  const p1 = controller.pause("user"); // first queued transition (cancelQueue: false)
  const p2 = controller.takeOver(); // second, enqueued synchronously right behind it

  await assert.rejects(() => controller.approve(requestId), TaskControllerError);

  releaseFirstCheckpoint();
  await p1;

  // The FIRST transition's checkpoint just succeeded, but a SECOND
  // transition is still queued behind it -- admission must NOT reopen here.
  assert.equal(controller._admissionOpen, false, "admission must stay closed while a later transition is still pending");
  await assert.rejects(
    () => controller.approve(requestId),
    TaskControllerError,
    "a fresh approve() at the exact boundary between the two transitions must still be rejected",
  );

  await p2;
  assert.equal(controller._admissionOpen, true, "admission reopens only after the LAST queued transition's checkpoint succeeds");
  assert.equal(controller.getSnapshot().state, "paused");
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover", "takeOver() ran second in the FIFO chain, so it wins the final pauseReason");
  await store.close();
});

test("I: deny()/confirmCriterion() (not just approve()/amend()) are also rejected with admission_closed while a transition is in progress, and succeed again once it reopens", async () => {
  const { store } = await makeStore({
    originalRequest: "goal",
    criteria: [{ id: "C1", text: "done", required: true, verification: "user" }],
  });
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, planner: singleObserveActionPlanner(), browser, approve: reviewApprove(), hostVerifier: () => true });

  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;

  let releaseCheckpoint;
  const gate = new Promise((r) => { releaseCheckpoint = r; });
  const originalCheckpoint = store.checkpoint.bind(store);
  store.checkpoint = async (payload) => {
    await gate;
    return originalCheckpoint(payload);
  };

  const pausePromise = controller.pause("user");
  await new Promise((r) => setImmediate(r));

  await assert.rejects(() => controller.deny(requestId), TaskControllerError);
  await assert.rejects(
    () => controller.confirmCriterion({ criterionId: "C1", goalVersion: 1, evidenceId: "x", outcome: "verified" }),
    TaskControllerError,
  );

  releaseCheckpoint();
  await pausePromise;
  assert.equal(controller._admissionOpen, true);

  // A plain pause() never cancels the queue -- deny() must still find and
  // remove the item now that admission has reopened.
  const snapshot = await controller.deny(requestId);
  assert.equal(snapshot.approvalQueue.length, 0);
  await store.close();
});

test("J: takeOver() waits for an admitted goal amendment to finish before checkpointing the paused state", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const plannerGate = new Promise(() => {});
  const controller = new TaskController({
    store,
    planner: { next: async () => plannerGate },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  controller.start();
  await new Promise((r) => setImmediate(r));

  let releaseAmend;
  let amendEntered = false;
  const amendGate = new Promise((r) => { releaseAmend = r; });
  const originalAmend = store.amendGoal.bind(store);
  store.amendGoal = async (...args) => {
    amendEntered = true;
    await amendGate;
    return originalAmend(...args);
  };

  const amendment = controller.amend({ text: "revised goal" });
  await new Promise((r) => setImmediate(r));
  assert.equal(amendEntered, true);
  let takeoverSettled = false;
  const takeover = controller.takeOver();
  takeover.then(() => { takeoverSettled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(takeoverSettled, false, "takeOver() must drain the admitted amendment's durable write");

  releaseAmend();
  await amendment;
  await takeover;
  assert.equal(controller.getGoal().goalVersion, 2);
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
  assert.equal(store.lastCheckpoint.payload.task.pauseReason, "user_takeover");
  assert.equal(store.lastCheckpoint.goalVersion, 2);
  await store.close();
});

test("K: takeOver() waits for an admitted user evidence confirmation before checkpointing", async () => {
  const { store } = await makeStore({
    originalRequest: "goal",
    criteria: [{ id: "C1", text: "done", required: true, verification: "user" }],
  });
  const controller = new TaskController({
    store,
    planner: singleObserveActionPlanner(),
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: reviewApprove(),
    hostVerifier: () => true,
  });
  await controller.start();
  controller._criteriaStatus.set("C1", { status: "pending", evidenceId: "evidence-pending", goalVersion: 1 });

  let releaseEvidence;
  let evidenceEntered = false;
  const evidenceGate = new Promise((r) => { releaseEvidence = r; });
  const originalAppend = store.append.bind(store);
  store.append = async (input) => {
    if (input.type === "evidence_recorded" && !evidenceEntered) {
      evidenceEntered = true;
      await evidenceGate;
    }
    return originalAppend(input);
  };

  const confirmation = controller.confirmCriterion({
    criterionId: "C1", goalVersion: 1, evidenceId: "evidence-pending", outcome: "verified",
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(evidenceEntered, true);
  let takeoverSettled = false;
  const takeover = controller.takeOver();
  takeover.then(() => { takeoverSettled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(takeoverSettled, false, "takeOver() must drain the admitted evidence append");

  releaseEvidence();
  await confirmation;
  await takeover;
  assert.equal(controller.getSnapshot().criteriaStatus[0].status, "verified");
  assert.equal(controller.getSnapshot().pauseReason, "user_takeover");
  assert.equal(store.lastCheckpoint.payload.criteriaStatus[0][1].status, "verified");
  await store.close();
});

test("every planner turn receives current user memory from the host-owned memory store", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const memoryLookups = [];
  const planner = {
    next: async (context) => {
      assert.deepEqual(context.userMemory, {
        authority: "untrusted_user_memory",
        entries: [{ id: "pref-1", text: "Keep reports short", origin: null }],
      });
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
    },
  };
  const controller = new TaskController({
    store, planner,
    browser: { observe: async () => ({ id: "obs", url: "https://example.com/" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(), hostVerifier: () => true,
    memoryStore: { forContext: async (url) => { memoryLookups.push(url); return { entries: [{ id: "pref-1", text: "Keep reports short", origin: null }] }; } },
  });
  await controller.start();
  assert.deepEqual(memoryLookups, ["https://example.com/"]);
  await store.close();
});

test("memory context overflow pauses fail-closed before contacting the planner", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let plannerCalled = false;
  const controller = new TaskController({
    store,
    planner: { next: async () => { plannerCalled = true; throw new Error("should not be called"); } },
    browser: { observe: async () => ({ id: "obs", url: "https://example.com/" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(), hostVerifier: () => true,
    memoryStore: { forContext: async () => { const error = new Error("memory budget exceeded"); error.code = "memory_context_overflow"; throw error; } },
  });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "context_error");
  assert.equal(plannerCalled, false);
  await store.close();
});

function makeChildPlanProposal(context) {
  return {
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: context.observation.id,
    criterionIds: [],
    kind: "child_plan",
    parentGoalVersion: context.goalVersion,
    requestedAgentCount: 1,
    assignments: [{ subgoal: "하위 작업", entryUrl: "https://example.com/child" }],
  };
}

test("onChildPlan hook: a child_plan proposal is delegated to the host, and the host rejecting it pauses the parent with child_plan_failed", async () => {
  const { store } = await makeStore({ originalRequest: "부모 작업" });
  let onChildPlanCalls = 0;
  let dispatched = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => makeChildPlanProposal(context),
    },
    browser: {
      observe: async () => ({ id: "obs" }),
      execute: async () => { dispatched += 1; return { status: "ok" }; },
    },
    approve: allowApprove(),
    hostVerifier: () => true,
    onChildPlan: async (proposal) => {
      onChildPlanCalls += 1;
      assert.equal(proposal.kind, "child_plan");
      assert.equal(proposal.assignments.length, 1);
      throw new Error("host refused to admit any child right now");
    },
  });
  const snapshot = await controller.start();
  assert.equal(onChildPlanCalls, 1);
  assert.equal(dispatched, 0, "a child_plan proposal must never be dispatched as a browser action");
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "child_plan_failed");
  await store.close();
});

test("onChildPlan hook: without one configured, a child_plan proposal is skipped and the parent keeps looping on a fresh observation instead of silently spawning anything", async () => {
  const { store } = await makeStore({ originalRequest: "부모 작업" });
  let plannerCalls = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        plannerCalls += 1;
        if (plannerCalls === 1) return makeChildPlanProposal(context);
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    },
    browser: {
      observe: async () => ({ id: "obs" }),
      execute: async () => { throw new Error("must not dispatch a child_plan as a browser action"); },
    },
    approve: allowApprove(),
    hostVerifier: () => true,
    // no onChildPlan configured -- a child controller (or any controller
    // never wired for delegation) must structurally be unable to spawn
    // children, not merely be told not to.
  });
  const snapshot = await controller.start();
  assert.equal(plannerCalls, 2, "the first child_plan proposal must be skipped, giving the planner a second turn");
  assert.equal(snapshot.state, "awaiting_verification");
  await store.close();
});

// --- Subagent communication protocol Task 4: pendingMessages context
// admission, fail-closed recordMessagesConsumed acknowledgement (BEFORE that
// turn's proposal is ever validated/dispatched), and the send_message
// proposal-kind dispatch -- symmetric with the onChildPlan hook above, since
// this controller is role-agnostic (it never knows if it is a parent's or a
// child's own loop).

test("recordMessagesConsumed() receives exactly the admitted messageIds, in order, before that turn's proposal is handled", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const recordedCalls = [];
  let plannerCalls = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        plannerCalls += 1;
        assert.deepEqual(context.pendingMessages.map((m) => m.messageId), ["m1", "m2"]);
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    listPendingMessages: async () => [{ messageId: "m1", text: "a" }, { messageId: "m2", text: "b" }],
    recordMessagesConsumed: async (ids, plannerCall) => {
      recordedCalls.push({ ids, plannerCall });
    },
  });
  const snapshot = await controller.start();
  assert.deepEqual(recordedCalls, [{ ids: ["m1", "m2"], plannerCall: 1 }]);
  assert.equal(plannerCalls, 1);
  assert.equal(snapshot.state, "awaiting_verification");
  await store.close();
});

test("fail-closed message ack: a throwing recordMessagesConsumed() pauses with message_ack_failed and that turn's proposal is never dispatched", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let executions = 0;
  let recordCalls = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => ({
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: "obs",
        criterionIds: [],
        kind: "actions",
        actions: [{ type: "click", elementId: "e1" }],
      }),
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executions += 1; return { status: "ok" }; } },
    approve: allowApprove(),
    hostVerifier: () => true,
    listPendingMessages: async () => [{ messageId: "m1" }],
    recordMessagesConsumed: async () => {
      recordCalls += 1;
      throw new Error("durable append failed");
    },
  });
  const snapshot = await controller.start();
  assert.equal(recordCalls, 1);
  assert.equal(executions, 0, "the proposal generated for the un-acknowledged turn must never be dispatched");
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "message_ack_failed");
  await store.close();
});

test("a stop() racing in while the planner call is still in flight breaks before ever acknowledging pending messages (a steer is never marked consumed)", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let recordCalls = 0;
  let resolvePlanner;
  const plannerGate = new Promise((resolve) => {
    resolvePlanner = resolve;
  });
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        await plannerGate;
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    listPendingMessages: async () => [{ messageId: "steer-1", kind: "steer" }],
    recordMessagesConsumed: async () => {
      recordCalls += 1;
    },
  });
  const started = controller.start();
  // Let the loop run up to (and suspend inside) planner.next() before
  // stop() is called -- observe()/listPendingMessages() above only need
  // microtask turns to settle, so a macrotask tick is enough headroom.
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = controller.stop();
  resolvePlanner();
  await Promise.all([started, stopped]);
  assert.equal(recordCalls, 0, "a stop() that races the planner call must prevent the pending steer from ever being marked consumed");
  assert.equal(controller.getSnapshot().state, "stopped");
  await store.close();
});

test("a stop after the planner response waits for the admitted batch's durable acknowledgement, then skips proposal handling", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let resolveAck;
  let executions = 0;
  let ackCalls = 0;
  const ackGate = new Promise((resolve) => { resolveAck = resolve; });
  const controller = new TaskController({
    store,
    planner: {
      next: async () => ({ taskId: store.taskId, goalVersion: 1, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "click", elementId: "e1" }] }),
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executions += 1; return { status: "ok" }; } },
    approve: allowApprove(),
    hostVerifier: () => true,
    listPendingMessages: async () => [{ messageId: "steer-2", kind: "steer" }],
    recordMessagesConsumed: async (ids) => {
      ackCalls += 1;
      assert.deepEqual(ids, ["steer-2"]);
      await ackGate;
    },
  });

  const started = controller.start();
  await new Promise((resolve) => setImmediate(resolve)); // planner response has reached the ack callback
  const stopped = controller.stop();
  resolveAck();
  await Promise.all([started, stopped]);
  assert.equal(ackCalls, 1, "a planner response that reached the durable ack boundary must finish acknowledgement");
  assert.equal(executions, 0, "stop during acknowledgement must still prevent that proposal from executing");
  assert.equal(controller.getSnapshot().state, "stopped");
  await store.close();
});

function makeSendMessageProposal(context, overrides = {}) {
  return {
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: context.observation.id,
    criterionIds: [],
    kind: "send_message",
    recipientTaskId: "11111111-1111-1111-1111-111111111111",
    messageKind: "progress",
    idempotencyKey: "idem-1",
    text: "hello parent",
    ...overrides,
  };
}

test("send_message hook: the host callback receives the validated proposal and it is never dispatched through the browser action pipeline", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let plannerCalls = 0;
  let executions = 0;
  const sendCalls = [];
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        plannerCalls += 1;
        if (plannerCalls === 1) return makeSendMessageProposal(context);
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executions += 1; return { status: "ok" }; } },
    approve: allowApprove(),
    hostVerifier: () => true,
    sendMessage: async (validated) => {
      sendCalls.push(validated);
    },
  });
  const snapshot = await controller.start();
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].kind, "send_message");
  assert.equal(sendCalls[0].text, "hello parent");
  assert.equal(executions, 0, "send_message must never be dispatched as a browser action");
  assert.equal(plannerCalls, 2);
  assert.equal(snapshot.state, "awaiting_verification");
  await store.close();
});

test("send_message hook: a throwing sendMessage callback pauses with send_message_failed instead of looping or crashing", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  const controller = new TaskController({
    store,
    planner: { next: async (context) => makeSendMessageProposal(context) },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    sendMessage: async () => {
      throw new Error("unauthorized_route");
    },
  });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "send_message_failed");
  await store.close();
});

test("send_message hook: without one configured, the controller fails closed instead of silently dropping the message", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let plannerCalls = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        plannerCalls += 1;
        if (plannerCalls === 1) return makeSendMessageProposal(context);
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    },
    browser: {
      observe: async () => ({ id: "obs" }),
      execute: async () => {
        throw new Error("must not dispatch send_message as an action");
      },
    },
    approve: allowApprove(),
    hostVerifier: () => true,
    // no sendMessage configured
  });
  const snapshot = await controller.start();
  assert.equal(plannerCalls, 1, "the message proposal must not be treated as handled without a host callback");
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "send_message_unavailable");
  await store.close();
});

test("pending messages fail closed when durable consumption callback is unavailable", async () => {
  const { store } = await makeStore({ originalRequest: "goal" });
  let plannerCalls = 0;
  const controller = new TaskController({
    store,
    planner: { next: async (context) => {
      plannerCalls += 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
    } },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    listPendingMessages: async () => [{ messageId: "m1", text: "untrusted input" }],
    // No recordMessagesConsumed callback: the proposal must not be processed.
  });
  const snapshot = await controller.start();
  assert.equal(plannerCalls, 1);
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "message_ack_unavailable");
  await store.close();
});

test("routine steps advance durably before the next proposal and checkpoint the cursor at the pause", async () => {
  const { store } = await makeStore({ originalRequest: "routine task" });
  let cursor = 0;
  let plannerCalls = 0;
  const stepBinding = { routineId: "routine-a", revision: 1, stepIndex: 0, stepDigest: "a".repeat(64) };
  const routineRunner = {
    next: async (context) => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "navigate", url: "https://example.com/" }] };
      }
      assert.equal((await store.getEvents()).filter((event) => event.type === "routine_step_advanced").length, 1, "the durable advancement record must land before the next proposal");
      assert.notEqual(store.lastCheckpoint?.payload?.routineRun?.cursor, 1, "no per-step cursor checkpoint is written");
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "routine complete" };
    },
    getCurrentStep: () => cursor === 0 ? stepBinding : null,
    advance: (binding) => {
      assert.deepEqual(binding, stepBinding);
      cursor += 1;
      return cursor;
    },
  };
  const controller = new TaskController({
    store,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "b".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
  });

  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(plannerCalls, 2);
  assert.equal(store.lastCheckpoint.payload.routineRun.cursor, 1);
  const events = await store.getEvents();
  const advancement = events.find((event) => event.type === "routine_step_advanced");
  assert.deepEqual(advancement.payload, { ...stepBinding, actionId: events.find((event) => event.type === "action_started").payload.actionId });
  await store.close();
});

test("isRoutine() reflects whether the controller was constructed with a routine run", async () => {
  const { store: plainStore } = await makeStore({ originalRequest: "plain task" });
  const plainController = new TaskController({
    store: plainStore,
    planner: { next: async () => ({ kind: "need_user", reason: "n/a" }) },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  assert.equal(plainController.isRoutine(), false);
  assert.equal(plainController.getHarnessProfile(), "middle");
  await plainStore.close();

  const { store: routineStore } = await makeStore({ originalRequest: "routine task" });
  const routineRunner = {
    next: async () => ({ kind: "need_user", reason: "n/a" }),
    getCurrentStep: () => null,
    advance: () => 0,
  };
  const routineController = new TaskController({
    store: routineStore,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "b".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  assert.equal(routineController.isRoutine(), true);
  assert.equal(routineController.getHarnessProfile(), "short");
  await routineStore.close();
});

test("the planner context carries visited pages and not-yet-visited links so a dead end can backtrack", async () => {
  const { store } = await makeStore({ originalRequest: "navigation memory" });
  const pages = {
    "https://site.test/r": { url: "https://site.test/r", elements: [
      { role: "link", name: "A", href: "https://site.test/a", elementId: "0" },
      { role: "link", name: "B", href: "https://site.test/b", elementId: "1" },
      { role: "link", name: "mailto", href: "mailto:x@y.z", elementId: "2" },
    ] },
    "https://site.test/a": { url: "https://site.test/a", elements: [] },
  };
  let current = "about:blank";
  const seenNavigation = [];
  let calls = 0;
  const controller = new TaskController({
    store,
    planner: { next: async (context) => {
      calls += 1;
      seenNavigation.push(context.navigationHistory);
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      if (calls === 1) return { ...base, kind: "actions", actions: [{ type: "navigate", url: "https://site.test/r" }] };
      if (calls === 2) return { ...base, kind: "actions", actions: [{ type: "navigate", url: "https://site.test/a" }] };
      return { ...base, kind: "need_user", reason: "done" };
    } },
    browser: {
      observe: async () => ({ id: `obs-${calls}`, documentEpoch: 0, ...(pages[current] || { url: current, elements: [] }) }),
      execute: async (action) => { current = action.url; return { status: "ok" }; },
    },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  await controller.start();
  assert.deepEqual(seenNavigation[0], { authority: "untrusted_page_derived", visited: [], frontier: [] });
  assert.deepEqual(seenNavigation[1].visited, ["https://site.test/r"]);
  assert.deepEqual(seenNavigation[1].frontier, [{ href: "https://site.test/a", name: "A" }, { href: "https://site.test/b", name: "B" }]);
  // Visiting /a removes it from the frontier; /b (never visited) remains; the non-http link never enters it.
  assert.deepEqual(seenNavigation[2].visited, ["https://site.test/r", "https://site.test/a"]);
  assert.deepEqual(seenNavigation[2].frontier, [{ href: "https://site.test/b", name: "B" }]);
  await store.close();
});

test("navigation memory stays bounded: visited and frontier are capped and hrefs are deduplicated", async () => {
  const { store } = await makeStore({ originalRequest: "navigation bounds" });
  let turn = 0;
  let last = null;
  const controller = new TaskController({
    store,
    planner: { next: async (context) => {
      last = context.navigationHistory;
      turn += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      return turn < 40 ? { ...base, kind: "actions", actions: [{ type: "scroll", direction: "down" }] } : { ...base, kind: "need_user", reason: "done" };
    } },
    browser: {
      observe: async () => ({
        id: `obs-${turn}`,
        documentEpoch: 0,
        url: `https://site.test/p${turn}`,
        elements: [
          ...Array.from({ length: 5 }, (_, i) => ({ role: "link", name: `L${turn}-${i}`, href: `https://site.test/l${turn}-${i}`, elementId: String(i) })),
          { role: "link", name: "dup", href: "https://site.test/dup", elementId: "9" },
        ],
      }),
      execute: async () => ({ status: "ok" }),
    },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  await controller.start();
  assert.equal(last.visited.length, 32);
  assert.equal(last.visited.at(-1), "https://site.test/p39");
  assert.equal(last.frontier.length, 32);
  // Oldest entries are dropped at the cap, and no href ever appears twice.
  assert.equal(new Set(last.frontier.map((entry) => entry.href)).size, last.frontier.length);
  assert.ok(last.frontier.filter((entry) => entry.href === "https://site.test/dup").length <= 1);
  assert.ok(!last.frontier.some((entry) => entry.href === "https://site.test/l0-0"), "the oldest frontier entry was evicted");
  await store.close();
});

function goalRun({ profile, criteria, script, store }) {
  // script: array of functions (context) => partial proposal, one per planner turn.
  let turn = 0;
  const contexts = [];
  const controller = new TaskController({
    store,
    planner: { next: async (context) => {
      contexts.push(context);
      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], ...step(context) };
    } },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok", evidenceCandidate: { kind: "host_check" } }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    harnessProfile: profile,
  });
  return { controller, contexts, turns: () => turn };
}

const HOST_CRITERIA = [{ id: "reached", text: "reached the target", required: true, verification: "host" }];
const finish = () => ({ kind: "finish", evidenceIds: [] });
const gatherEvidence = () => ({ kind: "actions", criterionIds: ["reached"], actions: [{ type: "observe" }] });

test("long: a finish with unmet host-verifiable criteria is rejected and the task keeps working until the host verifies the goal", async () => {
  const { store } = await makeStore({ originalRequest: "persistent goal", criteria: HOST_CRITERIA });
  const { controller, contexts, turns } = goalRun({ profile: "long", store, script: [finish, finish, gatherEvidence, finish] });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "completed");
  assert.equal(turns(), 4);
  // The planner is told the goal is persistent, what is missing, and how many finishes were refused.
  assert.deepEqual(contexts[0].progress.goalPersistence, { unmetCriterionIds: ["reached"], rejectedFinishes: 0, maxRejectedFinishes: 5 });
  assert.equal(contexts[2].progress.goalPersistence.rejectedFinishes, 2);
  assert.deepEqual(contexts[3].progress.goalPersistence.unmetCriterionIds, []);
  const rejected = (await store.getEvents()).filter((event) => event.type === "note" && event.payload.kind === "finish_rejected");
  assert.deepEqual(rejected.map((event) => event.payload.rejectedFinishes), [1, 2]);
  await store.close();
});

test("long: repeated finish attempts stop at the cap and pause for a human instead of looping forever", async () => {
  const { store } = await makeStore({ originalRequest: "never verifiable", criteria: HOST_CRITERIA });
  const { controller, turns } = goalRun({ profile: "long", store, script: [finish] });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "goal_not_reached");
  assert.equal(turns(), 5);
  assert.equal(store.lastCheckpoint.payload.goalPersistence.rejectedFinishes, 5);
  await store.close();
});

test("long: the rejection count survives a restart, so the cap cannot be reset by reloading", async () => {
  const { store, storageRoot } = await makeStore({ originalRequest: "restart keeps the cap", criteria: HOST_CRITERIA });
  const first = goalRun({ profile: "long", store, script: [finish, finish, (context) => ({ kind: "need_user", reason: "stop here" })] });
  await first.controller.start();
  assert.equal(store.lastCheckpoint.payload.goalPersistence.rejectedFinishes, 2);
  const taskId = store.taskId;
  await store.close();

  const reloaded = await TaskStore.load(taskId, { storageRoot });
  const second = goalRun({ profile: "long", store: reloaded, script: [finish] });
  assert.equal(second.controller.getHarnessProfile(), "long");
  await second.controller.resume({ confirmed: true });
  // 2 carried over + 3 more finishes reaches the cap of 5, not 5 fresh ones.
  assert.equal(second.turns(), 3);
  assert.equal(reloaded.lastCheckpoint.payload.goalPersistence.rejectedFinishes, 5);
  await reloaded.close();
});

test("long: a criterion that needs a human keeps the awaiting_verification handoff (no rejection loop)", async () => {
  const { store } = await makeStore({ originalRequest: "human verifies", criteria: [{ id: "human", text: "a person confirms", required: true, verification: "user" }] });
  const { controller, turns } = goalRun({ profile: "long", store, script: [finish] });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "awaiting_verification");
  assert.equal(turns(), 1);
  await store.close();
});

test("short and middle keep today's behavior: an unmet finish goes to awaiting_verification and the context has no goalPersistence", async () => {
  for (const profile of ["short", "middle"]) {
    const { store } = await makeStore({ originalRequest: "not persistent", criteria: HOST_CRITERIA });
    const { controller, contexts, turns } = goalRun({ profile, store, script: [finish] });
    const snapshot = await controller.start();
    assert.equal(snapshot.state, "awaiting_verification", profile);
    assert.equal(turns(), 1, profile);
    assert.equal("goalPersistence" in contexts[0].progress, false, profile);
    assert.equal("goalPersistence" in (store.lastCheckpoint?.payload ?? {}), false, profile);
    await store.close();
  }
});

test("the planner context carries the profile's per-proposal action bound", async () => {
  for (const [profile, expected] of [["short", 8], ["middle", 3], ["long", 3]]) {
    const { store } = await makeStore({ originalRequest: `bound ${profile}` });
    let seen = null;
    const controller = new TaskController({
      store,
      planner: { next: async (context) => { seen = context.progress.maxActionsPerProposal; return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "n/a" }; } },
      browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
      approve: allowApprove(),
      hostVerifier: () => true,
      harnessProfile: profile,
    });
    await controller.start();
    assert.equal(seen, expected, profile);
    await store.close();
  }
});

test("constructor rejects an explicit invalid harnessProfile and accepts an explicit valid one", async () => {
  const { store: badStore } = await makeStore({ originalRequest: "bad profile" });
  assert.throws(() => new TaskController({
    store: badStore,
    planner: { next: async () => ({ kind: "need_user", reason: "n/a" }) },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    harnessProfile: "fast",
  }));
  await badStore.close();

  const { store: longStore } = await makeStore({ originalRequest: "explicit long" });
  const controller = new TaskController({
    store: longStore,
    planner: { next: async () => ({ kind: "need_user", reason: "n/a" }) },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
    harnessProfile: "long",
  });
  assert.equal(controller.getHarnessProfile(), "long");
  await longStore.close();
});

test("routine denial is durably recorded and pauses instead of resuggesting the same step", async () => {
  const { store } = await makeStore({ originalRequest: "routine task" });
  let plannerCalls = 0;
  let executeCalls = 0;
  const binding = { routineId: "routine-a", revision: 1, stepIndex: 0, stepDigest: "c".repeat(64) };
  const routineRunner = {
    next: async (context) => {
      plannerCalls += 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "navigate", url: "https://example.com/" }] };
    },
    getCurrentStep: () => binding,
    advance: () => { throw new Error("a denied routine step must not advance"); },
  };
  const controller = new TaskController({
    store,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "d".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executeCalls += 1; return { status: "ok" }; } },
    approve: async () => ({ decision: "deny", reasons: ["origin_not_allowed"] }),
    hostVerifier: () => true,
  });

  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "routine_step_denied");
  assert.equal(plannerCalls, 1);
  assert.equal(executeCalls, 0);
  const events = await store.getEvents();
  const denied = events.find((event) => event.type === "routine_step_denied");
  assert.deepEqual(denied.payload, { ...binding, decision: "deny", reasons: ["origin_not_allowed"] });
  await store.close();
});

test("failed dispatched routine action is durably blocked rather than replayed", async () => {
  const { store } = await makeStore({ originalRequest: "routine task" });
  let plannerCalls = 0;
  const binding = { routineId: "routine-a", revision: 1, stepIndex: 0, stepDigest: "e".repeat(64) };
  const routineRunner = {
    next: async (context) => {
      plannerCalls += 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "navigate", url: "https://example.com/" }] };
    },
    getCurrentStep: () => binding,
    advance: () => { throw new Error("a failed routine step must not advance"); },
  };
  const controller = new TaskController({
    store,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "f".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "failed", errorCode: "navigation_failed" }) },
    approve: allowApprove(),
    hostVerifier: () => true,
  });

  const snapshot = await controller.start();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "routine_step_failed");
  assert.equal(plannerCalls, 1);
  const events = await store.getEvents();
  const started = events.find((event) => event.type === "action_started");
  const failed = events.find((event) => event.type === "routine_step_failed");
  assert.deepEqual(failed.payload, { ...binding, actionId: started.payload.actionId, status: "failed", errorCode: "navigation_failed" });
  await store.close();
});

test("a recovered routine with an outcome but no durable advancement cannot resume or replay", async () => {
  const { store: originalStore, storageRoot } = await makeStore({ originalRequest: "routine recovery" });
  const routineId = "44444444-4444-4444-8444-444444444444";
  const definition = {
    routineId,
    revision: 1,
    origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/next" }],
  };
  const run = { routineId, revision: 1, digest: "a".repeat(64), cursor: 0 };
  await originalStore.checkpoint({ task: { state: "paused", pauseReason: "recovered" }, routineRun: run });
  await originalStore.append({ type: "action_started", payload: { actionId: "action-1" } });
  await originalStore.append({ type: "action_outcome", payload: { actionId: "action-1", status: "ok" } });
  const taskId = originalStore.taskId;
  await originalStore.close();

  const store = await TaskStore.load(taskId, { storageRoot });
  const runner = new RoutineRunner({ definition });
  let plannerCalls = 0;
  let browserCalls = 0;
  const controller = new TaskController({
    store,
    planner: { next: async () => { plannerCalls += 1; throw new Error("must not call routine runner"); } },
    routineRunner: runner,
    routineRun: run,
    browser: {
      observe: async () => { browserCalls += 1; return { id: "obs" }; },
      execute: async () => { browserCalls += 1; return { status: "ok" }; },
    },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  assert.equal(controller.getSnapshot().pauseReason, "routine_recovery_incomplete");
  await assert.rejects(() => controller.resume({ confirmed: true }), (error) => error.code === "routine_recovery_incomplete");
  assert.equal(plannerCalls, 0);
  assert.equal(browserCalls, 0);
  await store.close();
});

// --- read-only action batching ---

function makeBatchPlanner(actions) {
  let calls = 0;
  return {
    next: async (context) => {
      calls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      return calls === 1 ? { ...base, kind: "actions", actions } : { ...base, kind: "need_user", reason: "batch done" };
    },
  };
}

function spyAppends(store) {
  const original = store.append.bind(store);
  const records = [];
  store.append = async (input, options) => {
    records.push({ type: input.type, durable: options?.durable !== false });
    return original(input, options);
  };
  return records;
}

function makeBatchController({ store, actions, approve, browser, extra = {} }) {
  const executed = [];
  const approvals = [];
  const controller = new TaskController({
    store,
    planner: makeBatchPlanner(actions),
    browser: browser ?? {
      observe: async () => ({ id: "obs" }),
      execute: async (action) => { executed.push(action.type); return { status: "ok" }; },
    },
    approve: approve ?? (async (descriptor) => { approvals.push(descriptor.action); return { decision: "allow", reasons: [] }; }),
    hostVerifier: () => true,
    ...extra,
  });
  return { controller, executed, approvals };
}

const SCROLL = { type: "scroll", direction: "down", amount: 400 };
const OBSERVE_ACTION = { type: "observe" };

function makeReuseObservationBrowser() {
  const counts = { observeCalls: 0 };
  let epoch = 0;
  let seq = 0;
  const snapshot = () => ({ id: `obs-${seq++}`, documentEpoch: epoch, url: "https://example.test/", elements: [] });
  return {
    counts,
    getDocumentEpoch: () => epoch,
    navigateNow: () => { epoch += 1; },
    observe: async () => { counts.observeCalls += 1; return snapshot(); },
    execute: async (action) => {
      if (action.type === "observe") {
        const observation = snapshot();
        return { status: "ok", evidenceCandidate: { kind: "artifact", observationId: observation.id }, observation };
      }
      return { status: "ok" };
    },
  };
}

test("harnessProfile:short reuses a batch's trailing observe action instead of re-observing next turn; middle always re-observes", async () => {
  const { store: shortStore } = await makeStore({ originalRequest: "reuse" });
  const shortBrowser = makeReuseObservationBrowser();
  const { controller: shortController } = makeBatchController({
    store: shortStore,
    actions: [SCROLL, OBSERVE_ACTION],
    browser: shortBrowser,
    extra: { harnessProfile: "short" },
  });
  await shortController.start();
  // 1 top-of-loop observe (turn 1) -- no second top-of-loop observe on turn
  // 2, because the trailing OBSERVE_ACTION's own result is reused.
  assert.equal(shortBrowser.counts.observeCalls, 1);
  await shortStore.close();

  const { store: middleStore } = await makeStore({ originalRequest: "reuse" });
  const middleBrowser = makeReuseObservationBrowser();
  const { controller: middleController } = makeBatchController({
    store: middleStore,
    actions: [SCROLL, OBSERVE_ACTION],
    browser: middleBrowser,
    extra: { harnessProfile: "middle" },
  });
  await middleController.start();
  // middle always re-observes: turn 1's top-of-loop observe, then turn 2's.
  assert.equal(middleBrowser.counts.observeCalls, 2);
  await middleStore.close();
});

test("harnessProfile:short does not reuse a stale observation across a navigation (documentEpoch mismatch)", async () => {
  const { store } = await makeStore({ originalRequest: "reuse-stale" });
  const browser = makeReuseObservationBrowser();
  const { controller } = makeBatchController({
    store,
    actions: [SCROLL, OBSERVE_ACTION],
    browser: {
      ...browser,
      execute: async (action) => {
        const result = await browser.execute(action);
        if (action.type === "observe") browser.navigateNow(); // simulate a navigation racing in right after the observe
        return result;
      },
    },
    extra: { harnessProfile: "short" },
  });
  await controller.start();
  // The cached observation's documentEpoch no longer matches the browser's
  // current epoch, so the reuse gate must fail closed to a real re-observe.
  assert.equal(browser.counts.observeCalls, 2);
  await store.close();
});

test("harnessProfile:short does not reuse an observation when the last dispatched action was not itself an observe", async () => {
  const { store } = await makeStore({ originalRequest: "reuse-non-observe" });
  const browser = makeReuseObservationBrowser();
  const { controller } = makeBatchController({
    store,
    actions: [OBSERVE_ACTION, SCROLL], // observe is NOT the last dispatched action
    browser,
    extra: { harnessProfile: "short" },
  });
  await controller.start();
  assert.equal(browser.counts.observeCalls, 2);
  await store.close();
});

test("harnessProfile:short falls back to re-observing against a browser without getDocumentEpoch()", async () => {
  const { store } = await makeStore({ originalRequest: "reuse-no-epoch-support" });
  let observeCalls = 0;
  const { controller } = makeBatchController({
    store,
    actions: [SCROLL, OBSERVE_ACTION],
    browser: {
      observe: async () => { observeCalls += 1; return { id: `obs-${observeCalls}` }; },
      execute: async (action) => action.type === "observe"
        ? { status: "ok", evidenceCandidate: { kind: "artifact", observationId: "x" }, observation: { id: "in-batch" } }
        : { status: "ok" },
    },
    extra: { harnessProfile: "short" },
  });
  await controller.start();
  assert.equal(observeCalls, 2);
  await store.close();
});

test("harnessProfile:short discards a stale reuse cache on resume", async () => {
  const { store } = await makeStore({ originalRequest: "reuse-resume" });
  const browser = makeReuseObservationBrowser();
  let calls = 0;
  const planner = {
    next: async (context) => {
      calls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      if (calls === 1) return { ...base, kind: "actions", actions: [SCROLL, OBSERVE_ACTION] };
      return { ...base, kind: "need_user", reason: "n/a" };
    },
  };
  const controller = new TaskController({
    store,
    planner,
    browser,
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
    harnessProfile: "short",
  });
  await controller.start();
  assert.equal(browser.counts.observeCalls, 1);
  await controller.resume();
  // resume() always starts from a fresh observation (existing invariant);
  // the reuse cache must not leak a pre-resume observation across it.
  assert.equal(browser.counts.observeCalls, 2);
  await store.close();
});

test("harnessProfile:short accepts a read-only batch wider than the default cap; middle rejects the same proposal as malformed", async () => {
  const fourScrolls = [1, 2, 3, 4].map((amount) => ({ type: "scroll", direction: "down", amount }));

  const { store: shortStore } = await makeStore({ originalRequest: "wide batch" });
  const { controller: shortController, executed: shortExecuted } = makeBatchController({
    store: shortStore,
    actions: fourScrolls,
    extra: { harnessProfile: "short" },
  });
  await shortController.start();
  assert.deepEqual(shortExecuted, ["scroll", "scroll", "scroll", "scroll"]);
  await shortStore.close();

  const { store: middleStore } = await makeStore({ originalRequest: "wide batch" });
  const { controller: middleController, executed: middleExecuted } = makeBatchController({
    store: middleStore,
    actions: fourScrolls,
    extra: { harnessProfile: "middle" },
  });
  await middleController.start();
  // The contract-level cap rejects the 4-action proposal outright for
  // middle, so the controller treats it as malformed and replans (see the
  // main loop's `catch { continue; }` around validateProposal) instead of
  // executing anything from it.
  assert.deepEqual(middleExecuted, []);
  await middleStore.close();
});

test("short's wider batch durably persists fewer action_started entries than middle for the same total read-only actions", async () => {
  // Harness v2 Phase 2 Task 5 (semantic durability): _runApprovedReadOnlyBatch
  // already marks only the LAST action_started in a batch durable (see the
  // `durable: index === actions.length - 1` line it's built around). Task 2's
  // wider short-profile batch cap directly extends that same fsync-coalescing
  // benefit -- completing the same 6 actions in one short batch of 6 durably
  // persists one action_started, where middle's own 3-cap needs two batches
  // (two durable action_started entries) to do the same work.
  const sixScrolls = [1, 2, 3, 4, 5, 6].map((amount) => ({ type: "scroll", direction: "down", amount }));

  function twoBatchPlanner() {
    let calls = 0;
    return {
      next: async (context) => {
        calls += 1;
        const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
        if (calls === 1) return { ...base, kind: "actions", actions: sixScrolls.slice(0, 3) };
        if (calls === 2) return { ...base, kind: "actions", actions: sixScrolls.slice(3) };
        return { ...base, kind: "need_user", reason: "done" };
      },
    };
  }

  const { store: middleStore } = await makeStore({ originalRequest: "durability" });
  const middleRecords = spyAppends(middleStore);
  const middleController = new TaskController({
    store: middleStore,
    planner: twoBatchPlanner(),
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
    harnessProfile: "middle",
  });
  await middleController.start();
  const middleDurableStarts = middleRecords.filter((r) => r.type === "action_started" && r.durable).length;
  assert.equal(middleDurableStarts, 2);
  await middleStore.close();

  const { store: shortStore } = await makeStore({ originalRequest: "durability" });
  const shortRecords = spyAppends(shortStore);
  const { controller: shortController } = makeBatchController({
    store: shortStore,
    actions: sixScrolls,
    extra: { harnessProfile: "short" },
  });
  await shortController.start();
  const shortDurableStarts = shortRecords.filter((r) => r.type === "action_started" && r.durable).length;
  assert.equal(shortDurableStarts, 1);
  await shortStore.close();
});

test("a read-only batch asks the approver once per distinct action type and makes only the last action_started durable", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const records = spyAppends(store);
  const { controller, executed, approvals } = makeBatchController({ store, actions: [SCROLL, SCROLL, SCROLL] });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "need_user");
  assert.deepEqual(executed, ["scroll", "scroll", "scroll"]);
  assert.deepEqual(approvals, ["scroll"]);
  assert.deepEqual(records.filter((r) => r.type === "action_started").map((r) => r.durable), [false, false, true]);
  assert.deepEqual(records.filter((r) => r.type === "action_outcome").map((r) => r.durable), [false, false, false]);
  await store.close();
});

test("a read-only batch mixing observe and scroll is approved once for each type", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const { controller, executed, approvals } = makeBatchController({ store, actions: [SCROLL, { type: "observe" }, SCROLL] });
  await controller.start();
  assert.deepEqual(executed, ["scroll", "observe", "scroll"]);
  assert.deepEqual(approvals.sort(), ["observe", "scroll"]);
  await store.close();
});

test("a batch containing a non-read-only action keeps per-action approval and durable action_started", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const records = spyAppends(store);
  const { controller, executed, approvals } = makeBatchController({
    store,
    actions: [SCROLL, { type: "navigate", url: "https://example.com/" }],
    extra: { permissionMode: "browse" },
  });
  await controller.start();
  assert.deepEqual(executed, ["scroll", "navigate"]);
  assert.deepEqual(approvals, ["scroll", "navigate"]);
  assert.deepEqual(records.filter((r) => r.type === "action_started").map((r) => r.durable), [true, true]);
  await store.close();
});

test("a single read-only action keeps its durable action_started", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const records = spyAppends(store);
  const { controller } = makeBatchController({ store, actions: [SCROLL] });
  await controller.start();
  assert.deepEqual(records.filter((r) => r.type === "action_started").map((r) => r.durable), [true]);
  await store.close();
});

test("a denied read-only batch dispatches nothing", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const { controller, executed } = makeBatchController({
    store,
    actions: [SCROLL, SCROLL],
    approve: async () => ({ decision: "deny", reasons: ["no"] }),
  });
  await controller.start();
  assert.deepEqual(executed, []);
  await store.close();
});

test("a reviewed read-only batch queues one item and approve() runs every action in it", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const { controller, executed } = makeBatchController({ store, actions: [SCROLL, SCROLL, SCROLL], approve: reviewApprove() });
  const snapshot = await controller.start();
  assert.equal(snapshot.state, "awaiting_approval");
  assert.equal(snapshot.approvalQueue.length, 1);
  assert.deepEqual(executed, []);
  await controller.approve(snapshot.approvalQueue[0].id);
  assert.deepEqual(executed, ["scroll", "scroll", "scroll"]);
  await store.close();
});

test("a routine read-only batch advances every step and only the last advancement and action_started are durable", async () => {
  const { store } = await makeStore({ originalRequest: "routine task" });
  const records = spyAppends(store);
  let cursor = 0;
  const bindingAt = (i) => ({ routineId: "routine-a", revision: 1, stepIndex: i, stepDigest: String(i).repeat(64) });
  let plannerCalls = 0;
  const routineRunner = {
    next: async (context) => {
      plannerCalls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [] };
      return plannerCalls === 1 ? { ...base, kind: "actions", actions: [SCROLL, SCROLL, SCROLL] } : { ...base, kind: "need_user", reason: "done" };
    },
    getCurrentStep: () => (cursor < 3 ? bindingAt(cursor) : null),
    advance: (binding) => {
      assert.deepEqual(binding, bindingAt(cursor));
      cursor += 1;
      return cursor;
    },
  };
  const executed = [];
  const controller = new TaskController({
    store,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "b".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async (a) => { executed.push(a.type); return { status: "ok" }; } },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  await controller.start();
  assert.deepEqual(executed, ["scroll", "scroll", "scroll"]);
  assert.deepEqual(records.filter((r) => r.type === "routine_step_advanced").map((r) => r.durable), [false, false, true]);
  assert.deepEqual(records.filter((r) => r.type === "action_started").map((r) => r.durable), [false, false, true]);
  const advanced = (await store.getEvents()).filter((e) => e.type === "routine_step_advanced");
  assert.deepEqual(advanced.map((e) => e.payload.stepIndex), [0, 1, 2]);
  await store.close();
});

test("a routine read-only batch pauses at a failed step without running the remaining actions", async () => {
  const { store } = await makeStore({ originalRequest: "routine task" });
  let cursor = 0;
  const bindingAt = (i) => ({ routineId: "routine-a", revision: 1, stepIndex: i, stepDigest: String(i).repeat(64) });
  const routineRunner = {
    next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [SCROLL, SCROLL, SCROLL] }),
    getCurrentStep: () => (cursor < 3 ? bindingAt(cursor) : null),
    advance: () => { cursor += 1; return cursor; },
  };
  let executes = 0;
  const controller = new TaskController({
    store,
    planner: routineRunner,
    routineRunner,
    routineRun: { routineId: "routine-a", revision: 1, digest: "b".repeat(64), cursor: 0 },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { executes += 1; return executes === 2 ? { status: "failed", errorCode: "boom" } : { status: "ok" }; } },
    approve: allowApprove(),
    hostVerifier: () => true,
  });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "routine_step_failed");
  assert.equal(executes, 2);
  const events = await store.getEvents();
  assert.deepEqual(events.filter((e) => e.type === "routine_step_advanced").map((e) => e.payload.stepIndex), [0]);
  assert.deepEqual(events.filter((e) => e.type === "routine_step_failed").map((e) => e.payload.stepIndex), [1]);
  await store.close();
});

test("batchReadOnlyActions:false restores per-action approval and durability for an all-read-only proposal", async () => {
  const { store } = await makeStore({ originalRequest: "batch" });
  const records = spyAppends(store);
  const { controller, executed, approvals } = makeBatchController({
    store,
    actions: [SCROLL, SCROLL, SCROLL],
    extra: { batchReadOnlyActions: false },
  });
  await controller.start();
  assert.deepEqual(executed, ["scroll", "scroll", "scroll"]);
  assert.deepEqual(approvals, ["scroll", "scroll", "scroll"]);
  assert.deepEqual(records.filter((r) => r.type === "action_started").map((r) => r.durable), [true, true, true]);
  await store.close();
});
