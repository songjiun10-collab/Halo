"use strict";

// Replays a fixed planner over the HALO accuracy fixtures to compare the
// native Electron WebContentsView path with standalone Chromium/CDP. No model
// process, credentials, external sites, or mutating fixture tasks are used.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.HALO_FIXED_OUTPUT || process.argv[2] || path.join(root, "../../artifacts/runtime-fixed-compare", new Date().toISOString().replaceAll(":", "-")));
const taskIds = ["specs-retrieval", "walkthrough-navigation", "returns-multihop-navigation"];
const repetitions = Number(process.env.HALO_FIXED_REPETITIONS || 5);
const READ_ONLY = { decision: "allow", reasons: ["fixed_local_fixture"] };
let electronWindow;
fs.mkdirSync(output, { recursive: true });

function fixedPlanner(task) {
  return {
    close() {},
    async next(context) {
      const observation = context.observation || {};
      const elements = observation.elements || [];
      const text = [observation.text || "", ...elements.map((item) => item.name || "")].join("\n");
      const base = {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: observation.id || "fixed-observation",
        criterionIds: (context.goal?.criteria || []).map((criterion) => criterion.id),
      };
      if (task.taskId === "specs-retrieval") {
        if (/11-inch/i.test(text)) return { ...base, kind: "need_user", reason: "M4, 11-inch, 16GB." };
        return { ...base, kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
      }
      const url = observation.url || "";
      if (task.taskId === "walkthrough-navigation") {
        if (/\/walkthrough\/2(?:$|[?#])/.test(url)) return { ...base, kind: "finish", evidenceIds: [] };
        const chapter = elements.find((item) => item.role === "link" && /Chapter 2/i.test(item.name || ""));
        return chapter
          ? { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: chapter.elementId }] }
          : { ...base, kind: "actions", actions: [{ type: "navigate", url: "__SITE__/walkthrough" }] };
      }
      if (/\/support\/shipping\/returns(?:$|[?#])/.test(url)) return { ...base, kind: "finish", evidenceIds: [] };
      const next = [
        { path: /\/support\/shipping(?:$|[?#])/, name: /Returns/i },
        { path: /\/support(?:$|[?#])/, name: /Shipping/i },
        { path: /\/$/, name: /Support/i },
      ].find((step) => step.path.test(url));
      const link = next && elements.find((item) => item.role === "link" && next.name.test(item.name || ""));
      return link
        ? { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: link.elementId }] }
        : { ...base, kind: "need_user", reason: `missing expected link at ${url}` };
    },
  };
}

async function runSuite(arm, browserState) {
  const { runAccuracySuite } = require("./accuracy/run-suite.ts");
  const { BrowserAdapter } = require("../main/harness/browser-adapter.js");
  const { openCdpView } = require("../main/harness/cdp-web-contents.js");
  const metrics = { observe: { calls: 0, ms: 0 }, execute: { calls: 0, ms: 0, byAction: {} } };
  const createBrowser = arm === "electron" ? async ({ viewport }) => {
    const { BrowserWindow, WebContentsView } = require("electron");
    if (!electronWindow) electronWindow = new BrowserWindow({ show: false, width: viewport.width, height: viewport.height });
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `halo-fixed-${process.pid}-${Date.now()}-${Math.random()}`,
    } });
    electronWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    return instrument(new BrowserAdapter({ view, navigationTimeoutMs: 20_000 }), metrics);
  } : async ({ viewport }) => {
    const view = await openCdpView(browserState.wsUrl, { ...viewport, commandTimeoutMs: 120_000 });
    const adapter = instrument(new BrowserAdapter({ view, navigationTimeoutMs: 20_000 }), metrics);
    const dispose = adapter.dispose.bind(adapter);
    adapter.dispose = async () => { await dispose(); view.closeConnection?.(); };
    return adapter;
  };
  const startedAt = performance.now();
  try {
    const suite = await runAccuracySuite({
      taskIds, createBrowser, timeoutMs: 60_000,
      plannerFactory: (task) => fixedPlanner(task),
      approve: async () => READ_ONLY,
    });
    return { arm, ...suite, metrics, wallMs: performance.now() - startedAt };
  } finally {
    // Keep the hidden host window alive across repetitions; closing the last
    // Electron window can terminate the app before the benchmark is serialized.
  }
}

function instrument(adapter, metrics) {
  const observe = adapter.observe.bind(adapter);
  adapter.observe = async (...args) => {
    const start = performance.now();
    try { return await observe(...args); }
    finally { metrics.observe.calls += 1; metrics.observe.ms += performance.now() - start; }
  };
  const execute = adapter.execute.bind(adapter);
  adapter.execute = async (action, ...args) => {
    const start = performance.now();
    try { return await execute(action, ...args); }
    finally {
      const elapsed = performance.now() - start;
      const type = action?.type || "unknown";
      metrics.execute.calls += 1;
      metrics.execute.ms += elapsed;
      const bucket = metrics.execute.byAction[type] || (metrics.execute.byAction[type] = { calls: 0, ms: 0 });
      bucket.calls += 1;
      bucket.ms += elapsed;
    }
  };
  return adapter;
}

async function electronWorker() {
  const { app } = require("electron");
  const appStart = Date.now();
  await app.whenReady();
  process.stdout.write(`HALO_READY:${JSON.stringify({ appReadyMs: Date.now() - appStart })}\n`);
  const warmup = await runSuite("electron", null);
  const runs = [];
  for (let i = 0; i < repetitions; i += 1) runs.push(await runSuite("electron", null));
  return { arm: "electron", warmup, runs };
}

function runElectronWorker() {
  return new Promise((resolve, reject) => {
    const executable = require("electron");
    const profile = mkdtempSync(path.join(os.tmpdir(), "halo-fixed-electron-"));
    const launchedAt = performance.now();
    const child = spawn(executable, [`--user-data-dir=${profile}`, __filename], {
      cwd: root,
      env: { ...process.env, HALO_FIXED_ARM: "electron", HALO_FIXED_OUTPUT: output },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    let appReadyMs = null;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const ready = stdout.split("\n").find((line) => line.startsWith("HALO_READY:"));
      if (ready && appReadyMs === null) appReadyMs = performance.now() - launchedAt;
    });
    child.once("error", (error) => { rmSync(profile, { recursive: true, force: true }); reject(error); });
    child.once("exit", (code) => {
      try {
        const line = stdout.split("\n").find((value) => value.startsWith("HALO_RESULT:"));
        if (code !== 0 || !line) throw new Error(`electron_benchmark_exit_${code}: ${stdout.slice(-2000)}`);
        resolve({ ...JSON.parse(line.slice("HALO_RESULT:".length)), startupMs: appReadyMs });
      } catch (error) { reject(error); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    });
  });
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, p50: percentile(0.5), p95: percentile(0.95), min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
}

async function main() {
  if (process.versions.electron && process.env.HALO_FIXED_ARM === "electron") {
    const result = await electronWorker();
    fs.writeFileSync(path.join(output, "electron.json"), JSON.stringify(result, null, 2));
    process.stdout.write(`HALO_RESULT:${JSON.stringify(result)}\n`);
    require("electron").app.quit();
    return;
  }
  const { acquireCdpBrowser, findChromium } = require("../main/harness/cdp-browser-host.js");
  const electron = await runElectronWorker();
  const startupAt = performance.now();
  const chromium = await acquireCdpBrowser({ headless: true, startupTimeoutMs: 120_000 });
  const chromiumStartupMs = performance.now() - startupAt;
  try {
    const chromiumWarmup = await runSuite("chromium", chromium);
    const chromiumRuns = [];
    for (let i = 0; i < repetitions; i += 1) chromiumRuns.push(await runSuite("chromium", chromium));
    const arms = [
      { arm: "electron", startupMs: electron.startupMs, warmup: electron.warmup, runs: electron.runs },
      { arm: "chromium", startupMs: chromiumStartupMs, warmup: chromiumWarmup, runs: chromiumRuns },
    ];
    const summarize = (arm) => {
      const all = arm.runs.flatMap((run) => run.rows);
      const taskIds = [...new Set(all.map((row) => row.taskId))];
      const obs = arm.runs.map((run) => run.metrics.observe.ms);
      const exec = arm.runs.map((run) => run.metrics.execute.ms);
      const taskWallById = Object.fromEntries(taskIds.map((id) => [id, stats(all.filter((row) => row.taskId === id).map((row) => row.wallMs))]));
      return {
        arm: arm.arm, startupMs: arm.startupMs,
        warmup: { verdicts: arm.warmup.rows.map(({ taskId, verdict }) => ({ taskId, verdict })), metrics: arm.warmup.metrics, wallMs: arm.warmup.wallMs },
        measured: {
          repetitions: arm.runs.length,
          verdicts: all.map(({ taskId, verdict }) => ({ taskId, verdict })),
          taskWallMs: taskWallById,
          suiteWallMs: stats(arm.runs.map((run) => run.wallMs)),
          observeTotalMs: stats(obs), executeTotalMs: stats(exec),
          meanBrowserOperationMs: {
            observe: arm.runs.reduce((sum, run) => sum + run.metrics.observe.ms, 0) / arm.runs.reduce((sum, run) => sum + run.metrics.observe.calls, 0),
            execute: arm.runs.reduce((sum, run) => sum + run.metrics.execute.ms, 0) / arm.runs.reduce((sum, run) => sum + run.metrics.execute.calls, 0),
          },
          aggregateMetrics: arm.runs.reduce((acc, run) => {
            acc.observe.calls += run.metrics.observe.calls; acc.observe.ms += run.metrics.observe.ms;
            acc.execute.calls += run.metrics.execute.calls; acc.execute.ms += run.metrics.execute.ms;
            for (const [type, bucket] of Object.entries(run.metrics.execute.byAction)) {
              const target = acc.execute.byAction[type] || (acc.execute.byAction[type] = { calls: 0, ms: 0 });
              target.calls += bucket.calls; target.ms += bucket.ms;
            }
            return acc;
          }, { observe: { calls: 0, ms: 0 }, execute: { calls: 0, ms: 0, byAction: {} } }),
        },
      };
    };
    const result = {
      schemaVersion: 1,
      method: "fixed local fixture planner; same three read-only tasks, BrowserAdapter, TaskController, viewport, approval, serial runs; one warmup then repeated measured runs; no model calls",
      repetitions, taskIds, electronVersion: require("electron/package.json").version,
      chromiumExecutable: findChromium(),
      arms: arms.map(summarize),
    };
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ output, ...result }, null, 2));
  } finally { await chromium.close?.(); }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
  if (process.versions.electron) require("electron").app.quit();
});
