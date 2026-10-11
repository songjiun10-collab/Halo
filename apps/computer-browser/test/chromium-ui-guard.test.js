"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { installChromiumUiGuard } = require("../main/harness/chromium-ui-guard");

test("Chromium UI guard blocks cross-origin document navigation and renderer popups", async () => {
  const events = new Set();
  const sent = [];
  const transport = {
    onEvent(callback) { events.add(callback); return () => events.delete(callback); },
    async send(method, params, sessionId) { sent.push({ method, params, sessionId }); return {}; },
  };
  const dispose = installChromiumUiGuard(transport, { origin: "http://127.0.0.1:43127", sessionId: "ui-session", targetId: "ui-target" });
  const emit = (method, params, session = "ui-session") => [...events].forEach((callback) => callback(method, params, session));
  emit("Fetch.requestPaused", { requestId: "safe", request: { url: "http://127.0.0.1:43127/settings" }, resourceType: "Document" });
  emit("Fetch.requestPaused", { requestId: "unsafe", request: { url: "https://example.com/" }, resourceType: "Document" });
  emit("Target.targetCreated", { targetInfo: { targetId: "popup", openerId: "ui-target" } }, "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some(({ method, params }) => method === "Fetch.continueRequest" && params.requestId === "safe"));
  assert.ok(sent.some(({ method, params }) => method === "Fetch.failRequest" && params.requestId === "unsafe"));
  assert.ok(sent.some(({ method, params }) => method === "Target.closeTarget" && params.targetId === "popup"));
  dispose();
  assert.equal(events.size, 0);
});

test("a stray new-tab window is closed and Halo is brought back to the front", async () => {
  const sent = [];
  let listener;
  const transport = { send: async (method, params) => { sent.push([method, params]); return {}; }, onEvent: (cb) => { listener = cb; return () => undefined; } };
  installChromiumUiGuard(transport, { origin: "http://127.0.0.1:43127", sessionId: "ui-session", targetId: "ui-target" });
  listener("Target.targetCreated", { targetInfo: { targetId: "stray", type: "page", url: "chrome://newtab/" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["Target.closeTarget", { targetId: "stray" }], ["Target.activateTarget", { targetId: "ui-target" }]]);
});
