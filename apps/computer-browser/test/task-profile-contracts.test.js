"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateResolvedTaskProfile,
  validateTaskProfileSelectedPayload,
} = require("../shared/task-profile-contracts");

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    classifierVersion: "task-profile-router-v1",
    duration: { id: "middle", harnessProfileVersion: 1, policySetId: "goal-limits-v1" },
    capability: {
      id: "browser",
      registryVersion: 1,
      dependencies: ["browser"],
      adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }],
    },
    selection: {
      duration: { source: "default" },
      capability: { source: "default" },
    },
    ...overrides,
  };
}

function selectedPayload(overrides = {}) {
  const resolved = profile();
  return {
    profileSchemaVersion: 1,
    classifierVersion: resolved.classifierVersion,
    duration: {
      ...resolved.duration,
      effectiveLimits: { maxActions: 1000, maxPlannerCalls: 500, maxActiveMs: 14_400_000 },
    },
    capability: resolved.capability,
    selection: resolved.selection,
    ...overrides,
  };
}

test("resolved profile accepts canonical IDs and independent selection attribution", () => {
  const value = profile({
    duration: { id: "long", harnessProfileVersion: 1, policySetId: "goal-limits-v1" },
    selection: {
      duration: { source: "explicit_user_choice" },
      capability: { source: "intent_rule", ruleId: "intent-multi-agent-v1" },
    },
  });
  assert.equal(validateResolvedTaskProfile(value), value);
});

test("resolved profile rejects unknown fields, invalid IDs, unsorted closures, and malformed parent binding", () => {
  assert.throws(() => validateResolvedTaskProfile(profile({ surprise: true })), { code: "unknown_field" });
  assert.throws(() => validateResolvedTaskProfile(profile({ duration: { id: "Long", harnessProfileVersion: 1, policySetId: "goal-limits-v1" } })), { code: "invalid_harness_profile" });
  assert.throws(() => validateResolvedTaskProfile(profile({
    capability: {
      id: "multi_agent",
      registryVersion: 1,
      dependencies: ["browser", "multi_agent"],
      adapters: [
        { capabilityId: "multi_agent", adapterId: "child-agent-coordinator", adapterVersion: 1 },
        { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
      ],
    },
  })), { code: "invalid_order" });
  assert.throws(() => validateResolvedTaskProfile(profile({ parentBinding: { parentTaskId: PARENT } })), { code: "invalid_field" });
});

test("selected payload validates bounded effective limits and optional child binding", () => {
  const payload = selectedPayload({ parentBinding: {
    parentTaskId: PARENT,
    planId: "plan_1",
    parentGoalVersion: 1,
  }, selection: {
    duration: { source: "parent_plan_policy" },
    capability: { source: "parent_plan_policy" },
  } });
  assert.equal(validateTaskProfileSelectedPayload(payload), payload);
  assert.throws(() => validateTaskProfileSelectedPayload(selectedPayload({
    duration: {
      id: "middle",
      harnessProfileVersion: 1,
      policySetId: "goal-limits-v1",
      effectiveLimits: { maxActions: 1001, maxPlannerCalls: 500, maxActiveMs: 14_400_000 },
    },
  })), { code: "limit_exceeded" });
  assert.throws(() => validateTaskProfileSelectedPayload(selectedPayload({
    parentBinding: { parentTaskId: PARENT, planId: "plan_1", parentGoalVersion: 0, childTaskId: CHILD },
  })), { code: "unknown_field" });
});

test("selected payload rejects unknown nested fields and invalid source enums", () => {
  assert.throws(() => validateTaskProfileSelectedPayload(selectedPayload({ unknown: "x" })), { code: "unknown_field" });
  assert.throws(() => validateTaskProfileSelectedPayload(selectedPayload({
    selection: { duration: { source: "model" }, capability: { source: "default" } },
  })), { code: "unknown_enum" });
});
