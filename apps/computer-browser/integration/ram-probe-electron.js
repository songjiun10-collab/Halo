"use strict";

// Per-process-type memory of Electron with N hidden agent surfaces, under a
// set of Chromium switches given as JSON in HALO_PROBE_SWITCHES
// ([["disable-features","X"],["renderer-process-limit","4"]]).
// Prints RESULT_JSON: {byType, totalMB, procs}.
const http = require("node:http");
const { app, BrowserWindow, WebContentsView } = require("electron");

for (const [name, value] of JSON.parse(process.env.HALO_PROBE_SWITCHES || "[]")) {
  if (value === undefined || value === null) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, String(value));
}
const SURFACES = Number(process.env.HALO_PROBE_SURFACES || 3);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>probe ${req.url}</title><main>${"bounded local fixture ".repeat(4000)}</main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const win = new BrowserWindow({ show: false, width: 1280, height: 800 });
  await win.loadURL("data:text/html,<title>ui</title><body>shell");
  for (let i = 0; i < SURFACES; i += 1) {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `probe-${i}`, spellcheck: false } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/${i}`);
  }
  await wait(3000);
  const byType = {};
  let total = 0;
  const rows = app.getAppMetrics();
  for (const row of rows) {
    const mb = row.memory.workingSetSize / 1024;
    byType[row.type] = Math.round(((byType[row.type] || 0) + mb) * 10) / 10;
    total += mb;
  }
  console.log(`RESULT_JSON:${JSON.stringify({ byType, totalMB: Math.round(total), procs: rows.length })}`);
  app.exit(0);
}
main().catch((error) => { console.error(error); app.exit(1); });
