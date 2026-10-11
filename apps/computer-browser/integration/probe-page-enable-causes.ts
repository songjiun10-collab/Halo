"use strict";

// Developer-only probe, raw CDP. Hypothesis test for the Page.enable stall:
// does Page.enable block on the renderer process becoming available, and is it
// the renderer spawn that costs the seconds?
//
// Each variant changes exactly ONE thing from the Halo baseline so the delta
// is attributable. Same binary, same launch flags, no Halo harness on the path.

const { performance } = require("node:perf_hooks");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport } = require("../main/harness/cdp-web-contents");

const REPEATS = Number(process.argv[2]) || 3;

interface Variant {
  name: string;
  // url used for Target.createTarget: "about:blank" is what Halo uses today.
  createUrl?: string;
  // ms to sleep between attachToTarget and Page.enable.
  settleMs?: number;
  // Probe whether a renderer-bound command (which must reach the renderer
  // process) is slow while a browser-process-only command is fast.
  probeRuntime?: boolean;
  extraFlags?: readonly string[];
}

async function runVariant(variant: Variant) {
  const samples: Array<Record<string, number>> = [];
  for (let i = 0; i < REPEATS; i++) {
    const browser = await acquireCdpBrowser({ ...(variant.extraFlags ? { extraFlags: variant.extraFlags } : {}) });
    const transport = await connectCdpTransport(browser.wsUrl);
    try {
      const send = (m: string, p?: any, s?: string) => transport.send(m, p, s);
      const ctx = await send("Target.createBrowserContext");
      const scope = { browserContextId: ctx.browserContextId };
      await send("Target.setDiscoverTargets", { discover: true });
      const { targetId } = await send("Target.createTarget", { url: variant.createUrl ?? "about:blank", ...scope });
      const attachStart = performance.now();
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const attachMs = performance.now() - attachStart;

      let settleMs = 0;
      if (variant.settleMs) {
        const sleepStart = performance.now();
        await new Promise<void>(resolve => setTimeout(resolve, variant.settleMs));
        settleMs = performance.now() - sleepStart;
      }

      // Browser-process-only command first: if this is fast while Page.enable
      // is slow, the stall is renderer-side, not transport-side.
      const bsStart = performance.now();
      await send("Target.getTargetInfo", { targetId });
      const browserOnlyMs = performance.now() - bsStart;

      const pageStart = performance.now();
      await send("Page.enable", {}, sessionId);
      const pageEnableMs = performance.now() - pageStart;

      let runtimeMs: number | null = null;
      if (variant.probeRuntime) {
        const rtStart = performance.now();
        await send("Runtime.enable", {}, sessionId);
        runtimeMs = performance.now() - rtStart;
      }

      samples.push({ attachMs, settleMs, browserOnlyMs, pageEnableMs, ...(runtimeMs !== null ? { runtimeMs } : {}) });
      send("Target.closeTarget", { targetId }).catch(() => undefined);
      send("Target.disposeBrowserContext", { browserContextId: ctx.browserContextId }).catch(() => undefined);
    } finally {
      transport.close();
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      await browser.close();
    }
  }
  const median = (key: string) => {
    const values = samples.map((s) => s[key] as number).sort((a, b) => a - b);
    return Number((values[Math.floor(values.length / 2)] ?? 0).toFixed(1));
  };
  return { variant: variant.name, repeats: REPEATS, medians: {
    attachMs: median("attachMs"), browserOnlyMs: median("browserOnlyMs"), pageEnableMs: median("pageEnableMs"),
    ...(variant.probeRuntime ? { runtimeMs: median("runtimeMs") } : {}),
  }, allPageEnableMs: samples.map((s) => Number(s.pageEnableMs.toFixed(1))) };
}

async function main() {
  const variants: Variant[] = [
    { name: "baseline-about-blank" },
    { name: "createTarget-with-real-url", createUrl: "http://127.0.0.1:1/" },
    { name: "settle-1000ms-before-enable", settleMs: 1000 },
    { name: "probe-runtime-enable", probeRuntime: true },
    { name: "no-sandbox", extraFlags: ["--no-sandbox"] },
    { name: "single-process", extraFlags: ["--single-process"] },
  ];
  for (const variant of variants) {
    try {
      process.stdout.write(`${JSON.stringify(await runVariant(variant))}\n`);
    } catch (error: any) {
      process.stdout.write(`${JSON.stringify({ variant: variant.name, error: String(error?.message ?? error).slice(0, 200) })}\n`);
    }
  }
  process.stdout.write(JSON.stringify({ limits: [
    "Median of a few repeats on a busy machine; treat as order-of-magnitude.",
    "Isolates where Page.enable time goes, not a benchmark of task speed.",
  ] }) + "\n");
}

void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });