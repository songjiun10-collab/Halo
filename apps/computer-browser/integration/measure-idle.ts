// Idle footprint and cold-start latency of the browser Halo launches, on about:blank, no model involved.
//   node integration/measure-idle.ts            3 runs, 30 s idle each, headless
//   HALO_MEASURE_HEADED=1 HALO_CHROMIUM=...     headed (needs a full Chromium binary)
//   HALO_MEASURE_RUNS=5 HALO_MEASURE_IDLE_S=60  override runs / idle seconds
// Each run uses its own profile directory as the marker, so a benchmark running at the same time is not counted.
// It does not touch the network beyond what Chromium does on its own at start.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { sampleTree, median } = require("./footprint.ts");

const MB = 1024 * 1024;

async function oneRun(headless: boolean, idleSeconds: number) {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "halo-idle-"));
  fs.chmodSync(profile, 0o700);
  const t0 = Date.now();
  let launched: any, view: any;
  try {
    launched = await acquireCdpBrowser({ headless, benchProfile: true, profilePath: profile });
    const launchMs = Date.now() - t0;
    view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
    const readyMs = Date.now() - t0;
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < idleSeconds * 1000) {
      await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(0, idleSeconds * 1000 - (Date.now() - start)))));
      samples.push(await sampleTree(profile));
    }
    const last = samples[samples.length - 1];
    return {
      launchMs, readyMs, processes: last.count, renderers: last.renderers,
      idleFootprintMB: Math.round(last.totalFootprintBytes / MB), idleRssMB: Math.round(last.totalRssKb / 1024),
      peakFootprintMB: Math.round(Math.max(...samples.map((s: any) => s.totalFootprintBytes)) / MB),
      byKindMB: Object.fromEntries(Object.entries(last.processes.reduce((a: any, p: any) => { a[p.kind] = (a[p.kind] ?? 0) + (p.footprintBytes ?? 0); return a; }, {})).map(([k, v]: any) => [k, Math.round(v / MB)])),
    };
  } finally {
    view?.closeConnection?.();
    await launched?.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const runs = Number(process.env.HALO_MEASURE_RUNS || 3);
  const idleSeconds = Number(process.env.HALO_MEASURE_IDLE_S || 30);
  const headless = process.env.HALO_MEASURE_HEADED !== "1";
  const results = [];
  for (let i = 0; i < runs; i++) { const r = await oneRun(headless, idleSeconds); results.push(r); process.stdout.write(JSON.stringify({ run: i + 1, headless, ...r }) + "\n"); }
  const pick = (k: string) => results.map((r: any) => r[k]);
  const summary = {
    runs, idleSeconds, headless,
    medianLaunchMs: median(pick("launchMs")), medianReadyMs: median(pick("readyMs")),
    medianIdleFootprintMB: median(pick("idleFootprintMB")), minMB: Math.min(...pick("idleFootprintMB")), maxMB: Math.max(...pick("idleFootprintMB")),
    medianRenderers: median(pick("renderers")), medianProcesses: median(pick("processes")),
    note: "physical footprint of the browser process tree only; model/planner processes excluded; goal is idle < 300 MB",
  };
  process.stdout.write(JSON.stringify({ summary }) + "\n");
}
main().catch((e: any) => { console.error("measure_idle_failed", e?.stack ?? e); process.exitCode = 1; });
