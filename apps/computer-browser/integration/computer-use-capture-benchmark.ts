"use strict";

// Developer-only paired benchmark. Run with Node's TypeScript stripping support.
// Uses only a disposable localhost page; no credentials, external sites or models.
const http = require("node:http");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { captureFrameJpeg } = require("../main/harness/frame-capture");

interface Sample { ms: number; bytes: number; transportBytes: number; calls: number; digest: string }
function summarize(samples: Sample[]) {
  const times = samples.map(s => s.ms).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
  return { samples: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95),
    meanJpegBytes: samples.reduce((n, s) => n + s.bytes, 0) / samples.length,
    meanTransportImageBytes: samples.reduce((n, s) => n + s.transportBytes, 0) / samples.length,
    screenshotCalls: samples.reduce((n, s) => n + s.calls, 0) };
}

async function main() {
  const server = http.createServer((_request: any, response: any) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<style>body{font:16px monospace;background:#101310;color:#daf0db}button{font:inherit}</style><h1>Halo local capture fixture</h1><input id=q value="ready"><button id=apply onclick="document.title='applied';document.querySelector('#q').value='done'">Apply</button>${Array.from({ length: 60 }, (_, i) => `<p>Row ${i}: backend developer-tools observation and deterministic screenshot parity.</p>`).join("")}`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });
  try {
    const view = engine.createPage("halo-task-capture-benchmark");
    const wc = view.webContents;
    await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const { transport } = await engine.connect();
    const send = transport.send.bind(transport);
    let calls = 0, transportBytes = 0;
    transport.send = async (method: string, params: any, sessionId: string) => {
      const result = await send(method, params, sessionId);
      if (method === "Page.captureScreenshot") { calls++; transportBytes += Buffer.from(result.data, "base64").length; }
      return result;
    };
    const legacy = async () => {
      let image = await wc.capturePage();
      if (image.getSize().width > 1200) image = image.resize({ width: 1200 });
      return image.encodeJpegAsync(65);
    };
    const direct = () => captureFrameJpeg(wc, { maxWidth: 1200, quality: 65 });
    await legacy(); await direct(); // equal warm-up; startup excluded
    const results: Record<string, Sample[]> = { legacy: [], direct: [] };
    let identicalPairs = 0;
    const pairs = 16;
    for (let pair = 0; pair < pairs; pair++) {
      for (const mode of pair % 2 ? ["direct", "legacy"] : ["legacy", "direct"]) {
        calls = 0; transportBytes = 0;
        const start = performance.now();
        const jpeg = await (mode === "legacy" ? legacy() : direct());
        if (!jpeg || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("invalid_jpeg");
        results[mode].push({ ms: performance.now() - start, bytes: jpeg.length, transportBytes, calls,
          digest: crypto.createHash("sha256").update(jpeg).digest("hex") });
      }
      if (results.legacy[pair].digest === results.direct[pair].digest) identicalPairs++;
    }
    // Exercise the host-built developer-tools path against a deterministic field/button.
    await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "document.getElementById('q').value='updated';document.getElementById('apply').click();true" }]);
    const effect = await wc.executeJavaScript("({title:document.title,value:document.getElementById('q').value})");
    if (effect.title !== "applied" || effect.value !== "done") throw new Error("dom_effect_verification_failed");
    const baseline = summarize(results.legacy), optimized = summarize(results.direct);
    process.stdout.write(JSON.stringify({ schemaVersion: 1, fixture: "local-static-1280x800", pairs, baseline, optimized,
      p50Speedup: baseline.p50Ms / optimized.p50Ms, p95Speedup: baseline.p95Ms / optimized.p95Ms,
      identicalJpegPairs: identicalPairs, domEffectVerified: true,
      limits: ["One static local fixture; startup excluded; order alternates.", "JPEG equality checks output fidelity, not task-level model success rate.", "No external model/API calls, production UI, user accounts or credentials tested."] }, null, 2) + "\n");
  } finally {
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
