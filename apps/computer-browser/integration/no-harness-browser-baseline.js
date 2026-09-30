"use strict";

// Browser-only comparison baseline for integration/repeat-journey-verification.js.
// Same Electron/Chromium build, local three-page fixture, hidden BrowserWindow,
// one new sandboxed WebContentsView per iteration, and the same 300ms aggregate
// Electron-process sampling cadence. Deliberately omits TaskStore,
// TaskController, BrowserAdapter, planner workers, Python approver, and approval
// round-trips: this measures the browser work without the long-horizon harness.
//
// Run: HALO_REPEAT_COUNT=20 node_modules/.bin/electron integration/no-harness-browser-baseline.js
// Emits RESULT_JSON:<json> and exits nonzero if any page fails to load.

const { app, BrowserWindow, WebContentsView } = require("electron");
const { startFixtureServer } = require("../fixtures/long-horizon-site");

const ITERATIONS = Number(process.env.HALO_REPEAT_COUNT || 20);
const SAMPLING_INTERVAL_MS = 300;

async function load(view, url, timeoutMs = 10000) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`navigation timed out: ${url}`)), timeoutMs);
    });
    await Promise.race([view.webContents.loadURL(url), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  await app.whenReady();
  const fixture = await startFixtureServer();
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const memorySamples = [];
  let peakBytes = 0;
  const startedAt = Date.now();
  const sample = () => {
    for (const metric of app.getAppMetrics()) {
      if (Number.isFinite(metric.memory?.workingSetSize)) peakBytes = Math.max(peakBytes, metric.memory.workingSetSize * 1024);
    }
    const totalBytes = app.getAppMetrics().reduce((sum, metric) => sum + (Number.isFinite(metric.memory?.workingSetSize) ? metric.memory.workingSetSize * 1024 : 0), 0);
    memorySamples.push({ at: Date.now() - startedAt, totalBytes });
    peakBytes = Math.max(peakBytes, totalBytes);
  };
  const timer = setInterval(sample, SAMPLING_INTERVAL_MS);
  sample();
  const paths = ["/", "/page2", "/page3"];
  const results = [];

  try {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const started = Date.now();
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
      win.contentView.addChildView(view);
      view.setVisible(false);
      let error = null;
      try {
        for (const path of paths) await load(view, `${fixture.url.replace(/\/$/, "")}${path === "/" ? "/" : path}`);
      } catch (caught) {
        error = String(caught?.message || caught);
      } finally {
        win.contentView.removeChildView(view);
        view.webContents.destroy();
      }
      const newPaths = fixture.requestLog.slice(-3).map((request) => request.path);
      results.push({ iteration, success: error === null && JSON.stringify(newPaths) === JSON.stringify(paths), elapsedMs: Date.now() - started, newRequestPaths: newPaths, error });
      process.stderr.write(`[baseline ${iteration}] success=${results.at(-1).success} elapsedMs=${results.at(-1).elapsedMs} paths=${JSON.stringify(newPaths)}${error ? ` error=${error}` : ""}\n`);
    }
  } finally {
    clearInterval(timer);
    sample();
    await fixture.stop();
    win.destroy();
  }

  const elapsed = results.map((result) => result.elapsedMs);
  const successCount = results.filter((result) => result.success).length;
  const output = {
    real: true,
    mode: "browser_without_harness",
    iterations: ITERATIONS,
    successCount,
    failureCount: ITERATIONS - successCount,
    totalWallMs: Date.now() - startedAt,
    samplingIntervalMs: SAMPLING_INTERVAL_MS,
    perIteration: results,
    elapsed: {
      minMs: Math.min(...elapsed),
      maxMs: Math.max(...elapsed),
      meanMs: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
    },
    memory: {
      peakBytes,
      sampleCount: memorySamples.length,
      coverage: "Electron main+renderer+gpu+utility via app.getAppMetrics; no external workers exist in this mode",
    },
    comparisonLimits: [
      "The no-harness baseline directly navigates the same three local pages and omits planning, observation, durable task storage, and approval round-trips.",
      "The harness run's MemoryMonitor includes the Python approver but does not register transient planner worker processes; its measured total may undercount full harness RSS.",
      "The 300ms polling interval can miss short-lived memory peaks.",
    ],
  };
  process.stdout.write(`RESULT_JSON:${JSON.stringify(output)}\n`);
  app.exit(output.failureCount > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, mode: "browser_without_harness", error: String(error?.stack || error) })}\n`);
  app.exit(1);
});
