"use strict";

// Design spike only. Run with:
//   node_modules/.bin/electron integration/agent-viewport-spike.js
//
// Verifies the pinned Electron runtime can host a hidden, fixed-size agent
// renderer without adding it to the user's visible window. It loads only a
// data: URL and makes no network requests. This is deliberately not wired into
// the regular suite until the architecture is accepted and product lifecycle
// behavior is implemented.

const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView } = require("electron");

const AGENT_WIDTH = 1440;
const AGENT_HEIGHT = 900;
const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_DURATION_MS = 3000;

function processBytes(metrics) {
  return metrics.map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    bytes: typeof metric.memory?.workingSetSize === "number"
      ? metric.memory.workingSetSize * 1024
      : null,
  }));
}

async function main() {
  await app.whenReady();
  const before = processBytes(app.getAppMetrics());
  const host = new BrowserWindow({
    show: false,
    width: AGENT_WIDTH,
    height: AGENT_HEIGHT,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "halo-viewport-spike",
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "halo-viewport-spike",
    },
  });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
  view.setVisible(true);

  try {
    const page = `<!doctype html><meta charset="utf-8"><title>Viewport probe</title><main>local viewport probe</main>`;
    await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const layout = await view.webContents.executeJavaScript(`({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
    })`);
    assert.deepEqual(layout, {
      innerWidth: AGENT_WIDTH,
      innerHeight: AGENT_HEIGHT,
      clientWidth: AGENT_WIDTH,
      clientHeight: AGENT_HEIGHT,
    });
    assert.equal(host.isVisible(), false);
    assert.equal(view.getBounds().width, AGENT_WIDTH);
    assert.equal(view.getBounds().height, AGENT_HEIGHT);

    const samples = [];
    const sampleUntil = Date.now() + SAMPLE_DURATION_MS;
    while (Date.now() < sampleUntil) {
      const processes = processBytes(app.getAppMetrics());
      const measured = processes.filter((item) => item.bytes !== null);
      samples.push({
        at: Date.now(),
        processes,
        totalBytes: measured.reduce((sum, item) => sum + item.bytes, 0),
      });
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    }
    const peak = samples.reduce((max, sample) => sample.totalBytes > max.totalBytes ? sample : max, samples[0]);
    const result = {
      pass: true,
      electron: process.versions.electron,
      viewport: layout,
      hostVisible: host.isVisible(),
      agentViewVisible: view.getVisible(),
      sampleCount: samples.length,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sampleDurationMs: SAMPLE_DURATION_MS,
      peakProcessBytes: peak.totalBytes,
      peakProcesses: peak.processes,
      note: "short Electron-process sample only; excludes external planner/approver and is not the full under-1-GB benchmark",
    };
    process.stdout.write(`RESULT_JSON=${JSON.stringify(result)}\n`);
  } finally {
    host.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
