// Generated from runtime-src/integration/approval-latency.ts. Do not edit; run npm run build:runtime.
"use strict";
// Benchmark-only. These inclusive latencies are not durable execution evidence.
const { performance } = require("node:perf_hooks");
const { summarize } = require("./stage-spans");
function createApprovalLatencyTracker({ now = () => performance.now(), onSample = () => { } } = {}) {
    const durations = { success: [], failed: [], execution_uncertain: [] };
    let started = null;
    return {
        begin() { started = now(); },
        clear() { started = null; },
        complete(outcome) {
            if (!Object.hasOwn(durations, outcome))
                throw new RangeError("invalid approval latency outcome");
            if (started === null)
                return null;
            const elapsedMs = Math.max(0, now() - started);
            started = null;
            durations[outcome].push(elapsedMs);
            const sample = { outcome, elapsedMs };
            try {
                onSample(sample);
            }
            catch { /* telemetry is not execution authority */ }
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
module.exports = { createApprovalLatencyTracker };
