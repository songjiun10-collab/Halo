"use strict";

// Real Electron measurement of two complete visible+hidden browser task
// surfaces. Planner and approver worker processes are not part of this probe;
// production admission adds a measured planner process-tree reserve and still
// requires a fresh, fully measurable aggregate sample.
const http = require("node:http");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { AgentViewportHost, applyBrowserHardening } = require("../main/harness/agent-viewport-host");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const LIMIT_BYTES = 1_000_000_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Parallel probe</title><main>${"bounded local fixture ".repeat(4000)}</main>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const host = new AgentViewportHost();
  const mainWindow = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const visibleAdapters = [];
  const samples = [];
  const sample = () => {
    const rows = app.getAppMetrics();
    const unmeasurable = rows.filter((row) => !Number.isFinite(row.memory?.workingSetSize)).map((row) => row.type || String(row.pid));
    const bytes = rows.reduce((total, row) => total + (Number.isFinite(row.memory?.workingSetSize) ? row.memory.workingSetSize * 1024 : 0), 0);
    samples.push({ bytes, unmeasurable });
  };
  const timer = setInterval(sample, 50);
  try {
    sample();
    const baselineBytes = samples.at(-1).bytes;
    const taskIds = ["parallel-probe-0001", "parallel-probe-0002"];
    const adapters = [];
    for (const taskId of taskIds) {
      const partition = `halo-task-${taskId}`;
      const visibleView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
      applyBrowserHardening(visibleView.webContents);
      mainWindow.contentView.addChildView(visibleView);
      visibleView.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      const visibleAdapter = new BrowserAdapter({ view: visibleView });
      visibleAdapters.push(visibleAdapter);
      const agentAdapter = host.ensure(taskId);
      adapters.push(visibleAdapter, agentAdapter);
    }
    const navigations = await Promise.all([
      ...adapters.map((adapter) => adapter.execute({ type: "navigate", url })),
    ]);
    if (navigations.some((result) => result.status !== "ok")) throw new Error(`parallel navigations failed: ${JSON.stringify(navigations)}`);
    for (let i = 0; i < 30; i += 1) { sample(); await wait(50); }
    const peakBytes = Math.max(...samples.map((item) => item.bytes));
    const result = {
      real: true,
      baselineBytes,
      peakBytes,
      observedIncrementBytes: Math.max(0, peakBytes - baselineBytes),
      reservedPerTaskSuggestionBytes: Math.ceil(Math.max(0, peakBytes - baselineBytes) / 2 * 1.25),
      limitBytes: LIMIT_BYTES,
      sampleCount: samples.length,
      pollIntervalMs: 50,
      unmeasurable: [...new Set(samples.flatMap((item) => item.unmeasurable))],
      limitation: "two complete visible+hidden browser task surfaces; no planner or approver workers; sampled peak cannot bound unobserved spikes",
    };
    result.pass = result.peakBytes < LIMIT_BYTES && result.unmeasurable.length === 0;
    process.stdout.write(`RESULT_JSON:${JSON.stringify(result)}\n`);
    if (!result.pass) throw new Error("concurrent renderer sample exceeded the memory gate or had unmeasurable processes");
  } finally {
    clearInterval(timer);
    await host.disposeAll();
    await Promise.allSettled(visibleAdapters.map((adapter) => adapter.dispose()));
    if (!mainWindow.isDestroyed()) mainWindow.destroy();
    await new Promise((resolve) => fixture.close(resolve));
    app.quit();
  }
}

main().catch((error) => {
  process.stdout.write(`RESULT_JSON:${JSON.stringify({ real: true, error: String(error.stack || error) })}\n`);
  app.exit(1);
});
