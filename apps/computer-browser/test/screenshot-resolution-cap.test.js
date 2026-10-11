"use strict";

// The computer-use attachment resolution cap. Screenshots are captured from
// the logical agent viewport (1440x900); the attachment renders at
// SCREENSHOT_MAX_WIDTH (1280) instead of full viewport pixels. Measured
// 2026-10-09 with macOS Vision OCR (accurate) on a dense console page:
// 98% label recall at 1440, 95% at 1280, then 51% at 1024, 20% at 768 --
// so 1280 is where Claude image tokens drop 21% (1,728 -> 1,366) before
// control labels start disappearing. Geometry is normalized, so the binding
// keeps the LOGICAL viewport; only the pixels shrink.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { openCdpView, pngSize } = require("../main/harness/cdp-web-contents");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { createScreenshotAttachment } = require("../main/harness/computer-use-contract");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));
const skip = CHROMIUM ? false : "no Chromium binary";

// A 1x1 PNG is enough for callers that only check the signature/buffer.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fakeCdpView({ width = 1440, height = 900, pngWidth = 1280, pngHeight = 800 } = {}) {
  const calls = [];
  const wc = new EventEmitter();
  Object.assign(wc, {
    isCdp: true,
    getURL: () => "https://page.test/",
    executeJavaScript: async () => ({ url: "https://page.test/", title: "Test", text: "hi", elements: [] }),
    capturePage: async (rect, options) => {
      calls.push({ rect, options });
      return {
        getSize: () => ({ width: pngWidth, height: pngHeight }),
        toPNG: () => PNG_1PX,
      };
    },
  });
  return { view: { webContents: wc, getBounds: () => ({ x: 0, y: 0, width, height }) }, calls };
}

test("a CDP viewport wider than the cap renders the screenshot smaller, but the binding viewport stays logical", async () => {
  const { view, calls } = fakeCdpView();
  const adapter = new BrowserAdapter({ view });
  const observation = await adapter.observe();
  const capture = await adapter.captureScreenshot(observation);

  assert.deepEqual(calls[0].rect, { x: 0, y: 0, width: 1440, height: 900 });
  assert.ok(calls[0].options && Math.abs(calls[0].options.scale - 1280 / 1440) < 1e-9, "the CDP capture is asked for the 1280px render");
  assert.deepEqual(capture.viewport, { width: 1440, height: 900 }, "normalized geometry keeps the logical viewport");
});

test("a viewport at or below the cap is captured unscaled, and non-CDP surfaces never get the scale option", async () => {
  const narrow = fakeCdpView({ width: 1200, height: 750, pngWidth: 1200, pngHeight: 750 });
  const adapter = new BrowserAdapter({ view: narrow.view });
  const observation = await adapter.observe();
  await adapter.captureScreenshot(observation);
  assert.equal(narrow.calls[0].options, undefined, "no cap when the viewport already fits");

  const electronLike = fakeCdpView();
  electronLike.view.webContents.isCdp = undefined; // Electron's capturePage has no scale option
  const adapter2 = new BrowserAdapter({ view: electronLike.view });
  const observation2 = await adapter2.observe();
  await adapter2.captureScreenshot(observation2);
  assert.equal(electronLike.calls[0].options, undefined, "the Electron fallback is untouched");
});

test("real Chromium: the attachment is 1280 wide, the binding viewport is 1440, and the contract accepts it", { skip, timeout: 90000 }, async (t) => {
  const http = require("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>capture</title><body><h1>Capture</h1><button>Go</button></body></html>");
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

  const navigated = await adapter.execute({ type: "navigate", url });
  assert.equal(navigated.status, "ok");
  const observation = await adapter.observe();
  const capture = await adapter.captureScreenshot(observation);

  const size = pngSize(capture.png);
  assert.deepEqual({ width: size.width, height: size.height }, { width: 1280, height: 800 }, "the attachment renders at the cap");
  assert.deepEqual(capture.viewport, { width: 1440, height: 900 }, "the binding viewport stays logical");

  const attachment = await createScreenshotAttachment({
    png: capture.png,
    taskId: "11111111-1111-4111-8111-111111111111",
    agentId: null,
    observation: { id: capture.observationId, documentEpoch: capture.documentEpoch, url: capture.url },
    viewport: capture.viewport,
    capturedAt: Date.now(),
  });
  t.after(() => attachment.attachment.dispose().catch(() => undefined));
  const written = fs.readFileSync(attachment.attachment.path);
  assert.deepEqual(pngSize(written), { width: 1280, height: 800 }, "the contract stores the scaled PNG intact");
});
