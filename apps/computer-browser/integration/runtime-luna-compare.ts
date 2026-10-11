"use strict";
// Same three ground-truth HALO tasks and Luna planner, comparing native
// Electron WebContentsView against the supported standalone Chromium CDP host.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.HALO_BENCH_OUTPUT || process.argv[2] || path.join(root, "../../artifacts/runtime-luna-compare", new Date().toISOString().replaceAll(":", "-")));
fs.mkdirSync(output, { recursive: true });
const taskIds = ["specs-retrieval", "returns-multihop-navigation", "store-mutation"];
function rssBytes() {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(x => x.trim().split(/\s+/).map(Number));
    const ids = new Set([process.pid]); let changed = true;
    while (changed) { changed = false; for (const [pid, parent] of rows) if (ids.has(parent) && !ids.has(pid)) { ids.add(pid); changed = true; } }
    return rows.reduce((sum, [pid, , rss]) => sum + (ids.has(pid) ? rss * 1024 : 0), 0);
  } catch { return 0; }
}
async function runSuite(kind) {
  const { runAccuracySuite } = require("./accuracy/run-suite.ts");
  const { PlannerStdioAdapter } = require("../main/harness/planner-stdio.js");
  const { BrowserAdapter } = require("../main/harness/browser-adapter.js");
  const usage: any[] = [];
  let window: any;
  const browser = kind === "electron" ? async () => {
    const { BrowserWindow, WebContentsView } = require("electron");
    if (!window) window = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `halo-ab-${Date.now()}-${Math.random()}` } });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    return new BrowserAdapter({ view, navigationTimeoutMs: 20_000 });
  } : undefined;
  let peakRssBytes = rssBytes();
  const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, rssBytes()); }, 250);
  const startedAt = performance.now();
  try {
    const suite = await runAccuracySuite({ taskIds, timeoutMs: 180_000, ...(browser ? { createBrowser: browser } : {}),
      approve: async () => ({ decision: "allow", reasons: [] }),
      plannerFactory: (task: any) => new PlannerStdioAdapter({ command: process.versions.electron ? execFileSync("which", ["node"], { encoding: "utf8" }).trim() : process.execPath, args: [path.join(root, "main/harness/providers/codex-planner-worker.js"), "--model", "gpt-6-luna"], cwd: root, timeoutMs: 120_000, onUsage: (entry: any) => usage.push({ taskId: task.taskId, ...entry }) }) });
    return { arm: kind, model: "gpt-6-luna", startupMs: kind === "chromium" ? 0 : null, ...suite, usage, peakProcessTreeRssBytes: peakRssBytes, wallMs: performance.now() - startedAt };
  } finally { clearInterval(sampler); window?.destroy(); }
}
function runElectronArm(): Promise<any> {
  return new Promise((resolve, reject) => {
    const executable = require("electron");
    const profile = mkdtempSync(path.join(os.tmpdir(), "halo-electron-luna-"));
    const child = spawn(executable, [`--user-data-dir=${profile}`, __filename], { cwd: root, env: { ...process.env, HALO_BENCH_ARM: "electron", HALO_BENCH_OUTPUT: output }, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      const line = stdout.split("\n").find(x => x.startsWith("HALO_RESULT:"));
      if (code !== 0 || !line) return reject(new Error(`electron_benchmark_exit_${code}: ${stdout.slice(-1000)}`));
      rmSync(profile, { recursive: true, force: true });
      resolve(JSON.parse(line.slice("HALO_RESULT:".length)));
    });
  });
}
async function main() {
  if (process.versions.electron && process.env.HALO_BENCH_ARM === "electron") {
    const { app } = require("electron"); await app.whenReady();
    const result = await runSuite("electron");
    fs.writeFileSync(path.join(output, "electron.json"), JSON.stringify(result, null, 2));
    console.log(`HALO_RESULT:${JSON.stringify(result)}`); app.quit(); return;
  }
  const report: any = { schemaVersion: 1, model: "gpt-6-luna", taskIds, method: "native Electron WebContentsView vs standalone Chromium CDP, same BrowserAdapter, TaskController, viewport, fixture and serial task order", electronVersion: require("electron/package.json").version, chromiumExecutable: require("../main/harness/cdp-browser-host.js").findChromium(), runs: [] };
  report.runs.push(await runElectronArm());
  fs.writeFileSync(path.join(output, "electron.json"), JSON.stringify(report.runs[0], null, 2));
  const chromium = await runSuite("chromium"); report.runs.push(chromium);
  fs.writeFileSync(path.join(output, "chromium.json"), JSON.stringify(chromium, null, 2));
  const summary = { schemaVersion: 1, model: report.model, method: report.method, electronVersion: report.electronVersion, chromiumExecutable: report.chromiumExecutable,
    runs: report.runs.map(({ arm, summary, rows, wallMs, peakProcessTreeRssBytes }: any) => ({ arm, summary, tasks: rows.map(({ taskId, verdict, reason, wallMs, plannerCalls, actionsUsed }: any) => ({ taskId, verdict, reason, wallMs, plannerCalls, actionsUsed })), wallMs, peakProcessTreeRssBytes })) };
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ ...report, runs: summary.runs }, null, 2));
  console.log(JSON.stringify({ output, ...summary }, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; if (process.versions.electron) require("electron").app.quit(); });
