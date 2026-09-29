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
const { HostSettingsStore } = require("../main/harness/host-settings");
const { RoutineStore } = require("../main/harness/routine-store");
const { RoutineRunner } = require("../main/harness/routine-runner");

const hostsToClose = new Set();
const SHUTDOWN_DEADLOCK_TIMEOUT_MS = 5000;

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
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => finishingPlanner(),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...overrides,
  });
  hostsToClose.add(host);
  return host;
}

test.afterEach(async () => {
  const hosts = [...hostsToClose];
  hostsToClose.clear();
  await Promise.all(hosts.map((host) => host.close()));
});

test("constructor requires storageRoot/makeBrowser/makePlanner/hostVerifier/approve", () => {
  assert.throws(() => new TaskHost({}), TaskHostError);
  assert.throws(() => new TaskHost({ storageRoot: "/tmp/x" }), TaskHostError);
});

test("runRoutine pins the saved revision and uses it without creating a planner worker", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Visit inbox", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  });
  let plannerFactories = 0;
  const host = makeHost(storageRoot, {
    makeBrowser: () => ({
      observe: async () => ({ id: "obs", url: "about:blank", elements: [] }),
      execute: async () => ({ status: "ok" }),
    }),
    makePlanner: () => { plannerFactories += 1; return finishingPlanner(); },
    approve: async () => ({ decision: "review", reasons: [] }),
  });
  const { taskId } = await host.runRoutine(saved.routineId, saved.revision);
  const entry = host._active.get(taskId);
  assert.equal(plannerFactories, 0);
  assert.equal(entry.store.lastCheckpoint.payload.routineRun.routineId, saved.routineId);
  assert.equal(entry.store.lastCheckpoint.payload.routineRun.revision, saved.revision);
  assert.equal(entry.store.lastCheckpoint.payload.routineRun.digest, saved.digest);
  assert.equal((await host.getTaskDetail(taskId)).harnessProfile, "short");
});

test("runRoutine rejects invalid revisions before creating task or browser resources", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Visit inbox", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  });
  let browsers = 0;
  const host = makeHost(storageRoot, { makeBrowser: () => { browsers += 1; throw new Error("browser created"); } });
  await assert.rejects(() => host.runRoutine(saved.routineId, 999));
  assert.equal(browsers, 0);
  assert.deepEqual(await host.listTasks(), []);
});

test("routine recovery rejects a wrong step digest before browser or planner creation", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Visit inbox", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  });
  const store = await TaskStore.create({ originalRequest: "Run saved routine" }, { storageRoot });
  await store.checkpoint({ task: { state: "paused", pauseReason: "recovered" }, routineRun: {
    routineId: saved.routineId, revision: saved.revision, digest: saved.digest, cursor: 0,
  } });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  await store.append({ type: "routine_step_advanced", payload: {
    routineId: saved.routineId, revision: saved.revision, stepIndex: 0,
    stepDigest: "0".repeat(64), actionId: "a1",
  } });
  const taskId = store.taskId;
  await store.close();
  let resources = 0;
  const host = makeHost(storageRoot, {
    makeBrowser: () => { resources += 1; throw new Error("browser created"); },
    makePlanner: () => { resources += 1; throw new Error("planner created"); },
  });
  await assert.rejects(() => host.resumeSavedTask(taskId), (error) => error.code === "routine_cursor_mismatch");
  assert.equal(resources, 0);
});

test("routine recovery rejects a wrong step digest on an earlier of several uncheckpointed advancements", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Visit two pages", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/a" }, { kind: "navigate", url: "https://example.com/b" }],
  });
  const store = await TaskStore.create({ originalRequest: "Run saved routine" }, { storageRoot });
  await store.checkpoint({ task: { state: "paused", pauseReason: "recovered" }, routineRun: {
    routineId: saved.routineId, revision: saved.revision, digest: saved.digest, cursor: 0,
  } });
  const definition = await new RoutineStore({ storageRoot }).get(saved.routineId, saved.revision);
  const lastStepDigest = new RoutineRunner({ definition, cursor: 1 }).getCurrentStep().stepDigest;
  const stepDigests = ["0".repeat(64), lastStepDigest];
  for (let index = 0; index < 2; index += 1) {
    const actionId = `a${index}`;
    await store.append({ type: "action_started", payload: { actionId } });
    await store.append({ type: "action_outcome", payload: { actionId, status: "ok" } });
    await store.append({ type: "routine_step_advanced", payload: {
      routineId: saved.routineId, revision: saved.revision, stepIndex: index,
      stepDigest: stepDigests[index], actionId,
    } });
  }
  const taskId = store.taskId;
  await store.close();
  const host = makeHost(storageRoot, {
    makeBrowser: () => { throw new Error("browser created"); },
    makePlanner: () => { throw new Error("planner created"); },
  });
  await assert.rejects(() => host.resumeSavedTask(taskId), (error) => error.code === "routine_cursor_mismatch");
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

test("amendTask/confirmCriterion/approveTask/denyTask/pauseTask/stopTask/takeOverTask require the task to be attached first", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  await assert.rejects(() => host.amendTask("11111111-1111-1111-1111-111111111111", { text: "x" }), TaskHostError);
  await assert.rejects(() => host.confirmCriterion("11111111-1111-1111-1111-111111111111", {}), TaskHostError);
  await assert.rejects(() => host.approveTask("11111111-1111-1111-1111-111111111111", "r1"), TaskHostError);
  await assert.rejects(() => host.takeOverTask("11111111-1111-1111-1111-111111111111"), TaskHostError);
});

test("takeOverTask() delegates to the attached controller's takeOver() with the given reason", async () => {
  const storageRoot = await mkTempRoot();
  let sawReason;
  const host = makeHost(storageRoot, {
    makePlanner: () => ({
      next: async (context) => ({
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: "obs",
        criterionIds: [],
        kind: "actions",
        actions: [{ type: "observe" }],
      }),
    }),
    approve: async () => ({ decision: "review", reasons: [] }), // queues instead of dispatching -- reaches awaiting_approval, no hang
  });
  const { taskId } = await host.createTask({ originalRequest: "long task" });
  const controller = host._active.get(taskId).controller;
  const realTakeOver = controller.takeOver.bind(controller);
  controller.takeOver = (reason) => {
    sawReason = reason;
    return realTakeOver(reason);
  };

  const snapshot = await host.takeOverTask(taskId, "user_takeover");
  assert.equal(sawReason, "user_takeover");
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "user_takeover");
});

test("close() durably pauses active work and closes each owned resource", async () => {
  const storageRoot = await mkTempRoot();
  const closed = [];
  const host = makeHost(storageRoot, {
    makeBrowser: () => ({
      observe: async () => ({ id: "obs" }),
      execute: async () => ({ status: "ok" }),
      dispose: async () => closed.push("browser"),
    }),
    makePlanner: () => ({
      next: async (context) => ({
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: "obs",
        criterionIds: [],
        kind: "actions",
        actions: [{ type: "observe" }],
      }),
      close: async () => closed.push("planner"),
    }),
    approve: async () => ({ decision: "review", reasons: [] }),
  });
  const { taskId } = await host.createTask({ originalRequest: "close me safely" });
  assert.equal((await host.getTaskDetail(taskId)).snapshot.state, "awaiting_approval");

  await host.close();

  assert.deepEqual(closed.sort(), ["browser", "planner"]);
  assert.equal(host._active.size, 0);
  const reopened = await TaskStore.load(taskId, { storageRoot });
  assert.equal(reopened.lastCheckpoint.payload.task.state, "paused");
  assert.equal(reopened.lastCheckpoint.payload.task.pauseReason, "host_shutdown");
  await reopened.close();
});

test("close() drains a pending createTask before it can attach unowned resources", async () => {
  const storageRoot = await mkTempRoot();
  const originalCreate = TaskStore.create;
  let releaseCreate;
  let signalCreateStarted;
  const createStarted = new Promise((resolve) => { signalCreateStarted = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  let createdStore;
  const resourcesCreated = [];
  TaskStore.create = async (...args) => {
    signalCreateStarted();
    await createGate;
    createdStore = await originalCreate(...args);
    return createdStore;
  };

  const host = makeHost(storageRoot, {
    makeBrowser: () => {
      resourcesCreated.push("browser");
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => {} };
    },
    makePlanner: () => {
      resourcesCreated.push("planner");
      return finishingPlanner();
    },
  });

  try {
    const creating = host.createTask({ originalRequest: "creation racing shutdown" });
    await createStarted;
    const closing = host.close();
    releaseCreate();

    await assert.rejects(creating, (error) => error.code === "host_closed");
    await closing;
    assert.deepEqual(resourcesCreated, [], "shutdown must prevent post-close BrowserView/planner attachment");

    const reopened = await TaskStore.load(createdStore.taskId, { storageRoot });
    await reopened.close();
  } finally {
    TaskStore.create = originalCreate;
    releaseCreate();
  }
});

test("close() drains a pending resumeSavedTask before it can attach unowned resources", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await TaskStore.create({ originalRequest: "saved task racing shutdown" }, { storageRoot });
  const taskId = saved.taskId;
  await saved.close();

  const originalLoad = TaskStore.load;
  let releaseLoad;
  let signalLoadStarted;
  const loadStarted = new Promise((resolve) => { signalLoadStarted = resolve; });
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loadedStore;
  const resourcesCreated = [];
  TaskStore.load = async (...args) => {
    signalLoadStarted();
    await loadGate;
    loadedStore = await originalLoad(...args);
    return loadedStore;
  };

  const host = makeHost(storageRoot, {
    makeBrowser: () => {
      resourcesCreated.push("browser");
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => {} };
    },
    makePlanner: () => {
      resourcesCreated.push("planner");
      return finishingPlanner();
    },
  });

  try {
    const resuming = host.resumeSavedTask(taskId);
    await loadStarted;
    const closing = host.close();
    releaseLoad();

    await assert.rejects(resuming, (error) => error.code === "host_closed");
    await closing;
    assert.deepEqual(resourcesCreated, [], "shutdown must prevent post-close BrowserView/planner attachment");
    const reopened = await originalLoad(taskId, { storageRoot });
    await reopened.close();
  } finally {
    TaskStore.load = originalLoad;
    releaseLoad();
  }
});

test("close() can take over a task while its initial planner response is pending", async () => {
  const storageRoot = await mkTempRoot();
  let signalPlannerStarted;
  const plannerStarted = new Promise((resolve) => { signalPlannerStarted = resolve; });
  let releasePlanner;
  const plannerGate = new Promise((resolve) => { releasePlanner = resolve; });
  const host = makeHost(storageRoot, {
    makePlanner: () => ({
      next: async () => {
        signalPlannerStarted();
        await plannerGate;
        return { kind: "need_user", reason: "planner yielded" };
      },
      close: async () => releasePlanner(),
    }),
    approve: async () => ({ decision: "allow", reasons: [] }),
  });

  const creating = host.createTask({ originalRequest: "task that waits on the planner" });
  try {
    await plannerStarted;
    const closing = host.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), SHUTDOWN_DEADLOCK_TIMEOUT_MS)),
    ]);
    assert.equal(closedPromptly, true, "shutdown must reach takeOver() instead of waiting for the planner first");
    assert.equal((await creating).snapshot.pauseReason, "host_shutdown");
  } finally {
    releasePlanner();
  }
});

test("close() can take over a freshly resumed task while its planner response is pending", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await TaskStore.create({ originalRequest: "paused task racing shutdown" }, { storageRoot });
  await saved.append({ type: "action_started", payload: { actionId: "completed-action" } });
  await saved.append({ type: "action_outcome", payload: { actionId: "completed-action", status: "ok" } });
  const taskId = saved.taskId;
  await saved.close();

  let signalPlannerStarted;
  const plannerStarted = new Promise((resolve) => { signalPlannerStarted = resolve; });
  let releasePlanner;
  const plannerGate = new Promise((resolve) => { releasePlanner = resolve; });
  const host = makeHost(storageRoot, {
    makePlanner: () => ({
      next: async () => {
        signalPlannerStarted();
        await plannerGate;
        return { kind: "need_user", reason: "planner yielded" };
      },
      close: async () => releasePlanner(),
    }),
    approve: async () => ({ decision: "allow", reasons: [] }),
  });

  const resuming = host.resumeSavedTask(taskId);
  try {
    await plannerStarted;
    const closing = host.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), SHUTDOWN_DEADLOCK_TIMEOUT_MS)),
    ]);
    assert.equal(closedPromptly, true, "shutdown must see and take over the freshly resumed controller");
    assert.equal((await resuming).pauseReason, "host_shutdown");
  } finally {
    releasePlanner();
  }
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
  assert.equal(activeDetail.harnessProfile, "middle");

  const savedDetail = await host.getTaskDetail(savedOnly.taskId);
  assert.equal(savedDetail.active, false);
  assert.equal(savedDetail.goal.originalRequest, "saved only");
  assert.equal(savedDetail.harnessProfile, "middle");
});

test("queued task does not create browser resources until the preceding task stops", async () => {
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

  assert.deepEqual(seenBrowserTaskIds, [first.taskId]);
  assert.equal(second.snapshot.state, "queued");
  await host.stopTask(first.taskId);
  for (let i = 0; i < 50 && seenBrowserTaskIds.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seenBrowserTaskIds, [first.taskId, second.taskId]);
});

async function waitForState(host, taskId, states, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const summaries = await host.listTasks();
    last = summaries.find((item) => item.taskId === taskId);
    if (last && states.includes(last.state)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach ${states.join("|")}; last=${JSON.stringify(last)}`);
}

test("a queued plain task actually runs to completion after the preceding task stops", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const first = await host.createTask({ originalRequest: "a" });
  const second = await host.createTask({ originalRequest: "b" });
  assert.equal(second.snapshot.state, "queued");
  await host.stopTask(first.taskId);
  const finished = await waitForState(host, second.taskId, ["awaiting_verification", "completed"]);
  assert.notEqual(finished.pauseReason, "queue_start_failed");
});

test("a queued routine task actually runs to awaiting_verification after the preceding task stops", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Visit inbox", origins: ["https://example.com"],
    steps: [{ kind: "navigate", url: "https://example.com/inbox" }],
  });
  const host = makeHost(storageRoot, {
    makeBrowser: () => ({
      observe: async () => ({ id: "obs", url: "about:blank", elements: [] }),
      execute: async () => ({ status: "ok" }),
    }),
  });
  const first = await host.createTask({ originalRequest: "blocker" });
  const queued = await host.runRoutine(saved.routineId, saved.revision);
  assert.equal(queued.snapshot.state, "queued");
  await host.stopTask(first.taskId);
  const finished = await waitForState(host, queued.taskId, ["awaiting_verification", "completed"]);
  assert.notEqual(finished.pauseReason, "queue_start_failed");
});

test("listTasks() reconciles the durable FIFO queue after restart without eagerly attaching queued browsers", async () => {
  const storageRoot = await mkTempRoot();
  const originalHost = makeHost(storageRoot);
  const first = await originalHost.createTask({ originalRequest: "active before restart" });
  const second = await originalHost.createTask({ originalRequest: "queued before restart" });
  assert.equal(second.snapshot.state, "queued");
  await originalHost.close();
  hostsToClose.delete(originalHost);

  let browserCreations = 0;
  const recoveredHost = makeHost(storageRoot, {
    makeBrowser: () => { browserCreations += 1; throw new Error("listTasks must not attach a browser"); },
  });
  const recovered = await recoveredHost.listTasks();
  const ordered = recovered.filter((item) => item.taskId === first.taskId || item.taskId === second.taskId)
    .sort((left, right) => left.queuePosition - right.queuePosition);

  assert.deepEqual(ordered.map((item) => [item.taskId, item.queuePosition]), [[first.taskId, 1], [second.taskId, 2]]);
  assert.equal(browserCreations, 0);
  await assert.rejects(() => recoveredHost.resumeSavedTask(second.taskId), { code: "queued_behind_other_task" });
  assert.equal(browserCreations, 0);
});

test("credential filling is a trusted, user-controlled, exact-origin path and never returns credential values", async () => {
  const storageRoot = await mkTempRoot();
  let fillArgs;
  const host = makeHost(storageRoot, {
    credentialVault: {
      fill: async (args) => {
        fillArgs = args;
        await args.fillCredential({ username: "user@example.test", password: "secret-value" });
        return { status: "ok" };
      },
    },
    makeBrowser: () => ({
      observe: async () => ({ id: "obs" }),
      execute: async () => ({ status: "ok" }),
      getBrowserSnapshot: () => ({ tabs: [{ id: "page", url: "https://login.example.test/" }], activeTabId: "page" }),
      fillCredential: async ({ username, password, origin }) => {
        assert.equal(username, "user@example.test");
        assert.equal(password, "secret-value");
        assert.equal(origin, "https://login.example.test/");
        return { status: "ok", usernameFilled: true, passwordFilled: true };
      },
    }),
  });
  const { taskId } = await host.createTask({ originalRequest: "login" });
  const result = await host.fillCredential(taskId, "credential-1");
  assert.deepEqual(result, { status: "ok" });
  assert.equal(fillArgs.approved, true);
  assert.equal(fillArgs.origin, "https://login.example.test/");
  assert.equal("password" in result, false);
  const events = await host.getTaskEvents(taskId);
  const autofillEvent = events.find((event) => event.payload?.kind === "credential_autofill_requested");
  assert.equal(autofillEvent.payload.credentialId, "credential-1");
  assert.equal(autofillEvent.payload.origin, "https://login.example.test/");
  assert.equal(JSON.stringify(autofillEvent).includes("secret-value"), false);
});

test("parallel queue mode opens a second slot only with a measured reservation and fresh memory admission", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  const admissions = [];
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      canAdmitTask: (args) => { admissions.push(args); return { allowed: true, usedBytes: 300_000_000, reserveBytes: args.reserveBytes, limitBytes: 1_000_000_000, ageMs: 100 }; },
    },
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const first = await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(first.snapshot.state, "awaiting_verification");
  assert.equal(second.snapshot.state, "awaiting_verification");
  assert.equal(built.length, 2);
  assert.deepEqual(admissions, [
    { reserveBytes: 220_000_000, maxAgeMs: 7500 },
    { reserveBytes: 220_000_000, maxAgeMs: 7500 },
  ]);
});

test("the first top-level task acquires the shared memory lease before browser or planner construction", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  const host = makeHost(storageRoot, {
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      canAdmitTask: () => ({ allowed: true }),
    },
    makeBrowser: () => {
      assert.equal(host._resourceAdmission.getSnapshot().leases.length, 1);
      built.push("browser");
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
    },
    makePlanner: () => {
      assert.equal(host._resourceAdmission.getSnapshot().leases.length, 1);
      built.push("planner");
      return finishingPlanner();
    },
  });
  const task = await host.createTask({ originalRequest: "first" });
  assert.equal(task.snapshot.state, "awaiting_verification");
  assert.deepEqual(built, ["browser", "planner"]);
  assert.deepEqual(host._resourceAdmission.getSnapshot().leases.map((lease) => lease.ownerId), [task.taskId]);
});

test("a denied first top-level lease keeps its FIFO head queued without constructing resources", async () => {
  const storageRoot = await mkTempRoot();
  let allowed = false;
  let built = 0;
  const host = makeHost(storageRoot, {
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      canAdmitTask: () => ({ allowed, reason: allowed ? null : "memory_sample_stale" }),
    },
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const first = await host.createTask({ originalRequest: "first" });
  assert.equal(first.snapshot.state, "queued");
  assert.equal(built, 0);
  allowed = true;
  await host.onMemorySample();
  for (let i = 0; i < 50 && built === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(built, 1);
  assert.deepEqual(host._resourceAdmission.getSnapshot().leases.map((lease) => lease.ownerId), [first.taskId]);
});

test("simultaneous top-level tasks cannot spend the same sampled memory headroom", async () => {
  const storageRoot = await mkTempRoot();
  let built = 0;
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      getLastSample: () => ({ totalBytes: 100_000_000, unmeasurable: [], sampledAt: 42 }),
      canAdmitTask: ({ reserveBytes }) => ({ allowed: reserveBytes <= 300_000_000, reason: reserveBytes <= 300_000_000 ? null : "memory_budget_exceeded" }),
    },
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const tasks = await Promise.all([
    host.createTask({ originalRequest: "one" }),
    host.createTask({ originalRequest: "two" }),
  ]);
  assert.deepEqual(tasks.map((item) => item.snapshot.state).sort(), ["awaiting_verification", "queued"]);
  assert.equal(built, 1);
  assert.equal(host._resourceAdmission.getSnapshot().leases.length, 1);
});

test("recovered top-level task cannot resume without a fresh memory lease", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await TaskStore.create({ originalRequest: "resume me" }, { storageRoot });
  const taskId = saved.taskId;
  await saved.close();
  let built = 0;
  const host = makeHost(storageRoot, {
    memoryMonitor: {
      getPressureLevel: () => "normal",
      canAdmitTask: () => ({ allowed: false, reason: "memory_sample_stale" }),
    },
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await assert.rejects(host.resumeSavedTask(taskId), { code: "memory_admission_denied" });
  assert.equal(built, 0);
  assert.deepEqual(host._resourceAdmission.getSnapshot().leases, []);
});

test("resumeSavedTask cannot skip a freshly queued FIFO task without admission", async () => {
  const storageRoot = await mkTempRoot();
  let built = 0;
  const host = makeHost(storageRoot, {
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await host.createTask({ originalRequest: "running first" });
  const queued = await host.createTask({ originalRequest: "queued second" });
  assert.equal(queued.snapshot.state, "queued");
  await assert.rejects(host.resumeSavedTask(queued.taskId), { code: "queued_behind_other_task" });
  assert.equal(built, 1);
});

test("close keeps a top-level memory lease until browser and planner teardown complete", async () => {
  const storageRoot = await mkTempRoot();
  let signalDisposing;
  let finishDisposing;
  const disposing = new Promise((resolve) => { signalDisposing = resolve; });
  const disposeGate = new Promise((resolve) => { finishDisposing = resolve; });
  const host = makeHost(storageRoot, {
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: { getPressureLevel: () => "normal", canAdmitTask: () => ({ allowed: true }) },
    makeBrowser: () => ({
      observe: async () => ({ id: "obs" }),
      execute: async () => ({ status: "ok" }),
      dispose: async () => { signalDisposing(); await disposeGate; },
    }),
  });
  await host.createTask({ originalRequest: "one" });
  const closing = host.close();
  await disposing;
  try {
    assert.equal(host._resourceAdmission.getSnapshot().leases.length, 1);
  } finally {
    finishDisposing();
  }
  await closing;
  assert.equal(host._resourceAdmission.getSnapshot().leases.length, 0);
});

test("the trusted host audits a memory override and freezes it for the existing parent run", async () => {
  const storageRoot = await mkTempRoot();
  const settingsStore = new HostSettingsStore({ storageRoot });
  const host = makeHost(storageRoot, {
    settingsStore,
    memoryMonitor: {
      getPressureLevel: () => "emergency",
      canAdmitTask: () => ({ allowed: false, reason: "memory_budget_exceeded" }),
    },
  });
  await host.updateHostSettings({ memoryPolicy: "user_override" });
  const audit = (await settingsStore.listMemoryPolicyAudit())[0];
  assert.equal(audit.actor, "user");
  const parent = await host.createTask({ originalRequest: "keep my selected policy" });
  assert.equal(parent.snapshot.state, "awaiting_verification", "the override also bypasses the HALO pressure pause for this run");
  assert.equal(host._resourceAdmission.getSnapshot().leases[0].mode, "user_override");

  await host.updateHostSettings({ memoryPolicy: "budgeted" });
  const { store } = host._require(parent.taskId);
  await host._onChildPlan(parent.taskId, store, {
    taskId: parent.taskId,
    goalVersion: 1,
    basedOnObservationId: "obs",
    criterionIds: [],
    kind: "child_plan",
    parentGoalVersion: 1,
    requestedAgentCount: 1,
    assignments: [{ subgoal: "bounded read", entryUrl: "https://child.example/start" }],
  });
  const accepted = (await store.getEvents()).find((event) => event.type === "child_plan_accepted");
  assert.equal(accepted.payload.memoryPolicy, "user_override");
  assert.equal(accepted.payload.memoryPolicyAuditEventId, audit.eventId);
});

test("parallel preference without a measured per-task reservation remains sequential", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(second.snapshot.state, "queued");
  assert.equal(built.length, 1);
});

test("parallel queue retries on fresh samples using renderer benchmark plus planner process-tree high water", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  let plannerHighWater = null;
  const reservations = [];
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    memoryMonitor: {
      getPressureLevel: () => "normal",
      getExternalProcessHighWaterBytes: (label) => label === "planner" ? plannerHighWater : null,
      canAdmitTask: ({ reserveBytes }) => { reservations.push(reserveBytes); return { allowed: true }; },
    },
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(second.snapshot.state, "queued");
  assert.equal(built.length, 1);
  plannerHighWater = 80_000_000;
  await host.onMemorySample();
  for (let i = 0; i < 50 && built.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(built.length, 2);
  assert.deepEqual(reservations, [370_000_000, 470_000_000]);
});

test("a ResourceAdmission denial (Task 2's shared ledger, not the raw canAdmitTask reason alone) keeps the second task queued", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  let checks = 0;
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    parallelTaskReserveBytes: 220_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      canAdmitTask: () => ({ allowed: ++checks === 1, reason: checks === 1 ? null : "memory_budget_exceeded" }),
    },
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(second.snapshot.state, "queued");
  assert.equal(built.length, 1);
});

test("a completed second-slot task's memory lease is released, so it does not keep padding admission checks against a later task under the same sample", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    parallelTaskReserveBytes: 250_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      // Fixed sample identity throughout (no new sample() between checks) --
      // this is what makes a leaked lease's padding observable: a real
      // deployment re-samples periodically, but a held-open lease from a
      // finished task must stop counting even against this same sample.
      getLastSample: () => ({ totalBytes: 0, unmeasurable: [], sampledAt: 999 }),
      // 550MB budget: the first and second 250MB reservations fit, but a
      // leaked second lease would block the third while the first remains.
      canAdmitTask: ({ reserveBytes }) => ({ allowed: reserveBytes <= 550_000_000, reason: reserveBytes > 550_000_000 ? "memory_budget_exceeded" : null }),
    },
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const first = await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(built.length, 2, "task two got the second slot");

  await host.stopTask(second.taskId);
  for (let i = 0; i < 50 && (await host.getTaskDetail(first.taskId)).active !== true; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  const third = await host.createTask({ originalRequest: "three" });
  assert.equal(third.snapshot.state, "awaiting_verification", "task two's released lease must not phantom-pad task three's admission check");
  assert.equal(built.length, 3);
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

// --- Task 3 (multi-agent background runtime plan): TaskHost.listChildren()
// delegates to its ChildAgentCoordinator -- children are never surfaced by
// listTasks()/resumeSavedTask(), only by this dedicated method.

test("listChildren() returns [] for a task with no child plan, and reflects an accepted plan via the coordinator", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "parent goal" });

  assert.deepEqual(await host.listChildren(taskId), []);

  const { store } = host._require(taskId);
  await host._childCoordinator.acceptParentPlan(
    taskId,
    {
      taskId,
      goalVersion: 1,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "child_plan",
      parentGoalVersion: 1,
      requestedAgentCount: 1,
      assignments: [{ subgoal: "하위 목표", entryUrl: "https://child.example/start" }],
    },
    { parentStore: store, memoryPolicy: "budgeted" },
  );

  const children = await host.listChildren(taskId);
  assert.equal(children.length, 1);
  assert.equal(children[0].origin, "https://child.example");
});

test("a child's taskId is absent from listTasks() and rejected by resumeSavedTask()", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId: parentTaskId } = await host.createTask({ originalRequest: "parent goal" });
  const { store } = host._require(parentTaskId);

  const { childIds } = await host._childCoordinator.acceptParentPlan(
    parentTaskId,
    {
      taskId: parentTaskId,
      goalVersion: 1,
      basedOnObservationId: "obs",
      criterionIds: [],
      kind: "child_plan",
      parentGoalVersion: 1,
      requestedAgentCount: 1,
      assignments: [{ subgoal: "하위 목표", entryUrl: "https://child.example/start" }],
    },
    { parentStore: store, memoryPolicy: "budgeted" },
  );

  const tasks = await host.listTasks();
  assert.equal(tasks.some((t) => t.taskId === childIds[0]), false);
  await assert.rejects(host.resumeSavedTask(childIds[0]));
});

// --- Subagent communication protocol Task 4: registerStore()/unregisterStore()
// wiring (the shared ChildAgentCoordinator's mailbox authority needs an
// already-open TaskStore handle for both attach paths, and must never keep a
// stale one after a task detaches), and a standalone (no-children) task
// behaving safely through the same coordinator a parent/child task shares.

test("registerStore(): createTask() registers the new task's store with the shared coordinator before the loop can run", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "standalone task" });

  assert.equal(host._childCoordinator._activeStores.has(taskId), true);
  assert.equal(host._childCoordinator._activeStores.get(taskId), host._require(taskId).store);
});

test("registerStore(): resumeSavedTask() also registers the reattached store with the shared coordinator", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "will detach" });
  await host.stopTask(taskId);
  for (let i = 0; i < 50 && host._childCoordinator._activeStores.has(taskId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(host._childCoordinator._activeStores.has(taskId), false, "stopTask() must have unregistered the store already");

  await host.resumeSavedTask(taskId);
  assert.equal(host._childCoordinator._activeStores.has(taskId), true);
});

test("unregisterStore(): a task reaching a terminal state (stopped) is removed from the coordinator's store registry, not left stale", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "will stop" });
  assert.equal(host._childCoordinator._activeStores.has(taskId), true);

  await host.stopTask(taskId);
  for (let i = 0; i < 50 && host._childCoordinator._activeStores.has(taskId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(host._childCoordinator._activeStores.has(taskId), false);
});

test("unregisterStore(): a stale memory_emergency entry is evicted from the coordinator's registry on resumeSavedTask(), not left dangling", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "will hit memory emergency" });
  const { controller } = host._require(taskId);

  // Simulate the 900MB emergency pressure path directly (real memory
  // sampling is out of scope here) -- this disposes the controller's owned
  // resources and closes its store, exactly like host.onMemorySample()
  // driving a real MemoryMonitor would.
  await controller._pauseForMemoryEmergency();
  assert.equal(controller.getSnapshot().pauseReason, "memory_emergency");
  // The store itself was already closed by the emergency teardown, but the
  // registry entry is only evicted lazily, on the next resumeSavedTask() --
  // proving that path, not just the terminal path above, calls unregister.
  assert.equal(host._childCoordinator._activeStores.has(taskId), true, "not yet evicted before resumeSavedTask() runs");

  await host.resumeSavedTask(taskId);
  assert.equal(host._childCoordinator._activeStores.get(taskId), host._require(taskId).store, "the stale handle must be replaced, not merely left registered");
});

test("a standalone task with no children behaves safely through the shared coordinator: no pending messages, and sending fails closed instead of crashing", async () => {
  const storageRoot = await mkTempRoot();
  const host = makeHost(storageRoot);
  const { taskId } = await host.createTask({ originalRequest: "standalone, no children ever" });

  await assert.doesNotReject(async () => {
    const pending = await host._childCoordinator.listPendingMessages(taskId);
    assert.deepEqual(pending, []);
  });

  await assert.rejects(
    host._childCoordinator.handleSendMessage(taskId, {
      kind: "send_message",
      recipientTaskId: "11111111-1111-1111-1111-111111111111",
      messageKind: "progress",
      idempotencyKey: "idem-standalone",
      text: "nobody to send this to",
    }),
    (err) => err && err.code === "unauthorized_route",
  );
});

test("maxParallelTasks validates as an integer from 1 to 8 and defaults to two slots", () => {
  const base = { storageRoot: "/tmp/x", makeBrowser: () => ({}), makePlanner: () => ({}), hostVerifier: () => true, approve: async () => ({}) };
  for (const bad of [0, 9, 1.5, "3", null, Number.NaN]) {
    assert.throws(() => new TaskHost({ ...base, maxParallelTasks: bad }), (error) => error instanceof TaskHostError && error.code === "invalid_config", String(bad));
  }
  for (const good of [1, 2, 8]) assert.doesNotThrow(() => new TaskHost({ ...base, maxParallelTasks: good }).close());
});

test("maxParallelTasks:3 admits three tasks at once, queues the fourth, and admits it when a slot frees", async () => {
  const storageRoot = await mkTempRoot();
  const built = [];
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    maxParallelTasks: 3,
    parallelTaskReserveBytes: 100_000_000,
    memoryMonitor: { getPressureLevel: () => "normal", canAdmitTask: () => ({ allowed: true }) },
    makeBrowser: (taskId) => { built.push(taskId); return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const tasks = [];
  for (const name of ["one", "two", "three", "four"]) tasks.push(await host.createTask({ originalRequest: name }));
  assert.deepEqual(tasks.map((item) => item.snapshot.state), ["awaiting_verification", "awaiting_verification", "awaiting_verification", "queued"]);
  assert.equal(built.length, 3);
  await host.stopTask(tasks[0].taskId);
  for (let i = 0; i < 100 && built.length < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(built.length, 4);
  assert.equal(built[3], tasks[3].taskId);
});

test("maxParallelTasks:3 does not override memory admission: with room for two, the third stays queued and builds nothing", async () => {
  const storageRoot = await mkTempRoot();
  let built = 0;
  const host = makeHost(storageRoot, {
    executionMode: "parallel",
    maxParallelTasks: 3,
    parallelTaskReserveBytes: 300_000_000,
    memoryMonitor: {
      getPressureLevel: () => "normal",
      getLastSample: () => ({ totalBytes: 0, unmeasurable: [], sampledAt: 7 }),
      canAdmitTask: ({ reserveBytes }) => ({ allowed: reserveBytes <= 700_000_000, reason: reserveBytes <= 700_000_000 ? null : "memory_budget_exceeded" }),
    },
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  const states = [];
  for (const name of ["one", "two", "three"]) states.push((await host.createTask({ originalRequest: name })).snapshot.state);
  assert.deepEqual(states, ["awaiting_verification", "awaiting_verification", "queued"]);
  assert.equal(built, 2);
});

test("sequential mode ignores maxParallelTasks", async () => {
  const storageRoot = await mkTempRoot();
  let built = 0;
  const host = makeHost(storageRoot, {
    executionMode: "sequential",
    maxParallelTasks: 4,
    makeBrowser: () => { built += 1; return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }; },
  });
  await host.createTask({ originalRequest: "one" });
  const second = await host.createTask({ originalRequest: "two" });
  assert.equal(second.snapshot.state, "queued");
  assert.equal(built, 1);
});
