"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecoveryPolicy } = require("../main/harness/recovery-policy");

test("restoring recovery state preserves lifetime usage even after progress", () => {
  const options = { now: () => 1000, lifetime: 3 };
  const first = createRecoveryPolicy(5, 2, options);
  first.tryConsume("planner_error");
  first.noteProgress();
  first.tryConsume("planner_error");
  const restored = createRecoveryPolicy(5, 2, { ...options, state: first.snapshot() });
  restored.noteProgress();
  assert.ok(restored.tryConsume("planner_error"));
  assert.equal(restored.tryConsume("observation_error"), null);
});

test("restored recent failures retain the per-reason limit and expire normally", () => {
  let at = 1000;
  const first = createRecoveryPolicy(5, 2, { now: () => at });
  first.tryConsume("planner_error"); first.tryConsume("planner_error");
  const restored = createRecoveryPolicy(5, 2, { now: () => at, state: first.snapshot() });
  assert.equal(restored.tryConsume("planner_error"), null);
  at += 600000;
  assert.deepEqual(restored.tryConsume("planner_error"), { attempt: 1, total: 1 });
});

test("malformed persisted state fails closed instead of resetting the budget", () => {
  for (const state of [{ version: 1, spent: -1, recent: [] },
    { version: 1, spent: 1, recent: [{ reason: "x", at: NaN }] },
    { version: 2, spent: 0, recent: [] },
    { version: 1, spent: 0, recent: [{ reason: "x", at: 1 }] }]) {
    assert.throws(() => createRecoveryPolicy(5, 2, { state }), /invalid_recovery_state/);
  }
});
