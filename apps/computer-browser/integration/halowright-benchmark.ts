"use strict";

// Developer-only localhost benchmark; no models, accounts or external sites.
// Question: where does one Halowright step spend its wall time (stability wait,
// authorize, snapshot, input, effect check), and how many CDP round trips does it make?
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { runHwStep } = require("../main/harness/halowright");

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const PAGE = `<title>t0</title><button id=b onclick="document.title='c'+(++window.n||(window.n=1))">Apply</button><input id=i placeholder="Name" oninput="document.title='f'+this.value.length">`;

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(values.length * p) - 1)];
  return { count: values.length, p50Ms: Math.round(at(.5)), p95Ms: Math.round(at(.95)) };
};

async function main() {
  const server = http.createServer((_q: any, r: any) => { r.setHeader("content-type", "text/html"); r.end(PAGE); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });
  try {
    const view = engine.createPage("halo-task-halowright-benchmark");
    const raw = view.webContents;
    await raw.loadURL(`http://127.0.0.1:${server.address().port}/`);
    let roundTrips = 0;
    const wc = new Proxy(raw, { get: (target: any, key: string) => {
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args: any[]) => { if (key === "executeJavaScriptInIsolatedWorld") roundTrips++; return value.apply(target, args); };
    } });
    const authorize = () => true;
    const n = Number(process.env.HW_BENCH_RUNS || 20);
    const out: Record<string, any> = {};
    for (const [name, step] of [
      ["click", () => ({ op: "click", locator: { role: "button", name: "Apply" } })],
      ["fill", (i: number) => ({ op: "fill", locator: { placeholder: "Name" }, text: "x".repeat(i + 1) })],
    ] as const) {
      const times: number[] = [], trips: number[] = [];
      let ok = 0;
      for (let i = 0; i < n + 2; i++) {
        roundTrips = 0;
        const start = performance.now();
        const result = await runHwStep(wc, (step as any)(i), { sleep, authorize });
        const took = performance.now() - start;
        if (i < 2) continue; // warm-up
        times.push(took); trips.push(roundTrips);
        if (result.status === "ok") ok++;
      }
      out[name] = { ...stats(times), roundTripsPerStep: Math.round(stats(trips).p50Ms), ok };
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, fixture: "localhost-button-and-input", runs: n, ...out,
      limits: ["Local page, no model; measures host-side step latency only."] }, null, 2) + "\n");
  } finally {
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
