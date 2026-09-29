"use strict";

// Shared schema for locally saved HALO routine definitions. See
// docs/superpowers/specs/2026-09-28-routine-execution-design.md ("Data
// model") for the field list and bounds this module enforces, and
// docs/superpowers/plans/2026-09-29-routine-execution.md (Task 1) for the
// exported interface this file must provide.
//
// This module is intentionally self-contained (it does not require
// ../shared/harness-contracts.js) even though that file already has a
// similar assert-helper/ContractError pattern: harness-contracts.js is
// owned by a later task in the same plan and is being edited concurrently
// in this shared checkout, so routine-contracts.js does not take a runtime
// dependency on its current shape.

const crypto = require("node:crypto");

const SCHEMA_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

// V1 step kinds only (design spec: "assert_text is deferred until its
// durable completion semantics are defined"; no free-form code/shell field).
const ROUTINE_STEP_KINDS = Object.freeze(["navigate", "follow_link", "scroll"]);
const SCROLL_DIRECTIONS = Object.freeze(["up", "down"]);

const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_STEPS = 64;
const MAX_URL_CHARS = 2048;
const MAX_NAME_CHARS = 256; // routine name and step accessible name share this bound
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_ORIGINS = 32;
const MAX_SCROLL_AMOUNT = 20000;

const ROUTINE_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "routineId",
  "revision",
  "name",
  "description",
  "origins",
  "steps",
  "createdAt",
  "updatedAt",
  "digest",
]);

const NAVIGATE_STEP_FIELDS = Object.freeze(["kind", "url"]);
const FOLLOW_LINK_STEP_FIELDS = Object.freeze(["kind", "name", "expectedHref"]);
const SCROLL_STEP_FIELDS = Object.freeze(["kind", "direction", "amount"]);

class RoutineContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoutineContractError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new RoutineContractError("invalid_shape", `${label} must be a plain object`);
}

function assertNoUnknownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new RoutineContractError("unknown_field", `${label} has unknown field "${key}"`);
    }
  }
}

function assertString(value, label, { maxChars, allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new RoutineContractError("invalid_field", `${label} must be a string`);
  if (!allowEmpty && value.length === 0) throw new RoutineContractError("invalid_field", `${label} must not be empty`);
  if (typeof maxChars === "number" && value.length > maxChars) {
    throw new RoutineContractError("field_too_large", `${label} exceeds ${maxChars} characters`);
  }
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new RoutineContractError("invalid_id", `${label} must be a UUID`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RoutineContractError("invalid_field", `${label} must be a positive integer`);
  }
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string") throw new RoutineContractError("invalid_field", `${label} must be an ISO timestamp string`);
  if (Number.isNaN(Date.parse(value))) throw new RoutineContractError("invalid_field", `${label} must be an ISO timestamp`);
}

// The exact-origin allowlist entries and every in-allowlist URL check below
// share this: parse, require http(s), forbid embedded credentials, and
// compare against URL#origin's own normalization (scheme+host+port, no
// trailing slash) so "https://example.com/" is rejected as non-canonical.
function parseHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RoutineContractError("invalid_field", `${label} must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RoutineContractError("invalid_field", `${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new RoutineContractError("invalid_field", `${label} must not contain embedded credentials`);
  }
  return url;
}

function normalizeOrigin(value, label) {
  return parseHttpUrl(value, label).origin;
}

function validateOrigins(origins, label) {
  if (!Array.isArray(origins)) throw new RoutineContractError("invalid_field", `${label} must be an array`);
  if (origins.length === 0) throw new RoutineContractError("invalid_field", `${label} must not be empty`);
  if (origins.length > MAX_ORIGINS) {
    throw new RoutineContractError("field_too_large", `${label} exceeds ${MAX_ORIGINS} entries`);
  }
  const seen = new Set();
  return origins.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    if (typeof entry !== "string") throw new RoutineContractError("invalid_field", `${itemLabel} must be a string`);
    const origin = normalizeOrigin(entry, itemLabel);
    if (origin !== entry) {
      throw new RoutineContractError("invalid_origin", `${itemLabel} must be an exact normalized origin ("${origin}")`);
    }
    if (seen.has(origin)) throw new RoutineContractError("duplicate_origin", `${itemLabel} duplicates an earlier origin`);
    seen.add(origin);
    return origin;
  });
}

function assertUrlWithinOrigins(url, origins, label) {
  if (!origins.includes(url.origin)) {
    throw new RoutineContractError("origin_not_allowed", `${label} origin "${url.origin}" is not in the routine's origin allowlist`);
  }
}

function validateBoundedUrl(value, label, origins) {
  assertString(value, label, { maxChars: MAX_URL_CHARS });
  const url = parseHttpUrl(value, label);
  assertUrlWithinOrigins(url, origins, label);
  return value;
}

function validateStep(step, label, origins) {
  assertPlainObject(step, label);
  if (typeof step.kind !== "string" || !ROUTINE_STEP_KINDS.includes(step.kind)) {
    throw new RoutineContractError("unknown_step_kind", `${label}.kind must be one of ${ROUTINE_STEP_KINDS.join("|")}`);
  }

  if (step.kind === "navigate") {
    assertNoUnknownKeys(step, NAVIGATE_STEP_FIELDS, label);
    const url = validateBoundedUrl(step.url, `${label}.url`, origins);
    return { kind: "navigate", url };
  }

  if (step.kind === "follow_link") {
    assertNoUnknownKeys(step, FOLLOW_LINK_STEP_FIELDS, label);
    assertString(step.name, `${label}.name`, { maxChars: MAX_NAME_CHARS });
    if (step.expectedHref === undefined) {
      return { kind: "follow_link", name: step.name };
    }
    const expectedHref = validateBoundedUrl(step.expectedHref, `${label}.expectedHref`, origins);
    return { kind: "follow_link", name: step.name, expectedHref };
  }

  // scroll
  assertNoUnknownKeys(step, SCROLL_STEP_FIELDS, label);
  if (typeof step.direction !== "string" || !SCROLL_DIRECTIONS.includes(step.direction)) {
    throw new RoutineContractError("invalid_field", `${label}.direction must be one of ${SCROLL_DIRECTIONS.join("|")}`);
  }
  if (step.amount === undefined) {
    return { kind: "scroll", direction: step.direction };
  }
  if (!Number.isInteger(step.amount) || step.amount < 1 || step.amount > MAX_SCROLL_AMOUNT) {
    throw new RoutineContractError("invalid_field", `${label}.amount must be an integer between 1 and ${MAX_SCROLL_AMOUNT}`);
  }
  return { kind: "scroll", direction: step.direction, amount: step.amount };
}

function validateSteps(steps, label, origins) {
  if (!Array.isArray(steps)) throw new RoutineContractError("invalid_field", `${label} must be an array`);
  if (steps.length === 0) throw new RoutineContractError("invalid_field", `${label} must not be empty`);
  if (steps.length > MAX_STEPS) {
    throw new RoutineContractError("field_too_large", `${label} exceeds ${MAX_STEPS} entries`);
  }
  return steps.map((step, index) => validateStep(step, `${label}[${index}]`, origins));
}

// Validates a fully-formed RoutineDefinition exactly as it is stored on disk
// (used both when RoutineStore assembles a new revision and when it re-reads
// one), mirroring shared/harness-contracts.js's validateGoalSpec: the sole
// schema gate for both write and read paths, so a hand-edited or corrupt
// file is rejected identically either time. routineId/revision/timestamps/
// digest are storage metadata the caller (RoutineStore) assigns -- this
// function only checks their shape, never derives them.
function validateRoutineDefinition(input, label = "routine") {
  assertPlainObject(input, label);
  assertNoUnknownKeys(input, ROUTINE_DEFINITION_FIELDS, label);

  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new RoutineContractError("unknown_version", `${label}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  assertUuid(input.routineId, `${label}.routineId`);
  assertPositiveInteger(input.revision, `${label}.revision`);
  assertString(input.name, `${label}.name`, { maxChars: MAX_NAME_CHARS });
  assertString(input.description, `${label}.description`, { maxChars: MAX_DESCRIPTION_CHARS, allowEmpty: true });
  const origins = validateOrigins(input.origins, `${label}.origins`);
  const steps = validateSteps(input.steps, `${label}.steps`, origins);
  assertIsoTimestamp(input.createdAt, `${label}.createdAt`);
  assertIsoTimestamp(input.updatedAt, `${label}.updatedAt`);
  if (typeof input.digest !== "string" || !DIGEST_RE.test(input.digest)) {
    throw new RoutineContractError("invalid_field", `${label}.digest must be a 64-character lowercase hex sha256 digest`);
  }

  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    routineId: input.routineId,
    revision: input.revision,
    name: input.name,
    description: input.description,
    origins,
    steps,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    digest: input.digest,
  };

  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_SERIALIZED_BYTES) {
    throw new RoutineContractError("definition_too_large", `${label} exceeds ${MAX_SERIALIZED_BYTES} serialized bytes`);
  }

  return normalized;
}

// The content digest the design spec calls for ("a content digest for
// corruption detection"). Deliberately covers only caller-controlled content
// (name/description/origins/steps), never routineId/revision/timestamps --
// those are storage metadata that RoutineStore verifies separately (a
// revision file's routineId/revision are checked against the path it was
// read from), not part of "did this definition's content get corrupted".
function computeContentDigest({ name, description, origins, steps }) {
  const canonical = JSON.stringify({ name, description, origins, steps });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

module.exports = {
  SCHEMA_VERSION,
  UUID_RE,
  DIGEST_RE,
  ROUTINE_STEP_KINDS,
  SCROLL_DIRECTIONS,
  MAX_SERIALIZED_BYTES,
  MAX_STEPS,
  MAX_URL_CHARS,
  MAX_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_ORIGINS,
  MAX_SCROLL_AMOUNT,
  ROUTINE_DEFINITION_FIELDS,
  RoutineContractError,
  isPlainObject,
  normalizeOrigin,
  validateRoutineDefinition,
  computeContentDigest,
};
