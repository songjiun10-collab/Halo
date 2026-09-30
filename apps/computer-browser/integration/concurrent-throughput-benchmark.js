"use strict";

// N routine tasks submitted at once through the real TaskHost (queue, slot cap,
// memory admission, leases). Only the browser is injectable: real Electron
// WebContentsViews under main(), a fake chain browser in the smoke test.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const { TaskHost } = require("../main/harness/task-host");
const { mulberry32, buildScenario } = require("./routine-vs-planner-benchmark");

const SAMPLE_MS = 100;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_DIAGNOSTIC_RESERVE_BYTES = 50_000_000;

const LIMITATIONS = [
  "Routine-only workload against a local fixture; page load and CPU contention on other sites will differ.",
  "RSS is poll-sampled at the reported cadence, not a hard ceiling. Per-task increment is (peak - baseline) / N and the baseline includes residue from earlier iterations.",
  "Approval is an in-process allow stand-in; every task ends in awaiting_verification and is then stopped to release its slot, so slot release is not a human-paced wait.",
  "Production admission mode uses TaskHost's real reserve rules. Diagnostic mode passes a small parallelTaskReserveBytes so admission cannot bind, and its numbers must not be read as what production would admit.",
  "Percentiles need enough repeats; the warm group has repeats - 1 samples per level.",
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stat(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))] ?? 0;
  return { count: values.length, min: sorted[0] ?? 0, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

function concurrencySchedule({ levels, repeats, seed = 1 } = {}) {
  if (!Array.isArray(levels) || levels.length === 0 || !levels.every((level) => Number.isInteger(level) && level >= 1 && level <= 8)) {
    throw new TypeError("levels must be a non-empty array of integers from 1 to 8");
  }
  if (!Number.isInteger(repeats) || repeats < 1) throw new TypeError("repeats must be a positive integer");
  const random = mulberry32(seed);
  return Array.from({ length: repeats }, (_, repeat) => {
    const order = [...levels];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    return { repeat, temperature: repeat === 0 ? "cold" : "warm", order };
  });
}

function observeAdmission(monitor, denials) {
  return new Proxy(monitor, {
    get(target, key) {
      const value = target[key];
      if (key === "canAdmitTask") {
        return (args) => {
          const result = target.canAdmitTask(args);
          if (!result.allowed) denials[result.reason] = (denials[result.reason] || 0) + 1;
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runConcurrentIteration({
  concurrency,
  maxParallelTasks,
  scenario,
  storageRoot,
  memoryMonitor,
  reserveBytes,
  createBrowser,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sampler = null,
  settleMs = 0,
  label = {},
}) {
  const denials = {};
  let live = 0;
  let peakConcurrentBrowsers = 0;
  const tasks = new Map();
  const stops = [];
  let host = null;
  let timer = null;
  let t0 = 0;
  let resolveAll;
  const allFinished = new Promise((resolve) => { resolveAll = resolve; });
  const row = {
    ...label, concurrency, maxParallelTasks, reserveMode: reserveBytes === undefined ? "production" : "diagnostic",
    success: false, error: null, tasks: [], wallMs: 0, tasksPerMinute: 0,
    peakConcurrentBrowsers: 0, admittedImmediately: 0, waitedForSlot: 0, denials, memory: null,
  };

  try {
    const iterationRoot = await fs.mkdtemp(path.join(storageRoot, "iter-"));
    host = new TaskHost({
      storageRoot: iterationRoot,
      executionMode: "parallel",
      maxParallelTasks,
      parallelTaskReserveBytes: reserveBytes,
      memoryMonitor: memoryMonitor ? observeAdmission(memoryMonitor, denials) : undefined,
      makeBrowser: (taskId) => {
        const browser = createBrowser(taskId);
        live += 1;
        peakConcurrentBrowsers = Math.max(peakConcurrentBrowsers, live);
        const dispose = browser.dispose?.bind(browser);
        let disposed = false;
        browser.dispose = async () => {
          if (!disposed) { disposed = true; live -= 1; }
          await dispose?.();
        };
        return browser;
      },
      makePlanner: () => { throw new Error("a routine task must never build a planner worker"); },
      hostVerifier: () => true,
      approve: async () => ({ decision: "allow", reasons: [] }),
    });
    const saved = await host.saveRoutine(scenario.routine);

    host.onEvent((taskId, snapshot) => {
      let task = tasks.get(taskId);
      if (!task) {
        task = { taskId, startMs: performance.now() - t0, finishMs: null, finalState: snapshot.state };
        tasks.set(taskId, task);
      }
      if (task.finishMs !== null) return;
      task.finalState = snapshot.state;
      if (snapshot.state === "awaiting_verification") {
        task.finishMs = performance.now() - t0;
        stops.push(host.stopTask(taskId).catch(() => {}));
        if ([...tasks.values()].filter((item) => item.finishMs !== null).length === concurrency) resolveAll();
      }
    });

    if (sampler) await sampler.begin();
    t0 = performance.now();
    const submitted = Array.from({ length: concurrency }, () => host.runRoutine(saved.routineId, saved.revision));
    // The iteration timeout may win before the aggregate Promise.race below
    // observes every submitted Task. Keep a rejection handler attached from
    // submission time so a host shutdown racing a slow admission path cannot
    // surface as an unrelated unhandledRejection after the benchmark row is
    // already classified as timed out.
    for (const pending of submitted) pending.catch(() => {});
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`iteration timed out after ${timeoutMs} ms`)), timeoutMs); });
    await Promise.race([allFinished, timeout]);
    const results = await Promise.race([Promise.all(submitted), timeout]);
    await Promise.all(stops);

    row.waitedForSlot = results.filter((result) => result.snapshot?.state === "queued").length;
    row.admittedImmediately = concurrency - row.waitedForSlot;
    row.tasks = [...tasks.values()].map((task) => ({
      taskId: task.taskId, startMs: task.startMs, finishMs: task.finishMs,
      runMs: task.finishMs - task.startMs, queueWaitMs: task.startMs, finalState: task.finalState,
    }));
    row.wallMs = Math.max(...row.tasks.map((task) => task.finishMs));
    row.tasksPerMinute = (concurrency / row.wallMs) * 60_000;
    row.success = row.tasks.length === concurrency && row.tasks.every((task) => task.finalState === "awaiting_verification");
    if (!row.success) row.error = `expected ${concurrency} finished tasks, saw ${row.tasks.length}`;
  } catch (error) {
    row.error = String(error?.message || error);
    row.tasks = [...tasks.values()].map((task) => ({
      taskId: task.taskId, startMs: task.startMs, finishMs: task.finishMs,
      runMs: task.finishMs === null ? null : task.finishMs - task.startMs, queueWaitMs: task.startMs, finalState: task.finalState,
    }));
  } finally {
    clearTimeout(timer);
    row.peakConcurrentBrowsers = peakConcurrentBrowsers;
    if (sampler) {
      const memory = await sampler.end().catch(() => null);
      if (memory) row.memory = { ...memory, incrementPerTaskBytes: (memory.peakBytes - memory.baselineBytes) / concurrency };
    }
    if (host) await Promise.race([host.close().catch(() => {}), delay(5000)]);
    if (settleMs) await delay(settleMs);
  }
  return row;
}

function summarizeGroup(rows) {
  const allTasks = rows.flatMap((row) => row.tasks.filter((task) => task.runMs !== null));
  const perTaskBytes = rows.map((row) => row.memory?.incrementPerTaskBytes).filter(Number.isFinite);
  const peakBytes = rows.map((row) => row.memory?.peakBytes).filter(Number.isFinite);
  const denials = {};
  for (const row of rows) for (const [reason, count] of Object.entries(row.denials || {})) denials[reason] = (denials[reason] || 0) + count;
  return {
    iterations: rows.length,
    wallMs: stat(rows.map((row) => row.wallMs)),
    tasksPerMinute: stat(rows.map((row) => row.tasksPerMinute)),
    runMs: stat(allTasks.map((task) => task.runMs)),
    queueWaitMs: stat(allTasks.map((task) => task.queueWaitMs)),
    peakConcurrentBrowsers: Math.max(0, ...rows.map((row) => row.peakConcurrentBrowsers)),
    admittedImmediately: rows.reduce((sum, row) => sum + row.admittedImmediately, 0),
    waitedForSlot: rows.reduce((sum, row) => sum + row.waitedForSlot, 0),
    denials,
    peakRssBytes: stat(peakBytes),
    incrementPerTaskBytes: stat(perTaskBytes),
  };
}

function buildReport({ scenario, schedule, iterations, diagnostic, seed, extra = {} }) {
  const levels = [...new Set(schedule.flatMap((block) => block.order))].sort((a, b) => a - b);
  const ok = iterations.filter((row) => row.success);
  const summary = {};
  for (const level of levels) {
    summary[level] = {};
    for (const temperature of ["cold", "warm"]) {
      summary[level][temperature] = summarizeGroup(ok.filter((row) => row.concurrency === level && row.temperature === temperature));
    }
  }
  return {
    kind: "concurrent-throughput-benchmark",
    schemaVersion: 1,
    scenario: { steps: scenario.steps, origin: scenario.origin, startUrl: scenario.startUrl },
    design: {
      levels, repeats: schedule.length, seed, diagnosticReserve: Boolean(diagnostic), sampleIntervalMs: SAMPLE_MS,
      schedule: schedule.map((block) => ({ repeat: block.repeat, temperature: block.temperature, order: block.order })),
    },
    iterations,
    failures: iterations.filter((row) => !row.success).map((row) => ({ concurrency: row.concurrency, repeat: row.repeat, error: row.error })),
    summary,
    limitations: LIMITATIONS,
    ...extra,
  };
}

async function runBenchmark({ scenario, levels, repeats, seed, diagnostic, reserveBytes, storageRoot, createBrowser, memoryMonitor, sampler, settleMs, timeoutMs }) {
  const schedule = concurrencySchedule({ levels, repeats, seed });
  const iterations = [];
  for (const block of schedule) {
    for (const level of block.order) {
      iterations.push(await runConcurrentIteration({
        concurrency: level,
        maxParallelTasks: level,
        scenario, storageRoot, memoryMonitor, createBrowser, sampler, settleMs, timeoutMs,
        reserveBytes: diagnostic ? reserveBytes : undefined,
        label: { repeat: block.repeat, temperature: block.temperature, sequence: iterations.length },
      }));
    }
  }
  return buildReport({ scenario, schedule, iterations, diagnostic, seed });
}

function getExternalMemoryBytes(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
      if (error) return resolve(null);
      const kb = Number(stdout.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

function envInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
}

async function main() {
  const { app, BrowserWindow, WebContentsView } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const { MemoryMonitor } = require("../main/harness/memory-monitor");
  const { startLongHorizon100Site } = require("../fixtures/long-horizon-100-site");

  const levels = (process.env.HALO_BENCH_LEVELS || "1,2,3,4").split(",").map(Number);
  const repeats = envInt("HALO_BENCH_REPEATS", 4, { min: 2, max: 50 });
  const steps = envInt("HALO_BENCH_STEPS", 20, { min: 2, max: 64 });
  const seed = envInt("HALO_BENCH_SEED", 1, { min: 0, max: 2 ** 31 });
  const settleMs = envInt("HALO_BENCH_SETTLE_MS", 500, { min: 0, max: 10_000 });
  const modeRaw = process.env.HALO_BENCH_RESERVE_MODE || "production";
  if (!["production", "diagnostic"].includes(modeRaw)) throw new RangeError("HALO_BENCH_RESERVE_MODE must be production|diagnostic");
  const diagnostic = modeRaw === "diagnostic";
  const reserveBytes = envInt("HALO_BENCH_DIAGNOSTIC_RESERVE_BYTES", DEFAULT_DIAGNOSTIC_RESERVE_BYTES, { min: 1, max: 1_000_000_000 });

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const fixture = await startLongHorizon100Site({ steps });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-concurrent-bench-"));
  const scenario = buildScenario({ origin: new URL(fixture.url).origin, steps });
  const monitor = new MemoryMonitor({ getAppMetrics: () => app.getAppMetrics(), getExternalMemoryBytes });

  let running = true;
  let active = null;
  let lastTotal = 0;
  const sampleLoop = (async () => {
    while (running) {
      const sample = await monitor.sample();
      lastTotal = sample.totalBytes;
      if (active) active.values.push(sample.totalBytes);
      await delay(SAMPLE_MS);
    }
  })();
  const sampler = {
    begin: async () => {
      const baseline = (await monitor.sample()).totalBytes;
      active = { baselineBytes: baseline, values: [] };
    },
    end: async () => {
      const done = active;
      active = null;
      const values = done.values.length ? done.values : [lastTotal];
      return { baselineBytes: done.baselineBytes, peakBytes: Math.max(...values), sampleCount: done.values.length };
    },
  };

  let exitCode = 0;
  try {
    // Warm the monitor so the first admission check never sees a stale sample.
    await monitor.sample();
    const report = await runBenchmark({
      scenario, levels, repeats, seed, diagnostic, reserveBytes, storageRoot, memoryMonitor: monitor, sampler, settleMs,
      createBrowser: (taskId) => {
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `halo-conc-bench-${taskId}` } });
        win.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
        view.setVisible(false);
        return new BrowserAdapter({ view });
      },
    });
    report.environment = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, reserveBytes: diagnostic ? reserveBytes : "production" };
    if (report.failures.length) exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify(report)}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "concurrent-throughput-benchmark", error: String(error?.stack || error) })}\n`);
  } finally {
    running = false;
    await sampleLoop.catch(() => {});
    await fixture.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

module.exports = { LIMITATIONS, concurrencySchedule, runConcurrentIteration, buildReport, runBenchmark, stat };

// process.argv[1] resolved against __filename, not require.main === module --
// see the matching comment in routine-vs-planner-benchmark.js. Under Electron's
// main process, require.main is Electron's own bootstrap module, never this
// script, so require.main === module alone would make this file's own direct
// invocation never call main() either.
const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return require.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();
if (isDirectInvocation) {
  main().catch((error) => {
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "concurrent-throughput-benchmark", error: String(error?.stack || error) })}\n`);
    require("electron").app.exit(1);
  });
}
