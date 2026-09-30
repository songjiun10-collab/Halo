"use strict";

// Schema and due-time evaluation for HALO routine schedules. See
// docs/superpowers/specs/2026-09-29-routine-scheduler-design.md.
// Pure module: no I/O and no clock reads (callers pass `nowMs`).

const { UUID_RE, isPlainObject } = require("./routine-contracts");

const SCHEMA_VERSION = 1;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
const ONCE_GRACE_MS = 60 * 60 * 1000;
const OVERLAP_POLICIES = Object.freeze(["skip", "queue"]);
const MAX_ERROR_CHARS = 500;

const INPUT_FIELDS = ["routineId", "revision", "trigger", "overlap", "enabled"];
const RECORD_FIELDS = [
  "schemaVersion", "scheduleId", "routineId", "revision", "enabled", "disabledReason", "trigger", "overlap",
  "createdAt", "updatedAt", "lastOccurrenceAt", "lastTaskId", "lastError", "consecutiveFailures", "skippedCount", "nextRunAt",
];

class ScheduleContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScheduleContractError(code, message);
}

function parseIso(value, label) {
  if (typeof value !== "string") fail("invalid_time", `${label} must be an ISO-8601 string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    fail("invalid_time", `${label} must be a canonical ISO-8601 UTC timestamp (toISOString form)`);
  }
  return ms;
}

function checkExactFields(value, allowed, label) {
  if (!isPlainObject(value)) fail("invalid_shape", `${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("unknown_field", `${label} has unknown field ${JSON.stringify(key)}`);
  }
}

function validateTrigger(trigger) {
  if (!isPlainObject(trigger)) fail("invalid_shape", "trigger must be a plain object");
  if (trigger.kind === "once") {
    checkExactFields(trigger, ["kind", "at"], "trigger");
    parseIso(trigger.at, "trigger.at");
    return { kind: "once", at: trigger.at };
  }
  if (trigger.kind === "interval") {
    checkExactFields(trigger, ["kind", "everyMs", "anchor"], "trigger");
    if (!Number.isInteger(trigger.everyMs)) fail("invalid_interval", "trigger.everyMs must be an integer number of milliseconds");
    if (trigger.everyMs < MIN_INTERVAL_MS) fail("interval_too_short", `trigger.everyMs must be at least ${MIN_INTERVAL_MS}`);
    if (trigger.everyMs > MAX_INTERVAL_MS) fail("invalid_interval", `trigger.everyMs must be at most ${MAX_INTERVAL_MS}`);
    parseIso(trigger.anchor, "trigger.anchor");
    return { kind: "interval", everyMs: trigger.everyMs, anchor: trigger.anchor };
  }
  return fail("invalid_trigger", "trigger.kind must be once or interval");
}

function validateRoutineRef(value) {
  if (typeof value.routineId !== "string" || !UUID_RE.test(value.routineId)) fail("invalid_routine_id", "routineId must be a UUID");
  if (!Number.isInteger(value.revision) || value.revision < 1) fail("invalid_revision", "revision must be an exact positive integer");
}

function validateScheduleInput(input) {
  checkExactFields(input, INPUT_FIELDS, "schedule input");
  validateRoutineRef(input);
  const overlap = input.overlap === undefined ? "skip" : input.overlap;
  if (!OVERLAP_POLICIES.includes(overlap)) fail("invalid_overlap", "overlap must be skip or queue");
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") fail("invalid_shape", "enabled must be a boolean");
  return { routineId: input.routineId, revision: input.revision, trigger: validateTrigger(input.trigger), overlap, enabled };
}

function nullableIso(value, label) {
  if (value === null) return null;
  parseIso(value, label);
  return value;
}

function nonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) fail("invalid_shape", `${label} must be a non-negative integer`);
  return value;
}

function validateScheduleRecord(value) {
  checkExactFields(value, RECORD_FIELDS, "schedule record");
  for (const key of RECORD_FIELDS) {
    if (!(key in value)) fail("invalid_shape", `schedule record is missing ${key}`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) fail("unsupported_schema", "unsupported schedule schemaVersion");
  if (typeof value.scheduleId !== "string" || !UUID_RE.test(value.scheduleId)) fail("invalid_schedule_id", "scheduleId must be a UUID");
  validateRoutineRef(value);
  if (typeof value.enabled !== "boolean") fail("invalid_shape", "enabled must be a boolean");
  if (value.disabledReason !== null && (typeof value.disabledReason !== "string" || value.disabledReason.length > MAX_ERROR_CHARS)) {
    fail("invalid_shape", "disabledReason must be null or a short string");
  }
  if (!OVERLAP_POLICIES.includes(value.overlap)) fail("invalid_overlap", "overlap must be skip or queue");
  const trigger = validateTrigger(value.trigger);
  parseIso(value.createdAt, "createdAt");
  parseIso(value.updatedAt, "updatedAt");
  nullableIso(value.lastOccurrenceAt, "lastOccurrenceAt");
  if (value.lastTaskId !== null && typeof value.lastTaskId !== "string") fail("invalid_shape", "lastTaskId must be null or a string");
  if (value.lastError !== null && (typeof value.lastError !== "string" || value.lastError.length > MAX_ERROR_CHARS)) {
    fail("invalid_shape", "lastError must be null or a short string");
  }
  nonNegativeInt(value.consecutiveFailures, "consecutiveFailures");
  nonNegativeInt(value.skippedCount, "skippedCount");
  nullableIso(value.nextRunAt, "nextRunAt");
  return { ...value, trigger };
}

function occurrenceKey(scheduleId, occurrenceAt) {
  return `${scheduleId}@${occurrenceAt}`;
}

// Decide what a schedule needs at `nowMs`.
//   run      -> create one task for occurrenceAtMs (missed intervals coalesced
//               into the latest one); nextRunAtMs is the occurrence after it
//   missed   -> a `once` schedule too far past its time; do not run
//   finished -> a `once` schedule that already ran
//   none     -> nothing due; nextRunAtMs is when to look again
function evaluateSchedule(record, nowMs) {
  const { trigger } = record;
  const lastMs = record.lastOccurrenceAt === null ? -Infinity : Date.parse(record.lastOccurrenceAt);
  if (trigger.kind === "once") {
    const atMs = Date.parse(trigger.at);
    if (lastMs !== -Infinity) return { action: "finished", nextRunAtMs: null };
    if (nowMs < atMs) return { action: "none", nextRunAtMs: atMs };
    if (nowMs - atMs > ONCE_GRACE_MS) return { action: "missed", occurrenceAtMs: atMs, nextRunAtMs: null };
    return { action: "run", occurrenceAtMs: atMs, nextRunAtMs: null };
  }
  const anchorMs = Date.parse(trigger.anchor);
  const createdMs = Date.parse(record.createdAt);
  const every = trigger.everyMs;
  const firstMs = createdMs <= anchorMs ? anchorMs : anchorMs + Math.ceil((createdMs - anchorMs) / every) * every;
  if (nowMs < anchorMs) return { action: "none", nextRunAtMs: firstMs };
  const latestMs = anchorMs + Math.floor((nowMs - anchorMs) / every) * every;
  if (latestMs >= firstMs && latestMs > lastMs) {
    return { action: "run", occurrenceAtMs: latestMs, nextRunAtMs: latestMs + every };
  }
  return { action: "none", nextRunAtMs: Math.max(firstMs, latestMs + every) };
}

module.exports = {
  SCHEMA_VERSION,
  MIN_INTERVAL_MS,
  ONCE_GRACE_MS,
  OVERLAP_POLICIES,
  MAX_ERROR_CHARS,
  ScheduleContractError,
  validateScheduleInput,
  validateScheduleRecord,
  evaluateSchedule,
  occurrenceKey,
};
