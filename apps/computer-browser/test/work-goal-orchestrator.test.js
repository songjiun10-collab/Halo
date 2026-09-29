"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { WorkGoalOrchestrator } = require("../main/harness/work-goal-orchestrator");
const { WorkGoalStore } = require("../main/harness/work-goal-store");
const { replayWorkGoalEvents, validateWorkGoalInput } = require("../shared/work-goal-contracts");
const { TaskStore } = require("../main/harness/task-store");
const { resolveTaskProfile } = require("../shared/task-profile-router");

const GOAL_ID = "11111111-1111-4111-8111-111111111111";

class MemoryGoalStore {
  constructor() { this.events = []; }

  async create(input) {
    validateWorkGoalInput(input);
    if (this.getActive()) throw Object.assign(new Error("an active Goal exists"), { code: "active_goal_exists" });
    const spec = { schemaVersion: 1, goalId: GOAL_ID, version: 1,
      objective: input.objective, successCriteria: input.successCriteria, budget: input.budget || {} };
    await this.append({ goalId: GOAL_ID, expectedVersion: 1, type: "work_goal_created", payload: { spec } });
    return this.get(GOAL_ID);
  }

  async append({ goalId, expectedVersion, type, payload }) {
    if (goalId !== GOAL_ID) throw Object.assign(new Error("unknown Goal"), { code: "not_found" });
    const current = this.events.length ? this.get(GOAL_ID) : null;
    if (current && current.spec.version !== expectedVersion) {
      throw Object.assign(new Error("stale Work Goal version"), { code: "stale_goal_version" });
    }
    const event = {
      seq: this.events.length + 1,
      eventId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.events.length + 1).padStart(12, "0")}`,
      goalId,
      goalVersion: type === "work_goal_amended" ? payload.spec.version : expectedVersion,
      type,
      payload,
      at: new Date().toISOString(),
    };
    replayWorkGoalEvents([...this.events, event]);
    this.events.push(event);
    return this.get(goalId);
  }

  get(goalId) {
    if (goalId !== GOAL_ID || !this.events.length) return null;
    return replayWorkGoalEvents(this.events);
  }

  getActive() {
    const state = this.get(GOAL_ID);
    return state && ["active", "paused", "blocked"].includes(state.status) ? state : null;
  }

  listHistory() { return this.events.length ? [this.get(GOAL_ID)] : []; }
}

function workGoalInput() {
  return {
    objective: "Verify a project across Tasks",
    successCriteria: [
      { id: "hostProof", text: "Host verified result", required: true, verification: "host_evidence" },
      { id: "userCheck", text: "User checked result", required: true, verification: "user" },
    ],
    budget: { maxTasks: 5, maxActions: 20, maxPlannerCalls: 12, maxActiveMs: 2000 },
  };
}

async function fixture(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-goal-orchestrator-"));
  const openStores = [];
  t.after(async () => {
    await Promise.all(openStores.map((item) => item.close()));
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  const store = new MemoryGoalStore();
  const orchestrator = new WorkGoalOrchestrator({
    storageRoot, store, getOpenTaskStore: (taskId) => openStores.find((item) => item.taskId === taskId) || null,
  });
  const goal = await orchestrator.startWorkGoal(workGoalInput());
  return { storageRoot, store, orchestrator, goalId: goal.goalId, openStores };
}

function limits() {
  return { maxTasks: 1, maxActions: 6, maxPlannerCalls: 3, maxActiveMs: 600 };
}

let nextTaskNumber = 1;
async function boundTask(t, fixtureValue, { goalVersion = 1, reservationId, taskId, evidence = "verified", criterionId = "hostProof", taskState = "completed", checkpoint = true } = {}) {
  const { storageRoot, orchestrator, goalId } = fixtureValue;
  const number = nextTaskNumber++;
  const id = taskId || `22222222-2222-4222-8222-${String(number).padStart(12, "0")}`;
  const reservation = reservationId || `33333333-3333-4333-8333-${String(number).padStart(12, "0")}`;
  await orchestrator.reserveTask(goalId, goalVersion, { taskId: id, reservationId: reservation, limits: limits() });
  const goalInput = {
    originalRequest: "Verify the bound task",
    criteria: [{ id: "hostProof", text: "Host verified result", required: true, verification: "host" }],
    limits: { maxActions: 6, maxPlannerCalls: 3, maxActiveMs: 600 },
  };
  const taskStore = await TaskStore.create(goalInput, {
    storageRoot,
    taskId: id,
    resolvedProfile: resolveTaskProfile({ goalInput }),
    workGoalBinding: { goalId, goalVersion, reservationId: reservation },
  });
  fixtureValue.openStores.push(taskStore);
  const evidenceId = "ev-real";
  const event = await taskStore.append({
    type: "evidence_recorded",
    payload: { evidence: {
      id: evidenceId, taskId: id, goalVersion: 1, criterionId,
      kind: "host_check", at: new Date().toISOString(), verification: evidence,
      ...(evidence === "pending" ? {} : { verifierId: "host" }),
    } },
  });
  if (checkpoint) await taskStore.checkpoint({
    task: { state: taskState, pauseReason: taskState === "paused" ? "planner_error" : null },
    budgets: { actionsUsed: 3, plannerCallsUsed: 2, activeMs: 100 },
  });
  await orchestrator.linkTask(goalId, goalVersion, { taskId: id, reservationId: reservation });
  return {
    taskId: id,
    reservationId: reservation,
    taskStore,
    evidenceRef: { criterionId, taskId: id, eventId: event.eventId, evidenceId },
  };
}

test("amendment and lifecycle reject stale versions and keep old-version context", async (t) => {
  const { orchestrator, goalId } = await fixture(t);
  const original = orchestrator.getContext(goalId, 1);
  assert.equal(original.objective, "Verify a project across Tasks");
  assert.deepEqual(original.verifiedCriterionIds, []);
  const nextInput = { ...workGoalInput(), objective: "Verify amended project" };
  const amended = await orchestrator.amendWorkGoal(1, nextInput);
  assert.equal(amended.spec.version, 2);
  assert.equal(orchestrator.getContext(goalId, 1).objective, original.objective);
  assert.equal(orchestrator.getContext(goalId, 2).objective, "Verify amended project");
  await assert.rejects(orchestrator.amendWorkGoal(1, nextInput), { code: "stale_goal_version" });
  await assert.rejects(orchestrator.verifyWorkGoalCriterion(goalId, 1, "userCheck"), { code: "stale_goal_version" });

  await orchestrator.pauseWorkGoal(goalId, 2);
  assert.equal(orchestrator.getActiveWorkGoal().status, "paused");
  await assert.rejects(orchestrator.completeWorkGoal(goalId, 2), { code: "invalid_transition" });
  await orchestrator.resumeWorkGoal(goalId, 2);
  await assert.rejects(orchestrator.archiveWorkGoal(goalId, 2), { code: "invalid_transition" });
  await orchestrator.pauseWorkGoal(goalId, 2);
  await orchestrator.archiveWorkGoal(goalId, 2);
  assert.equal(orchestrator.getActiveWorkGoal(), null);
  assert.equal((await orchestrator.listWorkGoalHistory())[0].status, "archived");
});

test("host evidence plus user verification are both required for completion", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const task = await boundTask(t, value);
  await assert.rejects(orchestrator.completeWorkGoal(goalId, 1), { code: "criteria_incomplete" });
  await orchestrator.recordWorkGoalProgress(goalId, 1, [task.evidenceRef]);
  assert.deepEqual(orchestrator.getContext(goalId, 1).verifiedCriterionIds, ["hostProof"]);
  await assert.rejects(orchestrator.completeWorkGoal(goalId, 1), { code: "criteria_incomplete" });
  await orchestrator.verifyWorkGoalCriterion(goalId, 1, "userCheck");
  const completed = await orchestrator.completeWorkGoal(goalId, 1);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.verifiedCriteria, ["hostProof", "userCheck"]);
  await assert.rejects(orchestrator.completeWorkGoal(goalId, 1), { code: "invalid_transition" });
});

test("evidence substitution, pending evidence, and stale Work Goal bindings fail closed", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const task = await boundTask(t, value);
  const badEvent = { ...task.evidenceRef, eventId: "44444444-4444-4444-8444-444444444444" };
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [badEvent]), { code: "invalid_evidence" });
  const badId = { ...task.evidenceRef, evidenceId: "ev-other" };
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [badId]), { code: "invalid_evidence" });
  const badCriterion = { ...task.evidenceRef, criterionId: "userCheck" };
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [badCriterion]), { code: "invalid_evidence" });
  const foreignTask = { ...task.evidenceRef, taskId: "55555555-5555-4555-8555-555555555555" };
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [foreignTask]), { code: "invalid_evidence" });

  const pending = await boundTask(t, value, { evidence: "pending" });
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [pending.evidenceRef]), { code: "invalid_evidence" });
  const amended = await orchestrator.amendWorkGoal(1, workGoalInput());
  assert.equal(amended.spec.version, 2);
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 2, [task.evidenceRef]), { code: "invalid_evidence" });
});

test("a Task at TaskSpec version 1 can verify its bound Work Goal version 2", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  await orchestrator.amendWorkGoal(1, workGoalInput());
  const task = await boundTask(t, value, { goalVersion: 2 });
  const events = await TaskStore.readEvents(task.taskId, { storageRoot: value.storageRoot });
  assert.equal(events.find((item) => item.type === "evidence_recorded").goalVersion, 1);
  assert.equal(events.find((item) => item.type === "task_profile_selected").payload.workGoalBinding.goalVersion, 2);
  await orchestrator.recordWorkGoalProgress(goalId, 2, [task.evidenceRef]);
  assert.deepEqual(orchestrator.getContext(goalId, 2).verifiedCriterionIds, ["hostProof"]);
  assert.deepEqual(orchestrator.getContext(goalId, 1).verifiedCriterionIds, []);
});

test("an old-version Task cannot count as a new-version continuation blocker", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const task = await boundTask(t, value, { taskState: "paused" });
  await orchestrator.amendWorkGoal(1, workGoalInput());
  await assert.rejects(
    orchestrator.recordContinuation(goalId, 2, { taskId: task.taskId, origin: "user" }),
    { code: "invalid_binding" },
  );
  assert.equal(value.store.get(goalId).blockerStreak.pendingTaskId, null);
});

test("reservation retries preserve their original identity across a Work Goal amendment", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const input = {
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    reservationId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    limits: limits(),
  };
  const first = await orchestrator.reserveTask(goalId, 1, input);
  await orchestrator.amendWorkGoal(1, workGoalInput());
  assert.deepEqual(await orchestrator.reserveTask(goalId, 1, input), first);
  assert.equal(value.store.events.filter((event) => event.type === "work_goal_task_reserved").length, 1);
  await assert.rejects(orchestrator.reserveTask(goalId, 1, { ...input, taskId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002" }), { code: "reservation_conflict" });
  await assert.rejects(orchestrator.reserveTask(goalId, 1, { ...input, reservationId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002" }), { code: "stale_goal_version" });
});

test("Task planner context requires an exact linked reservation and persisted profile binding", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const reservedTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
  const reservedId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000011";
  await orchestrator.reserveTask(goalId, 1, { taskId: reservedTaskId, reservationId: reservedId, limits: limits() });
  const unlinked = {
    goalId, goalVersion: 1, taskId: reservedTaskId, reservationId: reservedId,
    workGoalBinding: { goalId, goalVersion: 1, reservationId: reservedId },
  };
  assert.throws(() => orchestrator.getTaskContext(unlinked), { code: "invalid_binding" });

  const task = await boundTask(t, value);
  const binding = {
    goalId, goalVersion: 1, taskId: task.taskId, reservationId: task.reservationId,
    workGoalBinding: { goalId, goalVersion: 1, reservationId: task.reservationId },
  };
  assert.deepEqual(orchestrator.getTaskContext(binding), orchestrator.getContext(goalId, 1));
  assert.throws(() => orchestrator.getTaskContext({ ...binding, taskId: reservedTaskId }), { code: "invalid_binding" });
  assert.throws(() => orchestrator.getTaskContext({ ...binding, goalVersion: 2 }), { code: "invalid_binding" });
  assert.throws(() => orchestrator.getTaskContext({ ...binding, reservationId: reservedId }), { code: "invalid_binding" });
  assert.throws(() => orchestrator.getTaskContext({
    ...binding, workGoalBinding: { ...binding.workGoalBinding, reservationId: reservedId },
  }), { code: "invalid_binding" });
});

test("uncheckpointed evidence and a substituted Task binding cannot be credited", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId, storageRoot } = value;
  const uncheckpointed = await boundTask(t, value, { checkpoint: false });
  await assert.rejects(orchestrator.recordWorkGoalProgress(goalId, 1, [uncheckpointed.evidenceRef]), { code: "invalid_evidence" });

  const taskId = "88888888-8888-4888-8888-888888888888";
  const reservationId = "99999999-9999-4999-8999-999999999999";
  await orchestrator.reserveTask(goalId, 1, { taskId, reservationId, limits: limits() });
  const goalInput = { originalRequest: "Substituted binding" };
  const taskStore = await TaskStore.create(goalInput, {
    storageRoot, taskId, resolvedProfile: resolveTaskProfile({ goalInput }),
    workGoalBinding: { goalId, goalVersion: 1, reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  value.openStores.push(taskStore);
  await assert.rejects(orchestrator.linkTask(goalId, 1, { taskId, reservationId }), { code: "invalid_binding" });
  assert.equal(value.store.get(goalId).reservations[reservationId].status, "reserved");
});

test("persisted Task profile limits must equal every reserved budget axis", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId, storageRoot } = value;
  for (const [index, axis] of ["maxActions", "maxPlannerCalls", "maxActiveMs"].entries()) {
    const taskId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 31).padStart(12, "0")}`;
    const reservationId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 31).padStart(12, "0")}`;
    await orchestrator.reserveTask(goalId, 1, { taskId, reservationId, limits: limits() });
    const taskLimits = { maxActions: 6, maxPlannerCalls: 3, maxActiveMs: 600 };
    taskLimits[axis] += 1;
    const goalInput = { originalRequest: "Mismatched persisted profile", limits: taskLimits };
    const taskStore = await TaskStore.create(goalInput, {
      storageRoot, taskId, resolvedProfile: resolveTaskProfile({ goalInput }),
      workGoalBinding: { goalId, goalVersion: 1, reservationId },
    });
    value.openStores.push(taskStore);
    await assert.rejects(orchestrator.linkTask(goalId, 1, { taskId, reservationId }), { code: "invalid_binding" });
    assert.equal(value.store.get(goalId).reservations[reservationId].status, "reserved");
  }
});

test("completion rechecks stored Task evidence and refuses a now-missing journal", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId, storageRoot } = value;
  const task = await boundTask(t, value);
  await orchestrator.recordWorkGoalProgress(goalId, 1, [task.evidenceRef]);
  await orchestrator.verifyWorkGoalCriterion(goalId, 1, "userCheck");
  await task.taskStore.close();
  value.openStores.splice(value.openStores.indexOf(task.taskStore), 1);
  await fs.rename(path.join(storageRoot, "tasks", task.taskId), path.join(storageRoot, "removed-task"));
  await assert.rejects(orchestrator.completeWorkGoal(goalId, 1), { code: "invalid_evidence" });
  assert.equal(value.store.get(goalId).status, "active");
});

test("completed Goal history fails closed after restart when cited Task evidence disappears", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-goal-history-evidence-"));
  let first = null;
  let reopened = null;
  let taskStore = null;
  t.after(async () => {
    await Promise.all([taskStore?.close(), first?.close(), reopened?.close()]);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  first = new WorkGoalStore({ storageRoot });
  await first.load();
  const openStores = [];
  const orchestrator = new WorkGoalOrchestrator({
    storageRoot, store: first, getOpenTaskStore: (taskId) => openStores.find((item) => item.taskId === taskId) || null,
  });
  const { goalId } = await orchestrator.startWorkGoal(workGoalInput());
  const task = await boundTask(t, { storageRoot, orchestrator, goalId, openStores });
  taskStore = task.taskStore;
  await orchestrator.recordWorkGoalProgress(goalId, 1, [task.evidenceRef]);
  await orchestrator.verifyWorkGoalCriterion(goalId, 1, "userCheck");
  await orchestrator.completeWorkGoal(goalId, 1);
  assert.equal((await orchestrator.listWorkGoalHistory())[0].status, "complete");

  await taskStore.close();
  await first.close();
  await fs.rename(path.join(storageRoot, "tasks", task.taskId), path.join(storageRoot, "removed-task"));
  reopened = new WorkGoalStore({ storageRoot });
  await reopened.load();
  const recovered = new WorkGoalOrchestrator({ storageRoot, store: reopened });
  await assert.rejects(recovered.listWorkGoalHistory(), { code: "invalid_evidence" });
  await assert.rejects(recovered.reconcileAll(), { code: "invalid_evidence" });
});

test("user-only completed Goal history needs no Task evidence file", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-user-only-history-"));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const store = new MemoryGoalStore();
  const orchestrator = new WorkGoalOrchestrator({ storageRoot, store });
  const goal = await orchestrator.startWorkGoal({
    objective: "Obtain explicit user verification",
    successCriteria: [{ id: "userCheck", text: "User confirmed", required: true, verification: "user" }],
  });
  await orchestrator.verifyWorkGoalCriterion(goal.goalId, 1, "userCheck");
  await orchestrator.completeWorkGoal(goal.goalId, 1);
  assert.equal((await orchestrator.listWorkGoalHistory())[0].status, "complete");
  assert.deepEqual(await orchestrator.reconcileAll(), []);
});

test("terminal reconciliation releases only checkpointed usage and is idempotent", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const task = await boundTask(t, value);
  const before = orchestrator.getContext(goalId, 1);
  assert.equal(before.remainingBudget.maxActions, 14);
  const reconciled = await orchestrator.reconcileTask(goalId, 1, { taskId: task.taskId, reservationId: task.reservationId, taskStore: task.taskStore });
  assert.equal(reconciled.status, "released");
  assert.deepEqual(reconciled.usage, { maxActions: 3, maxPlannerCalls: 2, maxActiveMs: 100 });
  assert.equal(orchestrator.getContext(goalId, 1).remainingBudget.maxActions, 17);
  const again = await orchestrator.reconcileTask(goalId, 1, { taskId: task.taskId, reservationId: task.reservationId, taskStore: task.taskStore });
  assert.equal(again.status, "released");
  assert.equal(value.store.events.filter((event) => event.type === "work_goal_task_reservation_reconciled").length, 1);
});

test("missing, stale, or nonterminal checkpoint retains the full reservation", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const noCheckpoint = await boundTask(t, value, { checkpoint: false });
  const paused = await boundTask(t, value, { taskState: "paused" });
  const stale = await boundTask(t, value);
  await stale.taskStore.append({ type: "note", payload: { text: "after checkpoint" } });
  for (const task of [noCheckpoint, paused, stale]) {
    const result = await orchestrator.reconcileTask(goalId, 1, { taskId: task.taskId, reservationId: task.reservationId, taskStore: task.taskStore });
    assert.equal(result.status, "held");
  }
  assert.equal(orchestrator.getContext(goalId, 1).remainingBudget.maxActions, 20 - 3 * 6);
  assert.equal(value.store.events.some((event) => event.type === "work_goal_task_reservation_released"), false);
});

test("blocker streak derives reason from durable Task checkpoint and blocks on third matching attempt", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  for (let i = 0; i < 3; i += 1) {
    const task = await boundTask(t, value, { taskState: "paused" });
    await orchestrator.recordContinuation(goalId, 1, { taskId: task.taskId, origin: "user" });
    await assert.rejects(
      orchestrator.observeBlocker(goalId, 1, { taskId: task.taskId, reasonCode: "no_progress", phase: "action_progress", taskStore: task.taskStore }),
      { code: "invalid_blocker" },
    );
    await orchestrator.observeBlocker(goalId, 1, { taskId: task.taskId, reasonCode: "planner_error", phase: "planner", taskStore: task.taskStore });
  }
  assert.equal(orchestrator.getActiveWorkGoal().status, "blocked");
  await orchestrator.resumeWorkGoal(goalId, 1);
  assert.equal(orchestrator.getActiveWorkGoal().blockerStreak.count, 0);
});

test("real WorkGoalStore restart reconciles terminal Tasks and holds missing Task reservations", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-goal-orchestrator-real-"));
  let first = null;
  let reopened = null;
  let taskStore = null;
  t.after(async () => {
    await Promise.all([taskStore?.close(), first?.close(), reopened?.close()]);
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  first = new WorkGoalStore({ storageRoot });
  await first.load();
  const openStores = [];
  const orchestrator = new WorkGoalOrchestrator({
    storageRoot, store: first, getOpenTaskStore: (taskId) => openStores.find((item) => item.taskId === taskId) || null,
  });
  const { goalId } = await orchestrator.startWorkGoal(workGoalInput());
  const value = { storageRoot, orchestrator, goalId, openStores };
  const terminal = await boundTask(t, value);
  taskStore = terminal.taskStore;
  await taskStore.close();
  await orchestrator.reserveTask(goalId, 1, {
    taskId: "66666666-6666-4666-8666-666666666666",
    reservationId: "77777777-7777-4777-8777-777777777777",
    limits: limits(),
  });
  await first.close();

  reopened = new WorkGoalStore({ storageRoot });
  await reopened.load();
  const recovered = new WorkGoalOrchestrator({ storageRoot, store: reopened });
  const results = await recovered.reconcileAll();
  assert.equal(results.find((item) => item.taskId === terminal.taskId).status, "released");
  assert.equal(results.find((item) => item.taskId === "66666666-6666-4666-8666-666666666666").status, "held");
  assert.equal(recovered.getContext(goalId, 1).remainingBudget.maxActions, 20 - 3 - 6);
  assert.equal((await recovered.reconcileAll()).find((item) => item.taskId === terminal.taskId), undefined);
});

test("explicit repair releases only a reserved slot whose TaskStore is provably absent", async (t) => {
  const value = await fixture(t);
  const { orchestrator, goalId } = value;
  const taskId = "88888888-8888-4888-8888-888888888888";
  const reservationId = "99999999-9999-4999-8999-999999999999";
  await orchestrator.reserveTask(goalId, 1, { taskId, reservationId, limits: limits() });
  assert.equal(orchestrator.getContext(goalId, 1).remainingBudget.maxActions, 20 - limits().maxActions);
  const recovery = await orchestrator.getWorkGoalRecoveryStatus(goalId, 1);
  assert.deepEqual(recovery, [{ taskId, reservationId, status: "held", reason: "not_found" }]);
  const repaired = await orchestrator.repairMissingTaskReservation(goalId, 1, reservationId);
  assert.equal(repaired.status, "cancelled");
  assert.equal(orchestrator._store.get(goalId).reservations[reservationId].status, "cancelled");
  assert.equal(orchestrator.getContext(goalId, 1).remainingBudget.maxActions, 20);
  assert.equal(orchestrator.getContext(goalId, 1).remainingBudget.maxTasks, 5);
  const repeated = await orchestrator.repairMissingTaskReservation(goalId, 1, reservationId);
  assert.equal(repeated.status, "cancelled");
});

test("active and historical Goal summaries bound Task links and report truncation", async (t) => {
  const { orchestrator, store, goalId } = await fixture(t);
  await orchestrator.amendWorkGoal(1, { ...workGoalInput(), budget: {} });
  const goalVersion = 2;
  const taskIds = [];
  for (let index = 1; index <= 101; index += 1) {
    const suffix = String(index).padStart(12, "0");
    const taskId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
    const reservationId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
    taskIds.push(taskId);
    await orchestrator.reserveTask(goalId, goalVersion, {
      taskId, reservationId, limits: { maxTasks: 1, maxActions: 6, maxPlannerCalls: 3, maxActiveMs: 600 },
    });
    await store.append({ goalId, expectedVersion: goalVersion, type: "work_goal_task_linked", payload: { taskId, reservationId } });
  }

  const active = orchestrator.getActiveWorkGoal();
  assert.equal(active.taskCount, taskIds.length);
  assert.equal(active.tasks.length, 100);
  assert.equal(active.tasksTruncated, true);
  assert.deepEqual(active.tasks, taskIds.slice(-100));

  await orchestrator.pauseWorkGoal(goalId, goalVersion);
  await orchestrator.archiveWorkGoal(goalId, goalVersion);
  const history = await orchestrator.listWorkGoalHistory();
  assert.equal(history[0].taskCount, taskIds.length);
  assert.equal(history[0].tasks.length, 100);
  assert.equal(history[0].tasksTruncated, true);
  assert.deepEqual(history[0].tasks, taskIds.slice(-100));
});
