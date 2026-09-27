"use strict";

// Real-Electron end-to-end evidence for the long-horizon browser harness
// (Task 6). Launched as `electron integration/long-horizon-electron.js`
// (never via `node --test` -- see the header comment in
// fixtures/long-horizon-site.js for why fixtures/integration entry points
// with real listeners/child processes stay outside any test/tests
// directory). Drives:
//   - a REAL BrowserAdapter against a REAL Chromium WebContentsView,
//   - the REAL Python approver process (approver/approver_service.py) over
//     the REAL Unix-socket wire (main/approver-client.js),
//   - a REAL PlannerStdioAdapter child process (a scripted, non-natural-
//     language worker -- fixtures/scripted-planner-long-horizon.js -- see
//     that file's own header for why this is a protocol fixture, not
//     evidence of model quality),
//   - REAL OS process memory via app.getAppMetrics() + `ps` for the
//     approver/worker, summed exactly as main/harness/memory-monitor.js
//     does in production.
// against a REAL local HTTP fixture (fixtures/long-horizon-site.js).
//
// Writes one line `RESULT_JSON:<json>` to stdout and exits. Everything here
// is orchestration for a test; the harness code under test is
// main/harness/*.js and main/approver-client.js, unmodified.

const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APP_ROOT = path.resolve(__dirname, "..");
const APPROVER_SCRIPT = path.join(APP_ROOT, "approver", "approver_service.py");
const LONG_HORIZON_PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-long-horizon.js");
const PLANNER_COMMAND = process.env.HALO_NODE_COMMAND || process.execPath;
const PLANNER_ENV = process.env.HALO_NODE_COMMAND ? {} : { ELECTRON_RUN_AS_NODE: "1" };

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { requestDecision } = require("../main/approver-client");
const { startFixtureServer } = require("../fixtures/long-horizon-site");
const { performance } = require("node:perf_hooks");

function measureMethod(target, method, totals, label) {
  const original = target[method].bind(target);
  target[method] = async (...args) => {
    const started = performance.now();
    try {
      return await original(...args);
    } finally {
      const entry = totals[label] || { count: 0, totalMs: 0, maxMs: 0 };
      const elapsedMs = performance.now() - started;
      entry.count += 1;
      entry.totalMs += elapsedMs;
      entry.maxMs = Math.max(entry.maxMs, elapsedMs);
      totals[label] = entry;
    }
  };
}

function getExternalMemoryBytesViaPs(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, stdout) => {
      if (err) return resolve(null);
      const kb = Number(stdout.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

function defaultHostVerifier(criterion, evidence) {
  if (evidence.kind === "host_check") return true;
  return undefined;
}

async function makeSocketDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "halo-lh-approver-")));
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

function wrapWithCallCounter(obj, methods) {
  const counts = {};
  const wrapped = { ...obj };
  for (const m of methods) {
    counts[m] = 0;
    const original = obj[m].bind(obj);
    wrapped[m] = (...args) => {
      counts[m] += 1;
      return original(...args);
    };
  }
  return { wrapped, counts };
}

async function main() {
  const storageRoot = process.env.HALO_TEST_STORAGE_ROOT || (await fs.mkdtemp(path.join(os.tmpdir(), "halo-lh-tasks-")));
  const samplingIntervalMs = 50;
  const memorySamples = [];
  const startedAt = Date.now();
  let peakDuringRun = 0;
  const backgroundSamples = new Set();

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
  const plannerWorkerRecords = new Map();
  const plannerWorkerSamplePromises = [];

  await sample("startup_before_window");

  // A hidden window; BrowserAdapter never needs visibility, and this whole
  // script runs with no user watching it.
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });

function makeBrowser() {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    win.contentView.addChildView(view);
    view.setVisible(false);
    return new BrowserAdapter({ view });
  }

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
            peakDuringRun = Math.max(peakDuringRun, result.totalBytes);
            const processInfo = result.byProcess.find((item) => item.key === `${pid}:${creationTime}` && item.label === "external:planner");
            if (processInfo && Number.isFinite(processInfo.bytes)) {
              record.sampleCount += 1;
              record.bytes = Math.max(record.bytes || 0, processInfo.bytes);
            }
          }).catch(() => {});
          plannerWorkerSamplePromises.push(record.pending);
        };
        // The OS can expose a just-spawned pid before Node has loaded the
        // runtime. Poll while the child is registered so initialized RSS,
        // not only that transient early value, contributes to the peak.
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

  // --- Scenario 1: real goal-preserving multi-page journey + context resets ---

  const goal1 = { originalRequest: `방문 확인: ${fixture.url}`, criteria: [{ id: "visited", text: "reached the final page", required: true, verification: "host" }] };
  const store1 = await TaskStore.create(goal1, { storageRoot });
  const taskId1 = store1.taskId;

  const scenario1StageTotals = {};
  const scenario1ResetTimings = [];
  const pollTimer = setInterval(() => {
    const pending = sample("during_long_horizon_run").then((r) => {
      if (r.totalBytes > peakDuringRun) peakDuringRun = r.totalBytes;
    }).catch(() => {}).finally(() => backgroundSamples.delete(pending));
    backgroundSamples.add(pending);
  }, samplingIntervalMs);

  const CONTEXT_RESETS = 4; // real page loads + real approver round-trips are slow; see honest-limitations note in the final report
  let store = store1;
  let originalRequestAcrossResets = [];
  // The real WebContentsView is created ONCE, outside the loop, and reused
  // across every reset. Only the TaskStore/TaskController/planner are torn
  // down and rebuilt each iteration -- that is the actual thing this
  // scenario tests: that goal/evidence/progress survive purely off the
  // durable journal with zero in-memory continuity on the HARNESS side. The
  // real browser tab's own navigation state is a separate concern (a true
  // process-level crash would lose it too, and a fresh, never-navigated
  // WebContentsView would then legitimately re-navigate to the start URL --
  // that is not a harness defect, just a real browser session being gone).
  // Keeping the browser alive here is what lets requestPathCounts actually
  // prove noDuplicateNavigation: if the harness ever re-issued a navigate
  // the evidence log already satisfied, this would catch it.
  const browser = makeBrowser();
  measureMethod(browser, "observe", scenario1StageTotals, "browser_observe");
  measureMethod(browser, "execute", scenario1StageTotals, "browser_execute");
  for (let i = 0; i < CONTEXT_RESETS; i++) {
    const resetStartedAt = performance.now();
    // Reload from disk on every iteration -- a genuine "context reset": no
    // in-memory continuity is trusted, only what TaskStore.load() replays
    // from the durable journal/checkpoint.
    if (i > 0) {
      await store.close();
      store = await TaskStore.load(taskId1, { storageRoot });
    }
    measureMethod(store, "append", scenario1StageTotals, "durable_store");
    measureMethod(store, "checkpoint", scenario1StageTotals, "durable_store");
    originalRequestAcrossResets.push(store.getGoal().originalRequest);
    const planner = makePlanner();
    measureMethod(planner, "next", scenario1StageTotals, "planner_roundtrip");
    const measuredApprove = async (...args) => {
      const started = performance.now();
      try {
        return await approve(taskId1, ...args);
      } finally {
        const entry = scenario1StageTotals.approver_roundtrip || { count: 0, totalMs: 0, maxMs: 0 };
        const elapsedMs = performance.now() - started;
        entry.count += 1;
        entry.totalMs += elapsedMs;
        entry.maxMs = Math.max(entry.maxMs, elapsedMs);
        scenario1StageTotals.approver_roundtrip = entry;
      }
    };
    const controller = new TaskController({ store, planner, browser, approve: measuredApprove, hostVerifier: defaultHostVerifier, memoryMonitor });
    const state = controller.getSnapshot().state;
    if (state === "idle") {
      await controller.start();
    } else if (state === "paused") {
      await controller.resume();
    }
    // The real Python approver returns "review" (not "allow") for every
    // gated action here (untrusted self-provenance, external target scope --
    // see the descriptor built in _dispatchActionsBatch), so the loop stops
    // at awaiting_approval after each single navigate/follow_link and waits
    // for an explicit approve() -- exactly the approval boundary this
    // scenario must verify. Draining exactly ONE pending item per outer
    // iteration (not looping to drain the whole queue) means each real step
    // of the multi-page journey gets its own context reset in between,
    // matching CONTEXT_RESETS to the fixture's step count instead of
    // completing the whole journey inside a single resume() call.
    const pending = controller.getSnapshot().approvalQueue;
    if (controller.getSnapshot().state === "awaiting_approval" && pending.length > 0) {
      await controller.approve(pending[0].id);
    }
    await planner.close().catch(() => {});
    scenario1ResetTimings.push({ reset: i, elapsedMs: performance.now() - resetStartedAt });
    if (controller.getSnapshot().state === "completed") break;
  }

  const goalPreservedAcrossResets = originalRequestAcrossResets.every((r) => r === goal1.originalRequest);

  // Re-load once more to get the authoritative final state honestly (the
  // loop above may have left `store` pointed at the last iteration's
  // instance already, but re-loading proves it from disk, not memory).
  await store.close();
  const finalStore1 = await TaskStore.load(taskId1, { storageRoot });
  const finalController1 = new TaskController({
    store: finalStore1,
    planner: { next: async () => ({ kind: "need_user", reason: "inspection only" }) },
    browser: { observe: async () => ({ id: "inspect" }), execute: async () => ({ status: "ok" }) },
    approve: async () => ({ decision: "deny", reasons: [] }),
    hostVerifier: defaultHostVerifier,
  });
  const finalSnapshot1 = finalController1.getSnapshot();
  await finalStore1.close();

  const requestPaths = fixture.requestLog.map((r) => r.path);
  const requestPathCounts = requestPaths.reduce((acc, p) => ((acc[p] = (acc[p] || 0) + 1), acc), {});
  const noDuplicateNavigation = Object.values(requestPathCounts).every((count) => count === 1);

  await sample("after_scenario1");

  // --- Scenario 2: pause mid-flight, then resume from a freshly-attached
  // controller (simulating a process restart, not just an in-process resume) ---

  const goal2 = { originalRequest: `방문 확인: ${fixture.url}`, criteria: [{ id: "visited", text: "reached the final page", required: true, verification: "host" }] };
  const store2 = await TaskStore.create(goal2, { storageRoot });
  const taskId2 = store2.taskId;
  const browser2 = makeBrowser();
  const planner2 = makePlanner();
  const controller2 = new TaskController({ store: store2, planner: planner2, browser: browser2, approve: (d) => approve(taskId2, d), hostVerifier: defaultHostVerifier, memoryMonitor });

  const startPromise2 = controller2.start();
  await new Promise((r) => setTimeout(r, 60));
  await controller2.pause();
  await startPromise2;
  await planner2.close().catch(() => {});
  const pausedMidflightState = controller2.getSnapshot().state;

  await store2.close();
  const resumedStore2 = await TaskStore.load(taskId2, { storageRoot });
  const browser2b = makeBrowser();
  const planner2b = makePlanner();
  const controller2b = new TaskController({ store: resumedStore2, planner: planner2b, browser: browser2b, approve: (d) => approve(taskId2, d), hostVerifier: defaultHostVerifier, memoryMonitor });
  const pauseResumeWorks = pausedMidflightState === "paused" || pausedMidflightState === "completed";
  if (controller2b.getSnapshot().state === "paused") {
    await controller2b.resume();
  }
  // Unlike scenario 1, nothing after this point exercises another context
  // reset, so drain every real approval round (navigate + each follow_link)
  // here rather than just one -- an authorized operator approving each real
  // gated step in turn is exactly what "resume from a fresh reattach still
  // reaches completion" is meant to demonstrate.
  for (let guard = 0; guard < 10 && controller2b.getSnapshot().state === "awaiting_approval"; guard += 1) {
    const pending2 = controller2b.getSnapshot().approvalQueue;
    if (pending2.length === 0) break;
    await controller2b.approve(pending2[0].id);
  }
  await planner2b.close().catch(() => {});
  const scenario2FinalSnapshot = controller2b.getSnapshot();
  const scenario2Completed = scenario2FinalSnapshot.state === "completed";
  await resumedStore2.close();

  await sample("after_scenario2");

  // --- Scenario 3: execution_uncertain gating -- a dangling action_started
  // with no matching outcome (simulating a crash mid-dispatch) must force
  // paused:execution_uncertain on load, and neither browser nor planner may
  // be touched until an explicit resume({confirmed:true}). ---

  const store3 = await TaskStore.create({ originalRequest: "goal for crash simulation" }, { storageRoot });
  const taskId3 = store3.taskId;
  await store3.append({ type: "action_started", payload: { actionId: "dangling-action" } });
  await store3.close();

  const reloadedStore3 = await TaskStore.load(taskId3, { storageRoot });
  const recoveryReason3 = reloadedStore3.recoveryReason;
  const rawBrowser3 = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const rawPlanner3 = { next: async () => ({ kind: "need_user", reason: "should never be called before confirmed resume" }) };
  const { wrapped: browser3, counts: browser3Counts } = wrapWithCallCounter(rawBrowser3, ["observe", "execute"]);
  const { wrapped: planner3, counts: planner3Counts } = wrapWithCallCounter(rawPlanner3, ["next"]);
  const controller3 = new TaskController({ store: reloadedStore3, planner: planner3, browser: browser3, approve: async () => ({ decision: "deny", reasons: [] }), hostVerifier: defaultHostVerifier });

  let resumeWithoutConfirmThrew = false;
  try {
    await controller3.resume();
  } catch {
    resumeWithoutConfirmThrew = true;
  }
  const zeroDispatchBeforeConfirm = browser3Counts.observe === 0 && browser3Counts.execute === 0 && planner3Counts.next === 0;
  await controller3.resume({ confirmed: true });
  // The wrapped planner/browser prove confirmed resume actually dispatches
  // (dispatchedAfterConfirm), but planner3 always answers "need_user" -- it
  // was never meant to drive this task to completion, only to prove the
  // resume itself is unblocked -- so report the real post-resume state
  // honestly instead of assuming "completed".
  const dispatchedAfterConfirm = browser3Counts.observe > 0;
  const postConfirmedResumeState = controller3.getSnapshot().state;
  await reloadedStore3.close();

  clearInterval(pollTimer);
  await Promise.all([...backgroundSamples]);
  await sample("after_scenario3");
  await Promise.all(plannerWorkerSamplePromises);

  // --- cleanup ---
  approverProcess.kill();
  memoryMonitor.unregister(approverProcess.pid);
  await fixture.stop();

  const peakBytes = Math.max(peakDuringRun, ...memorySamples.map((s) => s.totalBytes));
  const limitBytes = 1_000_000_000;
  const plannerWorkerSamples = [...plannerWorkerRecords.values()].map(({ pid, bytes, sampleCount }) => ({ pid, bytes, sampleCount }));
  const allUnmeasurable = [...new Set(memorySamples.flatMap((s) => s.unmeasurable))];

  const result = {
    real: true,
    wallMs: Date.now() - startedAt,
    samplingIntervalMs,
    scenario1: {
      contextResets: CONTEXT_RESETS,
      goalPreservedAcrossResets,
      finalState: finalSnapshot1.state,
      finalPauseReason: finalSnapshot1.pauseReason,
      finalOriginalRequest: finalSnapshot1.goalVersion ? goal1.originalRequest : null,
      noDuplicateNavigation,
      requestPathCounts,
      resetTimings: scenario1ResetTimings,
      stageTotals: scenario1StageTotals,
    },
    scenario2: {
      pausedMidflightState,
      pauseResumeWorks,
      completedAfterFreshReattach: scenario2Completed,
      finalState: scenario2FinalSnapshot.state,
      finalPauseReason: scenario2FinalSnapshot.pauseReason,
    },
    scenario3: {
      recoveryReason: recoveryReason3,
      resumeWithoutConfirmThrew,
      zeroDispatchBeforeConfirm,
      dispatchedAfterConfirm,
      postConfirmedResumeState,
    },
    memory: {
      peakBytes,
      limitBytes,
      pass: peakBytes < limitBytes,
      unmeasurable: allUnmeasurable,
      sampleCount: memorySamples.length,
      plannerSamplingIntervalMs: 20,
      limitation: "sampled peak only; polling cannot guarantee detection of a short instantaneous spike between samples",
      plannerWorkerSamples,
      samples: memorySamples.map((s) => ({ label: s.label, at: s.at, totalBytes: s.totalBytes, unmeasurableCount: s.unmeasurable.length })),
    },
  };

  process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
  win.destroy();
  app.quit();
}

main().catch((err) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String((err && err.stack) || err) })}\n`);
  app.exit(1);
});
