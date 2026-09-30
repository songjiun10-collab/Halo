"use strict";

// Paired real-Electron benchmark: direct browser traversal vs. HALO's durable
// harness on the same local 100-page chain. The planner context is rebuilt
// from host-owned state on every call; its worker remains persistent by
// default, matching production. Optional worker restarts can be enabled for
// recovery stress with HALO_PLANNER_RESTART_EVERY=N. This is a protocol fixture,
// not evidence of model quality. No external network or credentials are used.
//
// Run from apps/computer-browser:
//   node_modules/.bin/electron integration/long-horizon-100-benchmark.js
// Emits RESULT_JSON:<json> and exits nonzero on any incorrect/missing/duplicate
// page, failed task completion, unmeasurable process, or >=1GB sampled peak.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const STEPS = Number(process.env.HALO_LONG_STEPS || 100);
const RESTART_EVERY = Number(process.env.HALO_PLANNER_RESTART_EVERY || 0);
const SAMPLE_MS = 100;
const LIMIT_BYTES = 1_000_000_000;
const APPROVER = path.join(APP_ROOT, "approver", "approver_service.py");
const PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-100.js");

const { startLongHorizon100Site } = require("../fixtures/long-horizon-100-site");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { requestDecision } = require("../main/approver-client");
const { performance } = require("node:perf_hooks");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getExternalMemoryBytes(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
      if (error) return resolve(null);
      const kb = Number(stdout.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

async function createPrivateTemp(prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await fs.chmod(dir, 0o700);
  return dir;
}

function spawnApprover(socketPath) {
  const child = spawn(process.env.HALO_PYTHON || path.join(REPO_ROOT, ".venv", "bin", "python"), [APPROVER, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-4000); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`approver startup timeout: ${errors}`)), 10000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`approver exited before ready: code=${code} signal=${signal}; ${errors}`)); });
    child.stdout.on("data", () => {
      if (output.includes("halo computer-use approver ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { child, ready, getErrors: () => errors };
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.once("exit", () => clearTimeout(timer));
  });
}

async function navigate(view, url) {
  await view.webContents.loadURL(url);
  return view.webContents.executeJavaScript("document.querySelector('h1')?.textContent || ''");
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: values.length,
    minMs: sorted[0] ?? 0,
    p50Ms: at(0.5) ?? 0,
    p95Ms: at(0.95) ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    totalMs: values.reduce((sum, value) => sum + value, 0),
  };
}

async function runDirectBaseline({ fixture, win, sampleMode }) {
  sampleMode("browser_only");
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  view.setVisible(false);
  const elapsed = [];
  const pages = [];
  const startedAt = Date.now();
  try {
    for (let i = 0; i < STEPS; i += 1) {
      const start = performance.now();
      const heading = await navigate(view, `${fixture.url.replace(/\/step\/0$/, "")}/step/${i}`);
      assert.equal(heading, `Step ${i + 1} of ${STEPS}`);
      elapsed.push(performance.now() - start);
      pages.push(`/step/${i}`);
    }
  } finally {
    view.webContents.destroy();
  }
  const counts = pages.reduce((map, item) => ({ ...map, [item]: (map[item] || 0) + 1 }), {});
  assert.equal(pages.length, STEPS);
  assert.equal(Object.keys(counts).length, STEPS);
  return { success: true, steps: STEPS, elapsed: summarize(elapsed), wallMs: Date.now() - startedAt, pageRequestCounts: counts };
}

function defaultHostVerifier(_criterion, evidence) {
  if (evidence.kind === "host_check") return true;
  return undefined;
}

function measure(target, method, totals, label) {
  const original = target[method].bind(target);
  target[method] = async (...args) => {
    const started = performance.now();
    try { return await original(...args); }
    finally {
      const item = totals[label] || { count: 0, totalMs: 0, maxMs: 0 };
      const ms = performance.now() - started;
      item.count += 1;
      item.totalMs += ms;
      item.maxMs = Math.max(item.maxMs, ms);
      totals[label] = item;
    }
  };
}

async function runHarness({ fixture, win, storageRoot, socketPath, approverProcess, memoryMonitor, sampleMode }) {
  sampleMode("full_harness");
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "halo-long-horizon-100" } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  view.setVisible(false);
  const browser = new BrowserAdapter({ view });
  const actionTrace = [];
  const executeAction = browser.execute.bind(browser);
  browser.execute = async (action, options) => {
    const result = await executeAction(action, options);
    const snapshot = browser.getBrowserSnapshot();
    actionTrace.push({ action, status: result.status, url: snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.url });
    return result;
  };
  const requestDecisionTimed = async (descriptor) => requestDecision(socketPath, {
    request_id: descriptor.requestId,
    action: descriptor.action,
    origin: descriptor.origin || "",
    summary: descriptor.summary,
    self_provenance: descriptor.selfProvenance,
    source: descriptor.source,
    target_scope: descriptor.targetScope ?? null,
    contains_secret: Boolean(descriptor.containsSecret),
  });

  const goal = {
    originalRequest: `Walk the local ${STEPS}-page chain from ${fixture.url} and verify the final page.`,
    criteria: [{ id: "reached-final", text: `reached page ${STEPS}`, required: true, verification: "host" }],
    limits: { maxActions: STEPS + 20, maxPlannerCalls: STEPS + 50, maxActiveMs: 30 * 60 * 1000 },
  };
  let store;
  let planner;
  let controller;
  const stageTotals = {};
  const controllerStageTotals = stageTotals;
  // TaskStore.create() durably appends goal_created before returning; count
  // that known first event here, then count every later successful append.
  const journalEventCounts = Object.assign(Object.create(null), { goal_created: 1 });
  const taskStoreOperationTimings = Object.create(null);
  let checkpointCount = 0;
  let approvalCount = 0;
  let resetCount = 0;
  const plannerPids = [];
  let policyChecks = 0;
  let plannerCalls = 0;
  let goalPreserved = true;
  const actionLatencies = [];
  const startedAt = Date.now();

  measure(browser, "observe", stageTotals, "browser_observe");
  measure(browser, "execute", stageTotals, "browser_execute");

  function makePlanner() {
    return new PlannerStdioAdapter({
      command: process.execPath,
      args: [PLANNER],
      cwd: APP_ROOT,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      onWorkerStart: ({ pid, creationTime }) => {
        plannerPids.push(pid);
        memoryMonitor.registerExternalProcess({ pid, creationTime, label: "planner" });
      },
      onWorkerExit: ({ pid, creationTime }) => memoryMonitor.unregister(pid, creationTime),
    });
  }

  store = await TaskStore.create(goal, {
    storageRoot,
    onTiming: ({ operation, elapsedMs }) => {
      const item = taskStoreOperationTimings[operation] || { count: 0, totalMs: 0, maxMs: 0 };
      item.count += 1;
      item.totalMs += elapsedMs;
      item.maxMs = Math.max(item.maxMs, elapsedMs);
      taskStoreOperationTimings[operation] = item;
    },
  });
  measure(store, "append", controllerStageTotals, "durable_store");
  measure(store, "checkpoint", controllerStageTotals, "durable_store");
  const appendMeasured = store.append.bind(store);
  store.append = async (...args) => {
    const result = await appendMeasured(...args);
    const eventType = args[0]?.type;
    if (typeof eventType === "string") journalEventCounts[eventType] = (journalEventCounts[eventType] || 0) + 1;
    return result;
  };
  const checkpointMeasured = store.checkpoint.bind(store);
  store.checkpoint = async (...args) => {
    checkpointCount += 1;
    return checkpointMeasured(...args);
  };
  const basePlanner = {
    warm() {
      if (!planner) {
        planner = makePlanner();
        measure(planner, "next", controllerStageTotals, "planner_roundtrip");
      }
      return planner.warm?.();
    },
    async next(context, options) {
      if (context.goal.originalRequest !== goal.originalRequest || context.goalVersion !== 1) goalPreserved = false;
      if (!planner || (RESTART_EVERY > 0 && plannerCalls > 0 && plannerCalls % RESTART_EVERY === 0)) {
        if (planner) {
          await planner.close().catch(() => {});
          resetCount += 1;
        }
        planner = makePlanner();
        measure(planner, "next", controllerStageTotals, "planner_roundtrip");
      }
      plannerCalls += 1;
      return planner.next(context, options);
    },
  };
  controller = new TaskController({
    store,
    planner: basePlanner,
    browser,
    approve: async (...args) => {
      const started = performance.now();
      policyChecks += 1;
      try { return await requestDecisionTimed(...args); }
      finally {
        const item = controllerStageTotals.approver_roundtrip || { count: 0, totalMs: 0, maxMs: 0 };
        const ms = performance.now() - started;
        item.count += 1; item.totalMs += ms; item.maxMs = Math.max(item.maxMs, ms);
        controllerStageTotals.approver_roundtrip = item;
      }
    },
    hostVerifier: defaultHostVerifier,
    memoryMonitor,
  });

  try {
    let idlePolls = 0;
    while (controller.getSnapshot().state !== "completed") {
      let snapshot = controller.getSnapshot();
      if (snapshot.state === "idle") {
        await controller.start();
      } else if (snapshot.state === "paused") {
        await controller.resume({ confirmed: true });
      } else if (snapshot.state === "awaiting_approval") {
        const item = snapshot.approvalQueue[0];
        if (!item) throw new Error("awaiting_approval without a queued item");
        const before = Date.now();
        await controller.approve(item.id); // deterministic human approval for the local fixture
        actionLatencies.push(Date.now() - before);
        approvalCount += 1;
        snapshot = controller.getSnapshot();
      } else if (snapshot.state === "running") {
        // start()/approve() normally resolve only at a policy wait or terminal
        // state; this guard turns an unexpected detached loop into a timeout.
        if (++idlePolls > 1000) throw new Error("task loop did not reach approval/completion");
        await delay(5);
      } else {
        throw new Error(`unexpected harness state ${snapshot.state} (${snapshot.pauseReason || "no reason"})`);
      }
      if (Date.now() - startedAt > 15 * 60 * 1000) throw new Error("100-step harness exceeded 15-minute timeout");
    }

    const finalSnapshot = controller.getSnapshot();
    const browserSnapshot = browser.getBrowserSnapshot();
    const url = browserSnapshot.tabs.find((tab) => tab.id === browserSnapshot.activeTabId)?.url;
    assert.equal(finalSnapshot.state, "completed");
    assert.equal(finalSnapshot.budgets.actionsUsed, STEPS, `action budget mismatch: state=${JSON.stringify(finalSnapshot)} url=${url} trace=${JSON.stringify(actionTrace)}`);
    assert.equal(actionTrace.length, STEPS, "must dispatch exactly one browser action per chain step");
    assert.equal(approvalCount, STEPS, "the scenario must pass every navigation through human approval");
    assert.equal(policyChecks, STEPS, "every navigation must receive an independent approver decision");
    assert.equal(journalEventCounts.action_started, STEPS, "each dispatched action must have one durable start event");
    assert.equal(journalEventCounts.action_outcome, STEPS, "each dispatched action must have one durable outcome event");
    assert.equal(journalEventCounts.evidence_recorded, STEPS, "each verified navigation must record one evidence event");
    assert.equal(Object.values(journalEventCounts).reduce((sum, count) => sum + count, 0), taskStoreOperationTimings.journal_append_write.count,
      "event-type counters must cover every successful journal append, including goal_created");
    assert.ok(checkpointCount > 0, "the run must persist at least one checkpoint");
    for (const operation of ["journal_append_write", "journal_fsync", "checkpoint_file_write", "checkpoint_file_fsync", "checkpoint_rename", "checkpoint_directory_fsync"]) {
      assert.ok(taskStoreOperationTimings[operation]?.count > 0, `missing TaskStore timing for ${operation}`);
    }
    assert.equal(finalSnapshot.goalVersion, 1);
    assert.equal(controller.getGoal().originalRequest, goal.originalRequest);
    assert.equal(goalPreserved, true, "the original goal must be present at every fresh planner process/context");
    assert.ok(url?.endsWith(`/step/${STEPS - 1}`), `expected final URL, got ${url}`);
    return {
      success: true,
      steps: finalSnapshot.budgets.actionsUsed,
      plannerCalls: finalSnapshot.budgets.plannerCallsUsed,
      approvals: approvalCount,
      policyChecks,
      plannerProcessResets: resetCount,
      plannerPids,
      plannerContextsRebuilt: plannerCalls,
      journalEventCounts,
      checkpointCount,
      taskStoreOperationTimings,
      goalPreserved,
      finalState: finalSnapshot.state,
      finalUrl: url,
      wallMs: Date.now() - startedAt,
      approvalToNextDecision: summarize(actionLatencies),
      stageTotals: controllerStageTotals,
    };
  } finally {
    if (planner) await planner.close().catch(() => {});
    await browser.dispose().catch(() => {});
    if (store) await store.close().catch(() => {});
  }
}

async function main() {
  assert.ok(Number.isInteger(STEPS) && STEPS >= 2 && STEPS <= 1000, "HALO_LONG_STEPS must be 2..1000");
  assert.ok(Number.isInteger(RESTART_EVERY) && RESTART_EVERY >= 0 && RESTART_EVERY <= STEPS, "HALO_PLANNER_RESTART_EVERY must be 0..HALO_LONG_STEPS");
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const fixture = await startLongHorizon100Site({ steps: STEPS });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-long-100-tasks-"));
  const socketDir = await createPrivateTemp("halo-long-100-approver-");
  const socketPath = path.join(socketDir, "approver.sock");
  let approverProcess;
  let sampleMode = "setup";
  const samples = [];
  const memoryMonitor = new MemoryMonitor({ getAppMetrics: () => app.getAppMetrics(), getExternalMemoryBytes });
  let samplePending = false;
  let runSampling = true;
  const sampleLoop = (async () => {
    while (runSampling) {
      if (!samplePending) {
        samplePending = true;
        try {
          const sample = await memoryMonitor.sample();
          samples.push({ mode: sampleMode, at: Date.now(), totalBytes: sample.totalBytes, unmeasurable: sample.unmeasurable, byProcess: sample.byProcess });
        } finally { samplePending = false; }
      }
      await delay(SAMPLE_MS);
    }
  })();

  try {
    const baseline = await runDirectBaseline({ fixture, win, sampleMode: (mode) => { sampleMode = mode; } });
    const { child, ready } = spawnApprover(socketPath);
    approverProcess = child;
    await ready;
    memoryMonitor.registerExternalProcess({ pid: child.pid, creationTime: Date.now(), label: "approver" });
    const harness = await runHarness({
      fixture,
      win,
      storageRoot,
      socketPath,
      approverProcess: child,
      memoryMonitor,
      sampleMode: (mode) => { sampleMode = mode; },
    });
    await stopChild(child);
    memoryMonitor.unregister(child.pid);
    approverProcess = null;
    runSampling = false;
    await sampleLoop;

    const pagePathCounts = fixture.requestLog
      .filter((item) => /^\/step\/\d+$/.test(item.path))
      .reduce((map, item) => ({ ...map, [item.path]: (map[item.path] || 0) + 1 }), {});
    const expected = Array.from({ length: STEPS }, (_, index) => `/step/${index}`);
    const actual = Object.keys(pagePathCounts).sort((a, b) => Number(a.split("/").at(-1)) - Number(b.split("/").at(-1)));
    assert.deepEqual(actual, expected, "both modes must visit exactly the same ordered local page chain");
    assert.ok(Object.values(pagePathCounts).every((count) => count === 2), "the same page chain should be visited once per mode, no duplicate navigation");

    const byMode = {};
    for (const mode of ["browser_only", "full_harness"]) {
      const selected = samples.filter((sample) => sample.mode === mode);
      if (!selected.length) throw new Error(`no memory samples for ${mode}`);
      const peak = selected.reduce((max, item) => item.totalBytes > max.totalBytes ? item : max, selected[0]);
      byMode[mode] = {
        peakBytes: peak.totalBytes,
        sampleCount: selected.length,
        coverage: mode === "browser_only"
          ? "Electron main/renderer/GPU/utility; no external workers"
          : "Electron main/renderer/GPU/utility + Python approver + registered planner workers",
        unmeasurable: [...new Set(selected.flatMap((sample) => sample.unmeasurable))],
        peakProcesses: peak.byProcess,
      };
    }
    const plannerSamples = new Set(samples
      .filter((sample) => sample.mode === "full_harness")
      .flatMap((sample) => (sample.byProcess || [])
        .filter((item) => item.label === "external:planner")
        .map((item) => Number(item.key.split(":")[0]))));
    const sampledPlannerPids = harness.plannerPids.filter((pid) => plannerSamples.has(pid));
    const approverSampled = samples.some((sample) => sample.mode === "full_harness"
      && (sample.byProcess || []).some((item) => item.label === "external:approver"));
    assert.deepEqual(sampledPlannerPids.sort((a, b) => a - b), [...harness.plannerPids].sort((a, b) => a - b),
      `each planner worker must appear in a memory sample: started=${harness.plannerPids} sampled=${sampledPlannerPids}`);
    assert.ok(approverSampled, "approver process must appear in a memory sample");
    assert.ok(byMode.browser_only.unmeasurable.length === 0, JSON.stringify(byMode.browser_only.unmeasurable));
    assert.ok(byMode.full_harness.unmeasurable.length === 0, JSON.stringify(byMode.full_harness.unmeasurable));
    assert.ok(byMode.full_harness.peakBytes < LIMIT_BYTES, `full harness peak ${byMode.full_harness.peakBytes} >= ${LIMIT_BYTES}`);
    assert.equal(baseline.success, true);
    assert.equal(harness.success, true);

    const result = {
      real: true,
      comparison: "same 100 local pages, one ordered visit per mode; browser-only direct navigation versus deterministic planner + real approver REVIEW + programmatic test approval + durable harness",
      steps: STEPS,
      plannerRestartEvery: RESTART_EVERY || null,
      baseline,
      harness,
      memory: byMode,
      processSampling: {
        plannerWorkersStarted: harness.plannerPids.length,
        plannerWorkersSampled: sampledPlannerPids.length,
        approverSampled,
      },
      speedRatioHarnessOverBrowserOnly: harness.wallMs / baseline.wallMs,
      fixturePageRequestCounts: pagePathCounts,
      limitation: "not a model-quality benchmark; user approval is simulated immediately; measured peak is poll-sampled and can miss between-sample spikes",
    };
    process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
  } finally {
    runSampling = false;
    await sampleLoop;
    if (approverProcess) {
      await stopChild(approverProcess);
      memoryMonitor.unregister(approverProcess.pid);
    }
    await fixture.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(socketDir, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String(error?.stack || error) })}\n`);
  app.exit(1);
});
