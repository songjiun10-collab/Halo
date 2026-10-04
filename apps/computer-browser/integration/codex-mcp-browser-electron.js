"use strict";

// Real Electron DOM -> connected GitHub MCP -> bounded planner observation.
// Read-only public file, no model inference, no imported browser credentials.
const { app, BrowserWindow, WebContentsView } = require("electron");
const { execFile } = require("node:child_process");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { CodexMcpAdapter, parseRepositories } = require("../main/harness/providers/codex-mcp-adapter");
const { makeMcpBrowserObservation } = require("../main/harness/mcp-browser-observation");
const { sumProcessTreeRssBytes } = require("../main/harness/process-tree-memory");

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("Pass a scoped public GitHub file URL");
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: `halo-mcp-smoke-${process.pid}`,
  } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const raw = new BrowserAdapter({ view });
  let codexPid = null;
  let workerPeakBytes = 0;
  let totalPeakBytes = 0;
  let sampling = false;
  let metrics;
  const connector = new CodexMcpAdapter({
    repositories: parseRepositories(process.env.HALO_CODEX_MCP_REPOSITORIES || ""),
    onWorkerStart: ({ pid }) => { codexPid = pid; },
    onWorkerExit: () => { codexPid = null; },
  });
  const browser = makeMcpBrowserObservation({ browser: raw, connector, onMetric: (metric) => { metrics = metric; } });
  const sample = () => {
    if (sampling) return;
    sampling = true;
    execFile("ps", ["-axo", "pid=,ppid=,rss="], (error, output) => {
      sampling = false;
      if (error) return;
      if (codexPid) workerPeakBytes = Math.max(workerPeakBytes, sumProcessTreeRssBytes(output, codexPid) || 0);
      totalPeakBytes = Math.max(totalPeakBytes, sumProcessTreeRssBytes(output, process.pid) || 0);
    });
  };
  const poll = setInterval(sample, 100);
  const deadline = setTimeout(() => { connector.close().catch(() => {}); view.webContents.stop(); }, 45000);
  try {
    const navigation = await raw.execute({ type: "navigate", url });
    if (navigation.status !== "ok") throw new Error(navigation.errorCode);
    const observationStartedAt = Date.now();
    const result = await browser.observe();
    const selected = result.connector?.authority === "untrusted_connector" && metrics?.source === "codex_mcp";
    if (!selected && metrics?.code !== "not_smaller") {
      throw new Error(metrics?.code || "connector_fallback");
    }
    const selectedBytes = Buffer.byteLength(JSON.stringify(result));
    if (selectedBytes > metrics.domObservationBytes) throw new Error("observation_size_regression");
    sample();
    console.log(JSON.stringify({ passed: true, sourceUrl: result.url, documentEpoch: result.documentEpoch,
      domObservationBytes: metrics.domObservationBytes, connectorObservationBytes: metrics.connectorObservationBytes,
      selectedObservationBytes: selectedBytes, connectorSelected: selected, fallbackReason: selected ? null : metrics.code,
      observationByteReductionPercent: Math.round((1 - selectedBytes / metrics.domObservationBytes) * 10000) / 100,
      observationLatencyMs: Date.now() - observationStartedAt, returnedTextBytes: Buffer.byteLength(result.text),
      truncated: result.connector?.truncated ?? null, retainedElements: result.elements.length,
      codexProcessTreePeakBytes: workerPeakBytes, haloSmokeProcessTreePeakBytes: totalPeakBytes,
      measuredTokens: null, note: "Byte comparison; no model token count or full-app memory measurement." }));
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
    await browser.dispose();
    await connector.close();
    window.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(JSON.stringify({ passed: false, code: error.code || error.message }));
  app.exit(1);
});
