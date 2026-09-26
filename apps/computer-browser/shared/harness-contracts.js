"use strict";

// Runtime JSON contracts for the long-horizon browser harness (see
// docs/superpowers/specs/2026-09-27-long-horizon-browser-harness-design.md
// section 3). Every object that crosses a process/storage/context boundary
// in the harness is validated here: unknown fields, unknown schema
// versions, and unknown enum values are rejected rather than silently
// tolerated, so a stray or forged field can never smuggle new meaning past
// the host. This module is pure (no fs/IPC) so it can be unit-tested and
// reused by task-store.js, context-builder.js, task-controller.js, and the
// approver/browser adapters without pulling in Electron or Node's fs.

const SCHEMA_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Bytes, per design doc section 5 ("원문 16 KiB", "각 512자까지" for
// criteria, journal/checkpoint/store caps in section 4).
const MAX_ORIGINAL_REQUEST_BYTES = 16 * 1024;
const MAX_AMENDMENT_TEXT_BYTES = MAX_ORIGINAL_REQUEST_BYTES; // an amendment is also verbatim user text
const MAX_CRITERIA_COUNT = 64;
const MAX_CRITERION_TEXT_CHARS = 512;
const MAX_CONSTRAINT_TEXT_CHARS = 512; // no separate bound is given for constraints; reuse the criteria bound
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_TASK_STORE_BYTES = 100 * 1024 * 1024;

const DEFAULT_LIMITS = Object.freeze({
  maxActions: 1000,
  maxPlannerCalls: 500,
  maxActiveMs: 4 * 60 * 60 * 1000,
});

// C1 is the always-present fallback completion criterion (section 3):
// "criteria 생략 시 같은 C1을 사용한다" -- a free-text goal with no explicit
// criteria still requires an explicit human check before it can complete.
const DEFAULT_CRITERION_C1 = Object.freeze({
  id: "C1",
  text: "originalRequest를 달성했고 사용자가 결과를 확인했다",
  required: true,
  verification: "user",
});

// Extend this list as later tasks introduce new journal event kinds; never
// remove/rename an existing entry, since old journals must keep replaying.
const EVENT_TYPES = Object.freeze(["goal_created", "goal_amended", "action_started", "action_outcome", "note"]);

const VERIFICATION_KINDS = Object.freeze(["host", "user"]);
const AMENDMENT_AUTHORITY = Object.freeze(["user"]); // pages/models can never author an amendment

class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new ContractError("invalid_shape", `${label} must be a plain object`);
}

function assertNoUnknownKeys(obj, allowedKeys, label) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new ContractError("unknown_field", `${label} has unknown field "${key}"`);
    }
  }
}

function assertString(value, label, { maxBytes, maxChars, allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new ContractError("invalid_field", `${label} must be a string`);
  if (!allowEmpty && value.length === 0) throw new ContractError("invalid_field", `${label} must not be empty`);
  if (typeof maxChars === "number" && value.length > maxChars) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxChars} characters`);
  }
  if (typeof maxBytes === "number" && Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxBytes} bytes`);
  }
}

function assertId(value, label) {
  assertString(value, label, { maxChars: 64 });
  if (!ID_RE.test(value)) throw new ContractError("invalid_id", `${label} has an invalid id: ${JSON.stringify(value)}`);
}

function assertUuid(value, label) {
  assertString(value, label, { maxChars: 64 });
  if (!UUID_RE.test(value)) throw new ContractError("invalid_id", `${label} must be a UUID`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ContractError("invalid_field", `${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ContractError("invalid_field", `${label} must be a non-negative integer`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new ContractError("invalid_field", `${label} must be a boolean`);
}

function assertIsoTimestamp(value, label) {
  assertString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ContractError("invalid_field", `${label} must be an ISO timestamp`);
}

function assertStringArray(value, label, { itemLabel, maxLength } = {}) {
  if (!Array.isArray(value)) throw new ContractError("invalid_field", `${label} must be an array`);
  if (typeof maxLength === "number" && value.length > maxLength) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxLength} entries`);
  }
  value.forEach((entry, i) => assertString(entry, itemLabel || `${label}[${i}]`));
}

function validateConstraint(constraint, label) {
  assertPlainObject(constraint, label);
  assertNoUnknownKeys(constraint, ["id", "text", "sourceMessageId"], label);
  assertId(constraint.id, `${label}.id`);
  assertString(constraint.text, `${label}.text`, { maxChars: MAX_CONSTRAINT_TEXT_CHARS });
  if (constraint.sourceMessageId !== undefined && constraint.sourceMessageId !== null) {
    assertString(constraint.sourceMessageId, `${label}.sourceMessageId`);
  }
}

function validateCriterion(criterion, label) {
  assertPlainObject(criterion, label);
  assertNoUnknownKeys(criterion, ["id", "text", "required", "verification", "sourceMessageId"], label);
  assertId(criterion.id, `${label}.id`);
  assertString(criterion.text, `${label}.text`, { maxChars: MAX_CRITERION_TEXT_CHARS });
  assertBoolean(criterion.required, `${label}.required`);
  if (!VERIFICATION_KINDS.includes(criterion.verification)) {
    throw new ContractError("unknown_enum", `${label}.verification must be one of ${VERIFICATION_KINDS.join("|")}`);
  }
  if (criterion.sourceMessageId !== undefined && criterion.sourceMessageId !== null) {
    assertString(criterion.sourceMessageId, `${label}.sourceMessageId`);
  }
}

function validateAmendment(amendment, label) {
  assertPlainObject(amendment, label);
  assertNoUnknownKeys(amendment, ["id", "text", "at", "supersedesConstraintIds", "authority"], label);
  assertId(amendment.id, `${label}.id`);
  assertString(amendment.text, `${label}.text`, { maxBytes: MAX_AMENDMENT_TEXT_BYTES });
  assertIsoTimestamp(amendment.at, `${label}.at`);
  assertStringArray(amendment.supersedesConstraintIds, `${label}.supersedesConstraintIds`);
  if (!AMENDMENT_AUTHORITY.includes(amendment.authority)) {
    throw new ContractError("unknown_enum", `${label}.authority must be one of ${AMENDMENT_AUTHORITY.join("|")}`);
  }
}

function validateLimits(limits, label) {
  assertPlainObject(limits, label);
  assertNoUnknownKeys(limits, ["maxActions", "maxPlannerCalls", "maxActiveMs"], label);
  assertPositiveInteger(limits.maxActions, `${label}.maxActions`);
  assertPositiveInteger(limits.maxPlannerCalls, `${label}.maxPlannerCalls`);
  assertPositiveInteger(limits.maxActiveMs, `${label}.maxActiveMs`);
}

const GOAL_SPEC_FIELDS = [
  "schemaVersion",
  "taskId",
  "goalVersion",
  "originalRequest",
  "amendments",
  "constraints",
  "criteria",
  "limits",
  "createdAt",
];

// Validates a fully-formed GoalSpec exactly as it will be stored on disk
// (used both when writing a new goal-vNNNN.json and when re-reading one, so
// a hand-edited or future-version file is rejected the same way either
// time). Does NOT fill defaults -- see normalizeGoalSpec for that.
function validateGoalSpec(goal, label = "goal") {
  assertPlainObject(goal, label);
  assertNoUnknownKeys(goal, GOAL_SPEC_FIELDS, label);
  if (goal.schemaVersion !== SCHEMA_VERSION) {
    throw new ContractError("unknown_version", `${label}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  assertUuid(goal.taskId, `${label}.taskId`);
  assertPositiveInteger(goal.goalVersion, `${label}.goalVersion`);
  assertString(goal.originalRequest, `${label}.originalRequest`, { maxBytes: MAX_ORIGINAL_REQUEST_BYTES });
  if (!Array.isArray(goal.amendments)) throw new ContractError("invalid_field", `${label}.amendments must be an array`);
  goal.amendments.forEach((a, i) => validateAmendment(a, `${label}.amendments[${i}]`));
  if (!Array.isArray(goal.constraints)) throw new ContractError("invalid_field", `${label}.constraints must be an array`);
  goal.constraints.forEach((c, i) => validateConstraint(c, `${label}.constraints[${i}]`));
  if (!Array.isArray(goal.criteria)) throw new ContractError("invalid_field", `${label}.criteria must be an array`);
  if (goal.criteria.length === 0) throw new ContractError("invalid_field", `${label}.criteria must not be empty`);
  if (goal.criteria.length > MAX_CRITERIA_COUNT) {
    throw new ContractError("field_too_large", `${label}.criteria exceeds ${MAX_CRITERIA_COUNT} entries`);
  }
  goal.criteria.forEach((c, i) => validateCriterion(c, `${label}.criteria[${i}]`));
  validateLimits(goal.limits, `${label}.limits`);
  assertIsoTimestamp(goal.createdAt, `${label}.createdAt`);
  return goal;
}

// Builds a fully-formed, validated GoalSpec (schemaVersion 1) from host
// input. `input` carries the fields the caller controls (originalRequest,
// optional constraints/criteria/limits); `host` carries fields only the
// store may assign (taskId, goalVersion, createdAt) so a caller can never
// forge its own taskId or backdate creation.
function normalizeGoalSpec(input, host) {
  assertPlainObject(input, "goalInput");
  assertNoUnknownKeys(input, ["originalRequest", "constraints", "criteria", "limits", "amendments"], "goalInput");
  assertPlainObject(host, "host");
  assertNoUnknownKeys(host, ["taskId", "goalVersion", "createdAt"], "host");

  const criteria = input.criteria && input.criteria.length > 0 ? input.criteria : [DEFAULT_CRITERION_C1];
  const goal = {
    schemaVersion: SCHEMA_VERSION,
    taskId: host.taskId,
    goalVersion: host.goalVersion,
    originalRequest: input.originalRequest,
    amendments: input.amendments || [],
    constraints: input.constraints || [],
    criteria,
    limits: { ...DEFAULT_LIMITS, ...(input.limits || {}) },
    createdAt: host.createdAt,
  };
  return validateGoalSpec(goal, "goal");
}

// Produces the next GoalSpec version from an amendment. originalRequest,
// taskId, and createdAt are always carried over unchanged -- no amendment
// or summary can rewrite them (design doc section 3: "원문은 어떤 요약에서도
// 재작성하지 않는다"). Constraints named in supersedesConstraintIds are
// dropped; everything else, and any newConstraints/newCriteria, is additive.
function applyAmendment(goal, amendmentInput, host) {
  validateGoalSpec(goal, "goal");
  assertPlainObject(amendmentInput, "amendmentInput");
  assertNoUnknownKeys(
    amendmentInput,
    ["text", "supersedesConstraintIds", "newConstraints", "newCriteria"],
    "amendmentInput",
  );
  assertPlainObject(host, "host");
  assertNoUnknownKeys(host, ["amendmentId", "at"], "host");

  const supersedes = amendmentInput.supersedesConstraintIds || [];
  assertStringArray(supersedes, "amendmentInput.supersedesConstraintIds");
  const newConstraints = amendmentInput.newConstraints || [];
  const newCriteria = amendmentInput.newCriteria || [];

  const amendment = {
    id: host.amendmentId,
    text: amendmentInput.text,
    at: host.at,
    supersedesConstraintIds: supersedes,
    authority: "user",
  };
  validateAmendment(amendment, "amendment");

  const survivingConstraints = goal.constraints.filter((c) => !supersedes.includes(c.id));
  const nextGoal = {
    schemaVersion: SCHEMA_VERSION,
    taskId: goal.taskId,
    goalVersion: goal.goalVersion + 1,
    originalRequest: goal.originalRequest,
    amendments: [...goal.amendments, amendment],
    constraints: [...survivingConstraints, ...newConstraints],
    criteria: [...goal.criteria, ...newCriteria],
    limits: goal.limits,
    createdAt: goal.createdAt,
  };
  return validateGoalSpec(nextGoal, "goal");
}

const JOURNAL_EVENT_FIELDS = ["seq", "eventId", "taskId", "goalVersion", "type", "payload", "at"];

function validateJournalEvent(event, label = "event") {
  assertPlainObject(event, label);
  assertNoUnknownKeys(event, JOURNAL_EVENT_FIELDS, label);
  assertNonNegativeInteger(event.seq, `${label}.seq`);
  assertUuid(event.eventId, `${label}.eventId`);
  assertUuid(event.taskId, `${label}.taskId`);
  assertPositiveInteger(event.goalVersion, `${label}.goalVersion`);
  if (!EVENT_TYPES.includes(event.type)) {
    throw new ContractError("unknown_enum", `${label}.type must be one of ${EVENT_TYPES.join("|")}`);
  }
  assertPlainObject(event.payload, `${label}.payload`);
  if (event.type === "action_started" || event.type === "action_outcome") {
    assertId(event.payload.actionId, `${label}.payload.actionId`);
  }
  assertIsoTimestamp(event.at, `${label}.at`);
  const size = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (size > MAX_EVENT_BYTES) {
    throw new ContractError("event_too_large", `${label} is ${size} bytes, exceeds ${MAX_EVENT_BYTES}`);
  }
  return event;
}

const CHECKPOINT_FIELDS = ["seq", "taskId", "goalVersion", "payload", "at"];

function validateCheckpointEnvelope(envelope, label = "checkpoint") {
  assertPlainObject(envelope, label);
  assertNoUnknownKeys(envelope, CHECKPOINT_FIELDS, label);
  assertNonNegativeInteger(envelope.seq, `${label}.seq`);
  assertUuid(envelope.taskId, `${label}.taskId`);
  assertPositiveInteger(envelope.goalVersion, `${label}.goalVersion`);
  assertPlainObject(envelope.payload, `${label}.payload`);
  assertIsoTimestamp(envelope.at, `${label}.at`);
  const size = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (size > MAX_CHECKPOINT_BYTES) {
    throw new ContractError("checkpoint_too_large", `${label} is ${size} bytes, exceeds ${MAX_CHECKPOINT_BYTES}`);
  }
  return envelope;
}

module.exports = {
  SCHEMA_VERSION,
  UUID_RE,
  ID_RE,
  MAX_ORIGINAL_REQUEST_BYTES,
  MAX_AMENDMENT_TEXT_BYTES,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_TEXT_CHARS,
  MAX_CONSTRAINT_TEXT_CHARS,
  MAX_EVENT_BYTES,
  MAX_CHECKPOINT_BYTES,
  MAX_TASK_STORE_BYTES,
  DEFAULT_LIMITS,
  DEFAULT_CRITERION_C1,
  EVENT_TYPES,
  VERIFICATION_KINDS,
  ContractError,
  isPlainObject,
  assertUuid,
  assertId,
  normalizeGoalSpec,
  validateGoalSpec,
  applyAmendment,
  validateJournalEvent,
  validateCheckpointEnvelope,
};
