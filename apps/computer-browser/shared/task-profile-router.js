"use strict";

// Deterministic host-side routing. This module intentionally imports only
// pure contracts and the static registry: no model, network, filesystem,
// Electron, settings, browser, or queue access is possible here.

const { MAX_ORIGINAL_REQUEST_BYTES, assertId, assertUuid, isPlainObject } = require("./harness-contracts");
const { HARNESS_PROFILES, validateHarnessProfile } = require("./harness-profile");
const { validateResolvedTaskProfile, validateTaskProfileSelectedPayload } = require("./task-profile-contracts");
const { CAPABILITY_REGISTRY_VERSION, getCapabilityProfile } = require("./capability-registry");

const CLASSIFIER_VERSION = "task-profile-router-v1";
const HORIZON_RANK = Object.freeze({ short: 0, middle: 1, long: 2 });
const DURATION_RULES = Object.freeze({
  short: Object.freeze(["quick", "brief", "short task", "빠르게", "간단히", "짧게"]),
  long: Object.freeze(["long-running", "long task", "extended task", "장기 작업", "오래 걸리는 작업"]),
});
const CAPABILITY_RULES = Object.freeze({
  research: Object.freeze(["research", "find sources", "cite sources", "compare sources", "조사해", "출처 찾아", "출처를 찾아", "근거를 인용", "자료 비교"]),
  computer_use: Object.freeze(["computer use", "use the mouse", "use the keyboard", "screenshot coordinates", "컴퓨터 유즈", "마우스로", "키보드로", "스크린샷 좌표", "좌표 클릭"]),
  multi_agent: Object.freeze(["parallel agents", "sub-agents", "delegate to agents", "병렬 에이전트", "서브 에이전트", "에이전트에게 분담"]),
});

class TaskProfileRouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskProfileRouterError";
    this.code = code;
  }
}

function fail(code, message) { throw new TaskProfileRouterError(code, message); }

function normalizeText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function containsEnglishPhrase(text, phrase) {
  const escaped = escapeRegExp(phrase);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

function matchingGroups(text, rules) {
  const matches = [];
  for (const [group, phrases] of Object.entries(rules)) {
    if (phrases.some((phrase) => {
      const normalized = normalizeText(phrase);
      return /^[\x00-\x7F]+$/.test(normalized)
        ? containsEnglishPhrase(text, normalized)
        : text.includes(normalized);
    })) matches.push(group);
  }
  return matches;
}

function getGoalText(goalInput) {
  if (!isPlainObject(goalInput) || typeof goalInput.originalRequest !== "string" || goalInput.originalRequest.trim().length === 0) {
    fail("invalid_goal", "goalInput.originalRequest must be a non-empty string");
  }
  if (Buffer.byteLength(goalInput.originalRequest, "utf8") > MAX_ORIGINAL_REQUEST_BYTES) {
    fail("invalid_goal", "goalInput.originalRequest exceeds the host request limit");
  }
  return normalizeText(goalInput.originalRequest);
}

function validateRoutineMetadata(value) {
  if (!isPlainObject(value)
      || Object.keys(value).some((key) => !["routineId", "revision", "digest", "stepCount"].includes(key))) {
    fail("invalid_routine_reference", "routineMetadata must be a host-validated pinned routine reference");
  }
  try {
    assertId(value.routineId, "routineMetadata.routineId");
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("invalid revision");
    if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) throw new Error("invalid digest");
    if (!Number.isSafeInteger(value.stepCount) || value.stepCount < 1 || value.stepCount > 64) throw new Error("invalid stepCount");
  } catch {
    fail("invalid_routine_reference", "routineMetadata does not identify a valid pinned routine revision");
  }
  return value;
}

function validateSelector(value, axis) {
  if (axis === "duration") {
    if (value === "auto") return null;
    try { return validateHarnessProfile(value); }
    catch { fail("invalid_selector", "requestedDurationProfile must be auto|short|middle|long"); }
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("invalid_selector", "requestedCapabilityProfile must be a capability ID or null");
  let entry;
  try { entry = getCapabilityProfile(value); }
  catch { fail("invalid_selector", "requestedCapabilityProfile is unknown"); }
  if (!entry.available) fail("capability_unavailable", `${value} capability is not available`);
  return value;
}

function validateParentInputs(parentProfile, parentBinding) {
  if (!parentProfile || !parentBinding) fail("invalid_parent_binding", "child profile resolution requires parentProfile and parentBinding");
  if (parentProfile.capability?.id !== "multi_agent") {
    fail("invalid_parent_profile", "child tasks require a validated Multi-agent parent profile");
  }
  let normalizedParent = parentProfile;
  try {
    if (Object.hasOwn(parentProfile, "profileSchemaVersion")) {
      validateTaskProfileSelectedPayload(parentProfile);
      normalizedParent = {
        schemaVersion: parentProfile.profileSchemaVersion,
        classifierVersion: parentProfile.classifierVersion,
        duration: {
          id: parentProfile.duration.id,
          harnessProfileVersion: parentProfile.duration.harnessProfileVersion,
          policySetId: parentProfile.duration.policySetId,
        },
        capability: parentProfile.capability,
        selection: parentProfile.selection,
      };
      if (parentProfile.parentBinding) normalizedParent.parentBinding = parentProfile.parentBinding;
    }
    validateResolvedTaskProfile(normalizedParent);
    assertUuid(parentBinding.parentTaskId, "parentBinding.parentTaskId");
    assertUuid(parentBinding.planId, "parentBinding.planId");
    assertId(String(parentBinding.parentGoalVersion), "parentBinding.parentGoalVersion");
    if (!Number.isSafeInteger(parentBinding.parentGoalVersion) || parentBinding.parentGoalVersion < 1) throw new Error("invalid parent goal version");
  } catch {
    fail("invalid_parent_binding", "parent binding or validated Multi-agent profile is malformed");
  }
  return { parentProfile: normalizedParent, parentBinding };
}

function makeCapability(id) {
  const entry = getCapabilityProfile(id);
  if (!entry.available) fail("capability_unavailable", `${id} capability is not available`);
  return {
    id: entry.id,
    registryVersion: CAPABILITY_REGISTRY_VERSION,
    dependencies: [...entry.dependencies],
    adapters: entry.adapters.map((adapter) => ({ ...adapter })),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function resolveTaskProfile({
  goalInput,
  requestedDurationProfile = "auto",
  requestedCapabilityProfile = null,
  routineMetadata = null,
  parentProfile = null,
  parentBinding = null,
} = {}) {
  const text = getGoalText(goalInput);
  const requestedDuration = validateSelector(requestedDurationProfile, "duration");
  const requestedCapability = validateSelector(requestedCapabilityProfile, "capability");
  const isChild = parentProfile !== null || parentBinding !== null;

  if (isChild && routineMetadata) fail("invalid_routine_reference", "a child task cannot claim a Routine capability");
  if (routineMetadata !== null && routineMetadata !== undefined) validateRoutineMetadata(routineMetadata);
  if (requestedCapability === "routine" && !routineMetadata) {
    fail("invalid_routine_reference", "Routine capability requires a typed, host-validated routine entrypoint");
  }
  if (routineMetadata && requestedCapability && requestedCapability !== "routine") {
    fail("conflicting_selectors", "a typed Routine entrypoint conflicts with the requested capability");
  }

  let durationId;
  let durationSelection;
  if (requestedDuration) {
    durationId = requestedDuration;
    durationSelection = { source: "explicit_user_choice" };
  } else {
    const durationMatches = matchingGroups(text, DURATION_RULES);
    if (durationMatches.length > 1) fail("ambiguous_duration", "task horizon hints conflict; choose a duration profile");
    if (durationMatches.length === 1) {
      durationId = durationMatches[0];
      durationSelection = { source: "intent_rule", ruleId: `duration-${durationId}-v1` };
    } else if (routineMetadata) {
      durationId = "short";
      durationSelection = { source: "routine_entrypoint" };
    } else {
      durationId = "middle";
      durationSelection = { source: "default" };
    }
  }

  let capabilityId;
  let capabilitySelection;
  let validatedParent = null;
  if (isChild) {
    validatedParent = validateParentInputs(parentProfile, parentBinding);
    if (requestedCapability !== null) fail("invalid_child_capability", "child capability is fixed to Browser by host policy");
    capabilityId = "browser";
    capabilitySelection = { source: "parent_plan_policy" };
  } else if (routineMetadata) {
    capabilityId = "routine";
    capabilitySelection = { source: "routine_entrypoint" };
  } else if (requestedCapability) {
    capabilityId = requestedCapability;
    capabilitySelection = { source: "explicit_user_choice" };
  } else {
    const capabilityMatches = matchingGroups(text, CAPABILITY_RULES);
    if (capabilityMatches.length > 1) fail("ambiguous_capability", "task intent matches multiple capabilities; clarify the requested route");
    if (capabilityMatches.length === 1) {
      capabilityId = capabilityMatches[0];
      capabilitySelection = { source: "intent_rule", ruleId: `capability-${capabilityId.replaceAll("_", "-")}-v1` };
    } else {
      capabilityId = "browser";
      capabilitySelection = { source: "default" };
    }
  }

  if (isChild) {
    const parentDuration = validatedParent.parentProfile.duration.id;
    if (!HARNESS_PROFILES.includes(parentDuration)) fail("invalid_parent_profile", "parent duration is not a supported horizon");
    if (HORIZON_RANK[durationId] > HORIZON_RANK[parentDuration]) {
      durationId = parentDuration;
      durationSelection = { source: "parent_plan_policy" };
    }
  }

  const profile = {
    schemaVersion: 1,
    classifierVersion: CLASSIFIER_VERSION,
    duration: { id: durationId, harnessProfileVersion: 1, policySetId: "goal-limits-v1" },
    capability: makeCapability(capabilityId),
    selection: { duration: durationSelection, capability: capabilitySelection },
    ...(validatedParent ? { parentBinding: { ...validatedParent.parentBinding } } : {}),
  };
  try { validateResolvedTaskProfile(profile); }
  catch (error) { fail(error.code || "invalid_profile", error.message); }
  return deepFreeze(profile);
}

module.exports = {
  CLASSIFIER_VERSION,
  TaskProfileRouterError,
  resolveTaskProfile,
};
