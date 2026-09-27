"use strict";

// Tests for main/harness/task-host.js: the multi-task coordinator behind
// createTask/listTasks/resumeSavedTask/amendTask/confirmCriterion/
// getTaskDetail/approveTask/denyTask/pauseTask/stopTask. Browser/planner are
// injected fakes (no real Electron/child process) -- the deep state-machine
// logic is already covered by task-controller.test.js/browser-adapter.test.js;
// these tests exercise TaskHost's own job: routing by taskId and lazily
// attaching a saved task's store/controller/browser/planner.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost, TaskHostError } = require("../main/harness/task-host");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-task-host-"));
}

function finishingPlanner() {
  return {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "finish",
      evidenceIds: [],
    }),
  };
}

function makeHost(storageRoot, overrides = {}) {
  return new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => finishingPlanner(),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...overrides,
  });
}

test("constructor requires storageRoot/makeBrowser/makePlanner/hostVerifier/approve", () => {
  assert.throws(() => new TaskHost({}), TaskHostError);
  assert.throws(() => new TaskHost({ storageRoot: "/tmp/x" }), TaskHostError);
});

test("createTask() creates and auto-starts a brand-new task", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);

  const { taskId, snapshot, goal } = await host.createTask({ originalRequest: "새 작업" });

  assert.ok(taskId);
  assert.equal(goal.originalRequest, "새 작업");
  // No explicit criteria -> the default C1 (verification:"user") applies,
  // and finishingPlanner immediately proposes "finish" with no evidence, so
  // this lands on awaiting_verification, not completed -- proves start()
  // actually ran the loop rather than leaving the task idle.
  assert.equal(snapshot.state, "awaiting_verification");
});

test("listTasks() lists both attached and never-attached (saved-only) tasks", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  await host.createTask({ originalRequest: "task A" });

  // A second task created directly via TaskStore (simulating a prior process
  // run) that this TaskHost instance has never attached.
  const saved = await TaskStore.create({ originalRequest: "task B" }, { storageRoot });
  await saved.close();

  const list = await host.listTasks();

  assert.equal(list.length, 2);
  const a = list.find((t) => t.originalRequest === "task A");
  const b = list.find((t) => t.originalRequest === "task B");
  assert.equal(a.active, true);
  assert.equal(b.active, false);
});

// 2026-09-27 follow-up: listTasks()'s never-attached "peek" path derived
// state purely from store.recoveryReason, so a task that had already
// reached "completed" (checkpointed as such) was peeked as plain
// "paused"/"recovered" -- indistinguishable from one merely interrupted
// mid-flight. Same root cause and fix as task-controller.js's constructor.
test("listTasks() peeks a completed-but-detached task as completed, not paused/recovered", async () => {
  const storageRoot = await mkTempRoot();

  // Drive a task to completed directly via TaskStore/TaskController (not
  // host.createTask(), which would keep it attached and holding the
  // writer.lock -- this test needs the store fully closed first, to
  // simulate a real process restart where nothing is attached anymore).
  const store = await TaskStore.create(
    { originalRequest: "finish me", criteria: [{ id: "c1", text: "done", required: true, verification: "host" }] },
    { storageRoot },
  );
  const taskId = store.taskId;
  let plannerCalls = 0;
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: ["c1"], kind: "actions", actions: [{ type: "observe" }] };
        }
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: ["c1"], kind: "finish", evidenceIds: [] };
      },
    },
    browser: {
      observe: async () => ({ id: "obs" }),
      execute: async () => ({ status: "ok", evidenceCandidate: { kind: "host_check", sourceUrl: "https://example.com" } }),
    },
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
  });
  await controller.start();
  assert.equal(controller.getSnapshot().state, "completed");
  await store.close();

  // Simulate a real process restart: a brand-new TaskHost that never
  // attached this task, only listTasks()'s detached-peek path reads it
  // back off disk.
  const freshHost = makeHost(storageRoot, { makePlanner: () => ({ next: async () => { throw new Error("must never be called for a peeked task"); } }) });
  const list = await freshHost.listTasks();
  const peeked = list.find((t) => t.taskId === taskId);
  assert.ok(peeked, "the completed task must still be listed");
  assert.equal(peeked.state, "completed", "a completed task must be peeked as completed, not paused/recovered");
  assert.equal(peeked.active, false);
});

test("resumeSavedTask() attaches a never-seen-before saved task and resumes it if paused", async () => {
  const storageRoot = await mkTempRoot();
  const created = await TaskStore.create({ originalRequest: "restart me" }, { storageRoot });
  await created.append({ type: "action_started", payload: { actionId: "a1" } });
  await created.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  const taskId = created.taskId;
  await created.close();

  const host = makeHost(storageRoot);
  const snapshot = await host.resumeSavedTask(taskId);

  assert.notEqual(snapshot.state, "paused", "a cleanly recovered task must resume, not stay paused, on resumeSavedTask()");
});

test("resumeSavedTask() on an execution_uncertain task requires confirmed:true (propagated through)", async () => {
  const storageRoot = await mkTempRoot();
  const created = await TaskStore.create({ originalRequest: "dangling" }, { storageRoot });
  await created.append({ type: "action_started", payload: { actionId: "a1" } }); // no matching outcome
  const taskId = created.taskId;
  await created.close();

  const host = makeHost(storageRoot);
  await assert.rejects(() => host.resumeSavedTask(taskId));
  const snapshot = await host.resumeSavedTask(taskId, { confirmed: true });
  assert.notEqual(snapshot.state, "paused");
});

test("amendTask/confirmCriterion/approveTask/denyTask/pauseTask/stopTask require the task to be attached first", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  await assert.rejects(() => host.amendTask("11111111-1111-1111-1111-111111111111", { text: "x" }), TaskHostError);
  await assert.rejects(() => host.confirmCriterion("11111111-1111-1111-1111-111111111111", {}), TaskHostError);
  await assert.rejects(() => host.approveTask("11111111-1111-1111-1111-111111111111", "r1"), TaskHostError);
});

test("getTaskDetail() works for both an active task and a saved-only one", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId: activeId } = await host.createTask({ originalRequest: "active task" });

  const savedOnly = await TaskStore.create({ originalRequest: "saved only" }, { storageRoot });
  await savedOnly.close();

  const activeDetail = await host.getTaskDetail(activeId);
  assert.equal(activeDetail.active, true);
  assert.equal(activeDetail.goal.originalRequest, "active task");

  const savedDetail = await host.getTaskDetail(savedOnly.taskId);
  assert.equal(savedDetail.active, false);
  assert.equal(savedDetail.goal.originalRequest, "saved only");
});

test("each task gets its own browser/planner instance (makeBrowser/makePlanner called per taskId)", async () => {
  const storageRoot = await mkTempRoot();
  const seenBrowserTaskIds = [];
  const host = makeHost(storageRoot, {
    makeBrowser: (taskId) => {
      seenBrowserTaskIds.push(taskId);
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
    },
  });

  const first = await host.createTask({ originalRequest: "a" });
  const second = await host.createTask({ originalRequest: "b" });

  assert.deepEqual(seenBrowserTaskIds, [first.taskId, second.taskId]);
});

// --- resumeSavedTask() after a 900MB emergency teardown must re-attach a
// FRESH browser/planner instead of calling .resume() on a controller whose
// resources were already disposed (task-controller.js's resume() now
// rejects that outright) -- otherwise a task that hit emergency pressure
// would be permanently stuck, unrecoverable without an actual app restart.

test("resumeSavedTask() re-attaches fresh browser/planner instances after a memory_emergency pause instead of erroring", async () => {
  const storageRoot = await mkTempRoot();
  let browserBuilds = 0;
  const memoryMonitor = { getPressureLevel: () => "emergency" };
  const host = makeHost(storageRoot, {
    makeBrowser: () => {
      browserBuilds += 1;
      return {
        observe: async () => ({ id: "obs" }),
        execute: async () => ({ status: "ok" }),
        dispose: async () => {},
      };
    },
    makePlanner: () => ({
      next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }),
      close: async () => {},
    }),
    memoryMonitor,
  });

  const { taskId } = await host.createTask({ originalRequest: "goal" });
  assert.equal(browserBuilds, 1);
  assert.equal((await host.getTaskDetail(taskId)).snapshot.pauseReason, "memory_emergency");

  // Pressure has since cleared -- a fresh attach + resume should now work.
  memoryMonitor.getPressureLevel = () => "normal";
  const snapshot = await host.resumeSavedTask(taskId);

  assert.equal(browserBuilds, 2, "resumeSavedTask() must build a brand-new browser instance, not reuse the disposed one");
  assert.notEqual(snapshot.pauseReason, "memory_emergency");
});
