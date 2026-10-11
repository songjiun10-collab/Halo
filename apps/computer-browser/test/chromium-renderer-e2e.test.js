"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { acquireCdpBrowser, findChromium } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");
const { createRendererBridge } = require("../main/harness/chromium-bridge");

// Every channel the production host registers (main/ipc.js) becomes a bridge method, as in chromium-desktop.
function hostMethods() {
  const source = require("node:fs").readFileSync(path.resolve(__dirname, "../main/ipc.js"), "utf8");
  const legacy = /const LEGACY_METHODS = \[([^\]]*)\]/.exec(source)[1].match(/"[A-Za-z]+"/g).map((name) => name.slice(1, -1));
  return [...new Set([...legacy, ...[...source.matchAll(/"halo:([A-Za-z]+)"/g)].map((match) => match[1])])];
}

// Minimal host replies shaped like the real ones, so the shell's startup reads succeed.
function hostReply(channel) {
  if (channel === "halo:getSnapshot") return { tabs: [], activeTabId: "", page: { hasPage: false } };
  if (/^halo:list/.test(channel)) return [];
  return null;
}

test("built HALO renderer mounts in a Chromium app page through the authenticated bridge", {
  skip: !findChromium(), timeout: 30000,
}, async (t) => {
  const root = path.resolve(__dirname, "../renderer/dist");
  // The production host derives `methods` from its registered handlers; an empty list makes the app's first
  // `getHostSettings`/`getSnapshot` calls throw, and React unmounts the shell depending on timing.
  const bridge = createRendererBridge({ root, methods: hostMethods(), layout: {}, invoke: async (channel) => hostReply(channel) });
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
  await view.webContents.cmd("Page.addScriptToEvaluateOnNewDocument", { source: "window.__errs=[];addEventListener('error',e=>__errs.push(e.message));addEventListener('unhandledrejection',e=>__errs.push(String(e.reason)))" });
  await view.webContents.loadURL(url);
  assert.equal(await view.webContents.waitForSelector(".hx-app", 15000), true, "React shell mounts in Chromium");
  const runtime = await view.webContents.executeJavaScript("document.documentElement.dataset.runtime");
  assert.equal(runtime, "chromium");
  assert.deepEqual(await view.webContents.executeJavaScript("window.__errs"), [], "no uncaught page errors");
});
