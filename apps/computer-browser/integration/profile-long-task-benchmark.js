"use strict";

// Long-task comparison of harness profiles on a real BrowserAdapter/Electron.
// The same deterministic N-page chain (per page: S scrolls, one explicit
// observe, then follow "Next") is driven by an in-process planner that fills
// each proposal up to the profile's own batch cap -- exactly what a real
// planner must do, since the controller rejects an over-cap proposal. Only the
// harness profile differs between arms: short (cap 8, observation reuse) vs
// middle and long (cap 3, always re-observe). Not a model-quality benchmark.
//
// Run from apps/computer-browser:
//   xvfb-run -a node_modules/.bin/electron --no-sandbox integration/profile-long-task-benchmark.js
// Env: HALO_BENCH_PAGES (2..500, default 100), HALO_BENCH_SCROLLS (0..8,
//   default 5), HALO_BENCH_REPS (>=1, default 3). Emits RESULT_JSON:<json>.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { maxActionsPerProposal } = require("../shared/harness-profile");

const PROFILES = ["short", "middle", "long"];

function envInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
}

// Round-robin rotation so no profile is always first/last (cold vs warm).
function orderFor(rep) {
  const shift = rep % PROFILES.length;
  return [...PROFILES.slice(shift), ...PROFILES.slice(0, shift)];
}

function makeChainPlanner({ cap, scrolls }) {
  let queueUrl = null;
  let queue = [];
  return {
    next: async (context) => {
      const observation = context.observation;
      const base = {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: observation.id,
        criterionIds: [],
      };
      const text = [observation.text || "", ...(observation.elements || []).map((item) => item.name || "")].join(" ");
      if (/CHAIN-DONE-\d+/.test(text)) return { ...base, kind: "need_user", reason: "chain complete" };
      if (!observation.url || observation.url === "about:blank") {
        const url = String(context.goal.originalRequest).match(/https?:\/\/\S+/)[0];
        return { ...base, kind: "actions", actions: [{ type: "navigate", url }] };
      }
      if (queueUrl !== observation.url) {
        queueUrl = observation.url;
        queue = Array.from({ length: scrolls }, (_, index) => ({ type: "scroll", direction: "down", amount: 200 + 100 * index }));
        queue.push({ type: "observe" });
      }
      if (queue.length > 0) return { ...base, kind: "actions", actions: queue.splice(0, cap) };
      const next = (observation.elements || []).find((item) => item.role === "link" && item.name === "Next");
      if (!next) return { ...base, kind: "need_user", reason: "no Next link" };
      queueUrl = null;
      return { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: next.elementId }] };
    },
  };
}

async function runOne({ profile, pages, scrolls, fixtureUrl, createBrowser, storageRoot }) {
  const cap = maxActionsPerProposal(profile);
  const counts = { controllerObserve: 0, adapterObserve: 0, approvals: 0, plannerCalls: 0, journalFsyncs: 0, executes: 0 };
  const pageDoneAt = [];
  const browser = await createBrowser();
  const observe = browser.observe.bind(browser);
  let inExecute = 0;
  browser.observe = async (...args) => {
    counts.adapterObserve += 1;
    if (!inExecute) counts.controllerObserve += 1;
    return observe(...args);
  };
  const execute = browser.execute.bind(browser);
  browser.execute = async (action, options) => {
    counts.executes += 1;
    inExecute += 1;
    try {
      const result = await execute(action, options);
      if (action.type === "follow_link" && result.status === "ok") pageDoneAt.push(performance.now());
      return result;
    } finally {
      inExecute -= 1;
    }
  };

  const totalActions = pages * (scrolls + 2) + 5;
  const store = await TaskStore.create({
    originalRequest: `Walk the local ${pages}-page chain starting at ${fixtureUrl}`,
    criteria: [{ id: "chain", text: "reached the last page", required: true, verification: "user" }],
    limits: { maxActions: totalActions + 50, maxPlannerCalls: totalActions + 100, maxActiveMs: 60 * 60 * 1000 },
  }, {
    storageRoot,
    onTiming: ({ operation }) => { if (operation === "journal_fsync") counts.journalFsyncs += 1; },
  });
  const planner = makeChainPlanner({ cap, scrolls });
  const countedPlanner = {
    next: async (context) => {
      counts.plannerCalls += 1;
      const proposal = await planner.next(context);
      if (process.env.HALO_BENCH_DEBUG) console.log("PLAN", context.observation.url, JSON.stringify(proposal.actions || proposal.reason), (context.observation.elements || []).length);
      return proposal;
    },
  };
  const controller = new TaskController({
    store,
    planner: countedPlanner,
    browser,
    approve: async () => { counts.approvals += 1; return { decision: "allow", reasons: [] }; },
    hostVerifier: () => true,
    harnessProfile: profile,
  });

  const startedAt = performance.now();
  try {
    const snapshot = await controller.start();
    const wallMs = performance.now() - startedAt;
    if (snapshot.state !== "paused" || snapshot.pauseReason !== "need_user") {
      throw new Error(`${profile}: unexpected end state ${snapshot.state}/${snapshot.pauseReason}`);
    }
    if (pageDoneAt.length !== pages - 1) throw new Error(`${profile}: visited ${pageDoneAt.length + 1} pages, expected ${pages}`);
    const perPage = pageDoneAt.map((at, index) => at - (index === 0 ? startedAt : pageDoneAt[index - 1]));
    const quarter = Math.max(1, Math.floor(perPage.length / 4));
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      profile,
      cap,
      wallMs,
      actions: snapshot.budgets.actionsUsed,
      ...counts,
      firstQuarterMsPerPage: mean(perPage.slice(0, quarter)),
      lastQuarterMsPerPage: mean(perPage.slice(-quarter)),
    };
  } finally {
    await browser.dispose().catch(() => {});
    await store.close().catch(() => {});
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function main() {
  const { app, BrowserWindow, WebContentsView } = require("electron");
  const { BrowserAdapter } = require("../main/harness/browser-adapter");
  const { startLongHorizon100Site } = require("../fixtures/long-horizon-100-site");

  const pages = envInt("HALO_BENCH_PAGES", 100, { min: 2, max: 500 });
  const scrolls = envInt("HALO_BENCH_SCROLLS", 5, { min: 0, max: 8 });
  const reps = envInt("HALO_BENCH_REPS", 3, { min: 1, max: 50 });

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const fixture = await startLongHorizon100Site({ steps: pages });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-profile-long-"));
  let exitCode = 0;
  try {
    const rows = [];
    for (let rep = 0; rep < reps; rep += 1) {
      for (const profile of orderFor(rep)) {
        rows.push({ rep, ...(await runOne({
          profile,
          pages,
          scrolls,
          fixtureUrl: fixture.url,
          storageRoot,
          createBrowser: async () => {
            const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "halo-profile-long" } });
            win.contentView.addChildView(view);
            view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
            view.setVisible(false);
            return new BrowserAdapter({ view });
          },
        })) });
      }
    }
    const summary = {};
    for (const profile of PROFILES) {
      const mine = rows.filter((row) => row.profile === profile);
      summary[profile] = {
        cap: mine[0].cap,
        medianWallMs: median(mine.map((row) => row.wallMs)),
        actions: mine[0].actions,
        plannerCalls: mine[0].plannerCalls,
        approvals: mine[0].approvals,
        controllerObserve: mine[0].controllerObserve,
        adapterObserve: mine[0].adapterObserve,
        journalFsyncs: mine[0].journalFsyncs,
        medianFirstQuarterMsPerPage: median(mine.map((row) => row.firstQuarterMsPerPage)),
        medianLastQuarterMsPerPage: median(mine.map((row) => row.lastQuarterMsPerPage)),
      };
    }
    process.stdout.write(`RESULT_JSON:${JSON.stringify({
      kind: "profile-long-task-benchmark",
      pages, scrolls, reps,
      environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform },
      summary,
      rows,
    })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "profile-long-task-benchmark", error: String(error?.stack || error) })}\n`);
  } finally {
    await fixture.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

module.exports = { makeChainPlanner, orderFor };

if (process.versions.electron || require.main === module) {
  main();
}
