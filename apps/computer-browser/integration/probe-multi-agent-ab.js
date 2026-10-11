"use strict";

// TEMPORARY measurement probe (not a test). Fair 10-agent A/B between Chromium
// builds AND against integration/ram-probe-electron.js's Electron numbers.
//
// Electron rig parity: same fixture HTML (ram-probe-electron.js:101-106), same
// 10 hidden surfaces, same 3s settle, same "total of all process memory"
// accounting. Chromium side uses the production shape: ONE browser process,
// one isolated browser context + page per agent, one shared CDP connection
// (CdpEngine.createPage), RSS summed by a ppid walk of the browser tree.
//
// Usage:
//   node integration/probe-multi-agent-ab.js [reps] [agents] [arms...]
//   arms default: out/Trial/headless_shell out/TrialLean/headless_shell
//
// Limits: RSS sums double-count shared library pages across processes, which
// flatters the non-component build; that is a real part of what this measures
// (the component build pays those pages per process) but the absolute numbers
// are not physical-memory deltas. 100ms sampling misses transients.

const http = require("node:http");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport, openCdpView } = require("../main/harness/cdp-web-contents");

const HOME = os.homedir();
const REPS = Number(process.argv[2]) || 3;
const AGENTS = Number(process.argv[3]) || 10;
const ARM_ARGS = process.argv.slice(4);
const DEFAULT_ARMS = [
  path.join(HOME, "chromium/src/out/Trial/headless_shell"),
  path.join(HOME, "chromium/src/out/TrialLean/headless_shell"),
];
const ARMS = (ARM_ARGS.length ? ARM_ARGS : DEFAULT_ARMS).map((p) => [path.basename(path.dirname(p)), p]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// electron/ram-probe shape: [Browser GPU Utility Tab], we classify by --type=.
function treeRss(rootPid) {
  let rows;
  try {
    rows = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
      .trim().split("\n").map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], command: m[4] } : null;
      }).filter(Boolean);
  } catch { return null; }
  const byParent = new Map();
  for (const row of rows) { if (!byParent.has(row.ppid)) byParent.set(row.ppid, []); byParent.get(row.ppid).push(row); }
  const tree = []; const stack = [rootPid]; const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) || []) { tree.push(child); stack.push(child.pid); }
  }
  const main = rows.find((r) => r.pid === rootPid);
  if (main) tree.push(main);
  const byType = { Browser: 0, GPU: 0, Renderer: 0, Utility: 0 };
  let totalKb = 0;
  for (const p of tree) {
    const mb = p.rss / 1024;
    totalKb += p.rss;
    if (p.pid === rootPid) byType.Browser += mb;
    else if (/--type=renderer/.test(p.command)) byType.Renderer += mb;
    else if (/--type=gpu/.test(p.command)) byType.GPU += mb;
    else byType.Utility += mb;
  }
  const rounded = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { totalMB: Math.round(totalKb / 1024), byType: rounded, procs: tree.length };
}

function fixtureServer() {
  // Byte-identical to ram-probe-electron.js's fixture so the page weight matches.
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>probe ${req.url}</title><main>${"bounded local fixture ".repeat(4000)}</main>`);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function runOnce(name, executablePath, url) {
  const extraFlags = process.env.HALO_PROBE_EXTRA_FLAGS ? JSON.parse(process.env.HALO_PROBE_EXTRA_FLAGS) : undefined;
  const launched = await acquireCdpBrowser({ executablePath, headless: true, ...(extraFlags ? { extraFlags } : {}) });
  const views = [];
  try {
    const transport = await connectCdpTransport(launched.wsUrl);
    // Settle before the baseline: an immediate sample can catch a browser
    // still paging in its own code, which showed up as a 283MB "baseline"
    // that later fell below 218MB with 10 pages open.
    await sleep(1500);
    const baseline = treeRss(launched.pid);
    for (let i = 0; i < AGENTS; i += 1) {
      const view = await openCdpView(transport, { isolated: true, width: 1280, height: 800 });
      views.push(view);
      await view.webContents.loadURL(`${url}${i}`);
    }
    await sleep(3000);
    const after = treeRss(launched.pid);
    // A screenshot is the one thing a dropped GPU must not break.
    let captureOk = null;
    try {
      const buf = await views[0].webContents.capturePage();
      const png = buf.toPNG();
      captureOk = Buffer.isBuffer(png) && png.length > 1000;
    } catch (error) { captureOk = `error:${String(error?.message || error).slice(0, 60)}`; }
    const result = { arm: name, agents: AGENTS, ok: true, baselineMB: baseline?.totalMB ?? null, totalMB: after?.totalMB ?? null,
      incrementMB: baseline && after ? after.totalMB - baseline.totalMB : null,
      byType: after?.byType ?? null, procs: after?.procs ?? null, captureOk, loadAvg: os.loadavg()[0].toFixed(2) };
    console.log(`RESULT_JSON:${JSON.stringify(result)}`);
    return result;
  } finally {
    for (const view of views) { try { view.webContents.destroy?.(); } catch { /* probe */ } }
    try { await launched.close(); } catch { /* probe */ }
    await sleep(400);
  }
}

const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * 0.5))];

(async () => {
  const server = await fixtureServer();
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`probe-multi-agent-ab: reps=${REPS} agents=${AGENTS} arms=${ARMS.map(([n]) => n).join(",")}`);
  console.log(`load average at start: ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")}\n`);
  const results = [];
  for (let rep = 0; rep < REPS; rep++) {
    const order = rep % 2 === 0 ? ARMS : [...ARMS].reverse();
    for (const [name, binary] of order) {
      try { results.push(await runOnce(name, binary, url)); }
      catch (error) { const f = { arm: name, ok: false, fatal: String(error?.message || error).slice(0, 200) }; console.log(`RESULT_JSON:${JSON.stringify(f)}`); results.push(f); }
      console.log(`  rep ${rep + 1}/${REPS} done (${name}); load=${os.loadavg()[0].toFixed(2)}`);
    }
  }
  await new Promise((r) => server.close(r));
  const groups = new Map();
  for (const r of results) if (r.ok) { if (!groups.has(r.arm)) groups.set(r.arm, []); groups.get(r.arm).push(r); }
  const table = {};
  for (const [arm, runs] of groups) {
    table[arm] = {
      baselineMB: median(runs.map((r) => r.baselineMB)),
      totalMB: median(runs.map((r) => r.totalMB)),
      incrementMB: median(runs.map((r) => r.incrementMB)),
      perAgentMB: Math.round(median(runs.map((r) => r.incrementMB)) / AGENTS),
      procs: median(runs.map((r) => r.procs)), n: runs.length,
    };
  }
  console.log("\n=== summary (median over successful runs) ===");
  console.log(JSON.stringify(table, null, 2));
  console.log("\nSUMMARY_JSON:" + JSON.stringify(table));
  process.exit(0);
})().catch((error) => { console.error(error?.stack || error); process.exit(1); });