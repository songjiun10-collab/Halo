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
const MAX_CONTEXT_PACKET_BYTES = 64 * 1024; // section 5: "구조화된 packet 상한 64 KiB"
const MAX_RECENT_EVENTS_IN_CONTEXT = 10; // section 5: "최근 action/result 10쌍"
const MAX_ACTIONS_PER_PROPOSAL = 3; // section 8: "최대 3개 observe/scroll만 순차 묶음"
// The only wider batch bound validateProposalEnvelope() will ever accept
// (harness-profile.js's maxActionsPerProposal(), short profile only) -- a
// second named constant, not an arbitrary caller-supplied number, so this
// security boundary can only ever widen to one pre-reviewed value.
const MAX_ACTIONS_PER_PROPOSAL_SHORT = 8;
const MAX_PLANNER_FRAME_BYTES = 64 * 1024; // section 6: JSONL stdio wire frame cap (envelope + payload)
const PLANNER_RESPONSE_TIMEOUT_MS = 60 * 1000; // section 6: "응답 timeout 60초"
const APPROVAL_EXPIRY_MS = 60 * 1000; // section 7: "60초 후 만료"
const SEGMENT_ROTATION_CALLS = 25; // section 5: "25회 planner 호출마다 새 segment"
const NO_PROGRESS_REPLAN_THRESHOLD = 3; // section 5: "3회 연속 같은 (action,target,observationHash)"

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
const EVENT_TYPES = Object.freeze([
  "goal_created",
  "task_profile_selected",
  "goal_amended",
  "action_started",
  "action_outcome",
  "evidence_recorded",
  "approval_cancelled",
  "note",
  "child_plan_accepted",
  "child_plan_cancelled",
  "child_result_verified",
  "message_sent",
  "message_turn_consumed",
  "routine_step_advanced",
  "routine_step_denied",
  "routine_step_failed",
]);

const VERIFICATION_KINDS = Object.freeze(["host", "user"]);
const AMENDMENT_AUTHORITY = Object.freeze(["user"]); // pages/models can never author an amendment

// Evidence.kind: what produced the candidate; EVIDENCE_VERIFICATION_STATES:
// only a host verifier (verifyCriterion) or a trusted user-confirmation IPC
// path may ever move an entry out of "pending" -- a model proposing Evidence
// can only ever produce "pending" (enforced below: verifierId is required
// for verified/rejected, forbidden while pending, and nothing in this module
// lets a caller self-assign verifierId from untrusted input).
const EVIDENCE_KINDS = Object.freeze(["host_check", "user_confirmation", "artifact"]);
const EVIDENCE_VERIFICATION_STATES = Object.freeze(["pending", "verified", "rejected"]);

const PROPOSAL_KINDS = Object.freeze(["actions", "replan", "finish", "need_user", "child_plan", "send_message"]);
const CHILD_PLAN_FIELDS = Object.freeze(["parentGoalVersion", "requestedAgentCount", "assignments"]);
const SEND_MESSAGE_FIELDS = Object.freeze([
  "recipientTaskId",
  "messageKind",
  "idempotencyKey",
  "text",
  "handoff",
  "evidenceRefs",
  "inReplyToMessageId",
]);

// Multi-agent background runtime plan, Task 3: a parent-only proposal kind
// that spawns isolated child browser agents. Kept intentionally small so a
// maximally-sized child_plan_accepted journal event (Task 3 persists one
// assignment-for-assignment copy of this into the parent journal) still fits
// MAX_EVENT_BYTES -- this is a defense-in-depth SHAPE bound against a
// degenerate/hostile planner payload, NOT a product concurrency policy (the
// design spec is explicit: "the user does not enter the count and it is not
// a fixed product concurrency constant"). Actual concurrent execution is
// gated by ResourceAdmission (Task 2) and same-origin serialization (Task 4).
const MAX_CHILD_ASSIGNMENTS = 8;
const MAX_CHILD_SUBGOAL_BYTES = 2000;
const MAX_ENTRY_URL_CHARS = 2048;
// Mirrors host-settings.js's own MEMORY_POLICIES enum (that module is
// filesystem-backed and this one is deliberately pure/fs-free, so the two
// are not shared code) -- keep both in sync if a third policy is ever added.
const MEMORY_POLICIES = Object.freeze(["budgeted", "user_override"]);

// Subagent communication protocol (spec:
// docs/superpowers/specs/2026-09-28-subagent-communication-protocol-design.md,
// plan: docs/superpowers/plans/2026-09-28-subagent-communication-protocol.md).
// Bounds mirror the spec's section 8.1/10 "proposed v1 defaults for review";
// they are enforced at the coordinator/controller layer (Task 4), not here --
// this module only validates message SHAPE.
const MESSAGE_KINDS = Object.freeze(["progress", "question", "answer", "steer", "handoff", "evidence"]);
const MAX_MESSAGE_TEXT_BYTES = 8 * 1024; // section 6: "at most 8 KiB UTF-8 in v1"
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
const MAX_MESSAGE_EVIDENCE_REFS = 8;
const MAX_HANDOFF_FIELD_CHARS = 2000;
const MAX_HANDOFF_LIST_ITEMS = 16;
const MAX_MESSAGES_PER_TURN = 4; // section 8.1/10 proposed default
const MAX_MESSAGE_TURN_CONTEXT_BYTES = 8 * 1024; // section 8.1/10 proposed default
const MAX_PENDING_MESSAGES_PER_CONVERSATION = 50; // section 10: both directions combined
const MAX_UNOBSERVED_STEER_PER_CHILD = 1; // section 10
const MAX_STEER_PER_CHILD_PER_WINDOW = 3; // section 10
const STEER_RATE_WINDOW_MS = 60 * 1000; // section 10: "rolling 60-second window"
const MAX_MESSAGE_PREVIEW_CHARS = 200; // section 10/14-6

type PlainObject = Record<string, unknown>;

class ContractError extends Error {
  // Type-only: `declare` emits no class field, so own keys stay [name, code].
  declare code: string | undefined;

  /**
   * `code` may be undefined when a caller forwards the code of a foreign
   * error that carried none (see task-profile-contracts capabilityErrorCode).
   */
  constructor(code: string | undefined, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Membership test for a closed string enum. Equivalent to list.includes(value)
 * for every input, since a string list contains no non-string element.
 */
function isOneOf(list: ReadonlyArray<string>, value: unknown): value is string {
  return typeof value === "string" && list.includes(value);
}

function assertPlainObject(value: unknown, label: string): asserts value is PlainObject {
  if (!isPlainObject(value)) throw new ContractError("invalid_shape", `${label} must be a plain object`);
}

function assertNoUnknownKeys(obj: PlainObject, allowedKeys: ReadonlyArray<string>, label: string) {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new ContractError("unknown_field", `${label} has unknown field "${key}"`);
    }
  }
}

function assertString(value: unknown, label: string, { maxBytes, maxChars, allowEmpty = false }: { maxBytes?: number, maxChars?: number, allowEmpty?: boolean } = {}): asserts value is string {
  if (typeof value !== "string") throw new ContractError("invalid_field", `${label} must be a string`);
  if (!allowEmpty && value.length === 0) throw new ContractError("invalid_field", `${label} must not be empty`);
  if (typeof maxChars === "number" && value.length > maxChars) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxChars} characters`);
  }
  if (typeof maxBytes === "number" && Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxBytes} bytes`);
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  assertString(value, label, { maxChars: 64 });
  if (!ID_RE.test(value)) throw new ContractError("invalid_id", `${label} has an invalid id: ${JSON.stringify(value)}`);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  assertString(value, label, { maxChars: 64 });
  if (!UUID_RE.test(value)) throw new ContractError("invalid_id", `${label} must be a UUID`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ContractError("invalid_field", `${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ContractError("invalid_field", `${label} must be a non-negative integer`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new ContractError("invalid_field", `${label} must be a boolean`);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ContractError("invalid_field", `${label} must be an ISO timestamp`);
}

function assertStringArray(value: unknown, label: string, { itemLabel, maxLength, itemMaxChars }: { itemLabel?: string, maxLength?: number, itemMaxChars?: number } = {}): asserts value is string[] {
  if (!Array.isArray(value)) throw new ContractError("invalid_field", `${label} must be an array`);
  if (typeof maxLength === "number" && value.length > maxLength) {
    throw new ContractError("field_too_large", `${label} exceeds ${maxLength} entries`);
  }
  value.forEach((entry, i) => assertString(entry, itemLabel || `${label}[${i}]`, { maxChars: itemMaxChars }));
}

function validateConstraint(constraint: unknown, label: string) {
  assertPlainObject(constraint, label);
  assertNoUnknownKeys(constraint, ["id", "text", "sourceMessageId"], label);
  assertId(constraint.id, `${label}.id`);
  assertString(constraint.text, `${label}.text`, { maxChars: MAX_CONSTRAINT_TEXT_CHARS });
  if (constraint.sourceMessageId !== undefined && constraint.sourceMessageId !== null) {
    assertString(constraint.sourceMessageId, `${label}.sourceMessageId`);
  }
}

function validateCriterion(criterion: unknown, label: string) {
  assertPlainObject(criterion, label);
  assertNoUnknownKeys(criterion, ["id", "text", "required", "verification", "sourceMessageId"], label);
  assertId(criterion.id, `${label}.id`);
  assertString(criterion.text, `${label}.text`, { maxChars: MAX_CRITERION_TEXT_CHARS });
  assertBoolean(criterion.required, `${label}.required`);
  if (!isOneOf(VERIFICATION_KINDS, criterion.verification)) {
    throw new ContractError("unknown_enum", `${label}.verification must be one of ${VERIFICATION_KINDS.join("|")}`);
  }
  if (criterion.sourceMessageId !== undefined && criterion.sourceMessageId !== null) {
    assertString(criterion.sourceMessageId, `${label}.sourceMessageId`);
  }
}

function validateAmendment(amendment: unknown, label: string) {
  assertPlainObject(amendment, label);
  assertNoUnknownKeys(amendment, ["id", "text", "at", "supersedesConstraintIds", "authority"], label);
  assertId(amendment.id, `${label}.id`);
  assertString(amendment.text, `${label}.text`, { maxBytes: MAX_AMENDMENT_TEXT_BYTES });
  assertIsoTimestamp(amendment.at, `${label}.at`);
  assertStringArray(amendment.supersedesConstraintIds, `${label}.supersedesConstraintIds`);
  if (!isOneOf(AMENDMENT_AUTHORITY, amendment.authority)) {
    throw new ContractError("unknown_enum", `${label}.authority must be one of ${AMENDMENT_AUTHORITY.join("|")}`);
  }
}

function validateLimits(limits: unknown, label: string) {
  assertPlainObject(limits, label);
  assertNoUnknownKeys(limits, ["maxActions", "maxPlannerCalls", "maxActiveMs"], label);
  assertPositiveInteger(limits.maxActions, `${label}.maxActions`);
  assertPositiveInteger(limits.maxPlannerCalls, `${label}.maxPlannerCalls`);
  assertPositiveInteger(limits.maxActiveMs, `${label}.maxActiveMs`);
}

type Constraint = { id: string, text: string, sourceMessageId?: string | null };
type Criterion = { id: string, text: string, required: boolean, verification: string, sourceMessageId?: string | null };
type Amendment = { id: string, text: string, at: string, supersedesConstraintIds: string[], authority: string };
type Limits = { maxActions: number, maxPlannerCalls: number, maxActiveMs: number };
type GoalTrigger = { scheduleId: string, occurrenceAt: string };
type GoalSpec = {
  schemaVersion: number,
  taskId: string,
  goalVersion: number,
  originalRequest: string,
  amendments: Amendment[],
  constraints: Constraint[],
  criteria: Criterion[],
  limits: Limits,
  createdAt: string,
  trigger?: GoalTrigger,
};

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
  "trigger",
];

// Scheduled-occurrence key. Lives on the goal (not the routineRun checkpoint)
// because TaskStore.create writes the goal atomically with the task.
function validateGoalTrigger(trigger: unknown, label: string) {
  assertPlainObject(trigger, label);
  assertNoUnknownKeys(trigger, ["scheduleId", "occurrenceAt"], label);
  assertUuid(trigger.scheduleId, `${label}.scheduleId`);
  assertIsoTimestamp(trigger.occurrenceAt, `${label}.occurrenceAt`);
}

// Validates a fully-formed GoalSpec exactly as it will be stored on disk
// (used both when writing a new goal-vNNNN.json and when re-reading one, so
// a hand-edited or future-version file is rejected the same way either
// time). Does NOT fill defaults -- see normalizeGoalSpec for that.
function validateGoalSpec(goal: unknown, label: string = "goal"): GoalSpec {
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
  if (goal.trigger !== undefined) validateGoalTrigger(goal.trigger, `${label}.trigger`);
  return (goal as GoalSpec);
}

// Builds a fully-formed, validated GoalSpec (schemaVersion 1) from host
// input. `input` carries the fields the caller controls (originalRequest,
// optional constraints/criteria/limits); `host` carries fields only the
// store may assign (taskId, goalVersion, createdAt) so a caller can never
// forge its own taskId or backdate creation.
function normalizeGoalSpec(input: unknown, host: unknown): GoalSpec {
  assertPlainObject(input, "goalInput");
  assertNoUnknownKeys(input, ["originalRequest", "constraints", "criteria", "limits", "amendments", "trigger"], "goalInput");
  assertPlainObject(host, "host");
  assertNoUnknownKeys(host, ["taskId", "goalVersion", "createdAt"], "host");

  // Type-only view: the expression below is unchanged, and validateGoalSpec
  // rejects any non-array value that it lets through.
  const inputCriteria = (input.criteria as { length: number } | null | undefined);
  const criteria = inputCriteria && inputCriteria.length > 0 ? inputCriteria : [DEFAULT_CRITERION_C1];
  const goal: PlainObject = {
    schemaVersion: SCHEMA_VERSION,
    taskId: host.taskId,
    goalVersion: host.goalVersion,
    originalRequest: input.originalRequest,
    amendments: input.amendments || [],
    constraints: input.constraints || [],
    criteria,
    limits: { ...DEFAULT_LIMITS, ...((input.limits || {}) as object) },
    createdAt: host.createdAt,
  };
  if (input.trigger !== undefined) goal.trigger = input.trigger;
  return validateGoalSpec(goal, "goal");
}

// Produces the next GoalSpec version from an amendment. originalRequest,
// taskId, and createdAt are always carried over unchanged -- no amendment
// or summary can rewrite them (design doc section 3: "원문은 어떤 요약에서도
// 재작성하지 않는다"). Constraints named in supersedesConstraintIds are
// dropped; everything else, and any newConstraints/newCriteria, is additive.
function applyAmendment(goalInput: unknown, amendmentInput: unknown, host: unknown): GoalSpec {
  const goal = validateGoalSpec(goalInput, "goal");
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
  // Type-only views; validateGoalSpec(nextGoal) below validates every entry.
  const newConstraints = ((amendmentInput.newConstraints || []) as Constraint[]);
  const newCriteria = ((amendmentInput.newCriteria || []) as Criterion[]);

  const amendment = {
    id: host.amendmentId,
    text: amendmentInput.text,
    at: host.at,
    supersedesConstraintIds: supersedes,
    authority: "user",
  };
  validateAmendment(amendment, "amendment");

  const survivingConstraints = goal.constraints.filter((c) => !supersedes.includes(c.id));
  const nextGoal: PlainObject = {
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
  if (goal.trigger !== undefined) nextGoal.trigger = goal.trigger;
  return validateGoalSpec(nextGoal, "goal");
}

// Subagent communication protocol handoff (spec section 8.2): the bounded,
// structured checkpoint/completion summary for kind="handoff" messages.
// verifiedResults entries cite the existing Evidence.id namespace rather
// than duplicating evidence content (section 9).
const HANDOFF_FIELDS = ["objective", "currentState", "verifiedResults", "unresolved", "risks", "suggestedNextAction"];

function validateHandoff(handoff: unknown, label: string) {
  assertPlainObject(handoff, label);
  assertNoUnknownKeys(handoff, HANDOFF_FIELDS, label);
  assertString(handoff.objective, `${label}.objective`, { maxChars: MAX_HANDOFF_FIELD_CHARS });
  assertString(handoff.currentState, `${label}.currentState`, { maxChars: MAX_HANDOFF_FIELD_CHARS });
  if (!Array.isArray(handoff.verifiedResults) || handoff.verifiedResults.length > MAX_HANDOFF_LIST_ITEMS) {
    throw new ContractError("field_too_large", `${label}.verifiedResults must be an array of at most ${MAX_HANDOFF_LIST_ITEMS} entries`);
  }
  handoff.verifiedResults.forEach((v, i) => {
    assertPlainObject(v, `${label}.verifiedResults[${i}]`);
    assertNoUnknownKeys(v, ["text", "evidenceId"], `${label}.verifiedResults[${i}]`);
    assertString(v.text, `${label}.verifiedResults[${i}].text`, { maxChars: MAX_HANDOFF_FIELD_CHARS });
    assertId(v.evidenceId, `${label}.verifiedResults[${i}].evidenceId`);
  });
  assertStringArray(handoff.unresolved, `${label}.unresolved`, { maxLength: MAX_HANDOFF_LIST_ITEMS, itemMaxChars: MAX_HANDOFF_FIELD_CHARS });
  assertStringArray(handoff.risks, `${label}.risks`, { maxLength: MAX_HANDOFF_LIST_ITEMS, itemMaxChars: MAX_HANDOFF_FIELD_CHARS });
  assertString(handoff.suggestedNextAction, `${label}.suggestedNextAction`, { maxChars: MAX_HANDOFF_FIELD_CHARS });
  return handoff;
}

// Validates the kind-dependent content fields shared by a persisted
// message_sent envelope and a planner-authored send_message proposal: kind
// determines whether text or handoff is required, and never both (spec
// section 6: "Do not duplicate the full handoff into text"). Does not check
// messageId/conversationId/sender-recipient/parentGoalVersion -- those are
// envelope-only (host-derived) fields, validated by validateMessageEnvelope.
function validateMessageContent(payload: PlainObject, label: string) {
  if (!isOneOf(MESSAGE_KINDS, payload.kind)) {
    throw new ContractError("unknown_enum", `${label}.kind must be one of ${MESSAGE_KINDS.join("|")}`);
  }
  assertString(payload.idempotencyKey, `${label}.idempotencyKey`, { maxChars: MAX_IDEMPOTENCY_KEY_CHARS });
  if (payload.kind === "handoff") {
    if (payload.text !== undefined) {
      throw new ContractError("invalid_field", `${label}.text must be absent for kind="handoff"`);
    }
    validateHandoff(payload.handoff, `${label}.handoff`);
  } else {
    if (payload.handoff !== undefined) {
      throw new ContractError("invalid_field", `${label}.handoff is only valid for kind="handoff"`);
    }
    assertString(payload.text, `${label}.text`, { maxBytes: MAX_MESSAGE_TEXT_BYTES });
  }
  if (payload.evidenceRefs !== undefined) {
    if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length > MAX_MESSAGE_EVIDENCE_REFS) {
      throw new ContractError("field_too_large", `${label}.evidenceRefs must be an array of at most ${MAX_MESSAGE_EVIDENCE_REFS} entries`);
    }
    payload.evidenceRefs.forEach((id: unknown, i: number) => assertId(id, `${label}.evidenceRefs[${i}]`));
  }
  if (payload.inReplyToMessageId !== undefined) {
    assertId(payload.inReplyToMessageId, `${label}.inReplyToMessageId`);
  }
}

const MESSAGE_ENVELOPE_FIELDS = Object.freeze([
  "messageId",
  "conversationId",
  "parentTaskId",
  "childTaskId",
  "senderTaskId",
  "recipientTaskId",
  "parentGoalVersion",
  "kind",
  "idempotencyKey",
  "text",
  "handoff",
  "evidenceRefs",
  "inReplyToMessageId",
]);

// Validates a message_sent journal event payload: the full, host-finalized
// envelope (spec section 6/7). Sender/recipient AUTHENTICATION (does this
// senderTaskId really own this journal, is recipientTaskId really its
// accepted child/parent) is the coordinator's job (Task 4), not this
// module's -- consistent with child_plan_accepted validating shape only.
function validateMessageEnvelope(envelope: unknown, label: string = "message") {
  assertPlainObject(envelope, label);
  assertNoUnknownKeys(envelope, MESSAGE_ENVELOPE_FIELDS, label);
  assertId(envelope.messageId, `${label}.messageId`);
  assertId(envelope.conversationId, `${label}.conversationId`);
  assertUuid(envelope.parentTaskId, `${label}.parentTaskId`);
  assertUuid(envelope.childTaskId, `${label}.childTaskId`);
  assertUuid(envelope.senderTaskId, `${label}.senderTaskId`);
  assertUuid(envelope.recipientTaskId, `${label}.recipientTaskId`);
  assertPositiveInteger(envelope.parentGoalVersion, `${label}.parentGoalVersion`);
  validateMessageContent(envelope, label);
  return envelope;
}

const MESSAGE_TURN_CONSUMED_FIELDS = Object.freeze(["consumedMessageIds", "observedAtPlannerCall"]);

const JOURNAL_EVENT_FIELDS = ["seq", "eventId", "taskId", "goalVersion", "type", "payload", "at"];

function validateJournalEvent(event: unknown, label: string = "event") {
  assertPlainObject(event, label);
  assertNoUnknownKeys(event, JOURNAL_EVENT_FIELDS, label);
  assertNonNegativeInteger(event.seq, `${label}.seq`);
  assertUuid(event.eventId, `${label}.eventId`);
  assertUuid(event.taskId, `${label}.taskId`);
  assertPositiveInteger(event.goalVersion, `${label}.goalVersion`);
  if (!isOneOf(EVENT_TYPES, event.type)) {
    throw new ContractError("unknown_enum", `${label}.type must be one of ${EVENT_TYPES.join("|")}`);
  }
  assertPlainObject(event.payload, `${label}.payload`);
  if (event.type === "action_started" || event.type === "action_outcome") {
    assertId(event.payload.actionId, `${label}.payload.actionId`);
  }
  if (event.type === "goal_created") {
    (require("./task-profile-contracts") as typeof import("./task-profile-contracts")).validateProfileRequiredGoalCreatedPayload(event.payload);
  }
  if (event.type === "task_profile_selected") {
    (require("./task-profile-contracts") as typeof import("./task-profile-contracts")).validateTaskProfileSelectedPayload(event.payload);
  }
  if (event.type === "evidence_recorded") {
    validateEvidence(event.payload.evidence, `${label}.payload.evidence`);
  }
  if (event.type === "note" && typeof event.payload.kind === "string" && event.payload.kind.startsWith("mcp_call_")) {
    validateMcpCallNote(event.payload, `${label}.payload`);
  }
  if (event.type === "approval_cancelled") {
    assertUuid(event.payload.requestId, `${label}.payload.requestId`);
    assertString(event.payload.actionType, `${label}.payload.actionType`);
    assertPositiveInteger(event.payload.goalVersion, `${label}.payload.goalVersion`);
    assertString(event.payload.reason, `${label}.payload.reason`);
  }
  if (isOneOf(["routine_step_advanced", "routine_step_denied", "routine_step_failed"], event.type)) {
    const payload = event.payload;
    const commonFields = ["routineId", "revision", "stepIndex", "stepDigest"];
    const allowedFields = event.type === "routine_step_advanced"
      ? [...commonFields, "actionId"]
      : event.type === "routine_step_denied"
        ? [...commonFields, "decision", "reasons"]
        : [...commonFields, "actionId", "status", "errorCode"];
    assertNoUnknownKeys(payload, allowedFields, `${label}.payload`);
    assertId(payload.routineId, `${label}.payload.routineId`);
    assertPositiveInteger(payload.revision, `${label}.payload.revision`);
    assertNonNegativeInteger(payload.stepIndex, `${label}.payload.stepIndex`);
    assertString(payload.stepDigest, `${label}.payload.stepDigest`, { maxChars: 64 });
    if (!/^[0-9a-f]{64}$/.test(payload.stepDigest)) {
      throw new ContractError("invalid_field", `${label}.payload.stepDigest must be a lowercase SHA-256 digest`);
    }
    if (event.type !== "routine_step_denied") {
      assertId(payload.actionId, `${label}.payload.actionId`);
    }
    if (event.type === "routine_step_denied") {
      if (!isOneOf(["deny", "quarantine"], payload.decision)) {
        throw new ContractError("unknown_enum", `${label}.payload.decision must be deny or quarantine`);
      }
      assertStringArray(payload.reasons, `${label}.payload.reasons`, { maxLength: 16, itemMaxChars: 256 });
    }
    if (event.type === "routine_step_failed") {
      if (!isOneOf(["failed", "cancelled"], payload.status)) {
        throw new ContractError("unknown_enum", `${label}.payload.status must be failed or cancelled`);
      }
      if (payload.errorCode !== undefined) {
        assertString(payload.errorCode, `${label}.payload.errorCode`, { maxChars: 128 });
      }
    }
  }
  // child_plan_accepted/cancelled (Task 3): host-authored record of a parent
  // task's child plan. planId/childId/assignments are always host-minted --
  // never accepted verbatim from planner output -- so this validates SHAPE
  // (the coordinator is the one place that decides the actual values).
  if (event.type === "child_plan_accepted") {
    assertId(event.payload.planId, `${label}.payload.planId`);
    assertPositiveInteger(event.payload.parentGoalVersion, `${label}.payload.parentGoalVersion`);
    assertPositiveInteger(event.payload.requestedAgentCount, `${label}.payload.requestedAgentCount`);
    if (!isOneOf(MEMORY_POLICIES, event.payload.memoryPolicy)) {
      throw new ContractError("unknown_enum", `${label}.payload.memoryPolicy must be one of ${MEMORY_POLICIES.join("|")}`);
    }
    assertString(event.payload.actor, `${label}.payload.actor`);
    if (!Array.isArray(event.payload.assignments) || event.payload.assignments.length !== event.payload.requestedAgentCount) {
      throw new ContractError("invalid_field", `${label}.payload.assignments must match requestedAgentCount`);
    }
    event.payload.assignments.forEach((a, i) => {
      assertPlainObject(a, `${label}.payload.assignments[${i}]`);
      assertUuid(a.childId, `${label}.payload.assignments[${i}].childId`);
      assertString(a.subgoal, `${label}.payload.assignments[${i}].subgoal`, { maxBytes: MAX_CHILD_SUBGOAL_BYTES });
      assertString(a.entryUrl, `${label}.payload.assignments[${i}].entryUrl`, { maxChars: MAX_ENTRY_URL_CHARS });
      assertString(a.origin, `${label}.payload.assignments[${i}].origin`);
    });
  }
  if (event.type === "child_plan_cancelled") {
    assertId(event.payload.planId, `${label}.payload.planId`);
    assertString(event.payload.reason, `${label}.payload.reason`, { maxChars: 2000 });
  }
  // child_result_verified (Task 4): host-authored record that the PARENT
  // itself read a child's own durable checkpoint/evidence and confirmed it --
  // never a copy of the child's self-report. verifiedCriteria always cites
  // real evidenceIds the parent independently found in the child's own
  // journal (ChildAgentCoordinator.verifyChildResult); this event type exists
  // so that citation itself is durable and replayable, not just an in-memory
  // side effect of verification.
  if (event.type === "child_result_verified") {
    assertUuid(event.payload.childId, `${label}.payload.childId`);
    assertId(event.payload.planId, `${label}.payload.planId`);
    assertPositiveInteger(event.payload.childCheckpointGoalVersion, `${label}.payload.childCheckpointGoalVersion`);
    if (!Array.isArray(event.payload.verifiedCriteria) || event.payload.verifiedCriteria.length === 0) {
      throw new ContractError("invalid_field", `${label}.payload.verifiedCriteria must be a non-empty array`);
    }
    event.payload.verifiedCriteria.forEach((v, i) => {
      assertPlainObject(v, `${label}.payload.verifiedCriteria[${i}]`);
      assertId(v.criterionId, `${label}.payload.verifiedCriteria[${i}].criterionId`);
      assertId(v.evidenceId, `${label}.payload.verifiedCriteria[${i}].evidenceId`);
    });
  }
  // message_sent/message_turn_consumed (subagent communication protocol
  // Task 1): the sender's own journal stores message_sent; the recipient's
  // own journal stores message_turn_consumed. Neither event type implies
  // anything about which task this journal belongs to -- that cross-check
  // is the coordinator's job (Task 4).
  if (event.type === "message_sent") {
    validateMessageEnvelope(event.payload, `${label}.payload`);
  }
  if (event.type === "message_turn_consumed") {
    assertNoUnknownKeys(event.payload, MESSAGE_TURN_CONSUMED_FIELDS, `${label}.payload`);
    if (!Array.isArray(event.payload.consumedMessageIds) || event.payload.consumedMessageIds.length === 0) {
      throw new ContractError("invalid_field", `${label}.payload.consumedMessageIds must be a non-empty array`);
    }
    if (event.payload.consumedMessageIds.length > MAX_MESSAGES_PER_TURN) {
      throw new ContractError(
        "field_too_large",
        `${label}.payload.consumedMessageIds exceeds the ${MAX_MESSAGES_PER_TURN}-item per-turn bound`,
      );
    }
    const seenConsumedIds = new Set();
    event.payload.consumedMessageIds.forEach((id, i) => {
      assertId(id, `${label}.payload.consumedMessageIds[${i}]`);
      if (seenConsumedIds.has(id)) {
        throw new ContractError("invalid_field", `${label}.payload.consumedMessageIds has a duplicate entry`);
      }
      seenConsumedIds.add(id);
    });
    if (event.payload.observedAtPlannerCall !== undefined) {
      assertNonNegativeInteger(event.payload.observedAtPlannerCall, `${label}.payload.observedAtPlannerCall`);
    }
  }
  assertIsoTimestamp(event.at, `${label}.at`);
  const size = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (size > MAX_EVENT_BYTES) {
    throw new ContractError("event_too_large", `${label} is ${size} bytes, exceeds ${MAX_EVENT_BYTES}`);
  }
  return event;
}

// Generic MCP calls (docs/superpowers/specs/2026-09-30-generic-mcp-broker-design.md).
// A proposal names a connector tool and its arguments only; approvals are
// minted by the host after human review, never carried in a proposal.
const MCP_CALL_ACTION_TYPE = "mcp_call";
const MAX_MCP_ARGUMENT_BYTES = 16 * 1024;
const MAX_MCP_NAME_CHARS = 256;
const MCP_PROPOSAL_FIELDS = ["connectionId", "toolName", "arguments"];
const MCP_CALL_STARTED_FIELDS = [
  "kind", "requestId", "connectionId", "provider", "server", "generation",
  "toolName", "connectorId", "schemaDigest", "argsDigest", "contextDigest",
];
const MCP_CALL_OUTCOME_FIELDS = ["kind", "requestId", "outcome", "resultDigest"];
const MCP_CALL_OUTCOMES = Object.freeze(["ok", "tool_error", "not_dispatched", "uncertain_acknowledged"]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function assertSha256Hex(value: unknown, label: string) {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    throw new ContractError("invalid_field", `${label} must be a lowercase SHA-256 digest`);
  }
}

function validateMcpProposal(proposal: unknown, label: string = "mcpProposal") {
  assertPlainObject(proposal, label);
  assertNoUnknownKeys(proposal, MCP_PROPOSAL_FIELDS, label);
  assertString(proposal.connectionId, `${label}.connectionId`, { maxChars: MAX_MCP_NAME_CHARS });
  assertString(proposal.toolName, `${label}.toolName`, { maxChars: MAX_MCP_NAME_CHARS });
  assertPlainObject(proposal.arguments, `${label}.arguments`);
  let json;
  try {
    json = JSON.stringify(proposal.arguments);
  } catch {
    throw new ContractError("invalid_field", `${label}.arguments must be JSON-serializable`);
  }
  if (Buffer.byteLength(json, "utf8") > MAX_MCP_ARGUMENT_BYTES) {
    throw new ContractError("field_too_large", `${label}.arguments exceeds ${MAX_MCP_ARGUMENT_BYTES} bytes`);
  }
  return { connectionId: proposal.connectionId, toolName: proposal.toolName, arguments: JSON.parse(json) };
}

// Journal notes for MCP calls carry identities and digests only: never the
// arguments, the connector's raw result, or any credential.
function validateMcpCallNote(payload: PlainObject, label: string) {
  if (payload.kind === "mcp_call_started") {
    assertNoUnknownKeys(payload, MCP_CALL_STARTED_FIELDS, label);
    assertUuid(payload.requestId, `${label}.requestId`);
    assertString(payload.connectionId, `${label}.connectionId`, { maxChars: MAX_MCP_NAME_CHARS });
    assertId(payload.provider, `${label}.provider`);
    assertString(payload.server, `${label}.server`, { maxChars: MAX_MCP_NAME_CHARS });
    assertNonNegativeInteger(payload.generation, `${label}.generation`);
    assertString(payload.toolName, `${label}.toolName`, { maxChars: MAX_MCP_NAME_CHARS });
    if (payload.connectorId !== null) assertString(payload.connectorId, `${label}.connectorId`, { maxChars: MAX_MCP_NAME_CHARS });
    assertSha256Hex(payload.schemaDigest, `${label}.schemaDigest`);
    assertSha256Hex(payload.argsDigest, `${label}.argsDigest`);
    assertSha256Hex(payload.contextDigest, `${label}.contextDigest`);
  } else if (payload.kind === "mcp_call_outcome") {
    assertNoUnknownKeys(payload, MCP_CALL_OUTCOME_FIELDS, label);
    assertUuid(payload.requestId, `${label}.requestId`);
    if (!isOneOf(MCP_CALL_OUTCOMES, payload.outcome)) {
      throw new ContractError("unknown_enum", `${label}.outcome must be one of ${MCP_CALL_OUTCOMES.join("|")}`);
    }
    if (payload.outcome === "ok" || payload.outcome === "tool_error") assertSha256Hex(payload.resultDigest, `${label}.resultDigest`);
    else if (payload.resultDigest !== null) throw new ContractError("invalid_field", `${label}.resultDigest must be null`);
  } else {
    throw new ContractError("unknown_enum", `${label}.kind is not a known MCP note kind`);
  }
  return payload;
}

const CHECKPOINT_FIELDS = ["seq", "taskId", "goalVersion", "payload", "at"];

function validateCheckpointEnvelope(envelope: unknown, label: string = "checkpoint") {
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

const EVIDENCE_FIELDS = [
  "id",
  "taskId",
  "goalVersion",
  "criterionId",
  "kind",
  "observationId",
  "sourceUrl",
  "artifactHash",
  "at",
  "verification",
  "verifierId",
  "details",
];

function validateEvidence(evidence: unknown, label: string = "evidence") {
  assertPlainObject(evidence, label);
  assertNoUnknownKeys(evidence, EVIDENCE_FIELDS, label);
  assertId(evidence.id, `${label}.id`);
  assertUuid(evidence.taskId, `${label}.taskId`);
  assertPositiveInteger(evidence.goalVersion, `${label}.goalVersion`);
  assertId(evidence.criterionId, `${label}.criterionId`);
  if (!isOneOf(EVIDENCE_KINDS, evidence.kind)) {
    throw new ContractError("unknown_enum", `${label}.kind must be one of ${EVIDENCE_KINDS.join("|")}`);
  }
  if (evidence.observationId !== undefined && evidence.observationId !== null) {
    assertString(evidence.observationId, `${label}.observationId`, { maxChars: 128 });
  }
  if (evidence.sourceUrl !== undefined && evidence.sourceUrl !== null) {
    assertString(evidence.sourceUrl, `${label}.sourceUrl`, { maxChars: 2048 });
  }
  if (evidence.artifactHash !== undefined && evidence.artifactHash !== null) {
    assertString(evidence.artifactHash, `${label}.artifactHash`, { maxChars: 256 });
  }
  assertIsoTimestamp(evidence.at, `${label}.at`);
  if (!isOneOf(EVIDENCE_VERIFICATION_STATES, evidence.verification)) {
    throw new ContractError("unknown_enum", `${label}.verification must be one of ${EVIDENCE_VERIFICATION_STATES.join("|")}`);
  }
  if (evidence.verification === "pending") {
    if (evidence.verifierId !== undefined && evidence.verifierId !== null) {
      throw new ContractError("invalid_field", `${label}.verifierId must be absent while verification is pending`);
    }
  } else {
    assertString(evidence.verifierId, `${label}.verifierId`);
  }
  if (evidence.details !== undefined && evidence.details !== null) {
    assertPlainObject(evidence.details, `${label}.details`);
  }
  return evidence;
}

// Derives the normalized origin (scheme + lowercased/punycode host + only a
// non-default port) HALO uses for same-origin-vs-concurrent decisions
// (Task 4), rejecting anything that is not an exact, credential-free
// HTTP(S) URL -- an entry URL is where the host performs the child's initial
// navigation itself, never a value dispatched to page/model-controlled code.
function deriveOrigin(urlString: string, label: string = "entryUrl") {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ContractError("invalid_field", `${label} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContractError("invalid_field", `${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ContractError("invalid_field", `${label} must not contain embedded credentials`);
  }
  return parsed.origin;
}

function validateChildAssignment(assignment: unknown, label: string) {
  assertPlainObject(assignment, label);
  assertNoUnknownKeys(assignment, ["subgoal", "entryUrl"], label);
  assertString(assignment.subgoal, `${label}.subgoal`, { maxBytes: MAX_CHILD_SUBGOAL_BYTES });
  assertString(assignment.entryUrl, `${label}.entryUrl`, { maxChars: MAX_ENTRY_URL_CHARS });
  deriveOrigin(assignment.entryUrl, `${label}.entryUrl`);
  return assignment;
}

// Proposal is the Planner->host wire message (section 6). Only the envelope
// shape is validated here; per-action-type payloads (navigate/follow_link/
// scroll/observe) are the browser adapter's concern (Task 4). `child_plan`
// (Task 3) is a parent-only kind -- rejecting it from a child planner's own
// transport is planner-stdio.js's job (it knows which role it is), since
// this function has no notion of parent/child.
const ALLOWED_PROPOSAL_MAX_ACTIONS = Object.freeze([MAX_ACTIONS_PER_PROPOSAL, MAX_ACTIONS_PER_PROPOSAL_SHORT]);

function validateProposalEnvelope(proposal: unknown, label: string = "proposal", { maxActions }: { maxActions?: unknown } = {}) {
  // The typeof guard only makes explicit what includes() already implied:
  // the list holds numbers, so no non-number was ever accepted.
  if (maxActions !== undefined && (typeof maxActions !== "number" || !ALLOWED_PROPOSAL_MAX_ACTIONS.includes(maxActions))) {
    throw new ContractError("invalid_field", `${label} maxActions override must be one of the pre-reviewed bounds`);
  }
  const actionsLimit = maxActions !== undefined ? maxActions : MAX_ACTIONS_PER_PROPOSAL;
  assertPlainObject(proposal, label);
  assertNoUnknownKeys(
    proposal,
    [
      "taskId",
      "goalVersion",
      "basedOnObservationId",
      "criterionIds",
      "kind",
      "actions",
      "reason",
      "evidenceIds",
      ...CHILD_PLAN_FIELDS,
      ...SEND_MESSAGE_FIELDS,
    ],
    label,
  );
  assertUuid(proposal.taskId, `${label}.taskId`);
  assertPositiveInteger(proposal.goalVersion, `${label}.goalVersion`);
  assertString(proposal.basedOnObservationId, `${label}.basedOnObservationId`, { maxChars: 128 });
  assertStringArray(proposal.criterionIds, `${label}.criterionIds`, { maxLength: MAX_CRITERIA_COUNT });
  if (!isOneOf(PROPOSAL_KINDS, proposal.kind)) {
    throw new ContractError("unknown_enum", `${label}.kind must be one of ${PROPOSAL_KINDS.join("|")}`);
  }

  const disallow = (fields: ReadonlyArray<string>) => {
    for (const f of fields) {
      if (proposal[f] !== undefined) throw new ContractError("invalid_shape", `${label} kind=${proposal.kind} must not include "${f}"`);
    }
  };

  if (proposal.kind === "finish") {
    assertStringArray(proposal.evidenceIds, `${label}.evidenceIds`);
    disallow(["actions", "reason", ...CHILD_PLAN_FIELDS, ...SEND_MESSAGE_FIELDS]);
  } else if (proposal.kind === "replan" || proposal.kind === "need_user") {
    assertString(proposal.reason, `${label}.reason`, { maxChars: 2000 });
    disallow(["actions", "evidenceIds", ...CHILD_PLAN_FIELDS, ...SEND_MESSAGE_FIELDS]);
  } else if (proposal.kind === "child_plan") {
    assertPositiveInteger(proposal.parentGoalVersion, `${label}.parentGoalVersion`);
    assertPositiveInteger(proposal.requestedAgentCount, `${label}.requestedAgentCount`);
    if (!Array.isArray(proposal.assignments) || proposal.assignments.length === 0) {
      throw new ContractError("invalid_field", `${label}.assignments must be a non-empty array`);
    }
    if (proposal.assignments.length > MAX_CHILD_ASSIGNMENTS) {
      throw new ContractError("field_too_large", `${label}.assignments exceeds the ${MAX_CHILD_ASSIGNMENTS}-item bound`);
    }
    if (proposal.requestedAgentCount !== proposal.assignments.length) {
      throw new ContractError("invalid_field", `${label}.requestedAgentCount must equal assignments.length`);
    }
    proposal.assignments.forEach((a, i) => validateChildAssignment(a, `${label}.assignments[${i}]`));
    disallow(["actions", "reason", "evidenceIds", ...SEND_MESSAGE_FIELDS]);
  } else if (proposal.kind === "send_message") {
    assertUuid(proposal.recipientTaskId, `${label}.recipientTaskId`);
    validateMessageContent(
      {
        kind: proposal.messageKind,
        idempotencyKey: proposal.idempotencyKey,
        text: proposal.text,
        handoff: proposal.handoff,
        evidenceRefs: proposal.evidenceRefs,
        inReplyToMessageId: proposal.inReplyToMessageId,
      },
      label,
    );
    disallow(["actions", "reason", "evidenceIds", ...CHILD_PLAN_FIELDS]);
  } else {
    // kind === "actions"
    if (!Array.isArray(proposal.actions) || proposal.actions.length === 0) {
      throw new ContractError("invalid_field", `${label}.actions must be a non-empty array`);
    }
    if (proposal.actions.length > actionsLimit) {
      throw new ContractError("field_too_large", `${label}.actions exceeds the ${actionsLimit}-item batch limit`);
    }
    proposal.actions.forEach((a, i) => assertPlainObject(a, `${label}.actions[${i}]`));
    disallow(["reason", "evidenceIds", ...CHILD_PLAN_FIELDS, ...SEND_MESSAGE_FIELDS]);
  }
  return proposal;
}

export = {
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
  MAX_CONTEXT_PACKET_BYTES,
  MAX_RECENT_EVENTS_IN_CONTEXT,
  MAX_ACTIONS_PER_PROPOSAL,
  MAX_ACTIONS_PER_PROPOSAL_SHORT,
  MAX_CHILD_ASSIGNMENTS,
  MAX_CHILD_SUBGOAL_BYTES,
  MAX_ENTRY_URL_CHARS,
  MEMORY_POLICIES,
  MESSAGE_KINDS,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_IDEMPOTENCY_KEY_CHARS,
  MAX_MESSAGE_EVIDENCE_REFS,
  MAX_HANDOFF_FIELD_CHARS,
  MAX_HANDOFF_LIST_ITEMS,
  MAX_MESSAGES_PER_TURN,
  MAX_MESSAGE_TURN_CONTEXT_BYTES,
  MAX_PENDING_MESSAGES_PER_CONVERSATION,
  MAX_UNOBSERVED_STEER_PER_CHILD,
  MAX_STEER_PER_CHILD_PER_WINDOW,
  STEER_RATE_WINDOW_MS,
  MAX_MESSAGE_PREVIEW_CHARS,
  SEND_MESSAGE_FIELDS,
  MESSAGE_ENVELOPE_FIELDS,
  MESSAGE_TURN_CONSUMED_FIELDS,
  MAX_PLANNER_FRAME_BYTES,
  PLANNER_RESPONSE_TIMEOUT_MS,
  APPROVAL_EXPIRY_MS,
  SEGMENT_ROTATION_CALLS,
  NO_PROGRESS_REPLAN_THRESHOLD,
  DEFAULT_LIMITS,
  DEFAULT_CRITERION_C1,
  EVENT_TYPES,
  VERIFICATION_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_VERIFICATION_STATES,
  PROPOSAL_KINDS,
  ContractError,
  isPlainObject,
  assertUuid,
  assertId,
  normalizeGoalSpec,
  validateGoalSpec,
  validateGoalTrigger,
  applyAmendment,
  validateJournalEvent,
  validateCheckpointEnvelope,
  validateEvidence,
  validateProposalEnvelope,
  validateChildAssignment,
  validateHandoff,
  validateMessageContent,
  validateMessageEnvelope,
  deriveOrigin,
  MCP_CALL_ACTION_TYPE,
  MAX_MCP_ARGUMENT_BYTES,
  MCP_CALL_OUTCOMES,
  validateMcpProposal,
  validateMcpCallNote,
};
