"use strict";

// Memory and CPU of HALO's CDP engine as isolated pages are added, and CPU per observation.
// Not a comparison with any other browser, and not a token count: no model runs here.
// Memory is PSS (shared pages counted once) summed over Chromium's process tree, read from /proc, so Linux only.
// CPU is user+system ticks from /proc/<pid>/stat. Headless Chromium, GPU off, local pages: real sites and a
// visible window will use more. Pages are isolated CDP views, a stand-in for agent pages, not real child agents.
//
// Usage: HALO_CHROMIUM=/path/to/chrome node bench/resource-bench.js
const APP = require("node:path").resolve(__dirname, "..");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");
const { BrowserAdapter } = require(`${APP}/main/harness/browser-adapter`);
const { openCdpView } = require(`${APP}/main/harness/cdp-web-contents`);
const { sumProcessTreeRssBytes } = require(`${APP}/main/harness/process-tree-memory`);

const CHROME = process.env.HALO_CHROMIUM;
if (!CHROME) { console.error("set HALO_CHROMIUM to a Chromium binary"); process.exit(2); }
const lorem = "Compare plans, prices and reviews before you choose. ".repeat(3);
const pages = {
  small: () => `<title>small</title><h1>Hello</h1><a href="/next">Go</a><button>Buy</button>`,
  medium: () => `<title>medium</title><h1>Shop</h1>${Array.from({ length: 40 }, (_, i) => `<div><h3>Item ${i}</h3><p>${lorem}</p><a href="/i/${i}">View</a><button>Add ${i}</button></div>`).join("")}`,
  large: () => `<title>large</title><h1>Directory</h1>${Array.from({ length: 600 }, (_, i) => `<p>${lorem}<a href="/p/${i}">Link ${i}</a></p>`).join("")}`,
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tree(rootPid) {
  const out = execSync("ps -eo pid=,ppid=", { encoding: "utf8" });
  const kids = new Map();
  for (const l of out.split("\n")) { const m = l.trim().split(/\s+/); if (m.length === 2) (kids.get(m[1]) ?? kids.set(m[1], []).get(m[1])).push(m[0]); }
  const pids = []; const stack = [String(rootPid)];
  while (stack.length) { const p = stack.pop(); pids.push(p); stack.push(...(kids.get(p) ?? [])); }
  return pids;
}
function snapshot(rootPid) {
  let pssKB = 0, ticks = 0;
  for (const p of tree(rootPid)) {
    try { const m = /Pss:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8")); if (m) pssKB += Number(m[1]); } catch { /* gone */ }
    try { const f = fs.readFileSync(`/proc/${p}/stat`, "utf8"); const rest = f.slice(f.lastIndexOf(")") + 2).split(" "); ticks += Number(rest[11]) + Number(rest[12]); } catch { /* gone */ }
  }
  return { pssMB: Math.round(pssKB / 1024), cpuMs: ticks * 10 };
}

async function oneRun() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const name = req.url.replace("/", "");
    res.end((pages[name] ?? pages.small)());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-meas-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--disable-gpu", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ""; const t = setTimeout(() => reject(new Error("no endpoint")), 30000);
    chrome.stderr.on("data", (c) => { buf += c; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const result = { byN: {} };
  await sleep(1500);
  result.byN[0] = snapshot(chrome.pid);
  const views = [];
  const adapters = [];
  const marks = new Set([1, 3, 5]);
  for (let i = 1; i <= 5; i += 1) {
    const view = await openCdpView(wsUrl, { width: 1280, height: 800, isolated: true });
    views.push(view);
    adapters.push(new BrowserAdapter({ view }));
    await adapters[i - 1].execute({ type: "navigate", url: `${base}/medium` });
    if (marks.has(i)) { await sleep(600); result.byN[i] = snapshot(chrome.pid); }
  }
  const before = snapshot(chrome.pid);
  for (let round = 0; round < 10; round += 1) for (const a of adapters) await a.observe();
  const after = snapshot(chrome.pid);
  result.fiftyObservesCpuMs = after.cpuMs - before.cpuMs;
  result.afterObservesPssMB = after.pssMB;
  for (const a of adapters) await a.dispose().catch(() => {});
  for (const v of views) { try { v.closeConnection(); } catch { /* ignore */ } }
  chrome.kill("SIGTERM"); await sleep(1500); chrome.kill("SIGKILL");
  await new Promise((r) => server.close(r));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  return result;
}

(async () => {
  const runs = [];
  for (let i = 0; i < 3; i += 1) { runs.push(await oneRun()); console.error(`run ${i + 1} done`); }
  const pick = (f) => median(runs.map(f));
  const out = { pssMB_byPages: {}, cpuMs_cumulative_byPages: {}, perAddedPagePssMB: null, fiftyObservesCpuMs: pick((r) => r.fiftyObservesCpuMs), pssAfterObservesMB: pick((r) => r.afterObservesPssMB) };
  for (const n of [0, 1, 3, 5]) { out.pssMB_byPages[n] = pick((r) => r.byN[n].pssMB); out.cpuMs_cumulative_byPages[n] = pick((r) => r.byN[n].cpuMs); }
  out.perAddedPagePssMB = Math.round((out.pssMB_byPages[5] - out.pssMB_byPages[1]) / 4);
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
