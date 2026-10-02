"use strict";

// The renderer calls getChildPlan(taskId) whenever a task is selected and
// validates the result with summarizeChildPlan (frontend/src/session/
// child-agents.ts). The host answers from the parent-authored plan only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { ChildAgentCoordinator } = require("../main/harness/child-agent-coordinator");
const { resolveTaskProfile } = require("../shared/task-profile-router");

async function parentStore(storageRoot) {
  const goalInput = { originalRequest: "parent goal" };
  return TaskStore.create(goalInput, { storageRoot, resolvedProfile: resolveTaskProfile({ goalInput, requestedCapabilityProfile: "multi_agent" }) });
}

const proposal = (taskId) => ({
  taskId,
  goalVersion: 1,
  basedOnObservationId: "obs-1",
  criterionIds: [],
  kind: "child_plan",
  parentGoalVersion: 1,
  requestedAgentCount: 2,
  assignments: [
    { subgoal: "a", entryUrl: "https://a.example/start" },
    { subgoal: "b", entryUrl: "https://b.example/start" },
  ],
});

test("getPlanSummary is null without a plan and matches the renderer contract with one", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-summary-"));
  const parent = await parentStore(storageRoot);
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  try {
    assert.equal(await coordinator.getPlanSummary(parent.taskId), null);
    const { childIds } = await coordinator.acceptParentPlan(parent.taskId, proposal(parent.taskId), { parentStore: parent, memoryPolicy: "budgeted" });
    const summary = await coordinator.getPlanSummary(parent.taskId);
    assert.deepEqual(summary, {
      requestedAgentCount: 2,
      activeAgentCount: 0,
      queuedAgentCount: 2,
      parentGoalVersion: 1,
      memoryPolicy: "budgeted",
      agents: [
        { agentId: childIds[0], status: "queued", assignedOrigin: "https://a.example", evidenceCount: 0, subgoal: "a" },
        { agentId: childIds[1], status: "queued", assignedOrigin: "https://b.example", evidenceCount: 0, subgoal: "b" },
      ],
    });

    // A fresh coordinator (process restart) rebuilds the same summary from the journal.
    const restarted = new ChildAgentCoordinator({ storageRoot });
    assert.deepEqual(await restarted.getPlanSummary(parent.taskId), summary);

    await coordinator.cancelPlan(parent.taskId, "user_stop", { parentStore: parent });
    assert.equal(await coordinator.getPlanSummary(parent.taskId), null);
  } finally {
    await parent.close();
  }
});

test("a terminal child carries its outcome and reason", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-summary-"));
  const parent = await parentStore(storageRoot);
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  try {
    const { childIds } = await coordinator.acceptParentPlan(parent.taskId, proposal(parent.taskId), { parentStore: parent, memoryPolicy: "budgeted" });
    coordinator._terminalChildren.set(childIds[0], { outcome: "failed", reason: "child_start_failed" });
    const summary = await coordinator.getPlanSummary(parent.taskId);
    assert.deepEqual(summary.agents[0], { agentId: childIds[0], status: "failed", assignedOrigin: "https://a.example", evidenceCount: 0, subgoal: "a", reason: "child_start_failed" });
    assert.equal(summary.queuedAgentCount, 1);
  } finally {
    await parent.close();
  }
});

test("getChildPlan is exposed through TaskHost, ipc, preload and the background service", async () => {
  const { TaskHost } = require("../main/harness/task-host");
  const { TASK_HOST_METHODS } = require("../main/harness/background-runtime-service");
  const host = new TaskHost({
    storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-host-")),
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async () => { throw new Error("unused"); } }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  try {
    await assert.rejects(host.getChildPlan("11111111-1111-4111-8111-111111111111"), /no task store/);
  } finally {
    await host.close();
  }
  assert.ok(TASK_HOST_METHODS.has("getChildPlan"));
  const ipcSource = await fs.readFile(path.join(__dirname, "..", "main", "ipc.js"), "utf8");
  const preloadSource = await fs.readFile(path.join(__dirname, "..", "preload", "index.js"), "utf8");
  assert.match(ipcSource, /"halo:getChildPlan": "getChildPlan"/);
  assert.match(preloadSource, /"getChildPlan"/);
});

test("plan changes are announced and a waiting child counts as active", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-summary-"));
  const parent = await parentStore(storageRoot);
  const changes = [];
  const coordinator = new ChildAgentCoordinator({ storageRoot, onPlanChange: (id) => changes.push(id) });
  try {
    const { childIds } = await coordinator.acceptParentPlan(parent.taskId, proposal(parent.taskId), { parentStore: parent, memoryPolicy: "budgeted" });
    assert.deepEqual(changes, [parent.taskId]);
    coordinator._liveChildren.set(childIds[0], { parentTaskId: parent.taskId, summaryStatus: "waiting_for_review" });
    const summary = await coordinator.getPlanSummary(parent.taskId);
    assert.equal(summary.agents[0].status, "waiting_for_review");
    assert.equal(summary.activeAgentCount, 1);
    assert.equal(summary.queuedAgentCount, 1);
    coordinator._liveChildren.delete(childIds[0]);
    await coordinator.cancelPlan(parent.taskId, "user_stop", { parentStore: parent });
    assert.deepEqual(changes, [parent.taskId, parent.taskId]);
  } finally {
    await parent.close();
  }
});

test("a throwing plan observer never breaks plan acceptance", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-summary-"));
  const parent = await parentStore(storageRoot);
  const coordinator = new ChildAgentCoordinator({ storageRoot, onPlanChange: () => { throw new Error("observer"); } });
  try {
    const result = await coordinator.acceptParentPlan(parent.taskId, proposal(parent.taskId), { parentStore: parent, memoryPolicy: "budgeted" });
    assert.equal(result.childIds.length, 2);
  } finally {
    await parent.close();
  }
});

test("TaskHost.getChildPlan returns null for a corrupt parent-child link", async () => {
  const { TaskHost } = require("../main/harness/task-host");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-corrupt-"));
  const parent = await parentStore(storageRoot);
  const { childIds } = await new ChildAgentCoordinator({ storageRoot }).acceptParentPlan(parent.taskId, proposal(parent.taskId), { parentStore: parent, memoryPolicy: "budgeted" });
  await parent.close();
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name === childIds[0]) found.push(full); else await walk(full); }
    }
  };
  await walk(storageRoot);
  assert.equal(found.length, 1);
  await fs.rm(found[0], { recursive: true });
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async () => { throw new Error("unused"); } }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  try {
    assert.equal(await host.getChildPlan(parent.taskId), null);
  } finally {
    await host.close();
  }
});

test("TaskHost pushes an attached parent's child plan with its snapshot", async () => {
  const { TaskHost } = require("../main/harness/task-host");
  const host = new TaskHost({
    storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-plan-push-")),
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async () => { throw new Error("unused"); } }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  const events = [];
  host.onEvent((taskId, snapshot, detail) => events.push({ taskId, snapshot, detail }));
  const plan = { requestedAgentCount: 1, activeAgentCount: 1, queuedAgentCount: 0, parentGoalVersion: 1, memoryPolicy: "budgeted", agents: [] };
  host._childCoordinator.getPlanSummary = async () => plan;
  try {
    host._emitChildPlan("detached-parent");
    host._active.set("parent-1", { snapshot: { state: "running" } });
    host._emitChildPlan("parent-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [{ taskId: "parent-1", snapshot: { state: "running" }, detail: { childPlan: plan } }]);
  } finally {
    host._active.delete("parent-1");
    await host.close();
  }
});
