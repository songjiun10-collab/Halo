"use strict";

// Deterministic host-side routing. This module intentionally imports only
// pure contracts and the static registry: no model, network, filesystem,
// Electron, settings, browser, or queue access is possible here.

const harnessContracts = require("./harness-contracts") as typeof import("./harness-contracts");
const { MAX_ORIGINAL_REQUEST_BYTES, isPlainObject } = harnessContracts;
// Explicit annotations preserve the assertion functions' narrowing while
// retaining the same load-time bindings as the original destructuring.
const assertId: typeof harnessContracts.assertId = harnessContracts.assertId;
const assertUuid: typeof harnessContracts.assertUuid = harnessContracts.assertUuid;
const { HARNESS_PROFILES, validateHarnessProfile } = require("./harness-profile") as typeof import("./harness-profile");
const { validateResolvedTaskProfile, validateTaskProfileSelectedPayload } = require("./task-profile-contracts") as typeof import("./task-profile-contracts");
const { CAPABILITY_REGISTRY_VERSION, getCapabilityProfile } = require("./capability-registry") as typeof import("./capability-registry");

const CLASSIFIER_VERSION = "task-profile-router-v1";
const HORIZON_RANK = Object.freeze({ short: 0, fast: 0, middle: 1, long: 2 });
const DURATION_RULES = Object.freeze({
  fast: Object.freeze(["fast mode", "패스트 모드", "패스트모드"]),
  short: Object.freeze(["quick", "brief", "short task", "빠르게", "간단히", "짧게"]),
  long: Object.freeze(["long-running", "long task", "extended task", "장기 작업", "오래 걸리는 작업"]),
});
const CAPABILITY_RULES = Object.freeze({
  research: Object.freeze(["research", "find sources", "cite sources", "compare sources", "조사해", "출처 찾아", "출처를 찾아", "근거를 인용", "자료 비교", "근거 url", "신뢰할 만한 출처", "출처와 함께"]),
  computer_use: Object.freeze(["computer use", "use the mouse", "use the keyboard", "screenshot coordinates", "컴퓨터 유즈", "마우스로", "키보드로", "스크린샷 좌표", "좌표 클릭"]),
  multi_agent: Object.freeze(["parallel agents", "sub-agents", "delegate to agents", "병렬 에이전트", "서브 에이전트", "에이전트에게 분담"]),
});

type HarnessProfile = ReturnType<typeof validateHarnessProfile>;
type CapabilityId = keyof typeof CAPABILITY_RULES | "browser" | "routine" | "multi_agent_computer_use";
type SelectionSource = "explicit_user_choice" | "intent_rule" | "routine_entrypoint" | "default" | "parent_plan_policy";
type SelectionItem = { readonly source: SelectionSource, readonly ruleId?: string };
type ParentBinding = {
  readonly parentTaskId: string,
  readonly planId: string,
  readonly parentGoalVersion: number,
};
type CapabilityBinding = {
  readonly id: CapabilityId,
  readonly registryVersion: number,
  readonly dependencies: ReadonlyArray<string>,
  readonly adapters: ReadonlyArray<Readonly<{ capabilityId: string, adapterId: string, adapterVersion: number }>>,
};
type ResolvedTaskProfile = {
  readonly schemaVersion: 1,
  readonly classifierVersion: string,
  readonly duration: Readonly<{ id: HarnessProfile, harnessProfileVersion: number, policySetId: string }>,
  readonly capability: CapabilityBinding,
  readonly selection: Readonly<{ duration: SelectionItem, capability: SelectionItem }>,
  readonly parentBinding?: ParentBinding,
};
type SelectedTaskProfile = {
  profileSchemaVersion: 1,
  classifierVersion: string,
  duration: ResolvedTaskProfile["duration"],
  capability: CapabilityBinding,
  selection: ResolvedTaskProfile["selection"],
  parentBinding?: ParentBinding,
};
type RoutineMetadata = { routineId: string, revision: number, digest: string, stepCount: number };
type RouterOptions = {
  goalInput?: unknown,
  requestedDurationProfile?: unknown,
  requestedCapabilityProfile?: unknown,
  routineMetadata?: unknown,
  parentProfile?: unknown,
  parentBinding?: unknown,
};

class TaskProfileRouterError extends Error {
  // Type-only: no emitted field before the original name/code assignments.
  declare code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskProfileRouterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never { throw new TaskProfileRouterError(code, message); }

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function containsEnglishPhrase(text: string, phrase: string): boolean {
  const escaped = escapeRegExp(phrase);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

function matchingGroups<K extends string>(text: string, rules: Readonly<Record<K, ReadonlyArray<string>>>): K[] {
  const matches: K[] = [];
  for (const [group, phrases] of Object.entries<ReadonlyArray<string>>(rules)) {
    if (phrases.some((phrase) => {
      const normalized = normalizeText(phrase);
      return /^[\x00-\x7F]+$/.test(normalized)
        ? containsEnglishPhrase(text, normalized)
        : text.includes(normalized);
    })) matches.push(group as K);
  }
  return matches;
}

function hasCapabilityIntent(value: unknown, capabilityId: unknown): boolean {
  if (typeof value !== "string" || !Object.hasOwn(CAPABILITY_RULES, capabilityId as PropertyKey)) return false;
  // hasOwn performs the existing property-key coercion; no new enum guard
  // changes its behavior for non-string keys or throwing coercions.
  const capabilityKey = capabilityId as keyof typeof CAPABILITY_RULES;
  return matchingGroups(normalizeText(value), { [capabilityKey]: CAPABILITY_RULES[capabilityKey] }).length > 0;
}

function getGoalText(goalInput: unknown): string {
  if (!isPlainObject(goalInput) || typeof goalInput.originalRequest !== "string" || goalInput.originalRequest.trim().length === 0) {
    fail("invalid_goal", "goalInput.originalRequest must be a non-empty string");
  }
  if (Buffer.byteLength(goalInput.originalRequest, "utf8") > MAX_ORIGINAL_REQUEST_BYTES) {
    fail("invalid_goal", "goalInput.originalRequest exceeds the host request limit");
  }
  return normalizeText(goalInput.originalRequest);
}

function validateRoutineMetadata(value: unknown): RoutineMetadata {
  if (!isPlainObject(value)
      || Object.keys(value).some((key) => !["routineId", "revision", "digest", "stepCount"].includes(key))) {
    fail("invalid_routine_reference", "routineMetadata must be a host-validated pinned routine reference");
  }
  try {
    assertId(value.routineId, "routineMetadata.routineId");
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error("invalid revision");
    if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) throw new Error("invalid digest");
    if (!Number.isSafeInteger(value.stepCount) || (value.stepCount as number) < 1 || (value.stepCount as number) > 64) throw new Error("invalid stepCount");
  } catch {
    fail("invalid_routine_reference", "routineMetadata does not identify a valid pinned routine revision");
  }
  return value as RoutineMetadata;
}

function validateSelector(value: unknown, axis: "duration"): HarnessProfile | null;
function validateSelector(value: unknown, axis: "capability"): CapabilityId | null;
function validateSelector(value: unknown, axis: "duration" | "capability"): HarnessProfile | CapabilityId | null {
  if (axis === "duration") {
    if (value === "auto") return null;
    try { return validateHarnessProfile(value); }
    catch { fail("invalid_selector", "requestedDurationProfile must be auto|short|fast|middle|long"); }
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("invalid_selector", "requestedCapabilityProfile must be a capability ID or null");
  let entry;
  try { entry = getCapabilityProfile(value); }
  catch { fail("invalid_selector", "requestedCapabilityProfile is unknown"); }
  if (!entry.available) fail("capability_unavailable", `${value} capability is not available`);
  // Successful registry lookup proves membership in the closed host IDs.
  return value as CapabilityId;
}

function validateParentInputs(parentProfile: unknown, parentBinding: unknown): { parentProfile: ResolvedTaskProfile, parentBinding: ParentBinding } {
  if (!parentProfile || !parentBinding) fail("invalid_parent_binding", "child profile resolution requires parentProfile and parentBinding");
  // Keep the initial capability check before profile validation, including
  // its existing optional-access behavior on malformed parent values.
  const profileInput = parentProfile as { capability?: { id: unknown } };
  if (!new Set(["multi_agent", "multi_agent_computer_use"]).has(profileInput.capability?.id as string)) {
    fail("invalid_parent_profile", "child tasks require a validated Multi-agent parent profile");
  }
  let normalizedParent = parentProfile;
  try {
    if (Object.hasOwn(parentProfile, "profileSchemaVersion")) {
      validateTaskProfileSelectedPayload(parentProfile);
      const selectedParent = parentProfile as SelectedTaskProfile;
      const resolvedParent: ResolvedTaskProfile = {
        schemaVersion: selectedParent.profileSchemaVersion,
        classifierVersion: selectedParent.classifierVersion,
        duration: {
          id: selectedParent.duration.id,
          harnessProfileVersion: selectedParent.duration.harnessProfileVersion,
          policySetId: selectedParent.duration.policySetId,
        },
        capability: selectedParent.capability,
        selection: selectedParent.selection,
      };
      if (selectedParent.parentBinding) {
        (resolvedParent as { parentBinding?: ParentBinding }).parentBinding = selectedParent.parentBinding;
      }
      normalizedParent = resolvedParent;
    }
    validateResolvedTaskProfile(normalizedParent);
    const binding = parentBinding as Record<string, unknown>;
    assertUuid(binding.parentTaskId, "parentBinding.parentTaskId");
    assertUuid(binding.planId, "parentBinding.planId");
    assertId(String(binding.parentGoalVersion), "parentBinding.parentGoalVersion");
    if (!Number.isSafeInteger(binding.parentGoalVersion) || (binding.parentGoalVersion as number) < 1) throw new Error("invalid parent goal version");
  } catch {
    fail("invalid_parent_binding", "parent binding or validated Multi-agent profile is malformed");
  }
  return { parentProfile: normalizedParent as ResolvedTaskProfile, parentBinding: parentBinding as ParentBinding };
}

function makeCapability(id: CapabilityId): CapabilityBinding {
  const entry = getCapabilityProfile(id);
  if (!entry.available) fail("capability_unavailable", `${id} capability is not available`);
  return {
    id: entry.id as CapabilityId,
    registryVersion: CAPABILITY_REGISTRY_VERSION,
    dependencies: [...entry.dependencies],
    adapters: entry.adapters.map((adapter) => ({ ...adapter })),
  };
}

function deepFreeze<T>(value: T): T {
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
}: RouterOptions = {}): ResolvedTaskProfile {
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

  let durationId: HarnessProfile;
  let durationSelection: SelectionItem;
  if (requestedDuration) {
    durationId = requestedDuration;
    durationSelection = { source: "explicit_user_choice" };
  } else {
    const durationMatches = matchingGroups(text, DURATION_RULES);
    // "fast mode" together with a short-task hint still means fast: it is the stricter ask.
    if (durationMatches.length === 2 && durationMatches.includes("fast") && durationMatches.includes("short")) durationMatches.splice(durationMatches.indexOf("short"), 1);
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

  let capabilityId: CapabilityId;
  let capabilitySelection: SelectionItem;
  let validatedParent: ReturnType<typeof validateParentInputs> | null = null;
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
    const parentDuration = validatedParent!.parentProfile.duration.id;
    if (!HARNESS_PROFILES.includes(parentDuration)) fail("invalid_parent_profile", "parent duration is not a supported horizon");
    if (HORIZON_RANK[durationId] > HORIZON_RANK[parentDuration]) {
      durationId = parentDuration;
      durationSelection = { source: "parent_plan_policy" };
    }
  }

  const profile: ResolvedTaskProfile = {
    schemaVersion: 1,
    classifierVersion: CLASSIFIER_VERSION,
    duration: { id: durationId, harnessProfileVersion: 1, policySetId: "goal-limits-v1" },
    capability: makeCapability(capabilityId),
    selection: { duration: durationSelection, capability: capabilitySelection },
    ...(validatedParent ? { parentBinding: { ...validatedParent.parentBinding } } : {}),
  };
  try { validateResolvedTaskProfile(profile); }
  catch (error) {
    const details = error as { code?: string, message: string };
    fail(details.code || "invalid_profile", details.message);
  }
  return deepFreeze(profile);
}

export = {
  CLASSIFIER_VERSION,
  TaskProfileRouterError,
  resolveTaskProfile,
  hasCapabilityIntent,
};
