"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const page = { url: "https://page.test/", title: "t", nodes: 10, textLength: 50, focus: "INPUT#q", valueLength: 4 };

// Builds an adapter with a valid, host-authorized visual binding (same flow as the coordinate tests in
// browser-adapter.test.js). The scripted snapshot reader is attached after observe so observation itself
// uses the plain executeJavaScript path. `snapshots` is consumed per read; the last one repeats.
async function adapterReady(snapshots, { withScripts = true } = {}) {
  const sent = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const webContents = {
    getURL: () => "https://page.test/",
    loadURL: async () => {},
    stop: () => {},
    executeJavaScript: async () => ({ url: "https://page.test/", title: "t", text: "", elements: [] }),
    capturePage: async () => ({ toPNG: () => png, getSize: () => ({ width: 1440, height: 900 }) }),
    sendInputEvent: (event) => { sent.push(event); },
    insertText: () => {},
    selectAll: () => {},
  };
  const view = { webContents, getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }) };
  const adapter = new BrowserAdapter({ view, permissionMode: "full" });
  const observation = await adapter.observe();
  const capture = await adapter.captureScreenshot(observation);
  adapter.authorizeVisualBinding({
    observationId: capture.observationId,
    taskId: "11111111-1111-4111-8111-111111111111",
    agentId: null,
    documentEpoch: capture.documentEpoch,
    origin: "https://page.test",
    capturedAt: 1,
    viewport: capture.viewport,
    digest: "0".repeat(64),
  });
  let reads = 0;
  if (withScripts) {
    webContents.executeJavaScriptInIsolatedWorld = async () => JSON.stringify(snapshots[Math.min(reads++, snapshots.length - 1)]);
  }
  return { adapter, sent, observation };
}

const run = (adapter, observation, action) =>
  adapter.execute({ observationId: observation.id, ...action }, { documentEpoch: observation.documentEpoch });

test("Enter that changes nothing is uncertain, not ok", async () => {
  const { adapter, observation } = await adapterReady([page]);
  const result = await run(adapter, observation, { type: "press_key", key: "Enter" });
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
});

test("Enter that clears the input is ok and reports what changed", async () => {
  const { adapter, observation } = await adapterReady([page, page, { ...page, valueLength: 0 }]);
  const result = await run(adapter, observation, { type: "press_key", key: "Enter" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.effect, { observed: true, changed: ["valueLength"] });
});

test("click_at that changes the page is ok with an effect", async () => {
  const { adapter, observation } = await adapterReady([page, { ...page, nodes: 12 }]);
  const result = await run(adapter, observation, { type: "click_at", x: 0.5, y: 0.5 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.effect.changed, ["nodes"]);
});

test("type_at that changes nothing is uncertain", async () => {
  const { adapter, observation } = await adapterReady([page]);
  const result = await run(adapter, observation, { type: "type_at", x: 0.5, y: 0.5, text: "hi" });
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
});

test("Tab is not checked for an effect", async () => {
  const { adapter, observation } = await adapterReady([page]);
  const result = await run(adapter, observation, { type: "press_key", key: "Tab" });
  assert.deepEqual(result, { status: "ok" });
});

test("a page object without script execution keeps the old behavior", async () => {
  const { adapter, observation, sent } = await adapterReady([page], { withScripts: false });
  const result = await run(adapter, observation, { type: "press_key", key: "Enter" });
  assert.deepEqual(result, { status: "ok" });
  assert.ok(sent.length > 0);
});

test("a failed backend pre-action snapshot must not dispatch side effects", async () => {
  const { adapter, observation, sent } = await adapterReady([null]);
  const result = await run(adapter, observation, { type: "click_at", x: 0.5, y: 0.5 });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "effect_unverifiable");
  assert.equal(sent.length, 0);
});
