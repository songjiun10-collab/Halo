"use strict";

// Paired benchmark: the same deterministic local page chain driven by a saved
// routine (RoutineRunner) versus the existing scripted planner worker. Both
// modes share the browser adapter, TaskController, TaskStore, approval path,
// viewport and success criterion; the ONLY difference is who proposes the next
// action. This measures harness overhead of the proposal source, not model
// quality, and it does not replace the historical one-shot 100-page numbers.
//
// Run from apps/computer-browser:
//   node_modules/.bin/electron integration/routine-vs-planner-benchmark.js
// Env: HALO_BENCH_STEPS (2..64, default 50), HALO_BENCH_PAIRS (>=2, default 6),
//   HALO_BENCH_SEED (default 1), HALO_BENCH_APPROVAL (review|allow, default
//   review), HALO_BENCH_SCROLLS_PER_PAGE (0..5, default 0) and
//   HALO_BENCH_BATCHING (on|off, default on; only matters with scrolls). Emits RESULT_JSON:<json>; exits nonzero on any failed iteration.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { RoutineStore } = require("../main/harness/routine-store");
const { RoutineRunner } = require("../main/harness/routine-runner");

const APP_ROOT = path.resolve(__dirname, "..");
const PLANNER_SCRIPT = path.join(APP_ROOT, "fixtures", "scripted-planner-100.js");
const MAX_ROUTINE_STEPS = 64;
const MODES = ["routine", "planner"];
const STAGE_LABELS = [
  "action_policy_decision", "approver_decision", "approve_call_inclusive", "proposal",
  "browser_observe", "browser_execute", "journal_prepare", "journal_append_write",
  "journal_fsync", "checkpoint_file_write", "checkpoint_file_fsync", "checkpoint_rename",
  "checkpoint_directory_fsync",
];
const SAMPLE_MS = 100;

const LIMITATIONS = [
  "This is not a model-quality benchmark: the planner mode is a deterministic scripted worker, so it isolates harness cost of the proposal source only.",
  "Memory figures are poll-sampled RSS at the reported cadence; they are not a hard memory ceiling and can miss spikes between samples.",
  "The historical one-shot 100-page results (browser-only vs full harness) are a different, non-feature-equivalent comparison and must not be read as planner-versus-routine.",
  "Approval is simulated immediately (programmatic), so approval latency is harness-only and excludes any human wait.",
  "Neither mode goes through TaskHost, so host memory admission is not exercised; approval is an in-process stand-in for the Python approver.",
  "plannerStartupMs is only the worker spawn call; worker boot time is inside proposalFirstCallMs and is excluded from proposalRoundtripMs.",
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile: p95 with five observations is the maximum, not
  // the fourth order statistic (floor((n - 1) * .95)).
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))];
  return {
    count: values.length,
    minMs: sorted[0] ?? 0,
    p50Ms: at(0.5) ?? 0,
    p95Ms: at(0.95) ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    totalMs: values.reduce((sum, value) => sum + value, 0),
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairedSchedule({ pairs, seed = 1 } = {}) {
  if (!Number.isInteger(pairs) || pairs < 1) throw new TypeError("pairs must be a positive integer");
  const random = mulberry32(seed);
  // Counterbalance first-vs-second order before shuffling. Pure independent
  // coin flips can put every small-N pair in the same order (the original
  // seed 29 / six-pair run did), systematically giving one mode a warmer
  // fixture/cache state. This keeps counts within one while preserving a
  // reproducible randomized order.
  const routineFirstCount = Math.floor(pairs / 2) + (pairs % 2 && random() < 0.5 ? 1 : 0);
  const orders = Array.from({ length: pairs }, (_, index) => index < routineFirstCount
    ? ["routine", "planner"]
    : ["planner", "routine"]);
  for (let index = orders.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [orders[index], orders[other]] = [orders[other], orders[index]];
  }
  return orders.map((order, pairIndex) => ({
    pairIndex,
    temperature: pairIndex === 0 ? "cold" : "warm",
    order,
  }));
}

// Scroll amounts must differ within a page: the controller's no-progress
// detector keys on (action, target, observation) and would otherwise flag
// identical consecutive scrolls of an unchanged page.
function scrollAmount(index) {
  return 200 + 100 * index;
}

function buildScenario({ origin, steps, scrollsPerPage = 0 }) {
  if (!Number.isInteger(steps) || steps < 2 || steps > MAX_ROUTINE_STEPS) {
    throw new TypeError(`steps must be an integer from 2 to ${MAX_ROUTINE_STEPS}`);
  }
  if (!Number.isInteger(scrollsPerPage) || scrollsPerPage < 0 || scrollsPerPage > 5) {
    throw new TypeError("scrollsPerPage must be an integer from 0 to 5");
  }
  const totalActions = steps + scrollsPerPage * (steps - 1);
  if (totalActions > MAX_ROUTINE_STEPS) {
    throw new TypeError(`routine would need ${totalActions} steps; the routine cap is ${MAX_ROUTINE_STEPS}`);
  }
  const startUrl = `${origin}/step/0`;
  const expectedUrls = Array.from({ length: steps }, (_, index) => `${origin}/step/${index}`);
  const scrolls = () => Array.from({ length: scrollsPerPage }, (_, index) => ({ kind: "scroll", direction: "down", amount: scrollAmount(index) }));
  const routineSteps = [{ kind: "navigate", url: startUrl }];
  expectedUrls.forEach((url, index) => {
    if (index > 0) routineSteps.push({ kind: "follow_link", name: "Next", expectedHref: url });
    if (index < steps - 1) routineSteps.push(...scrolls());
  });
  return {
    steps,
    scrollsPerPage,
    totalActions,
    origin,
    startUrl,
    expectedUrls,
    goal: {
      originalRequest: `Walk the local ${steps}-page chain from ${startUrl} and confirm the final page.`,
      criteria: [{ id: "chain-complete", text: `reached page ${steps}`, required: true, verification: "user" }],
      limits: { maxActions: totalActions + 20, maxPlannerCalls: totalActions + 50, maxActiveMs: 30 * 60 * 1000 },
    },
    routine: {
      name: `Benchmark ${steps}-page chain`,
      origins: [origin],
      steps: routineSteps,
    },
  };
}

function defaultMakePlanner({ onWorkerStart, onWorkerExit, scrollsPerPage = 0 } = {}) {
  return new PlannerStdioAdapter({
    command: process.execPath,
    args: [PLANNER_SCRIPT],
    cwd: APP_ROOT,
    env: { ELECTRON_RUN_AS_NODE: "1", HALO_BENCH_SCROLLS_PER_PAGE: String(scrollsPerPage) },
    onWorkerStart,
    onWorkerExit,
  });
}

function emptyStages() {
  return Object.fromEntries(STAGE_LABELS.map((label) => [label, { count: 0, totalMs: 0, maxMs: 0 }]));
}

function timedCall(stages, label, fn) {
  return async (...args) => {
    const started = performance.now();
    try { return await fn(...args); }
    finally {
      recordDuration(stages, label, performance.now() - started);
    }
  };
}

function recordDuration(stages, label, elapsedMs) {
  const item = stages[label];
  item.count += 1;
  item.totalMs += elapsedMs;
  item.maxMs = Math.max(item.maxMs, elapsedMs);
}

async function runIteration({
  mode,
  scenario,
  createBrowser,
  storageRoot,
  approvalMode = "review",
  batching = true,
  makePlanner = defaultMakePlanner,
  sampler,
  label = {},
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`mode must be one of ${MODES.join("|")}`);
  if (!["review", "allow"].includes(approvalMode)) throw new TypeError("approvalMode must be review|allow");

  const stages = emptyStages();
  const visitedUrls = [];
  const proposalSamples = [];
  const plannerPids = [];
  const record = {
    mode,
    pairIndex: label.pairIndex ?? null,
    temperature: label.temperature ?? null,
    sequence: label.sequence ?? null,
    approvalMode,
    batching: batching !== false,
    success: false,
    error: null,
    finalState: null,
    actions: 0,
    proposalCalls: 0,
    policyChecks: 0,
    approvals: 0,
    journalFsyncs: 0,
    visitedUrls,
    finalUrl: null,
    runMs: 0,
    plannerStartupMs: null,
    proposalFirstCallMs: null,
    proposalRoundtripMs: summarize([]),
    cleanupMs: 0,
    plannerPids,
    stages,
  };

  let browser = null;
  let store = null;
  let planner = null;
  let routineRoot = null;
  sampler?.enter?.({ mode, ...label });
  try {
    browser = await createBrowser();
    const observe = browser.observe.bind(browser);
    browser.observe = timedCall(stages, "browser_observe", async (...args) => {
      const observation = await observe(...args);
      const url = observation?.url;
      if (url && url !== "about:blank" && visitedUrls.at(-1) !== url) visitedUrls.push(url);
      return observation;
    });
    browser.execute = timedCall(stages, "browser_execute", browser.execute.bind(browser));

    store = await TaskStore.create(JSON.parse(JSON.stringify(scenario.goal)), {
      storageRoot,
      onTiming: ({ operation, elapsedMs }) => {
        // TaskStore exposes a closed timing vocabulary. Ignore anything else
        // rather than turning arbitrary callback metadata into metric labels.
        if (Object.hasOwn(stages, operation)) recordDuration(stages, operation, elapsedMs);
      },
    });

    let proposer;
    const routineOptions = {};
    if (mode === "routine") {
      routineRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-bench-routine-"));
      const saved = await new RoutineStore({ storageRoot: routineRoot }).save(scenario.routine);
      const runner = new RoutineRunner({ definition: saved, cursor: 0, batchReadOnlySteps: true });
      proposer = runner;
      routineOptions.routineRunner = runner;
      routineOptions.routineRun = { routineId: saved.routineId, revision: saved.revision, digest: saved.digest, cursor: 0 };
      await store.checkpoint({ task: { state: "idle", pauseReason: null }, routineRun: routineOptions.routineRun });
    } else {
      planner = makePlanner({
        scrollsPerPage: scenario.scrollsPerPage ?? 0,
        onWorkerStart: ({ pid, creationTime }) => { plannerPids.push(pid); sampler?.registerPlanner?.(pid, creationTime); },
        onWorkerExit: ({ pid, creationTime }) => sampler?.unregisterPlanner?.(pid, creationTime),
      });
      proposer = planner;
      const warmStarted = performance.now();
      planner.warm?.();
      record.plannerStartupMs = performance.now() - warmStarted;
    }

    const wrappedProposer = {
      next: async (context, options) => {
        const started = performance.now();
        try { return await proposer.next(context, options); }
        finally { proposalSamples.push(performance.now() - started); }
      },
    };
    const approve = timedCall(stages, "approver_decision", async () => {
      record.policyChecks += 1;
      return approvalMode === "allow"
        ? { decision: "allow", reasons: [] }
        : { decision: "review", reasons: ["benchmark_review"] };
    });

    const controller = new TaskController({
      store,
      planner: wrappedProposer,
      browser,
      approve,
      hostVerifier: () => undefined,
      batchReadOnlyActions: batching !== false,
      ...routineOptions,
    });
    const evaluatePolicy = controller._evaluateActionPolicy.bind(controller);
    controller._evaluateActionPolicy = (...args) => {
      const started = performance.now();
      try { return evaluatePolicy(...args); }
      finally { recordDuration(stages, "action_policy_decision", performance.now() - started); }
    };

    const startedAt = performance.now();
    while (true) {
      const snapshot = controller.getSnapshot();
      if (snapshot.state === "awaiting_verification" || snapshot.state === "completed") break;
      if (performance.now() - startedAt > timeoutMs) throw new Error(`iteration exceeded ${timeoutMs}ms`);
      if (snapshot.state === "idle") {
        await controller.start();
      } else if (snapshot.state === "awaiting_approval") {
        const item = snapshot.approvalQueue[0];
        if (!item) throw new Error("awaiting_approval without a queued item");
        const approvalStarted = performance.now();
        try { await controller.approve(item.id); }
        finally { recordDuration(stages, "approve_call_inclusive", performance.now() - approvalStarted); }
        record.approvals += 1;
      } else if (snapshot.state === "running") {
        await delay(2);
      } else {
        throw new Error(`unexpected task state ${snapshot.state} (${snapshot.pauseReason || "no reason"})`);
      }
    }
    record.runMs = performance.now() - startedAt;

    const finalSnapshot = controller.getSnapshot();
    record.finalState = finalSnapshot.state;
    record.actions = finalSnapshot.budgets.actionsUsed;
    // TaskController calls this shared budget `plannerCallsUsed`; for the
    // routine mode the same units are RoutineRunner turns, not model calls.
    record.proposalCalls = finalSnapshot.budgets.plannerCallsUsed;
    record.finalUrl = visitedUrls.at(-1) ?? null;
    record.proposalFirstCallMs = proposalSamples[0] ?? null;
    record.proposalRoundtripMs = summarize(proposalSamples.slice(1));

    if (record.finalState !== "awaiting_verification") throw new Error(`final state ${record.finalState}, expected awaiting_verification`);
    const expectedActions = scenario.totalActions ?? scenario.steps;
    if (record.actions !== expectedActions) throw new Error(`dispatched ${record.actions} actions, expected ${expectedActions}`);
    record.journalFsyncs = stages.journal_fsync.count;
    if (JSON.stringify(visitedUrls) !== JSON.stringify(scenario.expectedUrls)) {
      throw new Error(`visited pages diverged from the shared scenario: ${JSON.stringify(visitedUrls)}`);
    }
    record.success = true;
  } catch (error) {
    record.error = String(error?.stack || error);
  } finally {
    const cleanupStarted = performance.now();
    if (planner) await planner.close().catch(() => {});
    if (browser?.dispose) await browser.dispose().catch(() => {});
    if (store) await store.close().catch(() => {});
    if (routineRoot) await fs.rm(routineRoot, { recursive: true, force: true }).catch(() => {});
    record.cleanupMs = performance.now() - cleanupStarted;
    sampler?.exit?.();
  }
  return record;
}

function summarizeGroup(rows) {
  const stageTotal = (label) => summarize(rows.map((row) => row.stages[label].totalMs));
  const spread = (key) => {
    const values = rows.map((row) => row[key]);
    return { min: Math.min(...values, Infinity) === Infinity ? 0 : Math.min(...values), max: values.length ? Math.max(...values) : 0 };
  };
  return {
    iterations: rows.length,
    runMs: summarize(rows.map((row) => row.runMs)),
    cleanupMs: summarize(rows.map((row) => row.cleanupMs)),
    plannerStartupMs: summarize(rows.map((row) => row.plannerStartupMs).filter((value) => value !== null)),
    proposalFirstCallMs: summarize(rows.map((row) => row.proposalFirstCallMs).filter((value) => value !== null)),
    proposalRoundtripP50Ms: summarize(rows.filter((row) => row.proposalRoundtripMs.count > 0).map((row) => row.proposalRoundtripMs.p50Ms)),
    actions: spread("actions"),
    proposalCalls: spread("proposalCalls"),
    approvals: spread("approvals"),
    policyChecks: spread("policyChecks"),
    journalFsyncs: spread("journalFsyncs"),
    stageTotalMs: Object.fromEntries(STAGE_LABELS.map((label) => [label, stageTotal(label)])),
  };
}

function buildReport({ scenario, schedule, iterations, approvalMode, batching = true, seed, memory = null, extra = {} }) {
  const summary = {};
  for (const mode of MODES) {
    summary[mode] = {};
    for (const temperature of ["cold", "warm"]) {
      summary[mode][temperature] = summarizeGroup(iterations.filter((row) => row.mode === mode && row.temperature === temperature));
    }
  }
  const deltas = [];
  for (const pair of schedule) {
    const routine = iterations.find((row) => row.pairIndex === pair.pairIndex && row.mode === "routine");
    const planner = iterations.find((row) => row.pairIndex === pair.pairIndex && row.mode === "planner");
    if (routine && planner) deltas.push(planner.runMs - routine.runMs);
  }
  return {
    kind: "routine-vs-planner-benchmark",
    schemaVersion: 1,
    scenario: {
      steps: scenario.steps,
      scrollsPerPage: scenario.scrollsPerPage ?? 0,
      totalActions: scenario.totalActions ?? scenario.steps,
      origin: scenario.origin,
      startUrl: scenario.startUrl,
    },
    design: {
      pairs: schedule.length,
      seed,
      approvalMode,
      batching: batching !== false,
      sampleIntervalMs: memory?.sampleIntervalMs ?? null,
      schedule: schedule.map((pair) => ({ pairIndex: pair.pairIndex, temperature: pair.temperature, order: pair.order })),
    },
    iterations,
    summary,
    comparison: { pairedRunMsDelta: summarize(deltas), deltaDefinition: "planner runMs minus routine runMs within the same pair" },
    memory,
    limitations: LIMITATIONS,
    ...extra,
  };
}

async function runBenchmark({
  scenario,
  pairs,
  seed = 1,
  approvalMode = "review",
  batching = true,
  createBrowser,
  storageRoot,
  makePlanner,
  sampler,
  timeoutMs,
} = {}) {
  const schedule = pairedSchedule({ pairs, seed });
  const iterations = [];
  for (const pair of schedule) {
    for (const mode of pair.order) {
      const row = await runIteration({
        mode,
        scenario,
        createBrowser,
        storageRoot,
        approvalMode,
        batching,
        makePlanner,
        sampler,
        timeoutMs,
        label: { pairIndex: pair.pairIndex, temperature: pair.temperature, sequence: iterations.length },
      });
      iterations.push(row);
      if (!row.success) throw new Error(`iteration failed (${mode}, pair ${pair.pairIndex}): ${row.error}`);
    }
  }
  return buildReport({ scenario, schedule, iterations, approvalMode, batching, seed, memory: sampler?.summarize?.() ?? null });
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

  const steps = envInt("HALO_BENCH_STEPS", 50, { min: 2, max: MAX_ROUTINE_STEPS });
  const pairs = envInt("HALO_BENCH_PAIRS", 6, { min: 2, max: 200 });
  const seed = envInt("HALO_BENCH_SEED", 1, { min: 0, max: 2 ** 31 });
  const scrollsPerPage = envInt("HALO_BENCH_SCROLLS_PER_PAGE", 0, { min: 0, max: 5 });
  const batchingRaw = process.env.HALO_BENCH_BATCHING || "on";
  if (!["on", "off"].includes(batchingRaw)) throw new RangeError("HALO_BENCH_BATCHING must be on|off");
  const batching = batchingRaw === "on";
  const approvalMode = process.env.HALO_BENCH_APPROVAL || "review";
  if (!["review", "allow"].includes(approvalMode)) throw new RangeError("HALO_BENCH_APPROVAL must be review|allow");

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const fixture = await startLongHorizon100Site({ steps });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-routine-bench-tasks-"));
  const scenario = buildScenario({ origin: new URL(fixture.url).origin, steps, scrollsPerPage });

  const monitor = new MemoryMonitor({ getAppMetrics: () => app.getAppMetrics(), getExternalMemoryBytes });
  const samples = [];
  let currentLabel = null;
  let running = true;
  const sampleLoop = (async () => {
    while (running) {
      const sample = await monitor.sample();
      if (currentLabel) samples.push({ mode: currentLabel.mode, totalBytes: sample.totalBytes, unmeasurable: sample.unmeasurable });
      await delay(SAMPLE_MS);
    }
  })();
  const sampler = {
    enter: (label) => { currentLabel = label; },
    exit: () => { currentLabel = null; },
    registerPlanner: (pid, creationTime) => monitor.registerExternalProcess({ pid, creationTime, label: "planner" }),
    unregisterPlanner: (pid, creationTime) => monitor.unregister(pid, creationTime),
    summarize: () => ({
      sampleIntervalMs: SAMPLE_MS,
      method: "poll-sampled RSS via MemoryMonitor (Electron processes + registered planner workers); not a hard ceiling",
      byMode: Object.fromEntries(MODES.map((mode) => {
        const selected = samples.filter((sample) => sample.mode === mode);
        const values = selected.map((sample) => sample.totalBytes);
        return [mode, {
          sampleCount: selected.length,
          peakBytes: values.length ? Math.max(...values) : null,
          p50Bytes: values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] : null,
          unmeasurable: [...new Set(selected.flatMap((sample) => sample.unmeasurable))],
        }];
      })),
    }),
  };

  let exitCode = 0;
  try {
    const report = await runBenchmark({
      scenario,
      pairs,
      seed,
      approvalMode,
      batching,
      storageRoot,
      sampler,
      createBrowser: async () => {
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "halo-routine-bench" } });
        win.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
        view.setVisible(false);
        return new BrowserAdapter({ view });
      },
    });
    const pageCounts = fixture.requestLog
      .filter((item) => /^\/step\/\d+$/.test(item.path))
      .reduce((map, item) => ({ ...map, [item.path]: (map[item.path] || 0) + 1 }), {});
    const uniform = Object.keys(pageCounts).length === steps && Object.values(pageCounts).every((count) => count === report.iterations.length);
    report.fixture = { pagesServed: Object.keys(pageCounts).length, expectedRequestsPerPage: report.iterations.length, uniformRequests: uniform, requestsPerPage: pageCounts };
    report.environment = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch };
    process.stdout.write(`RESULT_JSON:${JSON.stringify(report)}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "routine-vs-planner-benchmark", error: String(error?.stack || error) })}\n`);
  } finally {
    running = false;
    await sampleLoop.catch(() => {});
    await fixture.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

module.exports = {
  MODES,
  LIMITATIONS,
  summarize,
  mulberry32,
  pairedSchedule,
  buildScenario,
  defaultMakePlanner,
  runIteration,
  buildReport,
  runBenchmark,
};

if (process.versions.electron || require.main === module) {
  main().catch((error) => {
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "routine-vs-planner-benchmark", error: String(error?.stack || error) })}\n`);
    (process.versions.electron ? require("electron").app.exit(1) : process.exit(1));
  });
}
