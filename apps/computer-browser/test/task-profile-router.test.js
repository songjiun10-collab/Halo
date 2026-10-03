"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveTaskProfile,
  TaskProfileRouterError,
} = require("../shared/task-profile-router");
const { DEFAULT_LIMITS } = require("../shared/harness-contracts");

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";

function parentProfile(duration = "middle") {
  return {
    schemaVersion: 1,
    classifierVersion: "task-profile-router-v1",
    duration: { id: duration, harnessProfileVersion: 1, policySetId: "goal-limits-v1" },
    capability: {
      id: "multi_agent",
      registryVersion: 1,
      dependencies: ["browser", "multi_agent"],
      adapters: [
        { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
        { capabilityId: "multi_agent", adapterId: "child-agent-coordinator", adapterVersion: 1 },
      ],
    },
    selection: { duration: { source: "default" }, capability: { source: "intent_rule", ruleId: "intent-multi-agent-v1" } },
  };
}

function childOptions(goal, duration = "auto", parentDuration = "middle") {
  return {
    goalInput: { originalRequest: goal },
    requestedDurationProfile: duration,
    parentProfile: parentProfile(parentDuration),
    parentBinding: { parentTaskId: PARENT_ID, planId: PLAN_ID, parentGoalVersion: 1 },
  };
}

test("default route is Browser+Middle and stable for the same normalized input", () => {
  const input = { goalInput: { originalRequest: "Open the assigned page and inspect its heading." } };
  const first = resolveTaskProfile(input);
  assert.deepEqual(first, resolveTaskProfile(input));
  assert.equal(first.duration.id, "middle");
  assert.equal(first.capability.id, "browser");
  assert.deepEqual(first.selection, {
    duration: { source: "default" },
    capability: { source: "default" },
  });
});

test("trusted duration and capability choices are independent and override lexical hints", () => {
  const selected = resolveTaskProfile({
    goalInput: { originalRequest: "Quick long task: research this and delegate to agents." },
    requestedDurationProfile: "short",
    requestedCapabilityProfile: "multi_agent",
  });
  assert.equal(selected.duration.id, "short");
  assert.equal(selected.capability.id, "multi_agent");
  assert.equal(selected.selection.duration.source, "explicit_user_choice");
  assert.equal(selected.selection.capability.source, "explicit_user_choice");
});

test("the combined team CUA profile preserves the multi-agent route", () => {
  const selected = resolveTaskProfile({
    goalInput: { originalRequest: "팀으로 사이트 확인" },
    requestedCapabilityProfile: "multi_agent_computer_use",
  });
  assert.equal(selected.capability.id, "multi_agent_computer_use");
  assert.ok(selected.capability.adapters.some((item) => item.capabilityId === "computer_use"));
});

test("exact English and Korean intent rules are versioned and normalized", () => {
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "Please use parallel agents for this." } }).capability.id, "multi_agent");
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "이 자료를 병렬 에이전트에게 분담해" } }).capability.id, "multi_agent");
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "짧게 끝내 줘" } }).duration.id, "short");
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "장기 작업으로 진행해" } }).duration.id, "long");
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "짧게 끝내 줘".normalize("NFD") } }).duration.id, "short");
});

test("English matching uses whole phrase boundaries and negative cases stay at defaults", () => {
  const result = resolveTaskProfile({ goalInput: { originalRequest: "A researcher mentioned parallel-agentism; just inspect this page." } });
  assert.equal(result.capability.id, "browser");
  assert.equal(result.duration.id, "middle");
});

test("unavailable capabilities fail explicitly and never fall back to Browser", () => {
  for (const requestedCapabilityProfile of ["research"]) {
    assert.throws(() => resolveTaskProfile({
      goalInput: { originalRequest: "Do the work." }, requestedCapabilityProfile,
    }), (error) => error instanceof TaskProfileRouterError && error.code === "capability_unavailable");
  }
  assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "Research this carefully." } }),
    (error) => error instanceof TaskProfileRouterError && error.code === "capability_unavailable");
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "Do this." }, requestedCapabilityProfile: "computer_use" }).capability.id, "computer_use");
});

test("overlapping capability or duration hint groups require clarification", () => {
  assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "Research this and use the mouse." } }),
    (error) => error instanceof TaskProfileRouterError && error.code === "ambiguous_capability");
  assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "Quick but long-running work." } }),
    (error) => error instanceof TaskProfileRouterError && error.code === "ambiguous_duration");
});

test("malformed selectors and Routine without a validated typed entrypoint are rejected", () => {
  for (const input of [
    { requestedDurationProfile: "Long" },
    { requestedCapabilityProfile: "mystery" },
    { requestedCapabilityProfile: "routine" },
  ]) {
    assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "Run it." }, ...input }), TaskProfileRouterError);
  }
});

test("typed Routine uses its pinned metadata and honors an explicit independent horizon", () => {
  const routineMetadata = { routineId: "routine_1", revision: 3, digest: "a".repeat(64), stepCount: 8 };
  const automatic = resolveTaskProfile({ goalInput: { originalRequest: "Run the saved routine." }, routineMetadata });
  assert.equal(automatic.capability.id, "routine");
  assert.equal(automatic.duration.id, "short");
  assert.equal(automatic.selection.duration.source, "routine_entrypoint");
  assert.equal(automatic.selection.capability.source, "routine_entrypoint");
  const explicit = resolveTaskProfile({
    goalInput: { originalRequest: "Run the saved routine." },
    routineMetadata,
    requestedDurationProfile: "long",
  });
  assert.equal(explicit.duration.id, "long");
  assert.equal(explicit.selection.duration.source, "explicit_user_choice");
});

test("children are host-pinned Browser tasks and cannot exceed the parent horizon", () => {
  const child = resolveTaskProfile(childOptions("Research for a long-running task on the site."));
  assert.equal(child.capability.id, "browser");
  assert.equal(child.duration.id, "middle");
  assert.equal(child.selection.capability.source, "parent_plan_policy");
  assert.equal(child.selection.duration.source, "parent_plan_policy");
  assert.deepEqual(child.parentBinding, { parentTaskId: PARENT_ID, planId: PLAN_ID, parentGoalVersion: 1 });

  const shortChild = resolveTaskProfile(childOptions("Quickly inspect the assigned page.", "auto", "short"));
  assert.equal(shortChild.duration.id, "short");
});

test("child profile resolution requires a valid Multi-agent parent and complete host binding", () => {
  const input = childOptions("Inspect this page.");
  assert.throws(() => resolveTaskProfile({ ...input, parentProfile: { ...parentProfile(), capability: { ...parentProfile().capability, id: "browser" } } }),
    (error) => error instanceof TaskProfileRouterError && error.code === "invalid_parent_profile");
  assert.throws(() => resolveTaskProfile({ ...input, parentBinding: undefined }),
    (error) => error instanceof TaskProfileRouterError && error.code === "invalid_parent_binding");
});

test("child resolution accepts the durable selected-profile form stored in the parent journal", () => {
  const resolved = parentProfile("long");
  const stored = {
    profileSchemaVersion: resolved.schemaVersion,
    classifierVersion: resolved.classifierVersion,
    duration: { ...resolved.duration, effectiveLimits: { ...DEFAULT_LIMITS } },
    capability: resolved.capability,
    selection: resolved.selection,
  };
  const child = resolveTaskProfile({
    goalInput: { originalRequest: "inspect the page" },
    parentProfile: stored,
    parentBinding: { parentTaskId: PARENT_ID, planId: PLAN_ID, parentGoalVersion: 1 },
  });
  assert.equal(child.duration.id, "middle");
  assert.equal(child.capability.id, "browser");
});

test("router rejects malformed raw goal input before selecting a route", () => {
  assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "" } }), TaskProfileRouterError);
  assert.throws(() => resolveTaskProfile({ goalInput: { originalRequest: "x".repeat(16 * 1024 + 1) } }), TaskProfileRouterError);
});

test("fast-mode wording selects the fast profile", () => {
  for (const request of ["Use fast mode to check the price", "패스트 모드로 가격 확인해 줘", "패스트모드로 확인"]) {
    const profile = resolveTaskProfile({ goalInput: { originalRequest: request } });
    assert.equal(profile.duration.id, "fast", request);
    assert.equal(profile.selection.duration.source, "intent_rule");
  }
  assert.equal(resolveTaskProfile({ goalInput: { originalRequest: "quick check in fast mode" } }).duration.id, "fast");
});
