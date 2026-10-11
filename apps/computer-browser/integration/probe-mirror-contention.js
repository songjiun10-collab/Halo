"use strict";

// TEMPORARY measurement probe. Tests whether the user-facing live mirror
// contends with the agent's own observe() on the SAME CDP page.
//
//   node integration/probe-mirror-contention.js [turns]
//
// Why this exists: frontend/src/App.tsx polls captureAgentFrame every 250 ms
// when the push stream is unavailable, and captureFrame goes through
// Page.captureScreenshot on the agent's own CDP session. A 70 ms capture every
// 250 ms is a ~28% duty cycle of in-flight CDP work on the transport the turn
// loop also uses. Serial stage timing cannot see that; this probe runs the
// mirror and observe concurrently and compares against observe alone.
//
// Measures observe() latency: quiet vs with the mirror polling at the real
// 250 ms cadence. Same page, same session, one variable.

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { captureFrameJpeg } = require("../main/harness/frame-capture");

const CHROMIUM = process.env.HALO_CHROMIUM
  || path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium");

const TURNS = Number(process.argv[2]) || 40;
const MIRROR_INTERVAL_MS = Number(process.argv[3]) || 250;

function pageHtml(n) {
  const rows = Array.from({ length: n }, (_, i) =>
    `<section><h2>Item ${i}</h2><p>Paragraph body for item ${i} with some readable text content.</p>`
    + `<a href="/item/${i}">Open item ${i}</a><button>Act ${i}</button></section>`).join("\n");
  return `<!doctype html><html><head><title>probe</title></head><body><h1>Probe</h1>${rows}</body></html>`;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))];
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted.at(-1).toFixed(2),
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) };
}

function report(title, s) {
  console.log(`${title.padEnd(26)} n=${String(s.n).padStart(3)}  p50=${String(s.p50).padStart(8)}  p95=${String(s.p95).padStart(8)}  max=${String(s.max).padStart(8)}  mean=${String(s.mean).padStart(8)}`);
}

async function main() {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(pageHtml(60)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
  const browser = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
  await browser.execute({ type: "navigate", url: `${base}/` });
  await browser.observe();

  // Phase 1: quiet. Only the agent's observe() touches the page.
  const quiet = [];
  for (let i = 0; i < TURNS; i += 1) {
    const t = performance.now();
    await browser.observe();
    quiet.push(performance.now() - t);
  }

  // Phase 2: the mirror polls at the product's real cadence while the agent
  // observes. The same page, same underlying CDP session.
  const contended = [];
  const mirrorDurations = [];
  let mirrorRuns = 0;
  let stopped = false;
  const mirrorLoop = (async () => {
    while (!stopped) {
      const t = performance.now();
      await captureFrameJpeg(view.webContents, { maxWidth: 1200, quality: 65 }).catch(() => null);
      mirrorDurations.push(performance.now() - t);
      mirrorRuns += 1;
      await new Promise((r) => setTimeout(r, MIRROR_INTERVAL_MS));
    }
  })();

  for (let i = 0; i < TURNS; i += 1) {
    const t = performance.now();
    await browser.observe();
    contended.push(performance.now() - t);
  }
  stopped = true;
  await mirrorLoop;

  view.closeConnection?.();
  await launched.close().catch(() => undefined);
  await new Promise((r) => server.close(r));

  const q = stats(quiet), c = stats(contended), m = stats(mirrorDurations);
  console.log(`\npage=60 sections  viewport=1440x900  turns=${TURNS}  mirror interval=${MIRROR_INTERVAL_MS}ms  mirror runs=${mirrorRuns}\n`);
  report("observe (quiet)", q);
  report("observe (+mirror)", c);
  report("mirror capture", m);
  const deltaP50 = c.p50 - q.p50, deltaP95 = c.p95 - q.p95;
  console.log(`\nobserve delta: p50 ${deltaP50 >= 0 ? "+" : ""}${deltaP50.toFixed(2)}ms   p95 ${deltaP95 >= 0 ? "+" : ""}${deltaP95.toFixed(2)}ms`);
  const ratio = c.mean / q.mean;
  console.log(`mean ratio: ${ratio.toFixed(2)}x`);
  console.log(`mirror duty cycle: ${((m.mean / MIRROR_INTERVAL_MS) * 100).toFixed(0)}% of wall time with a capture in flight`);
}

main().then(() => process.exit(0), (error) => { console.error(error?.stack ?? error); process.exit(1); });