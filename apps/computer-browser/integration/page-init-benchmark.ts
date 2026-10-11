"use strict";

// Developer-only measurement. Run with Node's TypeScript stripping support.
// Answers one question: how long does CdpWebContents.init() take, and which CDP
// round trips inside it own that time?
//
// Disposable localhost fixture, no credentials, no external sites, no models.
// Nothing here changes behavior; it wraps transport.send to attribute wall time
// per CDP method across N page creations.

const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { CdpEngine } = require("../main/harness/cdp-engine");

interface Method { ms: number[] }

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { count: values.length, p50Ms: at(.5), p95Ms: at(.95), meanMs: values.reduce((a, b) => a + b, 0) / (values.length || 1), totalMs: values.reduce((a, b) => a + b, 0) };
}

async function main() {
  const pageCount = Number(process.argv[2]) || 6;
  const server = http.createServer((_request: any, response: any) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<title>init fixture</title><h1>Hello</h1><button id=b onclick=\"document.title='clicked'\">Go</button>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });

  // Wrap the transport once so every page creation after this is attributed.
  const { transport } = await (engine as any).connect();
  const original = transport.send.bind(transport);
  const methods = new Map<string, Method>();
  transport.send = async function (method: string, params?: any, sessionId?: any) {
    const start = performance.now();
    try {
      return await original(method, params, sessionId);
    } finally {
      let entry = methods.get(method);
      if (!entry) { entry = { ms: [] }; methods.set(method, entry); }
      entry.ms.push(performance.now() - start);
    }
  };

  const initMs: number[] = [];
  const views: unknown[] = [];
  try {
    // One warm-up page: the browser process, the WebSocket and the shared
    // browser context are cold on the very first page and every later page
    // reuses them. Reported separately so the steady-state number is not
    // silently a cold-start number.
    for (let i = 0; i < pageCount; i++) {
      const start = performance.now();
      const view: any = engine.createPage(`halo-task-init-benchmark-${i}`);
      const wc = view.webContents;
      await wc.loadURL(url);
      const title = await wc.executeJavaScript("document.title");
      if (title !== "init fixture") throw new Error(`fixture_title_mismatch:${title}`);
      initMs.push(performance.now() - start);
      views.push(view);
    }
  } finally {
    for (const view of views) { try { (view as any).webContents.destroy?.(); } catch { /* best effort */ } }
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }

  const perMethod: Record<string, unknown> = {};
  let attributed = 0;
  for (const [method, entry] of [...methods].sort((a, b) => b[1].ms.reduce((s, x) => s + x, 0) - a[1].ms.reduce((s, x) => s + x, 0))) {
    perMethod[method] = summarize(entry.ms);
    attributed += entry.ms.reduce((s, x) => s + x, 0);
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    fixture: "local-static-page",
    pages: pageCount,
    note: "pageCreateToLoadedMs includes the fixture navigation itself, not just init().",
    pageCreateToLoadedMs: summarize(initMs),
    attributedCdpMs: Number(attributed.toFixed(1)),
    perMethod,
    limits: [
      "Attributes transport.send wall time; concurrent sends overlap so the attributed sum exceeds wall time once init is parallelized.",
      "One local fixture; excludes planner/model time and real cross-site network cost.",
    ],
  }, null, 2) + "\n");
}

void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });