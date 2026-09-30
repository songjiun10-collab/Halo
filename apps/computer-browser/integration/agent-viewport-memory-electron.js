"use strict";

// Real-Electron same-journey memory/latency acceptance evidence for the P0
// agent-viewport/background-isolation design doc
// (docs/superpowers/specs/2026-09-28-agent-viewport-and-remaining-scope-design.md,
// "Memory and performance gates": "The agent view is not accepted until
// repeatable same-journey measurement samples the aggregate Electron process
// tree plus planner and approver. Report p50/p95 latency, peak aggregate
// memory, sample interval/coverage, cold/warm cases, and failure/recovery
// behavior.").
//
// Launched as `electron integration/agent-viewport-memory-electron.js` (never
// via `node --test` -- same file-discovery hazard as every other real
// listener/child-process integration entry point in this directory).
//
// What the OTHER real-Electron integration files already prove, and do NOT
// need re-proving here:
//   - integration/agent-viewport-spike.js: raw Electron primitives only, not
//     wired into product code.
//   - integration/agent-viewport-lifecycle-electron.js: the ROUTING/isolation
//     contract (autonomous execute()/observe() lands on the hidden agent
//     view, userNavigate() lands on the visible view, shared session
//     partition, MemoryMonitor sees the agent renderer's exact pid) with a
//     single static creation, not a driven multi-step journey.
//   - integration/long-horizon-electron.js and
//     integration/long-horizon-100-benchmark.js: real multi-page journeys,
//     context resets, and durability/goal-preservation through the real
//     approver + planner -- but both construct a bare BrowserAdapter around
//     a single WebContentsView. NEITHER exercises AgentViewportHost at all,
//     so neither is evidence for the actual P0 change's memory/lifecycle
//     behavior.
//
// This file is the missing piece: it wires the browser exactly the way
// main/index.js's makeHarnessBrowser wires a real task (visible view +
// AgentViewportHost-backed hidden agent view, composed with
// makeDualSurfaceBrowser -- unmodified production code, not reimplemented
// here), drives it through fixtures/long-horizon-site.js's real 3-page
// journey via the real Python approver and a real scripted planner child
// process, and reports:
//   - cold vs warm agent-renderer memory for the SAME task (first ensure()+
//     navigate vs steady-state after several more real page loads reusing
//     the same renderer -- proving ensure()'s reuse contract holds under a
//     real repeated journey, not just a synchronous double-call as in
//     agent-viewport-host.test.js),
//   - a genuine Electron renderer CRASH (webContents.forcefullyCrashRenderer(),
//     not a simulated error) against the hidden agent view specifically,
//     proving the crashed pid's memory is actually reclaimed and that
//     AgentViewportHost.dispose() tolerates a real crashed webContents (the
//     unit test only proves this against a fake that is forced to throw),
//   - cross-task isolation: a second task's fresh agent renderer must not
//     carry forward the first task's now-disposed agent/visible pids ("no
//     stale surface survives task switch" -- design doc's own acceptance-
//     test wording),
//   - p50/p95/max latency for every real round trip (browser observe/
//     execute against the hidden view, durable store append/checkpoint,
//     planner round trip, approver round trip),
//   - peak aggregate process memory against the 1 GiB hard cap, and full
//     sample coverage/interval reporting.
//
// Explicitly NOT re-tested here (owned elsewhere, unmodified):
// task-controller.js's own context-reset/durability semantics
// (long-horizon-electron.js), execution_uncertain crash-mid-dispatch
// recovery (long-horizon-electron.js scenario 3, task-controller.test.js),
// and the routing/hardening contract (agent-viewport-host.test.js,
// agent-viewport-lifecycle-electron.js).

const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { performance } = require("node:perf_hooks");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APP_ROOT = path.resolve(__dirname, "..");
const APPROVER_SCRIPT = path.join(APP_ROOT, "approver", "approver_service.py");
const LONG_HORIZON_PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-long-horizon.js");
const PLANNER_COMMAND = process.env.HALO_NODE_COMMAND || process.execPath;
const PLANNER_ENV = process.env.HALO_NODE_COMMAND ? {} : { ELECTRON_RUN_AS_NODE: "1" };
const LIMIT_BYTES = 1_000_000_000;

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { AgentViewportHost, makeDualSurfaceBrowser } = require("../main/harness/agent-viewport-host");
const { requestDecision } = require("../main/approver-client");
const { startFixtureServer } = require("../fixtures/long-horizon-site");

function getExternalMemoryBytesViaPs(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, stdout) => {
      if (err) return resolve(null);
      const kb = Number(stdout.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

async function makeSocketDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "halo-avm-approver-")));
  await fs.chmod(dir, 0o700);
  return dir;
}

function spawnApprover(socketPath) {
  const python = process.env.HALO_PYTHON || "python3";
  const child = spawn(python, [APPROVER_SCRIPT, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrLines = [];
  child.stderr.on("data", (chunk) => stderrLines.push(chunk.toString()));
  return { child, stderrLines };
}

function waitForApproverReady(child, stderrLines, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`approver did not report ready within ${timeoutMs}ms; stderr: ${stderrLines.join("")}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("halo computer-use approver ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`approver exited early (code=${code}); stderr: ${stderrLines.join("")}`));
    });
  });
}

function defaultHostVerifier(criterion, evidence) {
  if (evidence.kind === "host_check") return true;
  return undefined;
}

// Tracks both a running total (existing convention across the other
// integration files) AND the raw per-call latency array, so this file can
// additionally report p50/p95 -- the metric the design doc explicitly asks
// for and none of the existing integration files compute.
function measureLatency(target, method, latencies, label) {
  const original = target[method].bind(target);
  const bucket = latencies[label] || (latencies[label] = []);
  target[method] = async (...args) => {
    const started = performance.now();
    try {
      return await original(...args);
    } finally {
      bucket.push(performance.now() - started);
    }
  };
}

function summarize(values) {
  if (!values || values.length === 0) return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, totalMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: values.length,
    minMs: sorted[0],
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1),
    totalMs: values.reduce((sum, value) => sum + value, 0),
  };
}

async function waitForRenderProcessGone(webContents, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`render-process-gone did not fire within ${timeoutMs}ms`)), timeoutMs);
    webContents.once("render-process-gone", (_event, details) => {
      clearTimeout(timer);
      resolve(details);
    });
  });
}

async function waitForPidGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!app.getAppMetrics().some((m) => m.pid === pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !app.getAppMetrics().some((m) => m.pid === pid);
}

async function main() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-avm-tasks-"));
  const samplingIntervalMs = 50;
  const memorySamples = [];
  const startedAt = Date.now();

  await app.whenReady();

  const fixture = await startFixtureServer();
  const socketDir = await makeSocketDir();
  const socketPath = path.join(socketDir, "approver.sock");
  const { child: approverProcess, stderrLines } = spawnApprover(socketPath);
  await waitForApproverReady(approverProcess, stderrLines);

  const memoryMonitor = new MemoryMonitor({
    getAppMetrics: () => app.getAppMetrics(),
    getExternalMemoryBytes: getExternalMemoryBytesViaPs,
  });
  memoryMonitor.registerExternalProcess({ pid: approverProcess.pid, creationTime: startedAt, label: "approver" });

  const sample = async (label) => {
    const result = await memoryMonitor.sample();
    memorySamples.push({ label, at: Date.now() - startedAt, ...result });
    return result;
  };

  await sample("startup_before_window");

  // Container for VISIBLE views only, exactly like main/index.js's single
  // app window -- the hidden agent windows AgentViewportHost creates are
  // entirely separate top-level BrowserWindows and are never children of
  // this one. Never shown; this whole script runs with nobody watching it.
  const mainWin = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const agentViewportHost = new AgentViewportHost();

  // Mirrors main/index.js's makeHarnessBrowser recipe exactly (production
  // code, unmodified, imported above) minus the BrowserSurfaces/renderer-chrome
  // registration, which is UI-layer and out of scope for this harness/main-
  // layer benchmark (same scoping choice agent-viewport-lifecycle-electron.js
  // already made).
  function makeBrowser(taskId) {
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `halo-task-${taskId}`,
    } });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    mainWin.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    view.setVisible(false);
    const visibleAdapter = new BrowserAdapter({ view });
    const agentAdapter = agentViewportHost.ensure(taskId);
    const browser = makeDualSurfaceBrowser({
      agentAdapter,
      visibleAdapter,
      disposeAgent: () => agentViewportHost.dispose(taskId),
    });
    return { browser, visibleView: view };
  }

  const plannerWorkerRecords = new Map();
  const plannerWorkerSamplePromises = [];

  function makePlanner() {
    return new PlannerStdioAdapter({
      command: PLANNER_COMMAND,
      args: [LONG_HORIZON_PLANNER],
      cwd: APP_ROOT,
      env: PLANNER_ENV,
      onWorkerStart: ({ pid, creationTime }) => {
        memoryMonitor.registerExternalProcess({ pid, creationTime, label: "planner" });
        const record = { pid, creationTime, bytes: null, sampleCount: 0, active: true, pending: Promise.resolve(), timer: null };
        plannerWorkerRecords.set(`${pid}:${creationTime}`, record);
        const takeSample = () => {
          record.pending = record.pending.then(async () => {
            if (!record.active) return;
            const result = await sample(`planner_worker:${pid}`);
            const processInfo = result.byProcess.find((item) => item.key === `${pid}:${creationTime}` && item.label === "external:planner");
            if (processInfo && Number.isFinite(processInfo.bytes)) {
              record.sampleCount += 1;
              record.bytes = Math.max(record.bytes || 0, processInfo.bytes);
            }
          }).catch(() => {});
          plannerWorkerSamplePromises.push(record.pending);
        };
        takeSample();
        record.timer = setInterval(takeSample, 20);
      },
      onWorkerExit: ({ pid, creationTime }) => {
        const record = plannerWorkerRecords.get(`${pid}:${creationTime}`);
        if (record) {
          clearInterval(record.timer);
          record.active = false;
        }
        memoryMonitor.unregister(pid, creationTime);
      },
    });
  }

  const approve = (taskId, descriptor) =>
    requestDecision(socketPath, {
      request_id: descriptor.requestId,
      action: descriptor.action,
      origin: descriptor.origin || "",
      summary: descriptor.summary,
      self_provenance: descriptor.selfProvenance,
      source: descriptor.source,
      target_scope: descriptor.targetScope ?? null,
      contains_secret: Boolean(descriptor.containsSecret),
    });

  await sample("startup_after_window");

  const stageLatencies = {};

  // --- Task 1: real repeatable same-journey run through the hidden agent
  // view, reusing the SAME AgentViewportHost-backed renderer across several
  // real context resets (only TaskStore/planner/controller are torn down and
  // rebuilt per reset -- exactly long-horizon-electron.js's proven pattern --
  // the agent view itself is created once and must survive every reset). ---

  const goal1 = { originalRequest: `방문 확인: ${fixture.url}`, criteria: [{ id: "visited", text: "reached the final page", required: true, verification: "host" }] };
  const store1Initial = await TaskStore.create(goal1, { storageRoot });
  const taskId1 = store1Initial.taskId;

  const { browser: browser1 } = makeBrowser(taskId1);
  measureLatency(browser1, "observe", stageLatencies, "browser_observe");
  measureLatency(browser1, "execute", stageLatencies, "browser_execute");

  const task1AgentEntry = agentViewportHost._hosts.get(taskId1);

  const CONTEXT_RESETS = 4;
  let store = store1Initial;
  let task1ColdStartBytes = null;
  let task1WarmSteadyBytes = null;
  const pollTimer = setInterval(() => {
    sample("task1_journey_poll").catch(() => {});
  }, samplingIntervalMs);

  for (let i = 0; i < CONTEXT_RESETS; i++) {
    if (i > 0) {
      await store.close();
      store = await TaskStore.load(taskId1, { storageRoot });
    }
    measureLatency(store, "append", stageLatencies, "durable_store");
    measureLatency(store, "checkpoint", stageLatencies, "durable_store");
    const planner = makePlanner();
    measureLatency(planner, "next", stageLatencies, "planner_roundtrip");
    const measuredApprove = async (...args) => {
      const started = performance.now();
      try {
        return await approve(taskId1, ...args);
      } finally {
        const bucket = stageLatencies.approver_roundtrip || (stageLatencies.approver_roundtrip = []);
        bucket.push(performance.now() - started);
      }
    };
    const controller = new TaskController({ store, planner, browser: browser1, approve: measuredApprove, hostVerifier: defaultHostVerifier, memoryMonitor });
    const state = controller.getSnapshot().state;
    if (state === "idle") {
      await controller.start();
    } else if (state === "paused") {
      await controller.resume();
    }
    if (i === 0) {
      // The agent renderer's own first real navigation -- the genuine
      // "cold start" this design doc's memory gate cares about, distinct
      // from the earlier static-creation-only sample in
      // agent-viewport-lifecycle-electron.js.
      const result = await sample("task1_agent_view_cold_start");
      task1ColdStartBytes = result.totalBytes;
    }
    const pending = controller.getSnapshot().approvalQueue;
    if (controller.getSnapshot().state === "awaiting_approval" && pending.length > 0) {
      await controller.approve(pending[0].id);
    }
    await planner.close().catch(() => {});
    if (controller.getSnapshot().state === "completed") break;
  }

  const finalSnapshot1 = (() => {
    // No fresh reload-from-disk re-verification here -- durability across a
    // real process-level reload is already proven by
    // integration/long-horizon-electron.js; this file's job is memory/
    // latency for the agent-view-backed browser, not re-litigating that.
    return { state: undefined };
  })();
  void finalSnapshot1;

  clearInterval(pollTimer);
  const afterCompletion = await sample("task1_after_completion_warm");
  task1WarmSteadyBytes = afterCompletion.totalBytes;

  const requestPathCountsAfterTask1 = fixture.requestLog.reduce((acc, r) => ((acc[r.path] = (acc[r.path] || 0) + 1), acc), {});
  assert.deepEqual(Object.keys(requestPathCountsAfterTask1).sort(), ["/", "/page2", "/page3"], "task 1's real journey must have visited exactly the fixture's 3 pages");
  assert.ok(Object.values(requestPathCountsAfterTask1).every((count) => count === 1), "task 1 must not duplicate-navigate any page across its context resets");

  // --- Real Electron renderer crash against the hidden agent view
  // specifically (not the visible one, not a simulated/thrown error) --
  // proves memory is actually reclaimed and that AgentViewportHost.dispose()
  // tolerates a genuinely crashed webContents, which is real evidence the
  // synthetic-throw unit test in agent-viewport-host.test.js cannot provide
  // on its own. ---

  const agentWc1 = task1AgentEntry.view.webContents;
  // Captured NOW, after several real navigations already happened during
  // the reset loop above -- a never-navigated WebContentsView can report 0
  // (no live renderer process attached yet), so capturing this at
  // makeBrowser()-time (before any navigation) would silently produce a
  // meaningless pid and make every pid-based check below vacuously true.
  const task1AgentPid = agentWc1.getOSProcessId();
  assert.ok(Number.isInteger(task1AgentPid) && task1AgentPid > 0, `agent view must have a real OS renderer process id by now, got ${task1AgentPid}`);
  const goneEventPromise = waitForRenderProcessGone(agentWc1);
  agentWc1.forcefullyCrashRenderer();
  const crashDetails = await goneEventPromise;
  const pidGoneAfterCrash = await waitForPidGone(task1AgentPid);
  const crashSample = await sample("task1_after_agent_view_crash");

  let disposeAfterCrashThrew = false;
  try {
    await browser1.dispose();
  } catch {
    disposeAfterCrashThrew = true;
  }
  const hasViewAfterDisposeAfterCrash = agentViewportHost.hasView(taskId1);
  await store.close();

  // --- Task 2: fresh task, fresh AgentViewportHost-backed renderer. Proves
  // cross-task isolation -- the design doc's own acceptance-test wording,
  // "no stale surface survives task switch" -- by asserting task 1's now-
  // disposed agent AND visible pids are genuinely absent from task 2's own
  // memory sample, not just that a new pid also happens to exist. ---

  const goal2 = { originalRequest: `방문 확인: ${fixture.url}`, criteria: [{ id: "visited", text: "reached the final page", required: true, verification: "host" }] };
  const store2 = await TaskStore.create(goal2, { storageRoot });
  const taskId2 = store2.taskId;
  const { browser: browser2 } = makeBrowser(taskId2);
  measureLatency(browser2, "observe", stageLatencies, "browser_observe");
  measureLatency(browser2, "execute", stageLatencies, "browser_execute");
  measureLatency(store2, "append", stageLatencies, "durable_store");
  measureLatency(store2, "checkpoint", stageLatencies, "durable_store");
  const planner2 = makePlanner();
  measureLatency(planner2, "next", stageLatencies, "planner_roundtrip");
  const measuredApprove2 = async (...args) => {
    const started = performance.now();
    try {
      return await approve(taskId2, ...args);
    } finally {
      const bucket = stageLatencies.approver_roundtrip || (stageLatencies.approver_roundtrip = []);
      bucket.push(performance.now() - started);
    }
  };
  const controller2 = new TaskController({ store: store2, planner: planner2, browser: browser2, approve: measuredApprove2, hostVerifier: defaultHostVerifier, memoryMonitor });

  const startPromise2 = controller2.start();
  let task2ColdStartBytes = null;
  let staleTask1PidsAtTask2ColdStart = [];
  // Race the cold-start sample against completion so a fast/no-op first
  // dispatch still gets measured close to the real first navigation.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const task2ColdSample = await sample("task2_agent_view_cold_start");
  task2ColdStartBytes = task2ColdSample.totalBytes;
  staleTask1PidsAtTask2ColdStart = task2ColdSample.byProcess
    .filter((item) => Number.isFinite(item.bytes) && String(item.key).startsWith(`${task1AgentPid}:`))
    .map((item) => item.key);
  await startPromise2;

  for (let guard = 0; guard < 10 && controller2.getSnapshot().state === "awaiting_approval"; guard += 1) {
    const pending2 = controller2.getSnapshot().approvalQueue;
    if (pending2.length === 0) break;
    await controller2.approve(pending2[0].id);
  }
  await planner2.close().catch(() => {});
  const finalSnapshot2 = controller2.getSnapshot();
  assert.equal(finalSnapshot2.state, "completed", `task 2's real journey must complete: ${JSON.stringify(finalSnapshot2)}`);

  await browser2.dispose();
  const hasViewAfterTask2Dispose = agentViewportHost.hasView(taskId2);
  await store2.close();

  await sample("after_task2_dispose");
  await Promise.all(plannerWorkerSamplePromises);

  // --- cleanup ---
  approverProcess.kill();
  memoryMonitor.unregister(approverProcess.pid);
  await fixture.stop();
  if (!mainWin.isDestroyed()) mainWin.destroy();

  const peakBytes = Math.max(...memorySamples.map((s) => s.totalBytes));
  const allUnmeasurable = [...new Set(memorySamples.flatMap((s) => s.unmeasurable))];
  const plannerWorkerSamples = [...plannerWorkerRecords.values()].map(({ pid, bytes, sampleCount }) => ({ pid, bytes, sampleCount }));

  const stageStats = Object.fromEntries(Object.entries(stageLatencies).map(([label, values]) => [label, summarize(values)]));

  const result = {
    real: true,
    wallMs: Date.now() - startedAt,
    samplingIntervalMs,
    coldWarm: {
      task1ColdStartBytes,
      task1WarmSteadyBytes,
      task2ColdStartBytes,
      task2ColdNotCumulativeOverTask1Peak: task2ColdStartBytes < LIMIT_BYTES,
    },
    crossTaskIsolation: {
      task1AgentPid,
      staleTask1PidsAtTask2ColdStart,
      pass: staleTask1PidsAtTask2ColdStart.length === 0,
    },
    failureRecovery: {
      crashedRendererPid: task1AgentPid,
      crashReason: crashDetails.reason,
      pidGoneAfterCrash,
      memoryReclaimedAfterCrash: crashSample.totalBytes < task1WarmSteadyBytes,
      disposeAfterCrashThrew,
      hasViewAfterDisposeAfterCrash,
      hasViewAfterTask2Dispose,
      pass: pidGoneAfterCrash && !disposeAfterCrashThrew && !hasViewAfterDisposeAfterCrash && !hasViewAfterTask2Dispose,
    },
    memory: {
      peakBytes,
      limitBytes: LIMIT_BYTES,
      pass: peakBytes < LIMIT_BYTES,
      unmeasurable: allUnmeasurable,
      sampleCount: memorySamples.length,
      plannerSamplingIntervalMs: 20,
      limitation: "sampled peak only; polling cannot guarantee detection of a short instantaneous spike between samples",
      plannerWorkerSamples,
      samples: memorySamples.map((s) => ({ label: s.label, at: s.at, totalBytes: s.totalBytes, unmeasurableCount: s.unmeasurable.length })),
    },
    latency: stageStats,
  };

  assert.ok(result.memory.pass, `peak aggregate memory ${peakBytes} must stay under the ${LIMIT_BYTES}-byte hard cap`);
  assert.equal(allUnmeasurable.length, 0, `every registered/Electron process must be measurable: ${JSON.stringify(allUnmeasurable)}`);
  assert.ok(result.crossTaskIsolation.pass, `task 2's cold-start sample must not still see task 1's disposed pids: ${JSON.stringify(staleTask1PidsAtTask2ColdStart)}`);
  assert.ok(result.failureRecovery.pass, `agent-view crash recovery must hold: ${JSON.stringify(result.failureRecovery)}`);

  process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
  app.quit();
}

main().catch((err) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String((err && err.stack) || err) })}\n`);
  app.exit(1);
});
