"use strict";

// Repeats the real 3-page journey (navigate -> follow_link -> follow_link ->
// finish) N times (default 20) against ONE long-running real Electron app +
// ONE real Python approver process, each iteration getting its own
// independent, fresh task state (new TaskStore/taskId, new BrowserAdapter
// WebContentsView, new PlannerStdioAdapter worker process). This exists to
// verify the 2026-09-27 approver_error root-cause fixes hold up over
// repeated real runs, not just a single lucky pass:
//   1. approver-client.js's requestDecision() only retried a transient
//      ENOENT, not the same race's ECONNREFUSED variant (real Electron run,
//      after ~234 rapid approve() round-trips).
//   2. approver_service.py's VALID_ACTIONS/_ACTION_MAPPING never included
//      follow_link/scroll/observe -- the real harness's actual action
//      vocabulary -- so every one was silently denied forever.
//   3. browser-adapter.js's buildObserveScript() text extraction used
//      childNodes.length===0 (matches almost no real element) instead of
//      childElementCount===0, so a page's own visible text (e.g. the
//      fixture's "DONE-XYZ" completion marker) never reached the planner.
// Also samples real aggregate process memory (Electron main/renderer/GPU/
// utility via app.getAppMetrics() + the Python approver via `ps`) at a fixed
// interval throughout the whole run, exactly as main/harness/memory-monitor.js
// does in production -- reporting the actual measured peak and sample count,
// not a single before/after snapshot or a hard-cap claim.
//
// Writes one line `RESULT_JSON:<json>` to stdout and exits.

const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { app, BrowserWindow, WebContentsView } = require("electron");

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APPROVER_SCRIPT = path.join(APP_ROOT, "approver", "approver_service.py");
const LONG_HORIZON_PLANNER = path.join(APP_ROOT, "fixtures", "scripted-planner-long-horizon.js");
const ITERATIONS = Number(process.env.HALO_REPEAT_COUNT || 20);
const SAMPLING_INTERVAL_MS = 300;
const APPROVE_GUARD_LIMIT = 10; // real journey needs exactly 3; generous headroom without masking a real hang as success

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
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

function defaultHostVerifier(criterion, evidence) {
  if (evidence.kind === "host_check") return true;
  return undefined;
}

async function makeSocketDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "halo-repeat-approver-")));
  await fs.chmod(dir, 0o700);
  return dir;
}

function spawnApprover(socketPath) {
  const python = process.env.HALO_PYTHON || "python3";
  const child = spawn(python, [APPROVER_SCRIPT, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrTail = { text: "" };
  child.stderr.on("data", (chunk) => {
    stderrTail.text = (stderrTail.text + chunk.toString()).slice(-4096);
  });
  return { child, stderrTail };
}

function waitForApproverReady(child, stderrTail, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`approver did not report ready within ${timeoutMs}ms; stderr: ${stderrTail.text}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.includes("halo computer-use approver ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`approver exited early (code=${code}); stderr: ${stderrTail.text}`));
    });
  });
}

async function runOneJourney({ win, fixtureUrl, approve, storageRoot, memoryMonitor }) {
  const startedAt = Date.now();
  const goal = {
    originalRequest: `방문 확인: ${fixtureUrl}`,
    criteria: [{ id: "visited", text: "reached the final page", required: true, verification: "host" }],
  };
  const store = await TaskStore.create(goal, { storageRoot });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  view.setVisible(false);
  const browser = new BrowserAdapter({ view });
  const planner = new PlannerStdioAdapter({
    command: process.execPath,
    args: [LONG_HORIZON_PLANNER],
    cwd: APP_ROOT,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: defaultHostVerifier, memoryMonitor });

  let approveCount = 0;
  try {
    await controller.start();
    for (; approveCount < APPROVE_GUARD_LIMIT && controller.getSnapshot().state === "awaiting_approval"; approveCount += 1) {
      const pending = controller.getSnapshot().approvalQueue;
      if (pending.length === 0) break;
      await controller.approve(pending[0].id);
    }
    const snapshot = controller.getSnapshot();
    return {
      success: snapshot.state === "completed",
      finalState: snapshot.state,
      pauseReason: snapshot.pauseReason,
      approveCount,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    // Never treat a thrown error as success -- record it plainly.
    return {
      success: false,
      finalState: controller.getSnapshot().state,
      pauseReason: controller.getSnapshot().pauseReason,
      approveCount,
      elapsedMs: Date.now() - startedAt,
      error: String((error && error.message) || error),
    };
  } finally {
    await planner.close().catch(() => {});
    await browser.dispose().catch(() => {});
    await store.close().catch(() => {});
  }
}

async function main() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-repeat-tasks-"));
  const startedAt = Date.now();
  await app.whenReady();

  const fixture = await startFixtureServer();
  const socketDir = await makeSocketDir();
  const socketPath = path.join(socketDir, "approver.sock");
  const { child: approverProcess, stderrTail } = spawnApprover(socketPath);
  await waitForApproverReady(approverProcess, stderrTail);

  const memoryMonitor = new MemoryMonitor({
    getAppMetrics: () => app.getAppMetrics(),
    getExternalMemoryBytes: getExternalMemoryBytesViaPs,
  });
  memoryMonitor.registerExternalProcess({ pid: approverProcess.pid, creationTime: startedAt, label: "approver" });

  const memorySamples = [];
  let peakBytes = 0;
  const sampleTimer = setInterval(() => {
    memoryMonitor
      .sample()
      .then((r) => {
        memorySamples.push({ at: Date.now() - startedAt, totalBytes: r.totalBytes, unmeasurableCount: r.unmeasurable.length });
        if (r.totalBytes > peakBytes) peakBytes = r.totalBytes;
      })
      .catch(() => {});
  }, SAMPLING_INTERVAL_MS);

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const approve = (descriptor) =>
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

  const results = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const beforeRequestCount = fixture.requestLog.length;
    // eslint-disable-next-line no-await-in-loop
    const result = await runOneJourney({ win, fixtureUrl: fixture.url, approve, storageRoot, memoryMonitor });
    const newPaths = fixture.requestLog.slice(beforeRequestCount).map((r) => r.path);
    result.iteration = i;
    result.newRequestPaths = newPaths;
    results.push(result);
    process.stderr.write(`[iteration ${i}] success=${result.success} finalState=${result.finalState} pauseReason=${result.pauseReason} elapsedMs=${result.elapsedMs} paths=${JSON.stringify(newPaths)}${result.error ? ` error=${result.error}` : ""}\n`);
  }

  clearInterval(sampleTimer);
  approverProcess.kill();
  memoryMonitor.unregister(approverProcess.pid);
  await fixture.stop();
  win.destroy();

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;
  const elapsedList = results.map((r) => r.elapsedMs);
  const limitBytes = 1_000_000_000;

  const result = {
    real: true,
    iterations: ITERATIONS,
    successCount,
    failureCount,
    totalWallMs: Date.now() - startedAt,
    samplingIntervalMs: SAMPLING_INTERVAL_MS,
    perIteration: results,
    elapsed: {
      minMs: Math.min(...elapsedList),
      maxMs: Math.max(...elapsedList),
      meanMs: elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length,
    },
    memory: {
      peakBytes,
      limitBytes,
      pass: peakBytes < limitBytes,
      sampleCount: memorySamples.length,
      coverage: "electron_main+renderer+gpu+utility(app.getAppMetrics) + python_approver(ps rss)",
    },
  };

  process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
  app.exit(failureCount > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String((err && err.stack) || err) })}\n`);
  app.exit(1);
});
