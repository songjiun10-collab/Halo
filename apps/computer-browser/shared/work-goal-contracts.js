"use strict";

// Pure validation/replay contract for project-scoped Work Goals. Filesystem,
// TaskStore evidence, IPC identity, and task admission remain host concerns.

const contracts = require("./harness-contracts");

const SCHEMA_VERSION = 1;
const MAX_OBJECTIVE_BYTES = 16 * 1024;
const MAX_SUCCESS_CRITERIA = 64;
const MAX_CRITERION_TEXT_CHARS = 512;
const MAX_EVENT_BYTES = contracts.MAX_EVENT_BYTES;
const MAX_BUDGET = Object.freeze({
  maxTasks: 10_000,
  maxActions: 1_000_000,
  maxPlannerCalls: 1_000_000,
  maxActiveMs: 31_536_000_000,
});
const INPUT_FIELDS = Object.freeze(["objective", "successCriteria", "budget"]);
const SPEC_FIELDS = Object.freeze(["schemaVersion", "goalId", "version", ...INPUT_FIELDS]);
const CRITERION_FIELDS = Object.freeze(["id", "text", "required", "verification"]);
const BUDGET_FIELDS = Object.freeze(Object.keys(MAX_BUDGET));
const EVENT_TYPES = Object.freeze([
  "work_goal_created",
  "work_goal_amended",
  "work_goal_task_reserved",
  "work_goal_task_reservation_cancelled",
  "work_goal_task_linked",
  "work_goal_task_reservation_reconciled",
  "work_goal_task_reservation_released",
  "work_goal_progress_recorded",
  "work_goal_blocker_observed",
  "work_goal_continuation_attempted",
  "work_goal_continuation_enqueued",
  "work_goal_continuation_resolved",
  "work_goal_paused",
  "work_goal_resumed",
  "work_goal_criterion_verified",
  "work_goal_completed",
  "work_goal_archived",
]);
const EVENT_FIELDS = Object.freeze(["seq", "eventId", "goalId", "goalVersion", "type", "payload", "at"]);
const RESERVATION_LIMIT_FIELDS = Object.freeze(["maxTasks", "maxActions", "maxPlannerCalls", "maxActiveMs"]);
const USAGE_FIELDS = Object.freeze(["maxActions", "maxPlannerCalls", "maxActiveMs"]);
const EVIDENCE_REF_FIELDS = Object.freeze(["criterionId", "taskId", "eventId", "evidenceId"]);
const ORIGINS = Object.freeze(["user", "routine", "scheduler"]);
const BLOCKER_REASONS = Object.freeze([
  "planner_unavailable",
  "planner_error",
  "observation_error",
  "context_error",
  "no_progress",
  "budget_exhausted",
  "child_plan_failed",
  "message_ack_failed",
  "send_message_failed",
  "routine_step_failed",
]);
const BLOCKER_PHASES = Object.freeze([
  "planner",
  "browser_observation",
  "context_build",
  "action_progress",
  "budget",
  "child_plan",
  "message_ack",
  "message_delivery",
  "routine_step",
]);
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

class WorkGoalContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkGoalContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkGoalContractError(code, message);
}

function exactObject(value, label, allowed, required = allowed) {
  if (!contracts.isPlainObject(value)) fail("invalid_shape", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("unknown_field", `${label} has unknown field "${key}"`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("invalid_field", `${label}.${key} is required`);
  }
}

function string(value, label, { allowEmpty = false, maxBytes, maxChars } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail("invalid_field", `${label} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  if (maxChars !== undefined && value.length > maxChars) fail("field_too_large", `${label} exceeds ${maxChars} characters`);
  if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) fail("field_too_large", `${label} exceeds ${maxBytes} bytes`);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_field", `${label} must be a positive safe integer`);
  if (value > maximum) fail("limit_exceeded", `${label} exceeds the host limit`);
}

function nonNegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_field", `${label} must be a non-negative safe integer`);
  if (value > maximum) fail("limit_exceeded", `${label} exceeds the host limit`);
}

function validateBudget(value, label = "budget", { optional = false } = {}) {
  if (value === undefined && optional) return {};
  exactObject(value, label, BUDGET_FIELDS, []);
  for (const key of BUDGET_FIELDS) {
    if (Object.hasOwn(value, key)) positiveInteger(value[key], `${label}.${key}`, MAX_BUDGET[key]);
  }
  return value;
}

function validateSuccessCriteria(value, label = "successCriteria") {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_field", `${label} must contain at least one criterion`);
  if (value.length > MAX_SUCCESS_CRITERIA) fail("field_too_large", `${label} exceeds ${MAX_SUCCESS_CRITERIA} entries`);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const criterion = value[index];
    const itemLabel = `${label}[${index}]`;
    exactObject(criterion, itemLabel, CRITERION_FIELDS);
    contracts.assertId(criterion.id, `${itemLabel}.id`);
    if (seen.has(criterion.id)) fail("duplicate_criterion", `${label} has duplicate criterion id ${criterion.id}`);
    seen.add(criterion.id);
    string(criterion.text, `${itemLabel}.text`, { maxChars: MAX_CRITERION_TEXT_CHARS });
    if (criterion.required !== true) fail("invalid_field", `${itemLabel}.required must be true`);
    if (criterion.verification !== "host_evidence" && criterion.verification !== "user") {
      fail("unknown_enum", `${itemLabel}.verification is unsupported`);
    }
  }
  return value;
}

function validateWorkGoalInput(value) {
  exactObject(value, "WorkGoalInput", INPUT_FIELDS, ["objective", "successCriteria"]);
  string(value.objective, "objective", { maxBytes: MAX_OBJECTIVE_BYTES });
  validateSuccessCriteria(value.successCriteria);
  validateBudget(value.budget, "budget", { optional: true });
  return value;
}

function validateWorkGoalSpec(value) {
  exactObject(value, "WorkGoalSpec", SPEC_FIELDS);
  if (value.schemaVersion !== SCHEMA_VERSION) fail("unknown_version", `schemaVersion must be ${SCHEMA_VERSION}`);
  contracts.assertUuid(value.goalId, "goalId");
  positiveInteger(value.version, "version");
  string(value.objective, "objective", { maxBytes: MAX_OBJECTIVE_BYTES });
  validateSuccessCriteria(value.successCriteria);
  validateBudget(value.budget, "budget");
  return value;
}

function validateLimits(value, label, fields, requiredFields = fields) {
  exactObject(value, label, fields, requiredFields);
  for (const key of Object.keys(value)) {
    const maximum = key === "maxTasks" ? MAX_BUDGET.maxTasks : MAX_BUDGET[key];
    positiveInteger(value[key], `${label}.${key}`, maximum);
  }
  return value;
}

function validateEvidenceRefs(value, label = "evidenceRefs") {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SUCCESS_CRITERIA) {
    fail("invalid_field", `${label} must contain 1..${MAX_SUCCESS_CRITERIA} references`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const ref = value[index];
    const itemLabel = `${label}[${index}]`;
    exactObject(ref, itemLabel, EVIDENCE_REF_FIELDS);
    contracts.assertId(ref.criterionId, `${itemLabel}.criterionId`);
    contracts.assertUuid(ref.taskId, `${itemLabel}.taskId`);
    contracts.assertUuid(ref.eventId, `${itemLabel}.eventId`);
    contracts.assertId(ref.evidenceId, `${itemLabel}.evidenceId`);
    const key = `${ref.taskId}\u0000${ref.eventId}\u0000${ref.evidenceId}\u0000${ref.criterionId}`;
    if (seen.has(key)) fail("duplicate_evidence", `${label} contains a duplicate reference`);
    seen.add(key);
  }
  return value;
}

function validateWorkGoalEvent(event) {
  exactObject(event, "event", EVENT_FIELDS);
  positiveInteger(event.seq, "event.seq");
  contracts.assertUuid(event.eventId, "event.eventId");
  contracts.assertUuid(event.goalId, "event.goalId");
  positiveInteger(event.goalVersion, "event.goalVersion");
  if (!EVENT_TYPES.includes(event.type)) fail("unknown_event", `unsupported Work Goal event type ${event.type}`);
  if (typeof event.at !== "string" || event.at.length === 0 || Number.isNaN(new Date(event.at).getTime())) {
    fail("invalid_field", "event.at must be an ISO timestamp");
  }
  if (!contracts.isPlainObject(event.payload)) fail("invalid_shape", "event.payload must be an object");
  const payload = event.payload;

  switch (event.type) {
    case "work_goal_created":
    case "work_goal_amended":
      exactObject(payload, "event.payload", ["spec"]);
      validateWorkGoalSpec(payload.spec);
      if (payload.spec.goalId !== event.goalId || payload.spec.version !== event.goalVersion) {
        fail("invalid_binding", "event goal identity/version must match its WorkGoalSpec");
      }
      break;
    case "work_goal_task_reserved":
      exactObject(payload, "event.payload", ["reservationId", "taskId", "taskGoalVersion", "limits"]);
      contracts.assertUuid(payload.reservationId, "event.payload.reservationId");
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      positiveInteger(payload.taskGoalVersion, "event.payload.taskGoalVersion");
      validateLimits(payload.limits, "event.payload.limits", RESERVATION_LIMIT_FIELDS, RESERVATION_LIMIT_FIELDS);
      if (payload.limits.maxTasks !== 1) fail("invalid_field", "a Task reservation must reserve exactly one task slot");
      break;
    case "work_goal_task_linked":
      exactObject(payload, "event.payload", ["reservationId", "taskId"]);
      contracts.assertUuid(payload.reservationId, "event.payload.reservationId");
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      break;
    case "work_goal_task_reservation_cancelled":
      exactObject(payload, "event.payload", ["reservationId", "taskId", "reason"]);
      contracts.assertUuid(payload.reservationId, "event.payload.reservationId");
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      if (payload.reason !== "task_store_absent") fail("invalid_field", "reservation cancellation requires proof that the TaskStore is absent");
      break;
    case "work_goal_task_reservation_reconciled":
      exactObject(payload, "event.payload", ["reservationId", "taskId", "taskState", "usage"]);
      contracts.assertUuid(payload.reservationId, "event.payload.reservationId");
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      if (payload.taskState !== "completed" && payload.taskState !== "stopped") fail("invalid_field", "reconciliation requires a durable terminal Task state");
      exactObject(payload.usage, "event.payload.usage", USAGE_FIELDS, USAGE_FIELDS);
      for (const axis of USAGE_FIELDS) nonNegativeInteger(payload.usage[axis], `event.payload.usage.${axis}`, MAX_BUDGET[axis]);
      break;
    case "work_goal_task_reservation_released":
      exactObject(payload, "event.payload", ["reservationId", "taskId", "unused"]);
      contracts.assertUuid(payload.reservationId, "event.payload.reservationId");
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      exactObject(payload.unused, "event.payload.unused", USAGE_FIELDS, []);
      for (const axis of Object.keys(payload.unused)) nonNegativeInteger(payload.unused[axis], `event.payload.unused.${axis}`, MAX_BUDGET[axis]);
      break;
    case "work_goal_progress_recorded":
      exactObject(payload, "event.payload", ["evidenceRefs"]);
      validateEvidenceRefs(payload.evidenceRefs);
      break;
    case "work_goal_blocker_observed":
      exactObject(payload, "event.payload", ["taskId", "reasonCode", "phase"]);
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      if (!BLOCKER_REASONS.includes(payload.reasonCode)) fail("unknown_enum", "event.payload.reasonCode is not blockable");
      if (!BLOCKER_PHASES.includes(payload.phase)) fail("unknown_enum", "event.payload.phase is unsupported");
      if (BLOCKER_PHASE_BY_REASON[payload.reasonCode] !== payload.phase) fail("invalid_blocker", "blocker phase does not match its reason code");
      break;
    case "work_goal_continuation_enqueued":
      exactObject(payload, "event.payload", ["taskId", "origin"]);
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      if (!ORIGINS.includes(payload.origin)) fail("unknown_enum", "event.payload.origin is unsupported");
      break;
    case "work_goal_continuation_resolved":
      exactObject(payload, "event.payload", ["taskId"]);
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      break;
    case "work_goal_continuation_attempted":
      exactObject(payload, "event.payload", ["taskId", "origin"]);
      contracts.assertUuid(payload.taskId, "event.payload.taskId");
      if (!ORIGINS.includes(payload.origin)) fail("unknown_enum", "event.payload.origin is unsupported");
      break;
    case "work_goal_paused":
    case "work_goal_resumed":
    case "work_goal_archived":
      exactObject(payload, "event.payload", ["actor"]);
      if (payload.actor !== "user") fail("untrusted_actor", "lifecycle transitions require the trusted user actor");
      break;
    case "work_goal_criterion_verified":
      exactObject(payload, "event.payload", ["criterionId", "actor", "evidenceRefs"], ["criterionId", "actor"]);
      contracts.assertId(payload.criterionId, "event.payload.criterionId");
      if (payload.actor !== "user" && payload.actor !== "host") fail("untrusted_actor", "criterion verification actor is unsupported");
      if (payload.actor === "host") validateEvidenceRefs(payload.evidenceRefs);
      else if (Object.hasOwn(payload, "evidenceRefs")) fail("invalid_field", "user verification cannot attach host evidence references");
      break;
    case "work_goal_completed":
      exactObject(payload, "event.payload", ["criterionIds"]);
      if (!Array.isArray(payload.criterionIds) || payload.criterionIds.length === 0) fail("invalid_field", "event.payload.criterionIds must be non-empty");
      payload.criterionIds.forEach((id, index) => contracts.assertId(id, `event.payload.criterionIds[${index}]`));
      if (new Set(payload.criterionIds).size !== payload.criterionIds.length) fail("invalid_field", "event.payload.criterionIds must be unique");
      break;
    default:
      fail("unknown_event", `unsupported Work Goal event type ${event.type}`);
  }
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_EVENT_BYTES) fail("event_too_large", "Work Goal event exceeds the event limit");
  return event;
}

function replayWorkGoalEvents(events) {
  if (!Array.isArray(events) || events.length === 0) fail("journal_empty", "Work Goal journal must not be empty");
  const seenEventIds = new Set();
  let state = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = validateWorkGoalEvent(events[index]);
    if (event.seq !== index + 1) fail("invalid_sequence", `expected Work Goal event sequence ${index + 1}, got ${event.seq}`);
    if (seenEventIds.has(event.eventId)) fail("duplicate_event", "Work Goal event IDs must be unique");
    seenEventIds.add(event.eventId);

    if (index === 0) {
      if (event.type !== "work_goal_created") fail("invalid_transition", "Work Goal journal must begin with work_goal_created");
      const spec = event.payload.spec;
      if (event.goalVersion !== 1 || spec.version !== 1) fail("invalid_transition", "new Work Goal starts at version 1");
      state = {
        goalId: event.goalId,
        spec,
        specsByVersion: { [spec.version]: spec },
        status: "active",
        seq: event.seq,
        tasks: [],
        reservations: {},
        reservationsByTask: {},
        progress: [],
        verifiedCriteria: [],
        verifiedCriteriaByVersion: { [spec.version]: [] },
        blockerStreak: { count: 0, fingerprint: null, pendingTaskId: null },
        continuationTrackingV2: false,
        continuationQueue: [],
        continuationTaskIds: [],
        committedBudget: { maxActions: 0, maxPlannerCalls: 0, maxActiveMs: 0 },
        taskSlotsUsed: 0,
      };
      continue;
    }

    if (event.goalId !== state.goalId) fail("invalid_binding", "Work Goal journal contains another goalId");
    if (event.goalVersion !== state.spec.version && !(event.type === "work_goal_amended" && event.goalVersion === state.spec.version + 1)) {
      fail("stale_goal_version", `event version ${event.goalVersion} does not match current version ${state.spec.version}`);
    }
    applyEvent(state, event);
    state.seq = event.seq;
  }

  state.tasks.sort();
  state.verifiedCriteria.sort();
  for (const ids of Object.values(state.verifiedCriteriaByVersion)) ids.sort();
  return state;
}

function requireStatus(state, allowed, event) {
  if (!allowed.includes(state.status)) fail("invalid_transition", `${event.type} is invalid while Work Goal is ${state.status}`);
}

function criterion(state, id) {
  const value = state.spec.successCriteria.find((item) => item.id === id);
  if (!value) fail("unknown_criterion", `unknown Work Goal criterion ${id}`);
  return value;
}

function reservationFor(state, reservationId, taskId, expectedStatuses, event) {
  const reservation = state.reservations[reservationId];
  if (!reservation || !expectedStatuses.includes(reservation.status) || reservation.taskId !== taskId) {
    fail("reservation_conflict", `${event.type} does not match an outstanding reservation`);
  }
  return reservation;
}

function resetBlockerStreak(state) {
  state.blockerStreak = { count: 0, fingerprint: null, pendingTaskId: null };
  state.continuationQueue = [];
}

function drainContinuationQueue(state) {
  while (state.continuationQueue[0]?.outcome) {
    const { outcome } = state.continuationQueue.shift();
    if (outcome.kind === "neutral") {
      state.blockerStreak = { count: 0, fingerprint: null, pendingTaskId: null };
      continue;
    }
    const count = state.blockerStreak.fingerprint === outcome.fingerprint ? state.blockerStreak.count + 1 : 1;
    state.blockerStreak = { count, fingerprint: outcome.fingerprint, pendingTaskId: null };
    if (count >= 3) state.status = "blocked";
  }
}

function applyWorkGoalEvent(previousState, event, seenEventIds = new Set()) {
  validateWorkGoalEvent(event);
  if (!previousState || !contracts.isPlainObject(previousState)) fail("invalid_state", "incremental Work Goal reduction requires a replay state");
  if (event.seq !== previousState.seq + 1) fail("invalid_sequence", `expected Work Goal event sequence ${previousState.seq + 1}, got ${event.seq}`);
  if (seenEventIds.has(event.eventId)) fail("duplicate_event", "Work Goal event IDs must be unique");
  if (event.goalId !== previousState.goalId) fail("invalid_binding", "Work Goal journal contains another goalId");
  if (event.goalVersion !== previousState.spec.version && !(event.type === "work_goal_amended" && event.goalVersion === previousState.spec.version + 1)) {
    fail("stale_goal_version", `event version ${event.goalVersion} does not match current version ${previousState.spec.version}`);
  }
  // This reducer mutates the private replay state so each append is O(size of
  // the event), not O(size of the ever-growing Work Goal index). Callers that
  // expose snapshots must structuredClone it at their boundary.
  const state = previousState;
  applyEvent(state, event);
  state.seq = event.seq;
  seenEventIds.add(event.eventId);
  return state;
}

function committedBudgetUsage(state) {
  return { maxTasks: state.taskSlotsUsed, ...state.committedBudget };
}

function validateEvidenceBindings(state, refs, event) {
  for (const ref of refs) {
    criterion(state, ref.criterionId);
    const reservationId = state.reservationsByTask[ref.taskId];
    const reservation = reservationId ? state.reservations[reservationId] : null;
    if (!reservation || !["linked", "reconciled", "released"].includes(reservation.status) || reservation.taskGoalVersion !== event.goalVersion) {
      fail("invalid_binding", "evidence must reference a linked Task bound to this Work Goal version");
    }
  }
}

function applyEvent(state, event) {
  const { payload } = event;
  switch (event.type) {
    case "work_goal_amended": {
      requireStatus(state, ["active"], event);
      if (payload.spec.goalId !== state.goalId || payload.spec.version !== state.spec.version + 1) {
        fail("stale_goal_version", "Work Goal amendment must preserve goalId and increment version exactly once");
      }
      const committed = committedBudgetUsage(state);
      for (const [axis, cap] of Object.entries(payload.spec.budget)) {
        if (cap < committed[axis]) fail("budget_overcommitted", `new ${axis} cap is below consumed usage or outstanding reservations`);
      }
      state.spec = payload.spec;
      state.specsByVersion[payload.spec.version] = payload.spec;
      state.verifiedCriteria = [];
      state.verifiedCriteriaByVersion[payload.spec.version] = [];
      resetBlockerStreak(state);
      break;
    }
    case "work_goal_task_reserved": {
      requireStatus(state, ["active"], event);
      if (payload.taskGoalVersion !== state.spec.version) fail("stale_goal_version", "Task reservation must use the active Work Goal version");
      if (state.reservations[payload.reservationId] || Object.hasOwn(state.reservationsByTask, payload.taskId)) {
        fail("reservation_conflict", "Task or reservation is already registered");
      }
      const committed = committedBudgetUsage(state);
      for (const [axis, cap] of Object.entries(state.spec.budget)) {
        const requested = axis === "maxTasks" ? 1 : payload.limits[axis];
        if (committed[axis] + requested > cap) fail("budget_exhausted", `reservation exceeds remaining ${axis} allowance`);
      }
      state.reservations[payload.reservationId] = {
        reservationId: payload.reservationId,
        taskId: payload.taskId,
        taskGoalVersion: payload.taskGoalVersion,
        limits: { ...payload.limits },
        status: "reserved",
        usage: null,
      };
      state.reservationsByTask[payload.taskId] = payload.reservationId;
      state.taskSlotsUsed += 1;
      for (const axis of USAGE_FIELDS) state.committedBudget[axis] += payload.limits[axis];
      break;
    }
    case "work_goal_task_linked": {
      const reservation = reservationFor(state, payload.reservationId, payload.taskId, ["reserved"], event);
      reservation.status = "linked";
      state.tasks.push(payload.taskId);
      break;
    }
    case "work_goal_task_reservation_cancelled": {
      const reservation = reservationFor(state, payload.reservationId, payload.taskId, ["reserved"], event);
      reservation.status = "cancelled";
      reservation.cancelReason = payload.reason;
      state.taskSlotsUsed -= 1;
      for (const axis of USAGE_FIELDS) state.committedBudget[axis] -= reservation.limits[axis];
      break;
    }
    case "work_goal_task_reservation_reconciled": {
      const reservation = reservationFor(state, payload.reservationId, payload.taskId, ["linked"], event);
      for (const axis of USAGE_FIELDS) {
        const max = reservation.limits[axis] ?? Number.MAX_SAFE_INTEGER;
        if (payload.usage[axis] > max) fail("budget_corrupt", `usage exceeds reserved ${axis}`);
      }
      reservation.status = "reconciled";
      reservation.taskState = payload.taskState;
      reservation.usage = { ...payload.usage };
      break;
    }
    case "work_goal_task_reservation_released": {
      const reservation = reservationFor(state, payload.reservationId, payload.taskId, ["reconciled"], event);
      const expectedAxes = Object.keys(reservation.limits).filter((axis) => axis !== "maxTasks").sort();
      const submittedAxes = Object.keys(payload.unused).sort();
      if (JSON.stringify(expectedAxes) !== JSON.stringify(submittedAxes)) {
        fail("budget_corrupt", "released allowance must name every and only reserved budget dimension");
      }
      for (const axis of Object.keys(payload.unused)) {
        const expected = Math.max(0, (reservation.limits[axis] ?? 0) - (reservation.usage?.[axis] ?? 0));
        if (payload.unused[axis] !== expected) fail("budget_corrupt", `released ${axis} does not equal its unused reservation`);
      }
      reservation.status = "released";
      reservation.unused = { ...payload.unused };
      for (const axis of USAGE_FIELDS) state.committedBudget[axis] -= reservation.limits[axis] - reservation.usage[axis];
      break;
    }
    case "work_goal_progress_recorded":
      requireStatus(state, ["active", "blocked"], event);
      validateEvidenceBindings(state, payload.evidenceRefs, event);
      state.progress.push(...payload.evidenceRefs.map((ref) => ({ ...ref, goalVersion: event.goalVersion })));
      resetBlockerStreak(state);
      if (state.status === "blocked") state.status = "active";
      break;
    case "work_goal_continuation_attempted": {
      requireStatus(state, ["active"], event);
      const reservationId = state.reservationsByTask[payload.taskId];
      if (!reservationId || !["linked", "reconciled", "released"].includes(state.reservations[reservationId].status)) fail("invalid_binding", "continuation Task must be linked before its attempt is recorded");
      if (state.blockerStreak.pendingTaskId !== null) {
        state.blockerStreak = { count: 0, fingerprint: null, pendingTaskId: null };
      }
      state.blockerStreak.pendingTaskId = payload.taskId;
      break;
    }
    case "work_goal_continuation_enqueued": {
      requireStatus(state, ["active"], event);
      const reservationId = state.reservationsByTask[payload.taskId];
      if (!reservationId || !["linked", "reconciled", "released"].includes(state.reservations[reservationId].status)) {
        fail("invalid_binding", "continuation Task must be linked before it is enqueued");
      }
      // This event starts ordered accounting without changing how any existing
      // legacy event sequence is replayed. Any legacy streak is ambiguous once
      // a task may be outstanding concurrently, so conservatively restart it.
      if (!state.continuationTrackingV2) {
        state.continuationTrackingV2 = true;
        state.blockerStreak = { count: 0, fingerprint: null, pendingTaskId: null };
        state.continuationQueue = [];
        state.continuationTaskIds = [];
      }
      if (state.continuationTaskIds.includes(payload.taskId)) fail("duplicate_continuation", "Task continuation was already enqueued");
      state.continuationTaskIds.push(payload.taskId);
      state.continuationQueue.push({ taskId: payload.taskId, outcome: null });
      break;
    }
    case "work_goal_continuation_resolved": {
      requireStatus(state, ["active", "blocked"], event);
      if (!state.continuationTrackingV2) fail("invalid_transition", "continuation resolution requires ordered tracking");
      const reservationId = state.reservationsByTask[payload.taskId];
      const continuation = state.continuationQueue.find((item) => item.taskId === payload.taskId);
      if (!reservationId || !["linked", "reconciled", "released"].includes(state.reservations[reservationId].status) ||
          !continuation || continuation.outcome) {
        fail("invalid_binding", "neutral continuation result must match an unresolved linked Task");
      }
      continuation.outcome = { kind: "neutral" };
      drainContinuationQueue(state);
      break;
    }
    case "work_goal_blocker_observed": {
      requireStatus(state, state.continuationTrackingV2 ? ["active", "blocked"] : ["active"], event);
      const reservationId = state.reservationsByTask[payload.taskId];
      if (state.continuationTrackingV2) {
        const continuation = state.continuationQueue.find((item) => item.taskId === payload.taskId);
        if (!reservationId || !["linked", "reconciled", "released"].includes(state.reservations[reservationId].status) ||
            !continuation || continuation.outcome) {
          fail("invalid_binding", "blocker must resolve an unresolved enqueued continuation Task");
        }
        continuation.outcome = { kind: "blocker", fingerprint: `${payload.reasonCode}:${payload.phase}` };
        drainContinuationQueue(state);
        break;
      }
      if (!reservationId || !["linked", "reconciled", "released"].includes(state.reservations[reservationId].status) || state.blockerStreak.pendingTaskId !== payload.taskId) {
        fail("invalid_binding", "blocker must resolve the currently pending continuation Task");
      }
      const fingerprint = `${payload.reasonCode}:${payload.phase}`;
      const count = state.blockerStreak.fingerprint === fingerprint ? state.blockerStreak.count + 1 : 1;
      state.blockerStreak = { count, fingerprint, pendingTaskId: null };
      if (count >= 3) state.status = "blocked";
      break;
    }
    case "work_goal_paused":
      requireStatus(state, ["active"], event);
      state.status = "paused";
      resetBlockerStreak(state);
      break;
    case "work_goal_resumed":
      requireStatus(state, ["paused", "blocked"], event);
      state.status = "active";
      resetBlockerStreak(state);
      break;
    case "work_goal_criterion_verified": {
      requireStatus(state, ["active", "paused", "blocked"], event);
      const target = criterion(state, payload.criterionId);
      if (payload.actor === "user" && target.verification !== "user") fail("invalid_verification", "user verification cannot satisfy a host-evidence criterion");
      if (payload.actor === "host" && target.verification !== "host_evidence") fail("invalid_verification", "host evidence cannot satisfy a user criterion");
      if (payload.actor === "host" && payload.evidenceRefs.some((ref) => ref.criterionId !== payload.criterionId)) {
        fail("invalid_verification", "host evidence references must match the verified criterion");
      }
      if (payload.actor === "host") validateEvidenceBindings(state, payload.evidenceRefs, event);
      if (!state.verifiedCriteria.includes(payload.criterionId)) state.verifiedCriteria.push(payload.criterionId);
      const verifiedForVersion = state.verifiedCriteriaByVersion[event.goalVersion] || [];
      if (!verifiedForVersion.includes(payload.criterionId)) verifiedForVersion.push(payload.criterionId);
      state.verifiedCriteriaByVersion[event.goalVersion] = verifiedForVersion;
      if (payload.actor === "host") state.progress.push(...payload.evidenceRefs.map((ref) => ({ ...ref, goalVersion: event.goalVersion })));
      resetBlockerStreak(state);
      if (state.status === "blocked") state.status = "active";
      break;
    }
    case "work_goal_completed": {
      requireStatus(state, ["active"], event);
      const required = state.spec.successCriteria.filter((item) => item.required).map((item) => item.id).sort();
      const submitted = [...payload.criterionIds].sort();
      if (JSON.stringify(required) !== JSON.stringify(submitted) || required.some((id) => !state.verifiedCriteria.includes(id))) {
        fail("criteria_incomplete", "every required current-version criterion must be verified before completion");
      }
      state.status = "complete";
      break;
    }
    case "work_goal_archived":
      requireStatus(state, ["complete", "paused", "blocked"], event);
      state.status = "archived";
      break;
    default:
      fail("invalid_transition", `event ${event.type} cannot follow work_goal_created`);
  }
}

module.exports = {
  SCHEMA_VERSION,
  MAX_OBJECTIVE_BYTES,
  MAX_SUCCESS_CRITERIA,
  MAX_CRITERION_TEXT_CHARS,
  MAX_BUDGET,
  EVENT_TYPES,
  BLOCKER_REASONS,
  BLOCKER_PHASES,
  BLOCKER_PHASE_BY_REASON,
  WorkGoalContractError,
  validateWorkGoalInput,
  validateWorkGoalSpec,
  validateWorkGoalEvent,
  applyWorkGoalEvent,
  replayWorkGoalEvents,
};
