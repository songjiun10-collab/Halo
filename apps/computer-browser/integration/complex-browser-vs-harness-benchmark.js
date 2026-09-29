"use strict";

// Complex-task comparison: raw browser vs the HALO harness, on a real Electron
// WebContentsView. The task is a depth-first search through a branching local
// site for a hidden target page: every page must be read (scroll x4, then an
// observation), dead ends force backtracking by direct navigation, and the
// walk visits hundreds of pages. All arms share ONE exploration policy
// (createExplorer) and must visit the identical page sequence; only the
// execution layer differs:
//   raw     - webContents.loadURL + executeJavaScript only (no TaskStore,
//             TaskController, BrowserAdapter, policy, approval, or journal)
//   short   - full harness, harnessProfile "short" (batch cap 8, observe reuse)
//   middle  - full harness, harnessProfile "middle" (batch cap 3)
// The harness arms use an in-process planner and an immediate programmatic
// "allow" approval, so this measures harness overhead, not model quality or
// human approval latency. Local pages only; no network or credentials.
//
// Run from apps/computer-browser:
//   xvfb-run -a node_modules/.bin/electron --no-sandbox integration/complex-browser-vs-harness-benchmark.js
// Env: HALO_BENCH_DEPTH (2..7, default 5), HALO_BENCH_BRANCH (2..4, default 3),
//   HALO_BENCH_REPS (>=1, default 5). Emits RESULT_JSON:<json>.

const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { maxActionsPerProposal } = require("../shared/harness-profile");

const ARMS = ["raw", "short", "middle"];
const SCROLLS_PER_PAGE = 4;
const SAMPLE_MS = 100;
const FILLER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);

function envInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer ${min}..${max}`);
  return value;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function targetPathFor({ depth, branch }) {
  // Deterministic, not the first DFS branch, so the walk hits dead ends.
  const digits = Array.from({ length: depth }, (_, level) => (level * 2 + 1) % branch);
  return ["r", ...digits].join("-");
}

function startSite({ depth, branch }) {
  const target = targetPathFor({ depth, branch });
  const requests = [];
  const server = http.createServer((req, res) => {
    const match = /^\/n\/(r(?:-\d+)*)$/.exec(new URL(req.url, "http://x").pathname);
    requests.push(req.url);
    if (!match) { res.writeHead(404); res.end("not found"); return; }
    const p = match[1];
    const level = p.split("-").length - 1;
    const children = level < depth ? Array.from({ length: branch }, (_, k) => `<a href="/n/${p}-${k}">Section ${k}</a>`).join(" ") : "";
    const marker = p === target ? "<p>TARGET-FOUND</p>" : "";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><h1>Node ${p}</h1>${marker}<p>${FILLER}</p><nav>${children}</nav><p>${FILLER}</p>`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      target,
      origin: `http://127.0.0.1:${server.address().port}`,
      requests,
      stop: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
    }));
  });
}

// Shared exploration policy: identical for every arm.
function createExplorer() {
  const stack = [];
  return {
    decide(page) {
      const match = /\/n\/(r(?:-\d+)*)$/.exec(new URL(page.url).pathname);
      const here = match[1];
      if (page.text.includes("TARGET-FOUND")) return { kind: "finish" };
      stack.push({ path: here, next: 0, count: page.links.length });
      let direct = true;
      while (stack.length > 0 && stack.at(-1).next >= stack.at(-1).count) {
        stack.pop();
        direct = false;
      }
      if (stack.length === 0) return { kind: "exhausted" };
      const frame = stack.at(-1);
      const index = frame.next;
      frame.next += 1;
      const origin = new URL(page.url).origin;
      return { kind: "go", direct, index, href: `${origin}/n/${frame.path}-${index}` };
    },
  };
}

async function runRaw({ site, createView }) {
  const view = createView();
  const wc = view.webContents;
  const explorer = createExplorer();
  const visited = [];
  const read = () => wc.executeJavaScript(`({ url: location.href, text: document.body.innerText, links: [...document.querySelectorAll("a")].map((a) => ({ name: a.textContent.trim(), href: a.href })) })`, true);
  const startedAt = performance.now();
  await wc.loadURL(`${site.origin}/n/r`);
  let decision;
  for (;;) {
    for (let i = 0; i < SCROLLS_PER_PAGE; i += 1) await wc.executeJavaScript(`window.scrollBy(0, ${200 + 100 * i})`, true);
    const page = await read();
    visited.push(page.url);
    decision = explorer.decide(page);
    if (decision.kind !== "go") break;
    await wc.loadURL(decision.href);
  }
  const wallMs = performance.now() - startedAt;
  wc.close();
  return { arm: "raw", found: decision.kind === "finish", visited, wallMs, actions: null, plannerCalls: null, approvals: null, journalFsyncs: null };
}

function makeHarnessPlanner({ cap }) {
  const explorer = createExplorer();
  let readUrl = null;
  let queue = [];
  let decidedUrl = null;
  return {
    next: async (context) => {
      const observation = context.observation;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: observation.id, criterionIds: [] };
      if (!observation.url || observation.url === "about:blank") {
        const url = String(context.goal.originalRequest).match(/https?:\/\/\S+/)[0];
        return { ...base, kind: "actions", actions: [{ type: "navigate", url }] };
      }
      if (readUrl !== observation.url) {
        readUrl = observation.url;
        queue = Array.from({ length: SCROLLS_PER_PAGE }, (_, index) => ({ type: "scroll", direction: "down", amount: 200 + 100 * index }));
        queue.push({ type: "observe" });
      }
      if (queue.length > 0) return { ...base, kind: "actions", actions: queue.splice(0, cap) };
      if (decidedUrl === observation.url) return { ...base, kind: "need_user", reason: "unexpected repeat on the same page" };
      decidedUrl = observation.url;
      const links = (observation.elements || []).filter((item) => item.role === "link").map((item) => ({ name: item.name, elementId: item.elementId }));
      // Observation text omits leaf text that equals an element's accessible
      // name (paragraphs are named by their own text), so read both channels.
      const text = [observation.text || "", ...(observation.elements || []).map((item) => item.name || "")].join(" ");
      const decision = explorer.decide({ url: observation.url, text, links });
      if (decision.kind === "finish") return { ...base, kind: "need_user", reason: "target found" };
      if (decision.kind === "exhausted") return { ...base, kind: "need_user", reason: "exhausted" };
      if (decision.direct) {
        const link = links.find((item) => item.name === `Section ${decision.index}`);
        if (link) return { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: link.elementId }] };
      }
      return { ...base, kind: "actions", actions: [{ type: "navigate", url: decision.href }] };
    },
  };
}

async function runHarness({ arm, site, createBrowser, storageRoot }) {
  const cap = maxActionsPerProposal(arm);
  const counts = { plannerCalls: 0, approvals: 0, journalFsyncs: 0 };
  const visited = [];
  const browser = await createBrowser();
  const observe = browser.observe.bind(browser);
  browser.observe = async (...args) => {
    const observation = await observe(...args);
    if (observation?.url && observation.url !== "about:blank" && visited.at(-1) !== observation.url) visited.push(observation.url);
    return observation;
  };
  const store = await TaskStore.create({
    originalRequest: `Find the page containing TARGET-FOUND, starting at ${site.origin}/n/r`,
    criteria: [{ id: "found", text: "found the target page", required: true, verification: "user" }],
    limits: { maxActions: 20000, maxPlannerCalls: 20000, maxActiveMs: 60 * 60 * 1000 },
  }, { storageRoot, onTiming: ({ operation }) => { if (operation === "journal_fsync") counts.journalFsyncs += 1; } });
  const planner = makeHarnessPlanner({ cap });
  const controller = new TaskController({
    store,
    planner: {
      next: async (context) => {
        counts.plannerCalls += 1;
        const proposal = await planner.next(context);
        if (process.env.HALO_BENCH_DEBUG && proposal.kind === "need_user") console.log("STOP", arm, proposal.reason, context.observation.url, visited.length);
        return proposal;
      },
    },
    browser,
    approve: async () => { counts.approvals += 1; return { decision: "allow", reasons: [] }; },
    hostVerifier: () => true,
    harnessProfile: arm,
  });
  const startedAt = performance.now();
  try {
    const snapshot = await controller.start();
    const wallMs = performance.now() - startedAt;
    if (snapshot.state !== "paused" || snapshot.pauseReason !== "need_user") throw new Error(`${arm}: unexpected end ${snapshot.state}/${snapshot.pauseReason}`);
    return { arm, found: visited.at(-1)?.endsWith(`/n/${site.target}`) === true, visited, wallMs, actions: snapshot.budgets.actionsUsed, ...counts };
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

  const depth = envInt("HALO_BENCH_DEPTH", 5, { min: 2, max: 7 });
  const branch = envInt("HALO_BENCH_BRANCH", 3, { min: 2, max: 4 });
  const reps = envInt("HALO_BENCH_REPS", 5, { min: 1, max: 50 });

  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const site = await startSite({ depth, branch });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-complex-bench-"));
  const createView = () => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "halo-complex-bench" } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    view.setVisible(false);
    return view;
  };

  let currentArm = null;
  const peaks = {};
  let running = true;
  const sampleLoop = (async () => {
    while (running) {
      if (currentArm) {
        const total = app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory?.workingSetSize || 0) * 1024, 0);
        peaks[currentArm] = Math.max(peaks[currentArm] || 0, total);
      }
      await delay(SAMPLE_MS);
    }
  })();

  let exitCode = 0;
  try {
    const rows = [];
    for (let rep = 0; rep < reps; rep += 1) {
      const shift = rep % ARMS.length;
      for (const arm of [...ARMS.slice(shift), ...ARMS.slice(0, shift)]) {
        currentArm = arm;
        const row = arm === "raw"
          ? await runRaw({ site, createView })
          : await runHarness({ arm, site, storageRoot, createBrowser: async () => new BrowserAdapter({ view: createView() }) });
        currentArm = null;
        rows.push({ rep, ...row });
      }
    }
    const reference = rows[0].visited;
    for (const row of rows) {
      if (!row.found) throw new Error(`${row.arm} rep ${row.rep} did not find the target`);
      if (row.visited.length !== reference.length || row.visited.some((url, index) => url !== reference[index])) {
        throw new Error(`${row.arm} rep ${row.rep} visited a different page sequence than the reference`);
      }
    }
    const summary = {};
    for (const arm of ARMS) {
      const mine = rows.filter((row) => row.arm === arm);
      summary[arm] = {
        medianWallMs: median(mine.map((row) => row.wallMs)),
        allWallMs: mine.map((row) => Math.round(row.wallMs)),
        pagesVisited: mine[0].visited.length,
        actions: mine[0].actions,
        plannerCalls: mine[0].plannerCalls,
        approvals: mine[0].approvals,
        journalFsyncs: mine[0].journalFsyncs,
        peakSampledBytes: peaks[arm] || null,
      };
    }
    process.stdout.write(`RESULT_JSON:${JSON.stringify({
      kind: "complex-browser-vs-harness-benchmark",
      depth, branch, reps, scrollsPerPage: SCROLLS_PER_PAGE, target: site.target,
      environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform },
      summary,
    })}\n`);
  } catch (error) {
    exitCode = 1;
    process.stdout.write(`RESULT_JSON:${JSON.stringify({ kind: "complex-browser-vs-harness-benchmark", error: String(error?.stack || error) })}\n`);
  } finally {
    running = false;
    await sampleLoop.catch(() => {});
    await site.stop().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

module.exports = { createExplorer, targetPathFor };

if (process.versions.electron || require.main === module) {
  main();
}
