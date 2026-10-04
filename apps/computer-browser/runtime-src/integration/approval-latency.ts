"use strict";

// Benchmark-only. These inclusive latencies are not durable execution evidence.
const { performance } = require("node:perf_hooks");
interface LatencyStats { count: number; p50Ms: number; p75Ms: number; p95Ms: number; maxMs: number; totalMs: number }
type Outcome = "success" | "failed" | "execution_uncertain";
interface Sample { outcome: Outcome; elapsedMs: number }
interface TrackerOptions { now?: () => number; onSample?: (sample: Sample) => void }
const { summarize } = require("./stage-spans") as { summarize(values: number[]): LatencyStats };

function createApprovalLatencyTracker({ now = () => performance.now(), onSample = () => {} }: TrackerOptions = {}) {
  const durations: Record<Outcome, number[]> = { success: [], failed: [], execution_uncertain: [] };
  let started: number | null = null;
  return {
    begin() { started = now(); },
    clear() { started = null; },
    complete(outcome: Outcome) {
      if (!Object.hasOwn(durations, outcome)) throw new RangeError("invalid approval latency outcome");
      if (started === null) return null;
      const elapsedMs = Math.max(0, now() - started);
      started = null;
      durations[outcome].push(elapsedMs);
      const sample = { outcome, elapsedMs };
      try { onSample(sample); } catch { /* telemetry is not execution authority */ }
      return sample;
    },
    summary() {
      return {
        count: Object.values(durations).reduce((total, values) => total + values.length, 0),
        outcomes: Object.fromEntries(Object.entries(durations).map(([outcome, values]) => [outcome, summarize(values)])),
      };
    },
  };
}

export = { createApprovalLatencyTracker };
