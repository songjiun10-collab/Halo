"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { captureFrameJpeg } = require("../main/harness/frame-capture");
const { createCdpView } = require("../main/harness/cdp-web-contents");
const options = { maxWidth: 1200, quality: 65 };

test("late frames from a navigated page are discarded", async () => {
  let url = "https://one.test"; let finish;
  const page = { getURL: () => url, captureJpeg: async () => new Promise(resolve => { finish = resolve; }) };
  const result = captureFrameJpeg(page, options);
  url = "https://two.test"; finish(Buffer.from("old-frame"));
  assert.equal(await result, null);
});
test("failed captures clear single-flight state and the next read can succeed", async () => {
  let calls = 0;
  const page = { captureJpeg: async () => { if (!calls++) throw new Error("closed"); return Buffer.from("new-frame"); } };
  await assert.rejects(captureFrameJpeg(page, options), /closed/);
  assert.equal((await captureFrameJpeg(page, options)).toString(), "new-frame");
});
test("invalid capture parameters never touch the browser", async () => {
  const page = { captureJpeg: async () => { throw new Error("browser touched"); } };
  await assert.rejects(captureFrameJpeg(page, { maxWidth: 0, quality: 65 }), /invalid_capture_options/);
});
test("the real CDP page requests one resized JPEG, never a PNG or layout roundtrip", async () => {
  const calls = [];
  const transport = { onEvent: () => () => {}, async send(method, params) {
    calls.push({ method, params });
    if (method === "Target.createTarget") return { targetId: "target" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [] };
    if (method === "Page.captureScreenshot") return { data: Buffer.from("jpeg").toString("base64") };
    return {};
  } };
  const view = createCdpView(async () => transport, { hardened: false, width: 1440, height: 900 });
  await view.webContents.ready; calls.length = 0;
  assert.equal((await captureFrameJpeg(view.webContents, options)).toString(), "jpeg");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "Page.captureScreenshot");
  assert.equal(calls[0].params.format, "jpeg");
  assert.equal(calls[0].params.clip.scale, 1200 / 1440);
  view.webContents.close();
});

test("JPEG capture waits for an in-flight viewport resize before choosing its clip", async () => {
  let finishResize; const captures = [];
  const transport = { onEvent: () => () => {}, async send(method, params) {
    if (method === "Target.createTarget") return { targetId: "target" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [] };
    if (method === "Emulation.setDeviceMetricsOverride" && params.width === 800) await new Promise(resolve => { finishResize = resolve; });
    if (method === "Page.captureScreenshot") { captures.push(params); return { data: Buffer.from("jpeg").toString("base64") }; }
    return {};
  } };
  const view = createCdpView(async () => transport, { hardened: false });
  await view.webContents.ready;
  const resize = view.webContents.setViewportSize(800, 600);
  await new Promise(resolve => setImmediate(resolve));
  const capture = captureFrameJpeg(view.webContents, options);
  await new Promise(resolve => setImmediate(resolve));
  const premature = captures.length;
  finishResize();
  await resize; await capture;
  assert.equal(premature, 0, "capturing the old geometry would mismatch input coordinates");
  assert.equal(captures[0].clip.width, 800);
  assert.equal(captures[0].clip.height, 600);
  view.webContents.close();
});
