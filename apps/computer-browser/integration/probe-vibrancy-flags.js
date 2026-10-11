"use strict";

// TEMPORARY probe (not a test). End-to-end check of the first native Chromium
// patch (--halo-vibrancy-width / --halo-vibrancy-tint) on the built browser.
//
// The patch sets NSWindowStyleMaskFullSizeContentView + a transparent titlebar
// for the --app window, so the web contents must extend under the titlebar.
// That is externally observable without screen-recording permission: compare
// window.innerHeight at the same --window-size with the Halo flags on and off.
//
//   node integration/probe-vibrancy-flags.js [binary]

const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { launchFlags } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport } = require("../main/harness/cdp-web-contents");

const BINARY = process.argv[2] || [
  path.join(os.homedir(), "chromium/src/out/TrialLean/Chromium.app/Contents/MacOS/Chromium"),
  path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium"),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(flags) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-vibrancy-probe-"));
  const child = spawn(BINARY, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("startup_timeout")), 30000);
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("exited_early")); });
  });
  return { child, wsUrl, profile };
}

async function measure(url) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>vibrancy probe</title><body style='margin:0;background:transparent'><h1>probe</h1></body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const appUrl = `http://127.0.0.1:${server.address().port}/`;
  const results = {};
  try {
    for (const arm of ["on", "off"]) {
      const all = launchFlags(undefined, false, "/tmp/probe-profile", BINARY, { desktop: true, appUrl });
      const flags = arm === "on" ? all : all.filter((f) => !f.startsWith("--halo-vibrancy") && f !== "--enable-features=GlassFrame");
      const { child, wsUrl, profile } = launch(flags);
      try {
        const transport = await connectCdpTransport(await wsUrl);
        await sleep(2500); // window + first paint
        const targets = await transport.send("Target.getTargets");
        const page = targets.targetInfos.find((t) => t.type === "page" && String(t.url).startsWith(appUrl));
        if (!page) throw new Error(`no app target; saw ${targets.targetInfos.map((t) => `${t.type}:${t.url}`).join(" | ").slice(0, 200)}`);
        const { sessionId } = await transport.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
        const value = await transport.send("Runtime.evaluate", {
          expression: "JSON.stringify({innerWidth:window.innerWidth,innerHeight:window.innerHeight,outerHeight:window.outerHeight,screenY:window.screenY})",
          returnByValue: true,
        }, sessionId);
        results[arm] = JSON.parse(value.result.value);
        transport.close();
      } finally {
        child.kill("SIGTERM");
        await sleep(600);
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* probe */ }
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  const { on, off } = results;
  const delta = on && off ? on.innerHeight - off.innerHeight : null;
  console.log(JSON.stringify({
    binary: BINARY, on, off,
    innerHeightDelta: delta,
    // A full-size content view must make the page taller than the non-patched
    // arm at the same --window-size; a difference of one titlebar (~28px) is
    // the expected signature.
    fullSizeContentViewObserved: delta !== null && delta > 10,
  }, null, 2));
}

measure().catch((error) => { console.error(error?.stack || error); process.exit(1); });