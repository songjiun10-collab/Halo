"use strict";

// P0 benchmark telemetry (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md).
// One recorder per benchmark run. It does not add new timing points: it takes
// the labels the benchmarks and TaskStore/TaskController onTiming already
// produce, files each under a closed stage vocabulary, keeps a bounded buffer
// of raw spans for JSONL, and rolls stages up without double-counting spans
// that contain other spans (approve_call_inclusive). Benchmark-only; nothing
// in main/ depends on it.

const { performance } = require("node:perf_hooks");

const STAGES = Object.freeze(["context", "planner", "decision", "approval", "journal_append", "checkpoint", "browser", "verification"]);

const STAGE_OF = Object.freeze({
  context_build: { stage: "context", inclusive: false },
  proposal: { stage: "planner", inclusive: false },
  profile_resolution: { stage: "decision", inclusive: false },
  action_policy_decision: { stage: "decision", inclusive: false },
  approver_decision: { stage: "approval", inclusive: false },
  approve_call_inclusive: { stage: "approval", inclusive: true },
  browser_observe: { stage: "browser", inclusive: false },
  browser_execute: { stage: "browser", inclusive: false },
  journal_prepare: { stage: "journal_append", inclusive: false },
  journal_append_write: { stage: "journal_append", inclusive: false },
  journal_fsync: { stage: "journal_append", inclusive: false },
  checkpoint_file_write: { stage: "checkpoint", inclusive: false },
  checkpoint_file_fsync: { stage: "checkpoint", inclusive: false },
  checkpoint_rename: { stage: "checkpoint", inclusive: false },
  checkpoint_directory_fsync: { stage: "checkpoint", inclusive: false },
});

// Wall time splits into active harness time and time spent waiting on a
// person (approval). Unmeasured phases stay null rather than reading as 0.
const PHASES = Object.freeze({ wall: "wallMs", active: "activeMs", human_wait: "humanWaitMs" });

// Same nearest-rank rule as routine-vs-planner-benchmark's summarize(), plus p75.
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))] ?? 0;
  return {
    count: values.length,
    p50Ms: at(0.5),
    p75Ms: at(0.75),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1) ?? 0,
    totalMs: values.reduce((sum, value) => sum + value, 0),
  };
}

function createSpanRecorder({ runId, maxSpans = 10000, now = () => performance.now() } = {}) {
  if (typeof runId !== "string" || runId.length === 0) throw new TypeError("runId must be a non-empty string");
  if (!Number.isInteger(maxSpans) || maxSpans < 0) throw new TypeError("maxSpans must be a non-negative integer");
  const spans = [];
  // Every duration is kept per label (numbers only) so aggregates stay exact
  // when the raw span buffer overflows.
  const durations = new Map();
  const counters = new Map();
  const marks = new Map();
  const phases = new Map();
  let origin = null;
  let seq = 0;
  let dropped = 0;

  function record(label, durationMs, { taskId = null, turnId = null, parentSpanId = null } = {}) {
    const kind = STAGE_OF[label];
    if (!kind) throw new RangeError(`unknown stage label: ${label}`);
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`invalid duration for ${label}`);
    if (!durations.has(label)) durations.set(label, []);
    durations.get(label).push(durationMs);
    seq += 1;
    if (spans.length >= maxSpans) {
      dropped += 1;
      return null;
    }
    const spanId = `${runId}:${seq}`;
    spans.push({ type: "span", runId, spanId, parentSpanId, taskId, turnId, stage: kind.stage, label, inclusive: kind.inclusive, durationMs });
    return spanId;
  }

  function wrap(label, fn, ids) {
    return async (...args) => {
      const startedAt = now();
      try {
        return await fn(...args);
      } finally {
        record(label, Math.max(0, now() - startedAt), ids);
      }
    };
  }

  function count(name, n = 1) {
    if (name === "tokens") throw new RangeError("tokens are reported by providers, never derived from bytes");
    if (typeof name !== "string" || name.length === 0) throw new TypeError("counter name must be a non-empty string");
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid count for ${name}`);
    counters.set(name, (counters.get(name) ?? 0) + n);
  }

  function phase(name, durationMs) {
    if (!Object.hasOwn(PHASES, name)) throw new RangeError(`unknown phase: ${name}`);
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError(`invalid duration for phase ${name}`);
    phases.set(name, (phases.get(name) ?? 0) + durationMs);
  }

  function start() {
    origin = now();
  }

  // First occurrence only: a user-perceived latency such as submit → first proposal.
  function mark(name) {
    const at = now();
    if (origin === null) throw new Error("start() must be called before mark()");
    if (!marks.has(name)) marks.set(name, Math.max(0, at - origin));
  }

  function summary() {
    const labels = {};
    for (const [label, values] of durations) labels[label] = summarize(values);
    const stages = {};
    for (const stage of STAGES) {
      const values = [];
      for (const [label, list] of durations) {
        const kind = STAGE_OF[label];
        if (kind.stage === stage && !kind.inclusive) values.push(...list);
      }
      if (values.length > 0) stages[stage] = summarize(values);
    }
    return {
      type: "summary",
      runId,
      stages,
      labels,
      counters: { tokens: null, ...Object.fromEntries(counters) },
      marks: Object.fromEntries(marks),
      phases: Object.fromEntries(Object.entries(PHASES).map(([name, key]) => [key, phases.get(name) ?? null])),
      droppedSpans: dropped,
    };
  }

  function toJsonl() {
    return [...spans, summary()].map((line) => JSON.stringify(line)).join("\n") + "\n";
  }

  return { record, wrap, count, phase, start, mark, summary, toJsonl };
}

module.exports = { createSpanRecorder, STAGE_OF, STAGES, PHASES, summarize };
