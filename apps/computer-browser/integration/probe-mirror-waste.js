"use strict";

// TEMPORARY measurement probe. Quantifies mirror-frame waste on the Chromium
// (CDP) engine path, where AgentViewportHost.captureFrame has no change
// fingerprint: it captures a JPEG and base64-encodes it on every poll even when
// the page has not painted anything new.
//
//   node integration/probe-mirror-waste.js [seconds] [intervalMs]
//
// The frontend polls every 250 ms (frontend/src/App.tsx). While the agent waits
// on a planner call the page is static, so every one of those polls is redundant
// work. This measures how often, and how many bytes.
//
// Reports redundant-frame ratio and bytes encoded. Byte counts are exact; the
// IPC transfer and renderer decode are NOT measured here.

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport, createCdpView } = require("../main/harness/cdp-web-contents");
const { AgentViewportHost } = require("../main/harness/agent-viewport-host");

const CHROMIUM = process.env.HALO_CHROMIUM
  || path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium");

const SECONDS = Number(process.argv[2]) || 12;
const INTERVAL_MS = Number(process.argv[3]) || 250;

async function main() {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><html><head><title>probe</title></head><body><h1>Static page</h1>"
      + Array.from({ length: 60 }, (_, i) => `<section><h2>Item ${i}</h2><p>Body text for item ${i}.</p></section>`).join("")
      + "</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Headless locally launched Chromium over a shared transport, mirroring what
// CdpEngine gives the host in production. Headless because the user's own HALO
// window is running and a second headed instance is the thing that fails.
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const transport = await connectCdpTransport(launched.wsUrl);
  const shared = { contextId: undefined };
  const host = new AgentViewportHost({
    createWindow: () => { throw new Error("electron constructor used"); },
    createView: () => { throw new Error("electron constructor used"); },
    createPage: () => createCdpView(async () => transport, { width: 1440, height: 900, isolated: true }),
  });
  const adapter = host.ensure("task-waste");
  await adapter.execute({ type: "navigate", url: base });

  const polls = [];
  let previous = null;
  let redundant = 0;
  let encodedBytes = 0;
  const startedAt = performance.now();
  for (let i = 0; i < Math.ceil((SECONDS * 1000) / INTERVAL_MS); i += 1) {
    const t = performance.now();
    const frame = await host.captureFrame("task-waste");
    const elapsed = performance.now() - t;
    const bytes = typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : 0;
    encodedBytes += bytes;
    if (previous !== null && frame === previous) redundant += 1;
    previous = frame;
    polls.push(elapsed);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  const wall = performance.now() - startedAt;

  await host.disposeAll();
  transport.close();
  await launched.close().catch(() => undefined);
  await new Promise((r) => server.close(r));

  const sorted = [...polls].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1))];
  console.log(`\nstatic page, ${SECONDS}s at ${INTERVAL_MS}ms cadence -> ${polls.length} polls (agent waiting on a planner call would look like this)\n`);
  console.log(`redundant frames      : ${redundant}/${polls.length} (${((redundant / polls.length) * 100).toFixed(0)}%) -- identical bytes to the previous frame`);
  console.log(`capture latency       : p50 ${at(0.5).toFixed(1)}ms  p95 ${at(0.95).toFixed(1)}ms`);
  console.log(`bytes encoded total   : ${(encodedBytes / 1024).toFixed(0)} KiB over ${(wall / 1000).toFixed(1)}s = ${(encodedBytes / (wall / 1000) / 1024).toFixed(0)} KiB/s of base64 churn`);
  console.log(`duty cycle            : ${(((polls.reduce((a, b) => a + b, 0)) / wall) * 100).toFixed(0)}% of wall time inside a capture`);
  console.log(`\nA dedup that returned the previous frame for an unchanged page would skip all ${redundant} of them.`);
  console.log(`Not measured here: IPC transfer to the renderer, base64 decode, and React re-render.`);
}

main().then(() => process.exit(0), (error) => { console.error(error?.stack ?? error); process.exit(1); });