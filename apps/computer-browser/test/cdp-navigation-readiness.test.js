"use strict";

// Navigation readiness regression: navigate() must resolve when the new
// document is READABLE (root-frame DOMContentLoaded for this navigation's
// loader), not when every subresource has finished.
//
// Measured on real pages (2026-10-09): DCL arrives 40ms-1.5s before full load
// and observe() already works at DCL, so waiting for did-stop-loading was pure
// added latency. The three ordering rules that matter:
//   1. Only the DCL of THIS navigation's loader may resolve it -- a previous
//      page's late DOMContentLoaded must not.
//   2. A previous page's TRAILING did-stop-loading must not resolve the next
//      navigate() before it has even started/committed (this actually happened
//      against real Chromium as `stale_document` in observe()).
//   3. Pages whose DCL never fires still finish on did-stop-loading once the
//      navigation started or committed, and downloads/errors do not hang.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { performance } = require("node:perf_hooks");

const { CdpWebContents } = require("../main/harness/cdp-web-contents");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));
const skip = CHROMIUM ? false : "no Chromium binary";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const settle = (promise) => Promise.race([promise.then(() => "settled", () => "rejected"), tick().then(() => "pending")]);

function fakeTransport() {
  const handlers = new Set();
  const sent = [];
  return {
    sent,
    send(method, params = {}) {
      sent.push({ method, params });
      if (method === "Target.setDiscoverTargets" || method === "Target.createTarget" || method === "Target.attachToTarget") {
        return Promise.resolve({ targetId: "t1", sessionId: "s1", browserContextId: "c1" });
      }
      if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "f1", url: "about:blank" } } });
      if (method === "Page.getNavigationHistory") return Promise.resolve({ entries: [], currentIndex: -1 });
      if (method === "Page.navigate") return Promise.resolve({ frameId: "f1", loaderId: params.url.includes("download") ? "L1" : "L2", isDownload: params.url.includes("download") });
      return Promise.resolve({});
    },
    onEvent(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    emit(method, params = {}, sessionId = "s1") { for (const h of [...handlers]) h(method, params, sessionId); },
    close() {},
  };
}

async function makePage(transport) {
  const page = new CdpWebContents(async () => transport, { url: "about:blank" });
  await page.ready;
  return page;
}

test("navigate resolves on this navigation's dom-ready, before did-stop-loading", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  const nav = page.loadURL("https://a.test/");
  await tick(); // let Page.navigate's loaderId reach the waiter
  transport.emit("Page.frameNavigated", { frame: { id: "f1", url: "https://a.test/", loaderId: "L2" } });
  assert.equal(await settle(nav), "pending", "a commit alone is not readable content yet");
  transport.emit("Page.domContentEventFired", {});
  assert.equal(await settle(nav), "settled", "root-frame DOMContentLoaded resolves the navigation");
});

test("a previous page's late dom-ready cannot resolve the next navigation", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  const nav = page.loadURL("https://b.test/");
  await tick();
  // Still on the old loader: this DCL belongs to the previous page.
  transport.emit("Page.domContentEventFired", {});
  assert.equal(await settle(nav), "pending", "DCL for a different loader must be ignored");
  transport.emit("Page.frameNavigated", { frame: { id: "f1", url: "https://b.test/", loaderId: "L2" } });
  transport.emit("Page.domContentEventFired", {});
  assert.equal(await settle(nav), "settled");
});

test("a trailing did-stop-loading from the previous page cannot resolve a fresh navigation", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  const nav = page.loadURL("https://c.test/");
  await tick();
  // The previous page's load finishing, delivered after this call began.
  transport.emit("Page.frameStoppedLoading", { frameId: "f1" });
  assert.equal(await settle(nav), "pending", "stop before start/commit of this navigation must be ignored");
  transport.emit("Page.frameNavigated", { frame: { id: "f1", url: "https://c.test/", loaderId: "L2" } });
  transport.emit("Page.domContentEventFired", {});
  assert.equal(await settle(nav), "settled");
});

test("a page that never fires dom-ready still finishes on did-stop-loading after commit", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  const nav = page.loadURL("https://d.test/");
  await tick();
  transport.emit("Page.frameNavigated", { frame: { id: "f1", url: "https://d.test/", loaderId: "L2" } });
  transport.emit("Page.frameStoppedLoading", { frameId: "f1" });
  assert.equal(await settle(nav), "settled");
});

test("an aborted load that started but never committed still finishes on did-stop-loading", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  const nav = page.loadURL("https://e.test/");
  await tick();
  transport.emit("Page.frameStartedLoading", { frameId: "f1" });
  transport.emit("Page.frameStoppedLoading", { frameId: "f1" });
  assert.equal(await settle(nav), "settled");
});

test("a download navigation resolves without waiting for a document", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());
  const nav = page.loadURL("https://f.test/download");
  assert.equal(await settle(nav), "settled");
});

test("a slow subresource no longer delays navigate, and observe works at dom-ready", { skip, timeout: 90000 }, async (t) => {
  const IMAGE_DELAY_MS = 2500;
  const server = http.createServer((request, response) => {
    if (request.url === "/img.png") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      }, IMAGE_DELAY_MS);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>slow</title></head><body><h1>Readable now</h1><img src="/img.png" width="8" height="8"><a href="/next">Go</a></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 800, height: 600 });
  const adapter = new BrowserAdapter({ view, navigationTimeoutMs: 20000 });
  t.after(async () => {
    try { adapter.dispose?.(); } catch { /* best effort */ }
    try { view.closeConnection(); } catch { /* best effort */ }
    await launched.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  });

  const started = performance.now();
  const result = await adapter.execute({ type: "navigate", url: `${base}/` });
  const navMs = performance.now() - started;
  assert.equal(result.status, "ok");
  // The image is still loading for a while; navigate must not have waited for it.
  assert.ok(navMs < IMAGE_DELAY_MS / 2, `navigate took ${Math.round(navMs)}ms; expected it to return at dom-ready, well before the ${IMAGE_DELAY_MS}ms image`);
  const observation = await adapter.observe();
  assert.ok(observation.elements.some((element) => element.role === "link"), "the link is visible to observe() at dom-ready");
});
