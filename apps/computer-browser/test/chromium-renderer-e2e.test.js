"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { acquireCdpBrowser, findChromium } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { createRendererBridge } = require("../main/harness/chromium-bridge");

test("built HALO renderer mounts in a Chromium app page through the authenticated bridge", {
  skip: !findChromium(), timeout: 30000,
}, async (t) => {
  const root = path.resolve(__dirname, "../renderer/dist");
  const bridge = createRendererBridge({ root, methods: [], layout: {}, invoke: async () => null });
  const { url } = await bridge.start();
  let browser;
  let view;
  t.after(async () => {
    view?.closeConnection();
    if (browser) await browser.close();
    await bridge.close();
  });
  browser = await acquireCdpBrowser({ headless: true, startupTimeoutMs: 15000 });
  view = await openCdpView(browser.wsUrl, { width: 1280, height: 900, commandTimeoutMs: 8000 });
  await view.webContents.loadURL(url);
  assert.equal(await view.webContents.waitForSelector(".hx-app", 15000), true, "React shell mounts in Chromium");
  const runtime = await view.webContents.executeJavaScript("document.documentElement.dataset.runtime");
  assert.equal(runtime, "chromium");
});
