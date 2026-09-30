"use strict";

// Pure, dependency-free latency-summary helpers. Kept separate from
// control-api.js so the percentile math is directly unit-testable without
// Electron and without needing real elapsed time.

function percentile(sortedAscending, p) {
  if (!Array.isArray(sortedAscending) || sortedAscending.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(sortedAscending.length - 1, Math.floor(clamped * sortedAscending.length));
  return sortedAscending[index];
}

// records: [{ kind, ms, outcome?, at, ... }]. Grouped by `kind`; each group
// reports count, p50/p95 of `ms`, and a breakdown of `outcome` values (an
// unset outcome counts as "ok") -- this is the per-stage failure-reason
// tally the bottleneck analysis asked for, not just a single latency number.
function summarizeMetrics(records) {
  const byKind = new Map();
  for (const record of records) {
    if (!byKind.has(record.kind)) byKind.set(record.kind, []);
    byKind.get(record.kind).push(record);
  }
  const summary = {};
  for (const [kind, group] of byKind) {
    const durations = group.map((r) => r.ms).slice().sort((a, b) => a - b);
    const outcomes = {};
    for (const record of group) {
      const key = record.outcome || "ok";
      outcomes[key] = (outcomes[key] || 0) + 1;
    }
    summary[kind] = { count: group.length, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), outcomes };
  }
  return summary;
}

module.exports = { percentile, summarizeMetrics };
