"use strict";

// P0 benchmark telemetry: a bounded, in-memory span recorder that maps the
// existing benchmark labels onto the design's stage vocabulary, keeps raw
// spans for JSONL, and never double-counts an inclusive span in a stage total.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpanRecorder, STAGE_OF, STAGES } = require("../integration/stage-spans");

function clock(times) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

test("existing labels map onto the closed stage vocabulary", () => {
  assert.deepEqual(STAGES, ["context", "planner", "decision", "approval", "journal_append", "checkpoint", "browser", "verification"]);
  assert.equal(STAGE_OF.context_build.stage, "context");
  assert.equal(STAGE_OF.proposal.stage, "planner");
  assert.equal(STAGE_OF.action_policy_decision.stage, "decision");
  assert.equal(STAGE_OF.journal_fsync.stage, "journal_append");
  assert.equal(STAGE_OF.checkpoint_directory_fsync.stage, "checkpoint");
  assert.equal(STAGE_OF.approve_call_inclusive.inclusive, true);
  for (const { stage } of Object.values(STAGE_OF)) assert.ok(STAGES.includes(stage));
});

test("spans carry identity and the summary rolls up stages without inclusive spans", () => {
  const rec = createSpanRecorder({ runId: "run-1", now: clock([0]) });
  rec.record("approver_decision", 4, { taskId: "t", turnId: 1 })
  rec.record("approve_call_inclusive", 10, { taskId: "t", turnId: 1 })
  rec.record("journal_append_write", 1, { taskId: "t", turnId: 1 })
  rec.record("journal_fsync", 2, { taskId: "t", turnId: 1 })
  const lines = rec.toJsonl().trim().split("\n").map((line) => JSON.parse(line));
  const spans = lines.filter((l) => l.type === "span");
  assert.equal(spans.length, 4);
  assert.deepEqual(Object.keys(spans[0]).sort(), ["durationMs", "inclusive", "label", "parentSpanId", "runId", "spanId", "stage", "taskId", "turnId", "type"]);
  assert.equal(new Set(spans.map((s) => s.spanId)).size, 4);
  const summary = lines.at(-1);
  assert.equal(summary.type, "summary");
  assert.equal(summary.stages.approval.totalMs, 4, "the inclusive approve call is not added on top");
  assert.equal(summary.stages.journal_append.totalMs, 3);
  assert.equal(summary.labels.approve_call_inclusive.totalMs, 10, "it is still reported under its own label");
})

test("unknown labels are refused rather than becoming new metric names", () => {
  const rec = createSpanRecorder({ runId: "r" });
  assert.throws(() => rec.record("whatever", 1), /unknown/);
  assert.throws(() => rec.record("proposal", -1), /duration/);
})

test("percentiles are nearest-rank and include p75", () => {
  const rec = createSpanRecorder({ runId: "r" });
  for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) rec.record("proposal", ms);
  const s = rec.summary().labels.proposal;
  assert.deepEqual([s.count, s.p50Ms, s.p75Ms, s.p95Ms, s.maxMs, s.totalMs], [10, 5, 8, 10, 10, 55]);
})

test("the buffer is bounded: overflow is counted and the summary stays exact", () => {
  const rec = createSpanRecorder({ runId: "r", maxSpans: 2 });
  for (let i = 0; i < 5; i += 1) rec.record("browser_execute", 1);
  const lines = rec.toJsonl().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((l) => l.type === "span").length, 2);
  const summary = lines.at(-1);
  assert.equal(summary.droppedSpans, 3);
  assert.equal(summary.labels.browser_execute.count, 5, "aggregates still see every sample");
})

test("wrap times async work and still records when it throws", async () => {
  const rec = createSpanRecorder({ runId: "r", now: clock([0, 7, 10, 13]) });
  assert.equal(await rec.wrap("browser_observe", async () => "ok")(), "ok");
  await assert.rejects(rec.wrap("browser_execute", async () => { throw new Error("x") })(), /x/);
  const { labels } = rec.summary();
  assert.equal(labels.browser_observe.totalMs, 7);
  assert.equal(labels.browser_execute.totalMs, 3);
})

test("counters and first-time marks are kept; bytes are never called tokens", () => {
  const rec = createSpanRecorder({ runId: "r", now: clock([100, 130, 160, 190]) });
  rec.start();
  rec.mark("first_observation");
  rec.mark("first_observation");
  rec.mark("first_proposal");
  rec.count("contextBytes", 1200);
  rec.count("contextBytes", 800);
  rec.count("plannerCalls");
  const s = rec.summary();
  assert.deepEqual(s.marks, { first_observation: 30, first_proposal: 90 });
  assert.equal(s.counters.contextBytes, 2000);
  assert.equal(s.counters.plannerCalls, 1);
  assert.equal(s.counters.tokens, null, "providers that report no tokens stay null");
  assert.throws(() => rec.count("tokens", 5), /tokens/);
})

test("wall, active and human-wait time are separate, closed phases", () => {
  const rec = createSpanRecorder({ runId: "r" });
  rec.phase("wall", 100);
  rec.phase("human_wait", 30);
  rec.phase("active", 70);
  rec.phase("human_wait", 5);
  assert.deepEqual(rec.summary().phases, { wallMs: 100, activeMs: 70, humanWaitMs: 35 });
  assert.throws(() => rec.phase("idle", 1), /phase/);
  assert.throws(() => rec.phase("wall", -1), /duration/);
  assert.deepEqual(createSpanRecorder({ runId: "e" }).summary().phases, { wallMs: null, activeMs: null, humanWaitMs: null }, "unmeasured is null, not zero");
})
