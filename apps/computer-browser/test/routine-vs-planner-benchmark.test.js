"use strict";

// Smoke coverage for integration/routine-vs-planner-benchmark.js. The real
// Electron run lives in that script's main(); everything asserted here uses a
// stateful fake chain browser so `npm test` needs no Electron, but drives the
// exact same TaskController/TaskStore/approval path in both modes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const bench = require("../integration/routine-vs-planner-benchmark");

const ORIGIN = "http://127.0.0.1:4173";

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-routine-bench-"));
}

function makeChainBrowser(steps) {
  let url = "about:blank";
  let counter = 0;
  const indexOf = (value) => Number(/\/step\/(\d+)$/.exec(value)?.[1] ?? -1);
  return {
    observe: async () => {
      const id = `obs-${counter++}`;
      const index = indexOf(url);
      if (index < 0) return { id, url, text: "", elements: [] };
      if (index === steps - 1) return { id, url, text: `Step ${steps} of ${steps} CHAIN-DONE-${steps}`, elements: [] };
      return {
        id,
        url,
        text: `Step ${index + 1} of ${steps}`,
        elements: [{ role: "link", name: "Next", href: `${ORIGIN}/step/${index + 1}`, elementId: `next-${index}` }],
      };
    },
    execute: async (action) => {
      if (action.type === "navigate") url = action.url;
      else if (action.type === "follow_link") url = `${ORIGIN}/step/${indexOf(url) + 1}`;
      else if (action.type === "scroll") { /* page state is unchanged */ }
      else throw new Error(`unsupported action ${action.type}`);
      return { status: "ok" };
    },
    dispose: async () => {},
  };
}

const STEPS = 6;

test("buildScenario yields one goal shared by both modes and a routine of the same length", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS });
  assert.equal(scenario.steps, STEPS);
  assert.equal(scenario.expectedUrls.length, STEPS);
  assert.equal(scenario.expectedUrls[0], `${ORIGIN}/step/0`);
  assert.match(scenario.goal.originalRequest, /http:\/\/127\.0\.0\.1:4173\/step\/0/);
  assert.equal(scenario.routine.steps.length, STEPS);
  assert.equal(scenario.routine.steps[0].kind, "navigate");
  assert.ok(scenario.routine.steps.slice(1).every((step) => step.kind === "follow_link" && step.name === "Next"));
  assert.throws(() => bench.buildScenario({ origin: ORIGIN, steps: 65 }), /steps/);
  assert.throws(() => bench.buildScenario({ origin: ORIGIN, steps: 1 }), /steps/);
});

test("pairedSchedule is deterministic per seed, runs each mode once per pair, and labels only the first pair cold", () => {
  const first = bench.pairedSchedule({ pairs: 8, seed: 7 });
  const again = bench.pairedSchedule({ pairs: 8, seed: 7 });
  assert.deepEqual(first, again);
  assert.equal(first.length, 8);
  for (const pair of first) assert.deepEqual([...pair.order].sort(), ["planner", "routine"]);
  assert.equal(first[0].temperature, "cold");
  assert.ok(first.slice(1).every((pair) => pair.temperature === "warm"));
  const orders = new Set(bench.pairedSchedule({ pairs: 40, seed: 3 }).map((pair) => pair.order.join(">")));
  assert.equal(orders.size, 2, "order must actually be randomized across a long run");
  const sixPairOrders = bench.pairedSchedule({ pairs: 6, seed: 29 }).map((pair) => pair.order.join(">"));
  assert.ok(sixPairOrders.includes("routine>planner") && sixPairOrders.includes("planner>routine"),
    "a small benchmark must counterbalance order instead of allowing one mode to run first in every pair");
});

test("summarize reports nearest-rank p50/p95 and tolerates empty input", () => {
  const stats = bench.summarize([5, 1, 3, 2, 4]);
  assert.equal(stats.count, 5);
  assert.equal(stats.minMs, 1);
  assert.equal(stats.p50Ms, 3);
  assert.equal(stats.p95Ms, 5);
  assert.equal(stats.maxMs, 5);
  assert.equal(stats.totalMs, 15);
  assert.equal(bench.summarize([]).count, 0);
});

for (const approvalMode of ["review", "allow"]) {
  test(`both modes run the same scenario to the same terminal state and record comparable fields (approval=${approvalMode})`, async () => {
    const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS });
    const results = {};
    for (const mode of ["routine", "planner"]) {
      results[mode] = await bench.runIteration({
        mode,
        scenario,
        approvalMode,
        storageRoot: await mkTempRoot(),
        createBrowser: async () => makeChainBrowser(STEPS),
      });
    }
    const { routine, planner } = results;
    for (const record of [routine, planner]) {
      assert.equal(record.success, true, record.error);
      assert.equal(record.finalState, "awaiting_verification");
      assert.equal(record.actions, STEPS);
      assert.equal(record.proposalCalls, STEPS + 1, "one proposal per action plus the finishing call");
      assert.deepEqual(record.visitedUrls, scenario.expectedUrls);
      assert.equal(record.policyChecks, STEPS);
      assert.equal(record.approvals, approvalMode === "review" ? STEPS : 0);
      assert.ok(record.runMs > 0);
      assert.ok(record.cleanupMs >= 0);
      assert.equal(record.stages.profile_resolution.count, 1);
      assert.ok(record.stages.journal_append_write.count > 0);
      assert.ok(record.stages.journal_fsync.count > 0);
      assert.ok(record.stages.checkpoint_file_write.count > 0);
      assert.ok(record.stages.checkpoint_file_fsync.count > 0);
      assert.ok(record.stages.browser_execute.count === STEPS);
      assert.equal(record.stages.approver_decision.count, STEPS);
      assert.equal(record.stages.approve_call_inclusive.count, approvalMode === "review" ? STEPS : 0);
      assert.equal(Object.hasOwn(record.stages, "durable_store"), false);
    }
    assert.deepEqual(Object.keys(routine).sort(), Object.keys(planner).sort(), "report rows must have identical fields in both modes");
    assert.equal(routine.plannerStartupMs, null, "a routine has no planner worker to start");
    assert.equal(typeof planner.plannerStartupMs, "number");
    assert.deepEqual(routine.resolvedProfile, { duration: "short", capability: "routine" });
    assert.deepEqual(planner.resolvedProfile, { duration: "middle", capability: "browser" });
    assert.ok(planner.plannerPids.length >= 1);
    assert.deepEqual(routine.plannerPids, []);
  });
}

test("a routine iteration never spawns a planner worker and a planner iteration never touches RoutineStore", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS });
  let plannersBuilt = 0;
  const makePlanner = (hooks) => {
    plannersBuilt += 1;
    return bench.defaultMakePlanner(hooks);
  };
  await bench.runIteration({ mode: "routine", scenario, approvalMode: "allow", storageRoot: await mkTempRoot(), createBrowser: async () => makeChainBrowser(STEPS), makePlanner });
  assert.equal(plannersBuilt, 0);
  const storageRoot = await mkTempRoot();
  await bench.runIteration({ mode: "planner", scenario, approvalMode: "allow", storageRoot, createBrowser: async () => makeChainBrowser(STEPS), makePlanner });
  assert.equal(plannersBuilt, 1);
  const entries = await fs.readdir(storageRoot);
  assert.equal(entries.some((name) => /routine/i.test(name)), false);
});

test("runBenchmark emits paired iterations with identical summary shapes and the mandatory caveats", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const report = await bench.runBenchmark({
    scenario,
    pairs: 3,
    seed: 11,
    approvalMode: "allow",
    storageRoot: await mkTempRoot(),
    createBrowser: async () => makeChainBrowser(STEPS),
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.iterations.length, 6);
  assert.deepEqual(report.iterations.map((row) => row.mode).sort(), ["planner", "planner", "planner", "routine", "routine", "routine"]);
  assert.deepEqual(report.iterations.filter((row) => row.pairIndex === 0).map((row) => row.temperature), ["cold", "cold"]);
  assert.ok(report.iterations.filter((row) => row.pairIndex > 0).every((row) => row.temperature === "warm"));
  assert.deepEqual(report.iterations.map((row) => row.sequence), [0, 1, 2, 3, 4, 5]);
  assert.ok(report.iterations.every((row) => row.success));

  assert.deepEqual(Object.keys(report.summary.routine).sort(), Object.keys(report.summary.planner).sort());
  assert.deepEqual(Object.keys(report.summary.routine.warm).sort(), Object.keys(report.summary.planner.warm).sort());
  assert.equal(report.summary.routine.warm.iterations, 2);
  assert.equal(report.summary.planner.cold.iterations, 1);
  assert.equal(typeof report.summary.planner.warm.runMs.p50Ms, "number");
  assert.equal(typeof report.summary.planner.warm.runMs.p95Ms, "number");
  assert.equal(report.summary.planner.warm.plannerStartupMs.count, 2);
  assert.equal(report.summary.routine.warm.plannerStartupMs.count, 0);
  assert.ok(report.summary.routine.warm.stageTotalMs.journal_fsync.p50Ms >= 0);
  assert.ok(report.summary.routine.warm.stageTotalMs.checkpoint_file_fsync.p50Ms >= 0);
  assert.equal(report.comparison.pairedRunMsDelta.count, 3);

  assert.equal(report.design.approvalMode, "allow");
  assert.equal(report.design.seed, 11);
  const limitations = report.limitations.join(" ");
  assert.match(limitations, /not a model-quality/i);
  assert.match(limitations, /not a hard memory ceiling/i);
  assert.match(limitations, /historical/i);
  assert.equal(report.memory, null, "no sampler was supplied");
});

test("runBenchmark fails closed when a mode diverges from the shared scenario", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const brokenBrowser = () => {
    const inner = makeChainBrowser(STEPS);
    return { ...inner, execute: async () => ({ status: "failed", errorCode: "boom" }) };
  };
  const record = await bench.runIteration({
    mode: "planner",
    scenario,
    approvalMode: "allow",
    storageRoot: await mkTempRoot(),
    createBrowser: async () => brokenBrowser(),
  });
  assert.equal(record.success, false);
  assert.equal(typeof record.error, "string");
  await assert.rejects(
    bench.runBenchmark({ scenario, pairs: 1, seed: 1, approvalMode: "allow", storageRoot: await mkTempRoot(), createBrowser: async () => brokenBrowser() }),
    /iteration failed/,
  );
});

test("runDurationProfileBenchmark pairs the same Browser planner workload across Middle and Long", async () => {
  const report = await bench.runDurationProfileBenchmark({
    scenario: bench.buildScenario({ origin: ORIGIN, steps: 3 }),
    pairs: 1,
    seed: 9,
    approvalMode: "allow",
    storageRoot: await mkTempRoot(),
    createBrowser: async () => makeChainBrowser(3),
  });
  assert.deepEqual(report.profiles, ["middle", "long"]);
  assert.equal(report.iterations.length, 2);
  assert.deepEqual(report.iterations.map((row) => row.resolvedProfile.duration).sort(), ["long", "middle"]);
  assert.ok(report.iterations.every((row) => row.success && row.resolvedProfile.capability === "browser"));
  assert.ok(report.iterations.every((row) => row.stages.profile_resolution.count === 1));
  assert.ok(report.iterations.every((row) => row.actions === 3 && row.visitedUrls.length === 3));
  assert.equal(report.summaryByTemperature.middle.cold.iterations, 1);
  assert.equal(report.summaryByTemperature.long.cold.iterations, 1);
  assert.equal(report.summaryByTemperature.middle.warm.iterations, 0);
  assert.equal(report.summaryByTemperature.long.warm.iterations, 0);
  assert.equal(report.comparison.pairedRunMsDelta.count, 1);
});

test("runRecoveryProbe reloads the same profile and preserves execution_uncertain on an open action", async () => {
  const result = await bench.runRecoveryProbe({
    storageRoot: await mkTempRoot(),
    durationProfile: "long",
    completedActions: 4,
    checkpointEvery: 2,
  });
  assert.equal(result.durationProfile, "long");
  assert.equal(result.reloadedDurationProfile, "long");
  assert.equal(result.recoveredReason, "recovered");
  assert.equal(result.uncertainReason, "execution_uncertain");
  assert.equal(result.completedActions, 4);
  assert.ok(result.journalReplayMs >= 0);
  assert.ok(result.timing.checkpoint_file_fsync.count > 0);
  assert.ok(result.timing.checkpoint_directory_fsync.count > 0);
});

test("buildScenario with scrollsPerPage adds distinct-amount scroll steps after every non-final page", () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: 4, scrollsPerPage: 2 });
  assert.equal(scenario.scrollsPerPage, 2);
  assert.equal(scenario.totalActions, 4 + 2 * 3);
  assert.equal(scenario.routine.steps.length, scenario.totalActions);
  assert.deepEqual(scenario.routine.steps.map((step) => step.kind), [
    "navigate", "scroll", "scroll", "follow_link", "scroll", "scroll", "follow_link", "scroll", "scroll", "follow_link",
  ]);
  const amounts = scenario.routine.steps.slice(1, 3).map((step) => step.amount);
  assert.equal(new Set(amounts).size, 2, "consecutive scrolls must differ or the no-progress detector fires");
  assert.equal(scenario.goal.limits.maxActions >= scenario.totalActions + 10, true);
  assert.equal(bench.buildScenario({ origin: ORIGIN, steps: 4 }).totalActions, 4);
  assert.throws(() => bench.buildScenario({ origin: ORIGIN, steps: 30, scrollsPerPage: 3 }), /64/);
  assert.throws(() => bench.buildScenario({ origin: ORIGIN, steps: 4, scrollsPerPage: -1 }), /scrollsPerPage/);
});

test("read-only batching cuts journal fsyncs in both modes on a scroll-heavy scenario without changing the outcome", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS, scrollsPerPage: 3 });
  for (const mode of ["routine", "planner"]) {
    const rows = {};
    for (const batching of [true, false]) {
      rows[batching] = await bench.runIteration({
        mode,
        scenario,
        batching,
        approvalMode: "allow",
        storageRoot: await mkTempRoot(),
        createBrowser: async () => makeChainBrowser(STEPS),
      });
      const record = rows[batching];
      assert.equal(record.success, true, record.error);
      assert.equal(record.batching, batching);
      assert.equal(record.actions, scenario.totalActions);
      assert.deepEqual(record.visitedUrls, scenario.expectedUrls);
      assert.equal(record.journalFsyncs, record.stages.journal_fsync.count);
    }
    assert.ok(rows[true].journalFsyncs < rows[false].journalFsyncs,
      `${mode}: batching should fsync less (${rows[true].journalFsyncs} vs ${rows[false].journalFsyncs})`);
    assert.ok(rows[true].policyChecks < rows[false].policyChecks, `${mode}: one approval per action type in a batch`);
  }
});

test("the scripted planner completes a scroll-heavy scenario under per-action review (batching off) and batch review (on)", async () => {
  const scenario = bench.buildScenario({ origin: ORIGIN, steps: STEPS, scrollsPerPage: 3 });
  const approvals = {};
  for (const batching of [true, false]) {
    const record = await bench.runIteration({
      mode: "planner",
      scenario,
      batching,
      approvalMode: "review",
      storageRoot: await mkTempRoot(),
      createBrowser: async () => makeChainBrowser(STEPS),
    });
    assert.equal(record.success, true, record.error);
    assert.equal(record.actions, scenario.totalActions);
    approvals[batching] = record.approvals;
  }
  assert.equal(approvals[false], scenario.totalActions, "per-action review queues every action");
  assert.ok(approvals[true] < approvals[false], "one review queue item per batch");
});
