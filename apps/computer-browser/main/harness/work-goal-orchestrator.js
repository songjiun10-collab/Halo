"use strict";

// Project Goal policy above TaskHost. This layer can account for Task work and
// cite durable evidence, but never dispatches browser actions or grants an
// approval. The Task journal and its immutable profile binding are the source
// of truth for every Task-derived claim.

const { TaskStore } = require("./task-store");
const taskContracts = require("../../shared/harness-contracts");
const { validateWorkGoalInput, validateWorkGoalSpec, validateWorkGoalEvent, BLOCKER_REASONS } = require("../../shared/work-goal-contracts");

const BUDGET_AXES = Object.freeze(["maxTasks", "maxActions", "maxPlannerCalls", "maxActiveMs"]);
const USAGE_AXES = Object.freeze(["maxActions", "maxPlannerCalls", "maxActiveMs"]);
const BLOCKER_PHASE_BY_REASON = Object.freeze({
  planner_unavailable: "planner",
  planner_error: "planner",
  observation_error: "browser_observation",
  context_error: "context_build",
  no_progress: "action_progress",
  budget_exhausted: "budget",
  child_plan_failed: "child_plan",
  message_ack_failed: "message_ack",
  send_message_failed: "message_delivery",
  routine_step_failed: "routine_step",
});

class WorkGoalOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkGoalOrchestratorError";
    this.code = code;
  }
}

function fail(code, message) { throw new WorkGoalOrchestratorError(code, message); }

function plainObject(value, label, keys, required = keys) {
  if (!taskContracts.isPlainObject(value)) fail("invalid_field", `${label} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("unknown_field", `${label} has an unknown field`);
  if (required.some((key) => !Object.hasOwn(value, key))) fail("invalid_field", `${label} has a missing field`);
}

function positiveVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) fail("invalid_field", "expectedVersion must be a positive integer");
}

function sameBinding(actual, expected) {
  return actual?.goalId === expected.goalId && actual.goalVersion === expected.goalVersion &&
    actual.reservationId === expected.reservationId && Object.keys(actual).length === 3;
}

function sameReference(a, b) {
  return a.goalVersion === b.goalVersion && a.criterionId === b.criterionId && a.taskId === b.taskId &&
    a.eventId === b.eventId && a.evidenceId === b.evidenceId;
}

function committedUsage(state) {
  const total = { maxTasks: state.tasks.length, maxActions: 0, maxPlannerCalls: 0, maxActiveMs: 0 };
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.status === "reserved") total.maxTasks += 1;
    if (reservation.status === "cancelled") continue;
    for (const axis of USAGE_AXES) {
      total[axis] += reservation.status === "released" ? reservation.usage[axis] : reservation.limits[axis];
    }
  }
  return total;
}

function remainingBudget(state, spec = state.spec) {
  const committed = committedUsage(state);
  return Object.fromEntries(Object.entries(spec.budget).map(([axis, cap]) => [axis, Math.max(0, cap - committed[axis])]));
}

function summary(state) {
  if (!state) return null;
  return {
    goalId: state.goalId,
    spec: {
      ...state.spec,
      successCriteria: state.spec.successCriteria.map((criterion) => ({ ...criterion })),
      budget: { ...state.spec.budget },
    },
    status: state.status,
    tasks: [...state.tasks],
    verifiedCriteria: [...state.verifiedCriteria],
    remainingBudget: remainingBudget(state),
    blockerStreak: { ...state.blockerStreak },
    progressCount: state.progress.length,
  };
}

class WorkGoalOrchestrator {
  constructor({ storageRoot, store, taskStoreClass = TaskStore, getOpenTaskStore } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) fail("invalid_config", "storageRoot is required");
    if (!store || typeof store.create !== "function" || typeof store.append !== "function" ||
        typeof store.get !== "function" || typeof store.getActive !== "function" || typeof store.listHistory !== "function") {
      fail("invalid_config", "a WorkGoalStore with create/append/get/getActive/listHistory is required");
    }
    if (!taskStoreClass || typeof taskStoreClass.readEvents !== "function" || typeof taskStoreClass.load !== "function") {
      fail("invalid_config", "taskStoreClass must provide readEvents/load");
    }
    if (getOpenTaskStore !== undefined && typeof getOpenTaskStore !== "function") {
      fail("invalid_config", "getOpenTaskStore must be a function");
    }
    this._storageRoot = storageRoot;
    this._store = store;
    this._taskStoreClass = taskStoreClass;
    this._getOpenTaskStore = getOpenTaskStore || (() => null);
  }

  _state(goalId, expectedVersion) {
    taskContracts.assertUuid(goalId, "goalId");
    positiveVersion(expectedVersion);
    const state = this._store.get(goalId);
    if (!state) fail("not_found", "Work Goal does not exist");
    if (state.spec.version !== expectedVersion) fail("stale_goal_version", "Work Goal version has changed");
    return state;
  }

  _reservation(state, reservationId, taskId) {
    taskContracts.assertUuid(reservationId, "reservationId");
    taskContracts.assertUuid(taskId, "taskId");
    const reservation = state.reservations[reservationId];
    if (!reservation || reservation.taskId !== taskId) fail("reservation_conflict", "Task reservation does not match Work Goal");
    return reservation;
  }

  async _append(goalId, expectedVersion, type, payload) {
    return this._store.append({ goalId, expectedVersion, type, payload });
  }

  async startWorkGoal(input) {
    validateWorkGoalInput(input);
    return summary(await this._store.create(input));
  }

  getActiveWorkGoal() { return summary(this._store.getActive()); }

  async listWorkGoalHistory() {
    const states = this._store.listHistory();
    for (const state of states) {
      if (this._claimsCompletedCriteria(state)) await this._requireCurrentEvidence(state);
    }
    return states.map(summary);
  }

  async amendWorkGoal(expectedVersion, nextInput) {
    positiveVersion(expectedVersion);
    validateWorkGoalInput(nextInput);
    const frozenInput = structuredClone(nextInput);
    const active = this._store.getActive();
    if (!active) fail("not_found", "there is no active Work Goal to amend");
    if (active.spec.version !== expectedVersion) fail("stale_goal_version", "Work Goal version has changed");
    const spec = validateWorkGoalSpec({
      schemaVersion: 1,
      goalId: active.goalId,
      version: expectedVersion + 1,
      objective: frozenInput.objective,
      successCriteria: frozenInput.successCriteria,
      budget: frozenInput.budget || {},
    });
    return summary(await this._append(active.goalId, expectedVersion, "work_goal_amended", { spec }));
  }

  async pauseWorkGoal(goalId, expectedVersion) {
    this._state(goalId, expectedVersion);
    return summary(await this._append(goalId, expectedVersion, "work_goal_paused", { actor: "user" }));
  }

  async resumeWorkGoal(goalId, expectedVersion) {
    this._state(goalId, expectedVersion);
    return summary(await this._append(goalId, expectedVersion, "work_goal_resumed", { actor: "user" }));
  }

  async archiveWorkGoal(goalId, expectedVersion) {
    this._state(goalId, expectedVersion);
    return summary(await this._append(goalId, expectedVersion, "work_goal_archived", { actor: "user" }));
  }

  getContext(goalId, goalVersion) {
    taskContracts.assertUuid(goalId, "goalId");
    positiveVersion(goalVersion);
    const state = this._store.get(goalId);
    if (!state) fail("not_found", "Work Goal does not exist");
    const spec = state.specsByVersion[goalVersion];
    if (!spec) fail("unknown_goal_version", "Task refers to an unknown Work Goal version");
    return {
      goalId,
      goalVersion,
      objective: spec.objective,
      successCriteria: spec.successCriteria.map((criterion) => ({ ...criterion })),
      verifiedCriterionIds: [...(state.verifiedCriteriaByVersion[goalVersion] || [])],
      remainingBudget: remainingBudget(state, spec),
    };
  }

  getTaskContext(binding) {
    plainObject(binding, "Task Work Goal binding", ["goalId", "goalVersion", "reservationId", "taskId", "workGoalBinding"]);
    taskContracts.assertUuid(binding.goalId, "binding.goalId");
    taskContracts.assertUuid(binding.reservationId, "binding.reservationId");
    taskContracts.assertUuid(binding.taskId, "binding.taskId");
    positiveVersion(binding.goalVersion);
    if (!sameBinding(binding.workGoalBinding, {
      goalId: binding.goalId, goalVersion: binding.goalVersion, reservationId: binding.reservationId,
    })) {
      fail("invalid_binding", "Task profile is not bound to the requested Work Goal context");
    }
    const state = this._store.get(binding.goalId);
    if (!state) fail("not_found", "Work Goal does not exist");
    const reservation = state.reservations[binding.reservationId];
    if (!reservation || reservation.taskId !== binding.taskId ||
        reservation.taskGoalVersion !== binding.goalVersion || !["linked", "reconciled", "released"].includes(reservation.status)) {
      fail("invalid_binding", "Task has no linked reservation for its Work Goal context");
    }
    return this.getContext(binding.goalId, binding.goalVersion);
  }

  async reserveTask(goalId, expectedVersion, input) {
    plainObject(input, "reservation", ["taskId", "reservationId", "limits"]);
    plainObject(input.limits, "reservation.limits", BUDGET_AXES);
    taskContracts.assertUuid(goalId, "goalId");
    positiveVersion(expectedVersion);
    const taskId = input.taskId;
    const reservationId = input.reservationId;
    const limits = structuredClone(input.limits);
    taskContracts.assertUuid(taskId, "reservation.taskId");
    taskContracts.assertUuid(reservationId, "reservation.reservationId");
    if (limits.maxTasks !== 1) fail("invalid_field", "a Task must reserve exactly one slot");
    for (const axis of USAGE_AXES) {
      if (!Number.isSafeInteger(limits[axis]) || limits[axis] < 1) fail("invalid_field", `${axis} must be a positive integer`);
    }
    const state = this._store.get(goalId);
    if (!state) fail("not_found", "Work Goal does not exist");
    const existing = state.reservations[reservationId];
    if (existing) {
      if (existing.taskId === taskId && existing.taskGoalVersion === expectedVersion &&
          BUDGET_AXES.every((axis) => existing.limits[axis] === limits[axis])) return existing;
      fail("reservation_conflict", "reservation ID was already used for another Task or limits");
    }
    if (state.spec.version !== expectedVersion) fail("stale_goal_version", "Work Goal version has changed");
    const available = remainingBudget(state);
    for (const axis of Object.keys(available)) {
      if (limits[axis] > available[axis]) fail("budget_exhausted", `Work Goal ${axis} budget is exhausted`);
    }
    const next = await this._append(goalId, expectedVersion, "work_goal_task_reserved", {
      reservationId,
      taskId,
      taskGoalVersion: expectedVersion,
      limits,
    });
    return next.reservations[reservationId];
  }

  async repairMissingTaskReservation(goalId, expectedVersion, reservationId) {
    const state = this._state(goalId, expectedVersion);
    taskContracts.assertUuid(reservationId, "reservationId");
    const reservation = state.reservations[reservationId];
    if (!reservation) fail("not_found", "Task reservation does not exist");
    if (reservation.status === "cancelled") return reservation;
    if (reservation.status !== "reserved") fail("reservation_conflict", "only an unlinked reservation can be repaired");
    try {
      const taskStore = await this._taskStoreClass.load(reservation.taskId, { storageRoot: this._storageRoot });
      await taskStore.close();
      fail("task_store_exists", "reserved TaskStore exists; its allocation cannot be reclaimed by repair");
    } catch (error) {
      if (error.code !== "not_found") throw error;
    }
    await this._append(goalId, expectedVersion, "work_goal_task_reservation_cancelled", {
      taskId: reservation.taskId,
      reservationId,
      reason: "task_store_absent",
    });
    // Report the absence to the operator even though the durable repair has
    // succeeded; callers can distinguish a repaired missing allocation from
    // a normal released Task reservation.
    fail("not_found", "reserved TaskStore was absent; reservation cancelled to release the slot");
  }

  async _taskMaterial(taskId, suppliedStore = null) {
    const openStore = suppliedStore || this._getOpenTaskStore(taskId);
    if (openStore && openStore.taskId !== taskId) fail("invalid_binding", "provided TaskStore belongs to another Task");
    let loaded = null;
    try {
      if (!openStore) loaded = await this._taskStoreClass.load(taskId, { storageRoot: this._storageRoot });
      const owner = openStore || loaded;
      const events = await this._taskStoreClass.readEvents(taskId, { storageRoot: this._storageRoot });
      const checkpoint = owner.lastCheckpoint || null;
      if (checkpoint) {
        taskContracts.validateCheckpointEnvelope(checkpoint);
        if (checkpoint.taskId !== taskId || checkpoint.seq > (events.at(-1)?.seq ?? 0)) {
          fail("invalid_checkpoint", "Task checkpoint does not match its journal");
        }
      }
      return { events, checkpoint, recoveryReason: owner.recoveryReason || null, taskProfile: owner.taskProfile || null };
    } finally {
      if (loaded) await loaded.close();
    }
  }

  _verifyBinding(state, reservation, material) {
    const profileEvent = material.events.find((event) => event.type === "task_profile_selected");
    const binding = {
      goalId: state.goalId,
      goalVersion: reservation.taskGoalVersion,
      reservationId: reservation.reservationId,
    };
    if (!profileEvent || !sameBinding(profileEvent.payload.workGoalBinding, binding) ||
        (material.taskProfile && !sameBinding(material.taskProfile.workGoalBinding, binding))) {
      fail("invalid_binding", "Task journal/profile is not bound to this Work Goal reservation");
    }
    if (profileEvent.taskId !== reservation.taskId) fail("invalid_binding", "Task profile belongs to another Task");
    for (const axis of USAGE_AXES) {
      if (profileEvent.payload.duration?.effectiveLimits?.[axis] !== reservation.limits[axis] ||
          (material.taskProfile && material.taskProfile.duration?.effectiveLimits?.[axis] !== reservation.limits[axis])) {
        fail("invalid_binding", `Task profile ${axis} limit differs from its Work Goal reservation`);
      }
    }
  }

  async linkTask(goalId, expectedVersion, input) {
    plainObject(input, "Task link", ["taskId", "reservationId"]);
    taskContracts.assertUuid(goalId, "goalId");
    positiveVersion(expectedVersion);
    const { taskId, reservationId } = input;
    const state = this._store.get(goalId);
    if (!state) fail("not_found", "Work Goal does not exist");
    const reservation = this._reservation(state, reservationId, taskId);
    if (reservation.status !== "reserved") {
      if (["linked", "reconciled", "released"].includes(reservation.status)) return reservation;
      fail("reservation_conflict", "Task reservation cannot be linked");
    }
    if (state.spec.version !== expectedVersion) fail("stale_goal_version", "Work Goal version has changed");
    // Linking only needs the durable initial Task profile event. Reading its
    // validated journal avoids acquiring TaskStore's exclusive writer lock
    // while TaskHost still owns the freshly created TaskStore.
    const events = await this._taskStoreClass.readEvents(taskId, { storageRoot: this._storageRoot });
    this._verifyBinding(state, reservation, { events, taskProfile: null });
    const next = await this._append(goalId, expectedVersion, "work_goal_task_linked", {
      taskId, reservationId,
    });
    return next.reservations[reservationId];
  }

  async recordContinuation(goalId, expectedVersion, input) {
    plainObject(input, "continuation", ["taskId", "origin"]);
    const payload = { taskId: input.taskId, origin: input.origin };
    const state = this._state(goalId, expectedVersion);
    taskContracts.assertUuid(payload.taskId, "continuation.taskId");
    if (!Object.values(state.reservations).some((reservation) =>
      reservation.taskId === payload.taskId && reservation.taskGoalVersion === expectedVersion &&
      reservation.status !== "reserved")) {
      fail("invalid_binding", "continuation Task is not linked to the current Work Goal version");
    }
    if (state.blockerStreak.pendingTaskId === payload.taskId) return summary(state);
    return summary(await this._append(goalId, expectedVersion, "work_goal_continuation_attempted", payload));
  }

  async observeBlocker(goalId, expectedVersion, input) {
    plainObject(input, "blocker", ["taskId", "reasonCode", "phase", "taskStore"], ["taskId", "reasonCode", "phase"]);
    const { taskId, reasonCode, phase, taskStore } = input;
    const state = this._state(goalId, expectedVersion);
    taskContracts.assertUuid(taskId, "blocker.taskId");
    if (!BLOCKER_REASONS.includes(reasonCode) || BLOCKER_PHASE_BY_REASON[reasonCode] !== phase ||
        state.blockerStreak.pendingTaskId !== taskId) {
      fail("invalid_blocker", "blocker must match the pending Task and a supported reason/phase");
    }
    const reservation = Object.values(state.reservations).find((item) => item.taskId === taskId &&
      item.taskGoalVersion === expectedVersion && item.status !== "reserved");
    if (!reservation) fail("invalid_binding", "blocker Task is not linked to the Work Goal");
    const material = await this._taskMaterial(taskId, taskStore);
    this._verifyBinding(state, reservation, material);
    if (!material.checkpoint || material.checkpoint.seq !== material.events.at(-1)?.seq ||
        material.checkpoint.payload?.task?.state !== "paused" ||
        material.checkpoint.payload.task.pauseReason !== reasonCode ||
        material.recoveryReason === "execution_uncertain") {
      fail("invalid_blocker", "blocker reason is not backed by a current paused Task checkpoint");
    }
    return summary(await this._append(goalId, expectedVersion, "work_goal_blocker_observed", {
      taskId, reasonCode, phase,
    }));
  }

  async _verifiedEvidence(state, goalVersion, ref, cache, options = {}) {
    const criterion = state.specsByVersion[goalVersion]?.successCriteria.find((item) => item.id === ref.criterionId);
    if (!criterion || criterion.verification !== "host_evidence") fail("invalid_evidence", "reference targets no host-evidence criterion");
    const reservation = Object.values(state.reservations).find((item) => item.taskId === ref.taskId && item.taskGoalVersion === goalVersion && ["linked", "reconciled", "released"].includes(item.status));
    if (!reservation) fail("invalid_evidence", "evidence Task is not linked to this Work Goal version");
    let material = cache.get(ref.taskId);
    if (!material) {
      const suppliedStore = options.taskStores?.get?.(ref.taskId) || options.taskStore || null;
      try { material = await this._taskMaterial(ref.taskId, suppliedStore); }
      catch (error) { fail("invalid_evidence", `Task evidence could not be loaded: ${error.message}`); }
      cache.set(ref.taskId, material);
    }
    try { this._verifyBinding(state, reservation, material); }
    catch (error) { fail("invalid_evidence", error.message); }
    const event = material.events.find((item) => item.eventId === ref.eventId);
    const evidence = event?.payload?.evidence;
    if (!event || event.type !== "evidence_recorded" || event.taskId !== ref.taskId ||
        evidence?.id !== ref.evidenceId || evidence.taskId !== ref.taskId ||
        evidence.criterionId !== ref.criterionId || evidence.goalVersion !== event.goalVersion ||
        evidence.verification !== "verified" ||
        !material.checkpoint || material.checkpoint.seq < event.seq) {
      fail("invalid_evidence", "reference lacks checkpointed, verified Task evidence");
    }
  }

  async recordWorkGoalProgress(goalId, expectedVersion, evidenceRefs, options = {}) {
    const state = this._state(goalId, expectedVersion);
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) fail("invalid_evidence", "evidenceRefs must not be empty");
    // The event contract validates exact reference shape and its size bound.
    const testEvent = {
      seq: 1, eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", goalId,
      goalVersion: expectedVersion, type: "work_goal_progress_recorded",
      payload: { evidenceRefs }, at: new Date().toISOString(),
    };
    try { validateWorkGoalEvent(testEvent); }
    catch (error) { fail("invalid_evidence", error.message); }
    const refs = structuredClone(evidenceRefs);
    const cache = new Map();
    for (const ref of refs) await this._verifiedEvidence(state, expectedVersion, ref, cache, options);

    let latest = state;
    const newRefs = refs.filter((ref) => !latest.progress.some((existing) => sameReference(existing, { ...ref, goalVersion: expectedVersion })));
    if (newRefs.length) latest = await this._append(goalId, expectedVersion, "work_goal_progress_recorded", { evidenceRefs: newRefs });
    for (const criterionId of new Set(refs.map((ref) => ref.criterionId))) {
      if (latest.verifiedCriteria.includes(criterionId)) continue;
      latest = await this._append(goalId, expectedVersion, "work_goal_criterion_verified", {
        criterionId, actor: "host", evidenceRefs: refs.filter((ref) => ref.criterionId === criterionId),
      });
    }
    return summary(latest);
  }

  async verifyWorkGoalCriterion(goalId, expectedVersion, criterionId) {
    const state = this._state(goalId, expectedVersion);
    taskContracts.assertId(criterionId, "criterionId");
    const criterion = state.spec.successCriteria.find((item) => item.id === criterionId);
    if (!criterion) fail("unknown_criterion", "Work Goal criterion does not exist");
    if (criterion.verification !== "user") fail("invalid_verification", "criterion requires verified Task evidence");
    if (state.verifiedCriteria.includes(criterionId)) return summary(state);
    return summary(await this._append(goalId, expectedVersion, "work_goal_criterion_verified", { criterionId, actor: "user" }));
  }

  _claimsCompletedCriteria(state) {
    if (state.status !== "complete" && state.status !== "archived") return false;
    return state.spec.successCriteria.filter((criterion) => criterion.required)
      .every((criterion) => state.verifiedCriteria.includes(criterion.id));
  }

  async _requireCurrentEvidence(state) {
    const goalVersion = state.spec.version;
    const cache = new Map();
    for (const criterion of state.spec.successCriteria.filter((item) => item.required && item.verification === "host_evidence")) {
      const refs = state.progress.filter((ref) => ref.goalVersion === goalVersion && ref.criterionId === criterion.id);
      let verified = false;
      for (const ref of refs) {
        try { await this._verifiedEvidence(state, goalVersion, ref, cache); verified = true; break; }
        catch { /* Another durable reference may still prove the criterion. */ }
      }
      if (!verified) fail("invalid_evidence", `Work Goal ${state.goalId} criterion ${criterion.id} has no current valid Task evidence`);
    }
  }

  async completeWorkGoal(goalId, expectedVersion) {
    const state = this._state(goalId, expectedVersion);
    if (state.status !== "active") fail("invalid_transition", "Work Goal must be active to complete");
    const required = state.spec.successCriteria.filter((criterion) => criterion.required);
    if (required.some((criterion) => !state.verifiedCriteria.includes(criterion.id))) {
      fail("criteria_incomplete", "every required Work Goal criterion must be verified");
    }
    await this._requireCurrentEvidence(state);
    const next = await this._append(goalId, expectedVersion, "work_goal_completed", {
      criterionIds: required.map((item) => item.id),
    });
    return summary(next);
  }

  async _reconcile(goalId, expectedVersion, input) {
    plainObject(input, "reconciliation", ["taskId", "reservationId", "taskStore"], ["taskId", "reservationId"]);
    let state = this._state(goalId, expectedVersion);
    let reservation = this._reservation(state, input.reservationId, input.taskId);
    if (reservation.status === "released") return reservation;
    let material;
    try { material = await this._taskMaterial(input.taskId, input.taskStore); }
    catch (error) {
      return { ...reservation, status: "held", reason: error.code || "task_unavailable" };
    }
    this._verifyBinding(state, reservation, material);
    if (reservation.status === "reserved") {
      state = await this._append(goalId, expectedVersion, "work_goal_task_linked", { taskId: input.taskId, reservationId: input.reservationId });
      reservation = state.reservations[input.reservationId];
    }
    if (reservation.status === "linked") {
      const checkpoint = material.checkpoint;
      if (!checkpoint) return { ...reservation, status: "held", reason: "checkpoint_missing" };
      if (material.recoveryReason === "execution_uncertain") return { ...reservation, status: "held", reason: "execution_uncertain" };
      if (checkpoint.seq !== material.events.at(-1)?.seq) return { ...reservation, status: "held", reason: "checkpoint_stale" };
      const taskState = checkpoint.payload?.task?.state;
      if (taskState !== "completed" && taskState !== "stopped") return { ...reservation, status: "held", reason: "nonterminal" };
      const budgets = checkpoint.payload?.budgets;
      if (!taskContracts.isPlainObject(budgets) || ["actionsUsed", "plannerCallsUsed", "activeMs"].some(
        (axis) => !Number.isSafeInteger(budgets[axis]) || budgets[axis] < 0)) {
        return { ...reservation, status: "held", reason: "invalid_usage" };
      }
      const usage = { maxActions: budgets.actionsUsed, maxPlannerCalls: budgets.plannerCallsUsed, maxActiveMs: budgets.activeMs };
      if (USAGE_AXES.some((axis) => usage[axis] > reservation.limits[axis])) {
        return { ...reservation, status: "held", reason: "usage_exceeds_reservation" };
      }
      state = await this._append(goalId, expectedVersion, "work_goal_task_reservation_reconciled", {
        taskId: input.taskId, reservationId: input.reservationId, taskState, usage,
      });
      reservation = state.reservations[input.reservationId];
    }
    if (reservation.status === "reconciled") {
      const unused = Object.fromEntries(USAGE_AXES.map((axis) => [axis, reservation.limits[axis] - reservation.usage[axis]]));
      state = await this._append(goalId, expectedVersion, "work_goal_task_reservation_released", {
        taskId: input.taskId, reservationId: input.reservationId, unused,
      });
      reservation = state.reservations[input.reservationId];
    }
    return reservation;
  }

  async reconcileTask(goalOrTaskId, expectedVersionOrOptions, explicitInput) {
    if (Number.isSafeInteger(expectedVersionOrOptions)) {
      return this._reconcile(goalOrTaskId, expectedVersionOrOptions, explicitInput);
    }
    const taskId = goalOrTaskId;
    taskContracts.assertUuid(taskId, "taskId");
    const options = expectedVersionOrOptions || {};
    plainObject(options, "reconciliation options", ["taskStore"], []);
    const states = this._allStates();
    for (const state of states) {
      const reservation = Object.values(state.reservations).find((item) => item.taskId === taskId);
      if (reservation) return this._reconcile(state.goalId, state.spec.version, {
        taskId, reservationId: reservation.reservationId, ...options,
      });
    }
    fail("not_found", "Task is not reserved under a Work Goal");
  }

  _allStates() {
    const active = this._store.getActive();
    const history = this._store.listHistory();
    const ids = new Set();
    const states = [];
    for (const item of [active, ...history]) {
      if (item && !ids.has(item.goalId)) { ids.add(item.goalId); states.push(item); }
    }
    return states;
  }

  async reconcileAll() {
    const results = [];
    for (const state of this._store.listHistory()) {
      if (this._claimsCompletedCriteria(state)) await this._requireCurrentEvidence(state);
    }
    for (const state of this._allStates()) {
      for (const reservation of Object.values(state.reservations)) {
        if (reservation.status === "released") continue;
        try {
          const outcome = await this._reconcile(state.goalId, state.spec.version, {
            taskId: reservation.taskId, reservationId: reservation.reservationId,
          });
          results.push({ goalId: state.goalId, taskId: reservation.taskId, reservationId: reservation.reservationId, ...outcome });
        } catch (error) {
          // Recovery must preserve the reservation if either Task journal is
          // absent/corrupt or a concurrent host operation changes the Goal.
          results.push({ goalId: state.goalId, taskId: reservation.taskId, reservationId: reservation.reservationId,
            status: "held", reason: error.code || "reconcile_failed" });
        }
      }
    }
    return results;
  }
}

module.exports = { WorkGoalOrchestrator, WorkGoalOrchestratorError };
