"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HARNESS_PROFILES,
  HarnessProfileError,
  validateHarnessProfile,
  selectHarnessProfile,
  maxActionsPerProposal,
} = require("../shared/harness-profile");
const { MAX_ACTIONS_PER_PROPOSAL, MAX_ACTIONS_PER_PROPOSAL_SHORT } = require("../shared/harness-contracts");

test("HARNESS_PROFILES is exactly short/middle/long", () => {
  assert.deepEqual(HARNESS_PROFILES, ["short", "middle", "long"]);
});

test("validateHarnessProfile accepts each defined profile", () => {
  for (const profile of HARNESS_PROFILES) {
    assert.equal(validateHarnessProfile(profile), profile);
  }
});

test("validateHarnessProfile rejects unknown, non-string, and empty values", () => {
  for (const bad of ["fast", "SHORT", "", null, undefined, 1, {}, ["short"]]) {
    assert.throws(() => validateHarnessProfile(bad), HarnessProfileError);
  }
});

test("selectHarnessProfile defaults to middle for an ordinary task", () => {
  assert.equal(selectHarnessProfile({}), "middle");
  assert.equal(selectHarnessProfile(), "middle");
  assert.equal(selectHarnessProfile({ isRoutine: false }), "middle");
});

test("selectHarnessProfile selects short for a saved routine task", () => {
  assert.equal(selectHarnessProfile({ isRoutine: true }), "short");
});

test("maxActionsPerProposal returns the wider bound only for short", () => {
  assert.equal(maxActionsPerProposal("short"), MAX_ACTIONS_PER_PROPOSAL_SHORT);
  assert.equal(maxActionsPerProposal("middle"), MAX_ACTIONS_PER_PROPOSAL);
  assert.equal(maxActionsPerProposal("long"), MAX_ACTIONS_PER_PROPOSAL);
  assert.ok(MAX_ACTIONS_PER_PROPOSAL_SHORT > MAX_ACTIONS_PER_PROPOSAL);
});

test("maxActionsPerProposal rejects an invalid profile", () => {
  assert.throws(() => maxActionsPerProposal("fast"), HarnessProfileError);
});
