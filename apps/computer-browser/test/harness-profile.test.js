"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HARNESS_PROFILES,
  HarnessProfileError,
  validateHarnessProfile,
  selectHarnessProfile,
} = require("../shared/harness-profile");

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
