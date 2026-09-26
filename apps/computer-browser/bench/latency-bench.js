"use strict";

// Repeatable harness demonstrating that the latency instrumentation added to
// ControlApi (see main/control-api.js's _recordMetric/getMetricsSummary,
// shared/metrics.js) actually produces meaningful count/p50/p95/outcome
// numbers, per the bottleneck-analysis request.
//
// IMPORTANT -- these are SIMULATED latencies, not measured production
// numbers. requestDecision/navigate/_findFirstOutboundLink are mocked with
// artificial delays in this script; there is no live Electron app, real
// approver process, or real external site involved (consistent with this
// project's standing rule to prefer localhost/fixtures over live external
// browsing for verification). The delay ranges below are rough, documented
// guesses at plausible real-world shapes:
//   - decision_wait: a local Unix socket round-trip to the already-running
//     Python approver -- normally fast, with an occasional spike modeling
//     approver-client.js's ENOENT reconnect backoff.
//   - navigation:    a real page load -- normally hundreds of ms to a few
//     seconds, with a rare timeout at the configured bound.
//   - dom_read:      one bounded executeJavaScript anchor scan -- small.
//   - queue_wait:    a HUMAN reviewer's response time -- seconds, highly
//     variable; modeled here only to exercise the metric, not to claim
//     anything about real review latency.
// Getting real numbers requires running this against the actual Electron
// app (see docs/superpowers/specs/2026-09-26-computer-use-browser-design.md
// for the CDP-based verification already done for other features) --
// out of scope for this script and for this session.
//
// Usage: node bench/latency-bench.js [iterations]

const { ControlApi } = require("../main/control-api");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

async function runOnce(api, i) {
  // Roughly 1 in 12 review-eligible actions to also exercise queue_wait.
  const willReview = i % 12 === 0;
  api.__nextDecision = willReview ? "review" : "allow";
  await api.performGatedAction(
    { requestId: `bench-${i}`, action: "navigate", summary: `bench action ${i}` },
    async () => {
      await sleep(randRange(150, 900));
    },
  );
  if (willReview) {
    await sleep(randRange(0, 5)); // negligible -- the simulated "human" delay is injected below
    const pending = api.getSnapshot().approvalQueue.at(-1);
    if (pending) await api.approve(pending.id);
  }
  await api._findFirstOutboundLink();
}

async function main() {
  const iterations = Number(process.argv[2]) || 200;

  const api = new ControlApi({
    window: {},
    socketPath: "/tmp/bench.sock",
    minAgentActionIntervalMs: 0, // isolate the metrics being benchmarked from the pacing floor
    requestDecision: async () => {
      const spike = Math.random() < 0.05;
      await sleep(spike ? randRange(200, 500) : randRange(5, 30));
      return { decision: api.__nextDecision || "allow", reasons: api.__nextDecision === "review" ? ["bench"] : [] };
    },
  });
  api._task = { id: "bench-task", state: "running", pauseReason: null };
  api._findFirstOutboundLink = async () => {
    const start = Date.now();
    await sleep(randRange(5, 40));
    api._recordMetric("dom_read", Date.now() - start, { outcome: "not_found" });
    return null;
  };
  // Directly patch _createdAtMs downward on queued items to simulate a
  // multi-second human review delay without slowing this script down for
  // real -- everything else in this harness uses real setTimeout delays.
  const originalPush = Array.prototype.push;
  api._approvalQueue.push = function patchedPush(...items) {
    for (const item of items) item._createdAtMs -= randRange(2000, 15000);
    return originalPush.apply(this, items);
  };

  for (let i = 0; i < iterations; i++) {
    await runOnce(api, i);
  }

  const summary = api.getMetricsSummary();
  console.log(`\nSimulated latency summary over ${iterations} actions (SIMULATED, not measured production data):\n`);
  for (const [kind, stats] of Object.entries(summary)) {
    console.log(
      `  ${kind.padEnd(14)} count=${String(stats.count).padEnd(5)} p50=${String(Math.round(stats.p50)).padEnd(6)}ms ` +
        `p95=${String(Math.round(stats.p95)).padEnd(6)}ms outcomes=${JSON.stringify(stats.outcomes)}`,
    );
  }
  console.log("");
}

main();
