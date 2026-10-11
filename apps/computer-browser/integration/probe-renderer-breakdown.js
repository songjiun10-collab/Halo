"use strict";

// TEMPORARY probe. What is a single agent page's renderer actually made of?
// The 10-agent breakdown is 81% renderer, so a native patch that matters has to
// move renderer memory; this prints vmmap's own categories per process type.
//
//   node integration/probe-renderer-breakdown.js [binary] [--load]
//     --load also navigates the page to the heavy fixture (default: about:blank)

const http = require("node:http");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport, openCdpView } = require("../main/harness/cdp-web-contents");

const BINARY = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : [path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/headless_shell")].find((p) => fs.existsSync(p));
const LOAD = process.argv.includes("--load");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rows() {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .trim().split("\n").map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: +m[1], ppid: +m[2], rss: +m[3], command: m[4] } : null;
    }).filter(Boolean);
}

function tree(rootPid) {
  const all = rows();
  const byParent = new Map();
  for (const r of all) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r); }
  const out = []; const stack = [rootPid]; const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of byParent.get(pid) || []) { out.push(c); stack.push(c.pid); }
  }
  const main = all.find((r) => r.pid === rootPid);
  if (main) out.push(main);
  return out;
}

// vmmap -summary's own footer categories, which is the breakdown the fork doc
// asked for (renderer heap vs shared libraries vs reserved).
function vmmapSummary(pid) {
  let text;
  try { text = execFileSync("vmmap", ["-summary", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) { return { error: String(error?.message || error).slice(0, 100) }; }
  const pick = (label) => {
    const m = new RegExp(`${label}:\\s+([\\d.]+)([KMG])?`).exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    return Math.round(m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n);
  };
  const line = (label) => {
    const m = new RegExp(`${label}[^\\n]*`).exec(text);
    return m ? m[0].trim() : null;
  };
  return {
    physicalFootprint: line("Physical footprint"),
    physicalFootprintPeak: line("Physical footprint (peak)"),
    total: pick("TOTAL"),
    readOnlyLibraries: line("ReadOnly portion of Libraries"),
    malloc: line("MALLOC_"),
    v8: line("V8 "),
    jsJit: line("JS JIT"),
  };
}

async function main() {
  const launched = await acquireCdpBrowser({ executablePath: BINARY, headless: true });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>heavy fixture</title><main>${"bounded local fixture ".repeat(4000)}</main>${Array.from({ length: 20 }, (_, i) => `<p>row ${i}</p>`).join("")}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const transport = await connectCdpTransport(launched.wsUrl);
    const view = await openCdpView(transport, { isolated: true, width: 1280, height: 800 });
    if (LOAD) await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await sleep(3000);
    const procs = tree(launched.pid);
    const out = [];
    for (const p of procs) {
      const kind = p.pid === launched.pid ? "browser" : /--type=([a-z-]+)/.exec(p.command)?.[1] ?? "other";
      out.push({ pid: p.pid, kind, rssMB: Math.round(p.rss / 1024), vmmap: vmmapSummary(p.pid) });
    }
    console.log(JSON.stringify({ binary: BINARY, loaded: LOAD, procs: out }, null, 2));
    transport.close();
    await sleep(100);
  } finally {
    await launched.close();
    await new Promise((r) => server.close(r));
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });