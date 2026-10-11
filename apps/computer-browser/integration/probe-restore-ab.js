"use strict";

// TEMPORARY measurement probe (not a test). Fair "restore + observe" A/B.
//
// The fork doc's "restore + observe: Electron 88 ms, Chromium ~1.5 s" was taken
// against the component build. This measures the same user-visible cost on the
// current binaries with the SAME production wiring for both runtimes:
//
//   ParkableView(lazy) -> wakeOnUse(BrowserAdapter) -> navigate -> observe
//   -> discard (renderer gone, URL kept) -> observe again
//
// The measured number is the second observe() to completion: wake (create the
// renderer + one GET of the saved URL) plus the real DOM observation.
//
// Run under BOTH runtimes, same fixture, same machine:
//   node integration/probe-restore-ab.js                              # Chromium
//   HALO_CHROMIUM=.../Trial/headless_shell node integration/probe-restore-ab.js
//   node_modules/.bin/electron integration/probe-restore-ab.js        # Electron
//
// HARO_RESTORE_REPS (default 5). Prints RESULT_JSON per rep + a median summary.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { ParkableView, wakeOnUse } = require("../main/harness/renderer-lifecycle");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const IS_ELECTRON = typeof process.versions.electron === "string";
const REPS = Number(process.env.HALO_RESTORE_REPS) || 5;
const PARTITION = "halo-task-restore-probe";

function fixtureServer() {
  const body = Array.from({ length: 40 }, (_, i) => `<p>row ${i}: bounded local fixture text for the restore probe</p>`).join("");
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><title>restore fixture</title></head><body><h1>Restore probe</h1><a href="/next">next</a><input id="q" value="ready">${body}</body></html>`);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function setupChromium() {
  const { CdpEngine } = require("../main/harness/cdp-engine");
  const chromiumPath = process.env.HALO_CHROMIUM
    || [path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/headless_shell")].find((p) => fs.existsSync(p));
  if (!chromiumPath || !fs.existsSync(chromiumPath)) throw new Error("no Chromium binary; set HALO_CHROMIUM");
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath });
  return {
    name: `chromium:${path.basename(path.dirname(chromiumPath))}`,
    create: () => ({ view: engine.createPage(PARTITION), dispose() {} }),
    teardown: () => engine.release(),
  };
}

async function setupElectron() {
  const { app, BrowserWindow, WebContentsView } = require("electron");
  const { installAgentRequestFilter } = require("../main/harness/agent-request-filter");
  await app.whenReady();
  const host = new BrowserWindow({ show: false, width: 1280, height: 800 });
  // Mirror of applyBrowserHardening (agent-viewport-host.js:89-98). That module
  // can no longer be imported here: it requires ../desktop-runtime at load time
  // and the runtime now refuses to load unless HALO_DESKTOP_RUNTIME=chromium.
  const harden = (wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    wc.on("will-navigate", (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
    wc.session.on("will-download", (event) => event.preventDefault());
    installAgentRequestFilter(wc.session);
  };
  return {
    name: `electron:${process.versions.electron}`,
    create: () => {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: PARTITION, offscreen: true } });
      harden(view.webContents);
      host.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      view.setVisible(true);
      return { view, dispose: () => { try { host.contentView.removeChildView(view); } catch { /* probe */ } } };
    },
    teardown: async () => { try { host.destroy(); } catch { /* probe */ } },
  };
}

async function main() {
  const runtime = IS_ELECTRON ? await setupElectron() : await setupChromium();
  const server = await fixtureServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const samples = [];
  const coldSamples = [];
  try {
    for (let rep = 0; rep < REPS; rep++) {
      const view = new ParkableView({ lazy: true, create: runtime.create, width: 1280, height: 800 });
      const adapter = wakeOnUse(new BrowserAdapter({ view }), view);
      try {
        const coldStart = performance.now();
        const nav = await adapter.execute({ type: "navigate", url });
        if (nav.status !== "ok") throw new Error(`navigate failed: ${nav.status}`);
        const warm = await adapter.observe();
        coldSamples.push(performance.now() - coldStart);
        if (!/restore fixture/.test(String(warm.title ?? ""))) throw new Error(`fixture title mismatch: ${warm.title}`);
        if (!(await view.discard())) throw new Error("discard refused");
        const started = performance.now();
        const observed = await adapter.observe();
        const restoreMs = performance.now() - started;
        if (!/restore fixture/.test(String(observed.title ?? ""))) throw new Error(`restore title mismatch: ${observed.title}`);
        if (observed.documentEpoch <= warm.documentEpoch) throw new Error("restore did not bump the document epoch");
        samples.push(restoreMs);
        console.log(`RESULT_JSON:${JSON.stringify({ runtime: runtime.name, rep, restoreMs: Number(restoreMs.toFixed(1)), coldMs: Number(coldSamples.at(-1).toFixed(1)), epochBumped: true, loadAvg: os.loadavg()[0].toFixed(2) })}`);
      } finally {
        try { await adapter.dispose(); } catch { /* probe */ }
      }
    }
  } finally {
    await runtime.teardown();
    await new Promise((resolve) => server.close(resolve));
  }
  const stat = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
    return { count: values.length, p50Ms: Number(at(0.5).toFixed(1)), p95Ms: Number(at(0.95).toFixed(1)), minMs: Number(sorted[0].toFixed(1)), maxMs: Number(sorted.at(-1).toFixed(1)) };
  };
  console.log(`\nRESULT_JSON:${JSON.stringify({ runtime: runtime.name, kind: "summary", restore: stat(samples), coldNavigateObserve: stat(coldSamples), machine: { cpus: os.cpus().length, loadAvg: os.loadavg()[0].toFixed(2) } })}`);
  process.exit(0);
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });