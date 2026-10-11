"use strict";

// page-zoom.js: the shared zoom mechanism for the human Mod+/Mod-/Mod+0
// shortcuts and the agent `zoom` action. CSS `zoom` on the root element was
// measured (2026-10-10) to scale layout, hit-testing, observation geometry and
// captures together -- these tests pin the ladder and the failure modes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { ZOOM_STEPS, normalizeZoom, nextZoom, applyPageZoom, resolveZoomAction } = require("../main/harness/page-zoom");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));

test("normalizeZoom snaps to the ladder and rejects out-of-range or non-numbers", () => {
  assert.equal(normalizeZoom(1), 1);
  assert.equal(normalizeZoom(1.23), 1.25);
  assert.equal(normalizeZoom(0.51), 0.5);
  assert.equal(normalizeZoom(2), 2);
  assert.equal(normalizeZoom(0.1), null);
  assert.equal(normalizeZoom(9), null);
  assert.equal(normalizeZoom("2"), null);
  assert.equal(normalizeZoom(Number.NaN), null);
});

test("nextZoom walks the ladder, saturates at both ends, and resets to 1", () => {
  assert.equal(nextZoom(1, "in"), 1.1);
  assert.equal(nextZoom(1.1, "in"), 1.25);
  assert.equal(nextZoom(1, "out"), 0.9);
  assert.equal(nextZoom(0.9, "out"), 0.8);
  assert.equal(nextZoom(1.25, "reset"), 1);
  assert.equal(nextZoom(ZOOM_STEPS[0], "out"), ZOOM_STEPS[0], "saturates at the floor");
  assert.equal(nextZoom(ZOOM_STEPS.at(-1), "in"), ZOOM_STEPS.at(-1), "saturates at the ceiling");
});

test("resolveZoomAction accepts direction or level, never both, never neither", () => {
  assert.equal(resolveZoomAction({ direction: "in" }, 1), 1.1);
  assert.equal(resolveZoomAction({ direction: "reset" }, 2), 1);
  assert.equal(resolveZoomAction({ level: 2 }, 1), 2);
  assert.equal(resolveZoomAction({ level: 1.23 }, 1), 1.25);
  assert.equal(resolveZoomAction({ direction: "in", level: 2 }, 1), null);
  assert.equal(resolveZoomAction({ direction: "sideways" }, 1), null);
  assert.equal(resolveZoomAction({}, 1), null);
  assert.equal(resolveZoomAction(null, 1), null);
  assert.equal(resolveZoomAction({ level: 99 }, 1), null);
});

test("applyPageZoom sets the root style and reports the applied level", async () => {
  const scripts = [];
  const wc = { executeJavaScript: async (code, userGesture) => { scripts.push(code); assert.equal(userGesture, true); return "1.25"; } };
  assert.deepEqual(await applyPageZoom(wc, 1.23), { ok: true, level: 1.25 });
  assert.ok(scripts[0].includes('document.documentElement.style.zoom = "1.25"'));
});

test("a page that cannot confirm the style reports zoom_unsupported, and errors fail closed", async () => {
  assert.equal((await applyPageZoom({ executeJavaScript: async () => null }, 2)).errorCode, "zoom_unsupported");
  assert.equal((await applyPageZoom({ executeJavaScript: async () => { throw new Error("gone"); } }, 2)).errorCode, "zoom_failed");
  assert.equal((await applyPageZoom({ isDestroyed: () => true }, 2)).errorCode, "zoom_target_unavailable");
  assert.equal((await applyPageZoom(null, 2)).errorCode, "zoom_target_unavailable");
  assert.equal((await applyPageZoom({ executeJavaScript: async () => "2" }, 99)).errorCode, "invalid_zoom_level");
});

test("real Chromium: the agent zoom action scales layout and hit-testing together", { skip: CHROMIUM ? false : "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>zoom</title><style>body{margin:0}
      #btn{position:absolute;left:360px;top:225px;width:120px;height:40px}</style>
      <body><button id="btn">target</button><script>window.__clicks=0;document.getElementById("btn").addEventListener("click",()=>{window.__clicks+=1});</script></body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
  const adapter = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
  t.after(async () => {
    try { adapter.dispose?.(); } catch { /* best effort */ }
    try { view.closeConnection(); } catch { /* best effort */ }
    await launched.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  });

  assert.equal((await adapter.execute({ type: "navigate", url })).status, "ok");
  const before = await view.webContents.executeJavaScript("JSON.stringify(document.getElementById('btn').getBoundingClientRect())");
  assert.equal(JSON.parse(before).x, 360);

  const zoomed = await adapter.execute({ type: "zoom", level: 2 });
  assert.deepEqual([zoomed.status, zoomed.level], ["ok", 2]);
  const applied = await view.webContents.executeJavaScript("document.documentElement.style.zoom");
  assert.equal(applied, "2", "the root style carries the zoom the browser sees");

  const rect = JSON.parse(await view.webContents.executeJavaScript("JSON.stringify(document.getElementById('btn').getBoundingClientRect())"));
  assert.equal(rect.x, 720, "layout scales with the zoom");
  assert.equal(rect.width, 240);
  // Hit-testing scales with it: a forwarded click at the SCALED center lands.
  const wc = view.webContents;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  wc.sendInputEvent({ type: "mouseMove", x: cx, y: cy });
  wc.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await view.webContents.executeJavaScript("window.__clicks"), 1, "the click landed on the same control the normalized geometry points at");

  const reset = await adapter.execute({ type: "zoom", direction: "reset" });
  assert.deepEqual([reset.status, reset.level], ["ok", 1]);
});
