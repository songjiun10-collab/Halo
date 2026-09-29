"use strict";

// Background-runtime plan Task 5, step 1: failing tests for the
// service-owned runtime lifecycle -- BackgroundRuntimeService wraps a
// TaskHost-like object behind the RuntimeIpcServer transport (already
// tested standalone in background-runtime-ipc.test.js) and is the thing a
// per-user LaunchAgent would keep alive. The core safety property under
// test: attaching/detaching a UI client is bookkeeping only -- it must
// never touch the underlying TaskHost -- while an explicit stopService()/
// stopTask() really does drain/stop real work. Uses the REAL
// RuntimeIpcServer/RuntimeIpcClient (already verified) end-to-end against a
// FAKE taskHost, so this file's own tests stay focused on the service's own
// lifecycle/allowlist semantics rather than re-testing the wire protocol.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { BackgroundRuntimeService, BackgroundRuntimeServiceError } = require("../main/harness/background-runtime-service");
const { RuntimeIpcClient } = require("../main/harness/background-runtime-ipc");
const { BackgroundRuntimeClient } = require("../main/harness/background-runtime-client");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-runtime-service-"));
}

function makeFakeTaskHost(overrides = {}) {
  const calls = [];
  const listeners = new Set();
  const host = {
    calls,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(taskId, snapshot, detail) {
      for (const listener of listeners) listener(taskId, snapshot, detail);
    },
    async listTasks() {
      calls.push(["listTasks"]);
      return [{ taskId: "t1", state: "running" }];
    },
    async createTask(goalInput) {
      calls.push(["createTask", goalInput]);
      return { taskId: "new-task" };
    },
    async stopTask(taskId) {
      calls.push(["stopTask", taskId]);
      return { taskId, state: "stopped" };
    },
    async updateHostSettings(patch) {
      calls.push(["updateHostSettings", patch]);
      return { memoryPolicy: patch.memoryPolicy };
    },
    async listChildren(parentTaskId) {
      calls.push(["listChildren", parentTaskId]);
      return [];
    },
    async close() {
      calls.push(["close"]);
    },
    ...overrides,
  };
  return host;
}

async function startService(taskHost) {
  const root = await mkTempRoot();
  const socketPath = path.join(root, "runtime.sock");
  const service = new BackgroundRuntimeService({ socketPath, taskHost });
  const { capability } = await service.start();
  return { service, socketPath, capability, root };
}

async function connectedClient(socketPath, capability, clientId) {
  const client = new RuntimeIpcClient({ socketPath, capability, clientId });
  await client.connect();
  return client;
}

test("start() opens a connectable socket and returns a fresh capability", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  assert.ok(typeof capability === "string" && capability.length >= 32);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.close();
  await service.stopService("test done");
});

test("starting the same service twice is rejected rather than silently rebinding", async () => {
  const taskHost = makeFakeTaskHost();
  const { service } = await startService(taskHost);
  await assert.rejects(() => service.start(), (error) => {
    assert.ok(error instanceof BackgroundRuntimeServiceError);
    assert.equal(error.code, "already_started");
    return true;
  });
  await service.stopService("test done");
});

test("attachClient()/detachClient() are pure bookkeeping: detaching a client never touches the TaskHost", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  await client.call("detachClient", "ui-1");
  assert.deepEqual(taskHost.calls, [], "no TaskHost method should have been invoked by attach/detach alone");
  await client.close();
  await service.stopService("test done");
});

test("attachClient() is idempotent: attaching the same clientId twice does not duplicate it in the snapshot", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  await client.call("attachClient", "ui-1");
  const snapshot = await client.call("getSnapshot");
  assert.deepEqual(snapshot.clients, ["ui-1"]);
  await client.close();
  await service.stopService("test done");
});

test("a TaskHost-surface method is rejected until the calling client has attached", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await assert.rejects(() => client.call("listTasks"), (error) => {
    assert.equal(error.code, "not_attached");
    return true;
  });
  await assert.rejects(() => client.call("getWorkGoalRecoveryStatus", ["g1", 1]), (error) => {
    assert.equal(error.code, "not_attached");
    return true;
  });
  await client.call("attachClient", "ui-1");
  const tasks = await client.call("listTasks");
  assert.deepEqual(tasks, [{ taskId: "t1", state: "running" }]);
  await client.close();
  await service.stopService("test done");
});

test("routine and work-goal TaskHost methods reach the TaskHost over the background runtime, not just the renderer's direct IPC path", async () => {
  // main/ipc.js's HARNESS_METHODS exposes listRoutines/getRoutine/saveRoutine/
  // deleteRoutine/runRoutine and the Work Goal lifecycle/recovery
  // methods to the renderer. BackgroundRuntimeService's TASK_HOST_METHODS
  // allowlist is a separate, hand-maintained list guarding the same TaskHost
  // surface for the out-of-process/background path -- it must not silently
  // fall behind main/ipc.js's list.
  const taskHost = makeFakeTaskHost({
    async listRoutines() { return [{ routineId: "r1" }]; },
    async getRoutine(routineId, revision) { return { routineId, revision }; },
    async saveRoutine(input) { return { routineId: "new-routine", ...input }; },
    async deleteRoutine(routineId) { return { routineId, deleted: true }; },
    async runRoutine(routineId, revision, options) { return { taskId: "routine-task", routineId, revision, options }; },
    async startWorkGoal(input) { return { goalId: "g1", ...input }; },
    async getActiveWorkGoal() { return null; },
    async listWorkGoalHistory(options) { return { options }; },
    async amendWorkGoal(expectedVersion, nextSpec) { return { expectedVersion, nextSpec }; },
    async pauseWorkGoal(goalId, expectedVersion) { return { goalId, expectedVersion, status: "paused" }; },
    async resumeWorkGoal(goalId, expectedVersion) { return { goalId, expectedVersion, status: "active" }; },
    async completeWorkGoal(goalId, expectedVersion) { return { goalId, expectedVersion, status: "completed" }; },
    async archiveWorkGoal(goalId, expectedVersion) { return { goalId, expectedVersion, status: "archived" }; },
    async recordWorkGoalProgress(goalId, expectedVersion, evidenceRefs) { return { goalId, expectedVersion, evidenceRefs }; },
    async verifyWorkGoalCriterion(goalId, expectedVersion, criterionId) { return { goalId, expectedVersion, criterionId, verified: true }; },
    async getWorkGoalRecoveryStatus(goalId, expectedVersion) { return [{ goalId, expectedVersion, status: "held" }]; },
    async repairWorkGoalReservation(goalId, expectedVersion, reservationId) { return { goalId, expectedVersion, reservationId, status: "cancelled" }; },
  });
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  assert.deepEqual(await client.call("listRoutines"), [{ routineId: "r1" }]);
  assert.deepEqual(await client.call("getRoutine", ["r1", 2]), { routineId: "r1", revision: 2 });
  assert.deepEqual(await client.call("saveRoutine", { name: "x" }), { routineId: "new-routine", name: "x" });
  assert.deepEqual(await client.call("deleteRoutine", "r1"), { routineId: "r1", deleted: true });
  assert.deepEqual(await client.call("runRoutine", ["r1", 2, { standalone: true }]), { taskId: "routine-task", routineId: "r1", revision: 2, options: { standalone: true } });
  assert.deepEqual(await client.call("startWorkGoal", { objective: "o" }), { goalId: "g1", objective: "o" });
  assert.equal(await client.call("getActiveWorkGoal"), null);
  assert.deepEqual(await client.call("listWorkGoalHistory", { limit: 9, cursor: "00000000-0000-4000-8000-000000000001" }), {
    options: { limit: 9, cursor: "00000000-0000-4000-8000-000000000001" },
  });
  assert.deepEqual(await client.call("amendWorkGoal", [1, { objective: "o2" }]), { expectedVersion: 1, nextSpec: { objective: "o2" } });
  assert.deepEqual(await client.call("pauseWorkGoal", ["g1", 1]), { goalId: "g1", expectedVersion: 1, status: "paused" });
  assert.deepEqual(await client.call("resumeWorkGoal", ["g1", 2]), { goalId: "g1", expectedVersion: 2, status: "active" });
  assert.deepEqual(await client.call("completeWorkGoal", ["g1", 3]), { goalId: "g1", expectedVersion: 3, status: "completed" });
  assert.deepEqual(await client.call("archiveWorkGoal", ["g1", 4]), { goalId: "g1", expectedVersion: 4, status: "archived" });
  assert.deepEqual(await client.call("recordWorkGoalProgress", ["g1", 1, ["e1"]]), { goalId: "g1", expectedVersion: 1, evidenceRefs: ["e1"] });
  assert.deepEqual(await client.call("verifyWorkGoalCriterion", ["g1", 1, "c1"]), { goalId: "g1", expectedVersion: 1, criterionId: "c1", verified: true });
  assert.deepEqual(await client.call("getWorkGoalRecoveryStatus", ["g1", 1]), [{ goalId: "g1", expectedVersion: 1, status: "held" }]);
  assert.deepEqual(await client.call("repairWorkGoalReservation", ["g1", 1, "r1"]), { goalId: "g1", expectedVersion: 1, reservationId: "r1", status: "cancelled" });
  await client.close();
  await service.stopService("test done");
});

test("an unlisted/unknown method name is rejected rather than reaching the TaskHost or any filesystem path", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  await assert.rejects(() => client.call("__proto__"), (error) => {
    assert.equal(error.code, "unknown_method");
    return true;
  });
  await assert.rejects(() => client.call("readFileSync"), (error) => {
    assert.equal(error.code, "unknown_method");
    return true;
  });
  assert.deepEqual(taskHost.calls.map((c) => c[0]), ["listTasks"].filter(() => false)); // no host call from the rejected attempts
  await client.close();
  await service.stopService("test done");
});

test("stopTask(taskId, reason) records the reason as a service event and then actually stops the task", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const events = [];
  service.onEvent((event, payload) => events.push({ event, payload }));
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  const result = await client.call("stopTask", ["t1", "user requested stop"]);
  assert.deepEqual(result, { taskId: "t1", state: "stopped" });
  assert.deepEqual(taskHost.calls, [["stopTask", "t1"]]);
  assert.ok(events.some((e) => e.event === "serviceNotice" && e.payload.kind === "task_stop_requested" && e.payload.reason === "user requested stop"));
  await client.close();
  await service.stopService("test done");
});

test("setMemoryPolicy() delegates to the TaskHost's updateHostSettings", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  const result = await client.call("setMemoryPolicy", "user_override");
  assert.deepEqual(result, { memoryPolicy: "user_override" });
  assert.deepEqual(taskHost.calls, [["updateHostSettings", { memoryPolicy: "user_override" }]]);
  await client.close();
  await service.stopService("test done");
});

test("taskHost.onEvent() updates are broadcast to every attached client as a taskEvent", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  const received = [];
  client.on("taskEvent", (payload) => received.push(payload));
  taskHost.emit("t1", { state: "running" }, { goal: { originalRequest: "x" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received.length, 1);
  assert.equal(received[0].taskId, "t1");
  assert.equal(received[0].snapshot.state, "running");
  await client.close();
  await service.stopService("test done");
});

test("stopService() drains the TaskHost (close()) exactly once even if called twice, and rejects further calls", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  await service.stopService("shutting down");
  await service.stopService("shutting down again");
  assert.deepEqual(taskHost.calls.filter((c) => c[0] === "close"), [["close"]]);
});

test("stopService() called over IPC returns its acknowledgement before the service closes the socket", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  const stopped = new Promise((resolve) => service.onEvent((event) => {
    if (event === "serviceStopped") resolve();
  }));
  const result = await client.call("stopService", "user requested stop");
  assert.equal(result, null);
  assert.deepEqual(taskHost.calls.filter((call) => call[0] === "close"), [["close"]]);
  await stopped;
  await client.close().catch(() => {});
});

test("window close (detachClient) leaves the service and its tasks running -- only stopService() drains them", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  await client.call("detachClient", "ui-1");
  await client.close();
  // Service is still alive and usable by a fresh client after the first one
  // detached and disconnected -- exactly the "hidden/closed UI is a client
  // detach, not task cancellation" global constraint.
  const secondClient = await connectedClient(socketPath, capability, "ui-2");
  await secondClient.call("attachClient", "ui-2");
  const tasks = await secondClient.call("listTasks");
  assert.deepEqual(tasks, [{ taskId: "t1", state: "running" }]);
  assert.equal(taskHost.calls.filter((c) => c[0] === "close").length, 0);
  await secondClient.close();
  await service.stopService("test done");
});

test("getSnapshot() reflects currently attached clients and the TaskHost's own task list", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = await connectedClient(socketPath, capability, "ui-1");
  await client.call("attachClient", "ui-1");
  const snapshot = await client.call("getSnapshot");
  assert.deepEqual(snapshot.clients, ["ui-1"]);
  assert.deepEqual(snapshot.tasks, [{ taskId: "t1", state: "running" }]);
  assert.equal(snapshot.stopped, false);
  await client.close();
  await service.stopService("test done");
});

// ---- BackgroundRuntimeClient: the UI-process side, used by main/index.js
// in place of an in-process TaskHost so main/ipc.js's existing
// `taskHost[method](...args)` calls work unchanged. ----

test("BackgroundRuntimeClient.connect() attaches in one step, and its proxied TaskHost methods reach the real TaskHost", async () => {
  const taskHost = makeFakeTaskHost({
    async getWorkGoalRecoveryStatus(goalId, expectedVersion) { return [{ goalId, expectedVersion, status: "held" }]; },
    async repairWorkGoalReservation(goalId, expectedVersion, reservationId) { return { goalId, expectedVersion, reservationId, status: "cancelled" }; },
  });
  const { service, socketPath, capability } = await startService(taskHost);
  const client = new BackgroundRuntimeClient({ socketPath, capability, clientId: "ui-1" });
  await client.connect();
  const tasks = await client.listTasks();
  assert.deepEqual(tasks, [{ taskId: "t1", state: "running" }]);
  const created = await client.createTask({ originalRequest: "goal" });
  assert.deepEqual(created, { taskId: "new-task" });
  assert.deepEqual(await client.getWorkGoalRecoveryStatus("g1", 2), [{ goalId: "g1", expectedVersion: 2, status: "held" }]);
  assert.deepEqual(await client.repairWorkGoalReservation("g1", 2, "r1"), { goalId: "g1", expectedVersion: 2, reservationId: "r1", status: "cancelled" });
  assert.deepEqual(taskHost.calls.filter((c) => c[0] === "createTask"), [["createTask", { originalRequest: "goal" }]]);
  await client.detach();
  await service.stopService("test done");
});

test("BackgroundRuntimeClient.detach() (the UI-window-close path) never stops any task, and a fresh client can still see it running afterward", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = new BackgroundRuntimeClient({ socketPath, capability, clientId: "ui-1" });
  await client.connect();
  await client.detach();
  assert.equal(taskHost.calls.filter((c) => c[0] === "stopTask" || c[0] === "close").length, 0);

  const second = new BackgroundRuntimeClient({ socketPath, capability, clientId: "ui-2" });
  await second.connect();
  const tasks = await second.listTasks();
  assert.deepEqual(tasks, [{ taskId: "t1", state: "running" }]);
  await second.detach();
  await service.stopService("test done");
});

test("BackgroundRuntimeClient delivers taskHost.onEvent() updates via onEvent() with the same (taskId, snapshot, detail) shape", async () => {
  const taskHost = makeFakeTaskHost();
  const { service, socketPath, capability } = await startService(taskHost);
  const client = new BackgroundRuntimeClient({ socketPath, capability, clientId: "ui-1" });
  await client.connect();
  const received = [];
  client.onEvent((taskId, snapshot, detail) => received.push({ taskId, snapshot, detail }));
  taskHost.emit("t1", { state: "paused" }, { pauseReason: "need_user" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received.length, 1);
  assert.equal(received[0].taskId, "t1");
  assert.equal(received[0].snapshot.state, "paused");
  assert.equal(received[0].detail.pauseReason, "need_user");
  await client.detach();
  await service.stopService("test done");
});
