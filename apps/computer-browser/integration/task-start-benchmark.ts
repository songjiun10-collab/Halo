"use strict";

// Developer-only localhost benchmark: where does "task start" spend its time?
// Cold = first page on a fresh engine (browser launch); warm = later pages on the same engine.
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const { CdpEngine } = require("../main/harness/cdp-engine");

const PAGE = "<title>t</title><button id=b>Apply</button>";
const ms = (start: number) => Math.round(performance.now() - start);

async function main() {
  const server = http.createServer((_q: any, r: any) => { r.setHeader("content-type", "text/html"); r.end(PAGE); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });
  const out: Record<string, any> = {};
  try {
    let t = performance.now();
    const first = engine.createPage("halo-task-bench-cold");
    out.coldCreatePageMs = ms(t);
    t = performance.now();
    await first.webContents.loadURL(url);
    out.coldFirstLoadMs = ms(t);
    const warmCreate: number[] = [], warmLoad: number[] = [];
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      const view = engine.createPage(`halo-task-bench-warm-${i}`);
      warmCreate.push(ms(t));
      t = performance.now();
      await view.webContents.loadURL(url);
      warmLoad.push(ms(t));
    }
    out.warmCreatePageMs = warmCreate;
    out.warmLoadMs = warmLoad;
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ...out }, null, 2) + "\n");
  } finally {
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
