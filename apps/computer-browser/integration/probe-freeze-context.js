"use strict";

// TEMPORARY diagnostic probe (not a test). Proves whether the isolated-world
// executionContextId cached in CdpWebContents.worlds survives a
// ParkableView freeze/thaw, and which CDP context events fire while it does.
//
//   node integration/probe-freeze-context.js
//   HALO_CHROMIUM=<path to Chromium binary>

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { ParkableView } = require("../main/harness/renderer-lifecycle");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));
const WORLD_ID = 7;

async function main() {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>t</title><h1>page</h1><a href='/next'>go</a>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  const { transport } = await engine.connect();
  const seen = [];
  const off = transport.onEvent((method, params) => {
    if (method.startsWith("Runtime.executionContext") || method === "Page.frameNavigated") {
      seen.push(`IN  ${method} ${JSON.stringify(params.executionContextId ?? params.executionContextIds ?? (params.context ? params.context.id : undefined) ?? "")}`);
    }
  });
  // Trace every Runtime/Page context command and its outcome.
  const originalSend = transport.send.bind(transport);
  transport.send = (method, params, sessionId) => {
    if (method === "Runtime.executionContextDestroyed") {
      console.log(`      -> SEND-ISH ${method} ${JSON.stringify(params)}`);
    }
    if (!/^(Runtime\.evaluate|Page\.createIsolatedWorld|Page\.setWebLifecycleState|Page\.getFrameTree)$/.test(method)) {
      return originalSend(method, params, sessionId);
    }
    return originalSend(method, params, sessionId).then(
      (r) => { console.log(`      -> ${method} ${JSON.stringify(params)} OK ${method === "Runtime.evaluate" ? `ctx=${params.contextId}` : JSON.stringify(r)}`.slice(0, 160)); return r; },
      (e) => { console.log(`      -> ${method} ${JSON.stringify(params)} FAIL ${e.message}`.slice(0, 160)); throw e; },
    );
  };

  // Reach the real CdpWebContents so the probe can read its `worlds` cache.
  let real = null;
  const view = new ParkableView({ create: () => {
    const page = engine.createPage("halo-task-probe");
    real = page.webContents;
    return { view: page, dispose() {} };
  } });
  const wc = view.webContents; // the waking proxy
  await wc.ready;
  await wc.loadURL(`${base}/a`);

  seen.length = 0;
  await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: "document.title" }]);
  const cached = [...real.worlds.entries()];
  console.log("after navigate+observe, worlds cache:", JSON.stringify(cached));
  console.log("   events:", seen.length ? seen.join(" | ") : "(none)");

  console.log("\n--- freeze ---");
  seen.length = 0;
  console.log("freeze() ->", await view.freeze(), "state:", view.state);
  await new Promise((r) => setTimeout(r, 500));
  console.log("   context events:", seen.length ? seen.join(" | ") : "(none)");
  console.log("   worlds cache AFTER freeze:", JSON.stringify([...real.worlds.entries()]),
    real.worlds.get(WORLD_ID) === cached[0]?.[1] ? "  <-- STALE id retained" : "  (invalidated)");

  console.log("\n--- thaw + observe (the failing path) ---");
  seen.length = 0;
  let failure = null;
  try {
    await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: "document.title" }]);
    console.log("   result: ok");
  } catch (error) { failure = error; console.log("   result: FAILED ->", error.message); }
  console.log("   context events:", seen.length ? seen.join(" | ") : "(none)");

  if (failure) {
    console.log("\n--- control A: drop cached world, retry immediately ---");
    real.worlds.clear();
    try {
      const value = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: "document.title" }]);
      console.log("   retry ok, value:", JSON.stringify(value), "cache:", JSON.stringify([...real.worlds.entries()]));
    } catch (error) { console.log("   retry FAILED ->", error.message); }

    console.log("\n--- control B: settle 1s, then a DIFFERENT world name ---");
    await new Promise((r) => setTimeout(r, 1000));
    seen.length = 0;
    const fresh = await real.rawCmd("Page.createIsolatedWorld", { frameId: real.mainFrameId, worldName: `halo-${WORLD_ID}-r1`, grantUniveralAccess: false });
    console.log("   createIsolatedWorld(unique name) ->", JSON.stringify(fresh));
    console.log("   context events during it:", seen.join(" | ") || "(none)");
    try {
      const evaluated = await real.rawCmd("Runtime.evaluate", { expression: "document.title", returnByValue: true, contextId: fresh.executionContextId });
      console.log("   evaluate in fresh world ->", JSON.stringify(evaluated.result));
    } catch (error) { console.log("   evaluate in fresh world FAILED ->", error.message); }

    console.log("\n--- control C: does the OLD world name still resolve? ---");
    const again = await real.rawCmd("Page.createIsolatedWorld", { frameId: real.mainFrameId, worldName: `halo-${WORLD_ID}`, grantUniveralAccess: false });
    console.log("   re-create old name ->", JSON.stringify(again));
  }

  off();
  await engine.release();
  await new Promise((r) => server.close(r));
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });