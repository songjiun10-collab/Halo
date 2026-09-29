"use strict";

// Smoke coverage for integration/concurrent-throughput-benchmark.js. The real
// Electron run lives in that script's main(); everything asserted here uses a
// fake chain browser per task so `npm test` needs no Electron, but drives the
// real TaskHost admission/queue/lease path.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const routineBench = require("../integration/routine-vs-planner-benchmark");
const bench = require("../integration/concurrent-throughput-benchmark");

const ORIGIN = "http://127.0.0.1:4173";
const STEPS = 4;

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-concurrent-bench-"));
}

function makeChainBrowser(steps, { latencyMs = 0 } = {}) {
  let url = "about:blank";
  let counter = 0;
  const indexOf = (value) => Number(/\/step\/(\d+)$/.exec(value)?.[1] ?? -1);
  const wait = () => (latencyMs ? new Promise((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve());
  return {
    observe: async () => {
      const id = `obs-${counter++}`;
      const index = indexOf(url);
      if (index < 0) return { id, url, text: "", elements: [] };
      if (index === steps - 1) return { id, url, text: `Step ${steps} of ${steps} CHAIN-DONE-${steps}`, elements: [] };
      return { id, url, text: `Step ${index + 1} of ${steps}`, elements: [{ role: "link", name: "Next", href: `${ORIGIN}/step/${index + 1}`, elementId: `next-${index}` }] };
    },
    execute: async (action) => {
      await wait();
      if (action.type === "navigate") url = action.url;
      else if (action.type === "follow_link") url = `${ORIGIN}/step/${indexOf(url) + 1}`;
      else throw new Error(`unsupported action ${action.type}`);
      return { status: "ok" };
    },
    dispose: async () => {},
  };
}

const roomyMonitor = () => ({ getPressureLevel: () => "normal", canAdmitTask: () => ({ allowed: true }) });

test("concurrencySchedule is deterministic per seed, runs every level once per block, and labels only block 0 cold", () => {
  const first = bench.concurrencySchedule({ levels: [1, 2, 3, 4], repeats: 6, seed: 7 });
  assert.deepEqual(first, bench.concurrencySchedule({ levels: [1, 2, 3, 4], repeats: 6, seed: 7 }));
  assert.equal(first.length, 6);
  for (const block of first) assert.deepEqual([...block.order].sort(), [1, 2, 3, 4]);
  assert.equal(first[0].temperature, "cold");
  assert.ok(first.slice(1).every((block) => block.temperature === "warm"));
  assert.ok(new Set(first.map((block) => block.order.join(">"))).size > 1, "order must be randomized across blocks");
  assert.throws(() => bench.concurrencySchedule({ levels: [], repeats: 3 }), /levels/);
  assert.throws(() => bench.concurrencySchedule({ levels: [0, 2], repeats: 3 }), /levels/);
  assert.throws(() => bench.concurrencySchedule({ levels: [1, 2], repeats: 0 }), /repeats/);
});

test("runConcurrentIteration reaches the requested concurrency when slots and memory allow", async () => {
  const scenario = routineBench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const row = await bench.runConcurrentIteration({
    concurrency: 3,
    maxParallelTasks: 3,
    scenario,
    storageRoot: await mkTempRoot(),
    memoryMonitor: roomyMonitor(),
    reserveBytes: 100_000_000,
    createBrowser: () => makeChainBrowser(STEPS, { latencyMs: 5 }),
  });
  assert.equal(row.success, true, row.error);
  assert.equal(row.concurrency, 3);
  assert.equal(row.peakConcurrentBrowsers, 3);
  assert.equal(row.tasks.length, 3);
  assert.ok(row.tasks.every((task) => task.finalState === "awaiting_verification"));
  assert.ok(row.tasks.every((task) => task.startMs >= 0 && task.finishMs > task.startMs && task.runMs === task.finishMs - task.startMs));
  assert.equal(row.wallMs, Math.max(...row.tasks.map((task) => task.finishMs)));
  assert.ok(row.tasksPerMinute > 0);
  assert.equal(row.admittedImmediately, 3);
  assert.equal(row.waitedForSlot, 0);
});

test("with fewer slots than tasks every task still finishes, and peak concurrency stays at the slot cap", async () => {
  const scenario = routineBench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const row = await bench.runConcurrentIteration({
    concurrency: 4,
    maxParallelTasks: 2,
    scenario,
    storageRoot: await mkTempRoot(),
    memoryMonitor: roomyMonitor(),
    reserveBytes: 100_000_000,
    createBrowser: () => makeChainBrowser(STEPS, { latencyMs: 5 }),
  });
  assert.equal(row.success, true, row.error);
  assert.equal(row.peakConcurrentBrowsers, 2);
  assert.equal(row.tasks.length, 4);
  assert.ok(row.tasks.every((task) => task.finalState === "awaiting_verification"));
  assert.equal(row.admittedImmediately, 2);
  assert.equal(row.waitedForSlot, 2);
});

test("a stalled task fails the iteration at the timeout instead of hanging", async () => {
  const scenario = routineBench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const row = await bench.runConcurrentIteration({
    concurrency: 1,
    maxParallelTasks: 1,
    scenario,
    storageRoot: await mkTempRoot(),
    memoryMonitor: roomyMonitor(),
    reserveBytes: 100_000_000,
    timeoutMs: 150,
    createBrowser: () => ({ ...makeChainBrowser(STEPS), execute: () => new Promise(() => {}) }),
  });
  assert.equal(row.success, false);
  assert.match(row.error, /timed out/);
});

test("buildReport groups by concurrency and temperature and states its limits", async () => {
  const scenario = routineBench.buildScenario({ origin: ORIGIN, steps: STEPS });
  const schedule = bench.concurrencySchedule({ levels: [1, 2], repeats: 2, seed: 3 });
  const iterations = [];
  for (const block of schedule) {
    for (const level of block.order) {
      const row = await bench.runConcurrentIteration({
        concurrency: level, maxParallelTasks: level, scenario, storageRoot: await mkTempRoot(),
        memoryMonitor: roomyMonitor(), reserveBytes: 100_000_000,
        createBrowser: () => makeChainBrowser(STEPS, { latencyMs: 2 }),
        label: { repeat: block.repeat, temperature: block.temperature },
      });
      assert.equal(row.success, true, row.error);
      iterations.push(row);
    }
  }
  const report = bench.buildReport({ scenario, schedule, iterations, diagnostic: true, seed: 3 });
  assert.equal(report.kind, "concurrent-throughput-benchmark");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.design.diagnosticReserve, true);
  for (const level of ["1", "2"]) {
    assert.equal(report.summary[level].cold.iterations, 1);
    assert.equal(report.summary[level].warm.iterations, 1);
    assert.ok(report.summary[level].warm.tasksPerMinute.p50 > 0);
  }
  assert.ok(Array.isArray(report.limitations) && report.limitations.length > 0);
});
