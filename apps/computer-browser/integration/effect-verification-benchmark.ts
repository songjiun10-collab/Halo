"use strict";

// Developer-only localhost benchmark; no models, accounts or external sites.
// Questions: how much does the initial sleep cost for an already-visible
// effect, and do both algorithms return the same measured outcome?
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { PAGE_SNAPSHOT_SOURCE, parseSnapshot, diffSnapshots, verifyEffect } = require("../main/harness/effect-verifier");

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Frozen pre-change algorithm, not a second production execution path.
async function legacyVerify(before: any, read: () => Promise<any>) {
  for (let waited = 0; waited < 1500; waited += 100) {
    await sleep(100);
    const after = await read().catch(() => null);
    if (!after) continue;
    const changed = diffSnapshots(before, after);
    if (changed.length) return { observed: true, changed };
  }
  return { observed: false, changed: [] };
}

async function main() {
  const server = http.createServer((_request: any, response: any) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>before</title><button id=apply onclick=\"document.title=this.dataset.next\">Apply</button>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });
  try {
    const view = engine.createPage("halo-task-effect-benchmark");
    const wc = view.webContents;
    await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const read = async () => parseSnapshot(await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: PAGE_SNAPSHOT_SOURCE }]));
    const samples: Record<string, number[]> = { legacy: [], immediate: [] };
    let verified = 0;
    for (let pair = 0; pair < 12; pair++) {
      for (const mode of pair % 2 ? ["immediate", "legacy"] : ["legacy", "immediate"]) {
        const before = await read();
        if (!before) throw new Error("snapshot_unavailable");
        const title = `effect-${pair}-${mode}`;
        // Host-built deterministic button action. The model never supplies JS.
        await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `(()=>{const b=document.getElementById('apply');b.dataset.next=${JSON.stringify(title)};b.click();return true})()` }]);
        const start = performance.now();
        const result = mode === "legacy" ? await legacyVerify(before, read) : await verifyEffect({ before, read, sleep });
        samples[mode].push(performance.now() - start);
        if (!result.observed || !result.changed.includes("title") || (await read())?.title !== title) throw new Error("effect_not_verified");
        verified++;
      }
    }
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { count: values.length, p50Ms: sorted[Math.ceil(values.length * .5) - 1], p95Ms: sorted[Math.ceil(values.length * .95) - 1] };
    };
    process.stdout.write(JSON.stringify({ schemaVersion: 1, fixture: "localhost-synchronous-button-effect", pairs: 12,
      legacy: stats(samples.legacy), immediate: stats(samples.immediate), verified,
      limits: ["Verification latency only; input dispatch/startup excluded.", "Deterministic local button; no model quality or cross-site E2E speed claim."] }, null, 2) + "\n");
  } finally {
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
