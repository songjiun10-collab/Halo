"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { ChildAgentCoordinator } = require("../main/harness/child-agent-coordinator");
const { resolveTaskProfile } = require("../shared/task-profile-router");

async function childFixture() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-child-report-"));
  const goalInput = { originalRequest: "parent goal" };
  const parent = await TaskStore.create(goalInput, {
    storageRoot,
    resolvedProfile: resolveTaskProfile({ goalInput, requestedCapabilityProfile: "multi_agent" }),
  });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  coordinator.registerStore(parent.taskId, parent);
  const { childIds } = await coordinator.acceptParentPlan(parent.taskId, {
    taskId: parent.taskId, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [],
    kind: "child_plan", parentGoalVersion: 1, requestedAgentCount: 1,
    assignments: [{ subgoal: "a", entryUrl: "https://a.example/start" }],
  }, { parentStore: parent, memoryPolicy: "user_override" });
  const childId = childIds[0];
  const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
  coordinator.registerStore(childId, childStore);
  const closed = () => {};
  const finishChild = async (id, state) => {
    coordinator._liveChildren.set(id, {
      parentTaskId: parent.taskId,
      store: childStore,
      leaseId: "lease",
      controller: { closeMcp: closed },
      planner: {},
      browser: {},
    });
    coordinator._getResourceAdmission = () => ({ release: async () => {} });
    await coordinator._retireChild(parent.taskId, id, state);
  };
  const sendReport = (id, { messageKind, text }) => coordinator.handleSendMessage(id, {
    kind: "send_message", recipientTaskId: parent.taskId, messageKind, text,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
  });
  const agentOf = async () => (await coordinator.getPlanSummary(parent.taskId)).agents.find((a) => a.agentId === childId);
  return { coordinator, parent, childId, finishChild, sendReport, agentOf };
}

test("a child that finishes without any progress or handoff report is marked unreported", async () => {
  const { childId, finishChild, agentOf } = await childFixture();
  await finishChild(childId, "completed");
  const agent = await agentOf();
  assert.equal(agent.status, "completed");
  assert.equal(agent.reported, false);
  assert.equal(agent.unreported, true);
});

test("a child that posted a progress report before finishing is marked reported", async () => {
  const { childId, finishChild, sendReport, agentOf } = await childFixture();
  await sendReport(childId, { messageKind: "progress", text: "searched three pages, nothing found" });
  await finishChild(childId, "completed");
  const agent = await agentOf();
  assert.equal(agent.reported, true);
  assert.equal(agent.unreported, undefined);
});

test("a stopped child is not reported as unreported", async () => {
  const { childId, finishChild, agentOf } = await childFixture();
  await finishChild(childId, "stopped");
  const agent = await agentOf();
  assert.equal(agent.status, "stopped");
  assert.equal(agent.unreported, undefined);
  assert.equal(agent.reported, undefined);
});
