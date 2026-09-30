"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { percentile, summarizeMetrics } = require("../shared/metrics");

test("percentile returns null for an empty array", () => {
  assert.equal(percentile([], 0.5), null);
});

test("percentile picks the expected rank for p50/p95", () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 0.5), 60);
  assert.equal(percentile(sorted, 0.95), 100);
  assert.equal(percentile(sorted, 0), 10);
});

test("percentile clamps p outside [0,1]", () => {
  const sorted = [1, 2, 3];
  assert.equal(percentile(sorted, -1), 1);
  assert.equal(percentile(sorted, 2), 3);
});

test("summarizeMetrics groups by kind and computes count/p50/p95", () => {
  const records = [
    { kind: "decision_wait", ms: 10, outcome: "allow" },
    { kind: "decision_wait", ms: 30, outcome: "allow" },
    { kind: "decision_wait", ms: 20, outcome: "review" },
    { kind: "navigation", ms: 500, outcome: "ok" },
  ];
  const summary = summarizeMetrics(records);

  assert.equal(summary.decision_wait.count, 3);
  assert.equal(summary.decision_wait.p50, 20);
  assert.deepEqual(summary.decision_wait.outcomes, { allow: 2, review: 1 });
  assert.equal(summary.navigation.count, 1);
  assert.equal(summary.navigation.p50, 500);
});

test("summarizeMetrics treats a missing outcome as 'ok'", () => {
  const summary = summarizeMetrics([{ kind: "execute", ms: 5 }]);
  assert.deepEqual(summary.execute.outcomes, { ok: 1 });
});

test("summarizeMetrics returns an empty object for no records", () => {
  assert.deepEqual(summarizeMetrics([]), {});
});
