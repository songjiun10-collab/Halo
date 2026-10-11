"use strict";

// TEMPORARY mechanics check (no screenshots): verifies that the measurement
// method's plumbing works while we cannot see the screen —
//   - launch the patched --app window with the Halo desktop flags,
//   - Target.createTarget({newWindow:true}) makes a SECOND real OS window,
//   - Browser.getWindowForTarget / setWindowBounds can place it full-screen,
//   - both windows get the expected bounds.
//   node integration/tmp-vibrancy-window-mechanics.js

const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { launchFlags } = require("../main/harness/cdp-browser-host");
const { connectCdpTransport } = require("../main/harness/cdp-web-contents");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BINARY = path.join(os.homedir(), "chromium/src/out/TrialLean/Chromium.app/Contents/MacOS/Chromium");

function launch(binary, flags, tag, timeoutMs) {
  const child = spawn(binary, flags, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.setEncoding("utf8");
  let buffer = "";
  const wsUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag}: timeout ${timeoutMs}; ${buffer.slice(-300)}`)), timeoutMs);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`${tag}: exited early`)); });
  });
  wsUrl.catch(() => {});
  return { child, wsUrl };
}

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>x</title><body style='margin:0;background:transparent'>x</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/test`;
  const bgUrl = `http://127.0.0.1:${port}/bg`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "halo-glass-mech-"));
  const flags = launchFlags(undefined, false, profile, BINARY, { desktop: true, appUrl: testUrl });
  const browser = launch(BINARY, flags, "mech", 120000);
  let transport = null;
  try {
    transport = await connectCdpTransport(await browser.wsUrl);
    const waitTarget = async (prefix) => {
      for (let i = 0; i < 100; i++) {
        const { targetInfos } = await transport.send("Target.getTargets");
        const t = targetInfos.find((x) => x.type === "page" && String(x.url).startsWith(prefix));
        if (t) return t;
        await sleep(250);
      }
      throw new Error(`no target ${prefix}`);
    };
    const test = await waitTarget(testUrl);
    const created = await transport.send("Target.createTarget", { url: bgUrl, newWindow: true });
    const bg = await waitTarget(bgUrl);
    await sleep(1500);
    const testWindow = await transport.send("Browser.getWindowForTarget", { targetId: test.targetId });
    const bgWindow = await transport.send("Browser.getWindowForTarget", { targetId: bg.targetId });
    let bgAfter = null;
    try {
      await transport.send("Browser.setWindowBounds", {
        windowId: bgWindow.windowId,
        bounds: { left: 0, top: 0, width: 1710, height: 1112, windowState: "normal" },
      });
      await sleep(500);
      bgAfter = await transport.send("Browser.getWindowForTarget", { targetId: bg.targetId });
    } catch (error) {
      bgAfter = { error: String(error?.message || error) };
    }
    const testAfter = await transport.send("Browser.getWindowForTarget", { targetId: test.targetId });
    await transport.send("Target.attachToTarget", { targetId: test.targetId, flatten: true });
    console.log(JSON.stringify({
      separateWindows: testWindow.windowId !== bgWindow.windowId,
      testTarget: test.targetId,
      bgTargetCreated: created.targetId,
      bgTargetSeen: bg.targetId,
      testWindow,
      bgWindowBefore: bgWindow,
      bgWindowAfter: bgAfter,
      testWindowAfter: testAfter,
    }, null, 2));
  } finally {
    if (transport) transport.close();
    try { process.kill(-browser.child.pid, "SIGTERM"); } catch { try { browser.child.kill("SIGTERM"); } catch {} }
    await sleep(1500);
    try { process.kill(-browser.child.pid, "SIGKILL"); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    server.close();
  }
}

main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
