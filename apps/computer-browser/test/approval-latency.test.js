"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApprovalLatencyTracker } = require("../integration/approval-latency");

test("latency is approval-relative, consumed once, and split by outcome", () => {
  let time = 100;
  const samples = [];
  const tracker = createApprovalLatencyTracker({ now: () => time, onSample: (s) => samples.push(s) });
  assert.equal(tracker.complete("success"), null);
  for (const outcome of ["success", "failed", "execution_uncertain"]) {
    tracker.begin(); time += 7;
    assert.deepEqual(tracker.complete(outcome), { outcome, elapsedMs: 7 });
    assert.equal(tracker.complete(outcome), null);
  }
  assert.equal(tracker.summary().count, 3);
  for (const outcome of ["success", "failed", "execution_uncertain"]) {
    assert.equal(tracker.summary().outcomes[outcome].count, 1);
    assert.equal(tracker.summary().outcomes[outcome].p95Ms, 7);
  }
  assert.equal(samples.length, 3);
});

test("clear discards unused approvals and callback failure cannot change execution", () => {
  let time = 10;
  const tracker = createApprovalLatencyTracker({ now: () => time, onSample: () => { throw new Error("sink unavailable"); } });
  tracker.begin(); tracker.clear(); time = 40;
  assert.equal(tracker.complete("success"), null);
  tracker.begin(); time = 50;
  assert.deepEqual(tracker.complete("success"), { outcome: "success", elapsedMs: 10 });
  assert.throws(() => tracker.complete("unknown"), /outcome/);
  assert.equal(tracker.summary().count, 1);
});
