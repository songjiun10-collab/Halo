"use strict";

// "/goal"-style real-agent run: a real Claude (the local `claude` CLI, via the
// existing claude-code-worker planner provider) is handed ONE natural-language
// goal and drives the HALO harness on a real Electron BrowserAdapter until it
// reaches the target page. Only harnessProfile differs between runs. This is
// a small-sample, nondeterministic run (an LLM decides each step), not a
// benchmark: it exists to observe real planner latency and how many actions a
// real model actually batches under each profile's cap.
//
// DATA FLOW: every planner call sends the goal, journal events and the current
// page observation to the Anthropic API through the local `claude` login. The
// pages are a local synthetic fixture; no real site, account, or credential
// is involved. Approval is an immediate programmatic "allow" (no human).
//
// Run from apps/computer-browser:
//   ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node_modules/.bin/electron integration/llm-goal-run.js
// HALO_LLM_VERIFIED=1 switches to a persistent-goal check: the criterion is
//   host-verified (true only while the browser's current page contains
//   TARGET-FOUND), the run does NOT stop when the marker is first seen, and it
//   ends when the controller itself ends (completed / awaiting_verification /
//   paused) or the timeout stops it.
// Env: HALO_LLM_PROFILES (comma list, default "short,middle"), HALO_LLM_DEPTH
//   (1..3, default 2), HALO_LLM_BRANCH (2..4, default 3), HALO_LLM_TIMEOUT_S
//   (30..900, default 300). Emits RESULT_JSON:<json>.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { PlannerStdioAdapter } = require("../main/harness/planner-stdio");
const { HARNESS_PROFILES } = require("../shared/harness-profile");

const WORKER = path.resolve(__dirname, "..", "main", "harness", "providers", "claude-code-worker.js");
const APP_ROOT = path.resolve(__dirname, "..");

function envInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
}

async function runOne({ profile, site, createBrowser, storageRoot, timeoutMs, verified }) {
  const plannerLatencies = [];
  const proposalSizes = [];
  const counts = { approvals: 0, plannerCalls: 0, journalFsyncs: 0 };
  const visited = [];
  const trace = [];
  let found = false;
  let foundAtMs = null;
  let onTargetPage = false;
  const startedAt = performance.now();
  let controller = null;

  const browser = await createBrowser();
  const observe = browser.observe.bind(browser);
  browser.observe = async (...args) => {
    const observation = await observe(...args);
    if (observation?.url && observation.url !== "about:blank" && visited.at(-1) !== observation.url) visited.push(observation.url);
    const seen = [observation?.text || "", ...(observation?.elements || []).map((item) => item.name || "")].join(" ");
    onTargetPage = seen.includes("TARGET-FOUND");
    if (!found && onTargetPage) {
      found = true;
      foundAtMs = performance.now() - startedAt;
      if (!verified) Promise.resolve().then(() => controller?.stop()).catch(() => {});
    }
    return observation;
  };

  const store = await TaskStore.create({
    originalRequest: `Find the page on this small website that contains the text TARGET-FOUND. Start at ${site.origin}/n/r . Pages link to sub-sections; some sections are dead ends.`,
    criteria: [{ id: "found", text: "reached the page containing TARGET-FOUND", required: true, verification: verified ? "host" : "user" }],
    limits: { maxActions: 200, maxPlannerCalls: 60, maxActiveMs: 30 * 60 * 1000 },
  }, { storageRoot, onTiming: ({ operation }) => { if (operation === "journal_fsync") counts.journalFsyncs += 1; } });

  const planner = new PlannerStdioAdapter({
    command: process.execPath,
    args: [WORKER],
    cwd: APP_ROOT,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: 120000,
  });
  const timedPlanner = {
    warm: () => planner.warm?.(),
    close: () => planner.close(),
    next: async (context, options) => {
      counts.plannerCalls += 1;
      const t0 = performance.now();
      try {
        const proposal = await planner.next(context, options);
        if (proposal.kind === "actions") proposalSizes.push(proposal.actions.length);
        trace.push({ url: context.observation?.url, links: (context.observation?.elements || []).filter((item) => item.role === "link").length, kind: proposal.kind, actions: (proposal.actions || []).map((action) => action.type + (action.elementId ? `:${action.elementId}` : "")) });
        return proposal;
      } finally {
        plannerLatencies.push(performance.now() - t0);
      }
    },
  };
  controller = new TaskController({
    store,
    planner: timedPlanner,
    browser,
    approve: async () => { counts.approvals += 1; return { decision: "allow", reasons: [] }; },
    hostVerifier: () => (verified ? onTargetPage : true),
    harnessProfile: profile,
  });

  let endState = null;
  let workerStderrTail = null;
  const timer = setTimeout(() => { controller.stop().catch(() => {}); }, timeoutMs);
  try {
    const snapshot = await controller.start();
    endState = `${snapshot.state}/${snapshot.pauseReason ?? "-"}`;
  } catch (error) {
    endState = `error: ${error.message}`;
  } finally {
    workerStderrTail = planner.stderrTail ?? planner.getStderrTail?.() ?? null;
    clearTimeout(timer);
    const finalSnapshot = controller.getSnapshot();
    const actions = finalSnapshot.budgets?.actionsUsed ?? null;
    await planner.close().catch(() => {});
    await browser.dispose().catch(() => {});
    await store.close().catch(() => {});
    const sorted = [...plannerLatencies].sort((a, b) => a - b);
    return {
      profile,
      found,
      endState,
      timeToTargetMs: foundAtMs,
      totalMs: performance.now() - startedAt,
      actions,
      finalSnapshotState: finalSnapshot.state,
      workerStderrTail,
      trace,
      pagesVisited: visited.length,
      ...counts,
      proposalSizes,
      meanActionsPerProposal: proposalSizes.length ? proposalSizes.reduce((a, b) => a + b, 0) / proposalSizes.length : null,
      plannerLatencyMs: {
        mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
        median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
        max: sorted.at(-1) ?? null,
      },
    };
  }
}

async function main() {
  const { app, BrowserWindow, WebContentsView } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const { startSite } = require("./complex-browser-vs-harness-benchmark");

  const profiles = (process.env.HALO_LLM_PROFILES || "short,middle").split(",").map((item) => item.trim());
  for (const profile of profiles) if (!HARNESS_PROFILES.includes(profile)) throw new RangeError(`unknown profile ${profile}`);
  const depth = envInt("HALO_LLM_DEPTH", 2, { min: 1, max: 3 });
  const branch = envInt("HALO_LLM_BRANCH", 3, { min: 2, max: 4 });
  const timeoutMs = envInt("HALO_LLM_TIMEOUT_S", 300, { min: 30, max: 900 }) * 1000;
  const verified = process.env.HALO_LLM_VERIFIED === "1";

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const site = await startSite({ depth, branch });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-llm-goal-"));
  let exitCode = 0;
  try {
    const runs = [];
    for (const profile of profiles) {
      runs.push(await runOne({
        profile, site, storageRoot, timeoutMs, verified,
        createBrowser: async () => {
          const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "halo-llm-goal" } });
          win.contentView.addChildView(view);
          view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
          view.setVisible(false);
          return new BrowserAdapter({ view });
        },
      }));
    }
    process.stdout.write(`RESULT_JSON:${JSON.stringify({
      kind: "llm-goal-run", depth, branch, target: site.target, totalPagesOnSite: ((branch ** (depth + 1)) - 1) / (branch - 1),
      environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform },
      runs,
    })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "llm-goal-run", error: String(error?.stack || error) })}\n`);
  } finally {
    await site.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

if (process.versions.electron || require.main === module) {
  main();
}
