"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { effortForRoute, routeForProfile, EFFORT_MODES } = require("../main/harness/planner-effort-policy");

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("fixed mode always uses the user's effort", () => {
  for (const base of EFFORTS) {
    for (const route of ["child", "short", "middle", "long"]) {
      assert.equal(effortForRoute({ base, mode: "fixed", route }), base);
    }
  }
});

test("auto mode lowers only cheap routes and never raises above the user's effort", () => {
  for (const base of EFFORTS) {
    assert.equal(effortForRoute({ base, mode: "auto", route: "child" }), "low");
    assert.equal(effortForRoute({ base, mode: "auto", route: "short" }), "low");
    assert.equal(effortForRoute({ base, mode: "auto", route: "middle" }), base);
    assert.equal(effortForRoute({ base, mode: "auto", route: "long" }), base);
  }
});

test("unknown inputs fail closed to the user's effort or throw", () => {
  assert.equal(effortForRoute({ base: "high", mode: "auto", route: "mystery" }), "high");
  assert.throws(() => effortForRoute({ base: "turbo", mode: "auto", route: "child" }), { code: "invalid_planner_effort" });
  assert.throws(() => effortForRoute({ base: "high", mode: "smart", route: "child" }), { code: "invalid_planner_effort_mode" });
  assert.deepEqual(EFFORT_MODES, ["auto", "fixed"]);
});

test("routes come from the persisted task profile duration", () => {
  assert.equal(routeForProfile({ duration: { id: "short" } }), "short");
  assert.equal(routeForProfile({ duration: { id: "long" } }), "long");
  assert.equal(routeForProfile({ duration: { id: "fast" } }), "fast");
  // fast keeps a medium ceiling in auto mode (low looped on exploratory goals).
  assert.equal(effortForRoute({ base: "high", mode: "auto", route: "fast" }), "medium");
  assert.equal(effortForRoute({ base: "low", mode: "auto", route: "fast" }), "low");
  assert.equal(effortForRoute({ base: "high", mode: "fixed", route: "fast" }), "high");
  // Legacy tasks without a profile are treated as the default horizon.
  assert.equal(routeForProfile(null), "middle");
  assert.equal(routeForProfile(undefined), "middle");
});
