"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAction, runLoop, callAnthropic } = require("../integration/vanilla-mind2web-bench.ts");

const fakeView = () => {
  const events = [];
  const wc = {
    capturePage: async () => ({ getSize: () => ({ width: 720, height: 450 }), encodeJpegAsync: async () => Buffer.from("jpg") }),
    executeJavaScript: async () => "page text",
    getURL: () => "https://shop.example/", getTitle: () => "Shop",
    sendInputEvent: (e) => events.push(e), insertText: (t) => events.push({ insert: t }),
    loadURL: async (u) => events.push({ load: u }),
  };
  return { view: { webContents: wc }, events };
};
const reply = (input) => ({ content: [{ type: "tool_use", input }], usage: { input_tokens: 10, output_tokens: 2 } });
const task = { task_id: "t1", confirmed_task: "Find a thing" };
const limits = { maxSteps: 5, maxActiveMs: 60000 };

test("parseAction accepts well-formed actions and rejects unusable ones", () => {
  assert.deepEqual(parseAction({ type: "click", x: 1, y: 2 }), { type: "click", x: 1, y: 2 });
  assert.deepEqual(parseAction({ type: "scroll", dy: 99999 }), { type: "scroll", dy: 3000 });
  assert.equal(parseAction({ type: "navigate", url: "file:///etc/passwd" }), null);
  assert.equal(parseAction({ type: "navigate", url: "javascript:alert(1)" }), null);
  assert.equal(parseAction({ type: "key", key: "F12" }), null);
  assert.equal(parseAction({ type: "click", x: "1", y: 2 }), null);
  assert.equal(parseAction(null), null);
  assert.equal(parseAction({ type: "finish", answer: "ok" }).answer, "ok");
});

test("runLoop scales clicks to the viewport, sums usage, and stops on finish", async () => {
  const { view, events } = fakeView();
  const replies = [reply({ type: "click", x: 10, y: 20 }), reply({ type: "finish", answer: "done" })];
  const out = await runLoop({ view, task, model: "m", callModel: async () => replies.shift(), limits });
  assert.equal(out.finished, true);
  assert.equal(out.finalAnswer, "done");
  assert.equal(out.calls, 2);
  assert.deepEqual(out.usages, [{ inputTokens: 10, outputTokens: 2 }, { inputTokens: 10, outputTokens: 2 }]);
  assert.deepEqual(events.find((e) => e.type === "mouseDown"), { type: "mouseDown", x: 20, y: 40, button: "left", clickCount: 1 });
});

test("runLoop stops at the step limit without finishing", async () => {
  const { view } = fakeView();
  const out = await runLoop({ view, task, model: "m", callModel: async () => reply({ type: "back" }), limits: { maxSteps: 2, maxActiveMs: 60000 } });
  assert.equal(out.finished, false);
  assert.equal(out.calls, 2);
});

test("runLoop records invalid actions and model errors instead of throwing", async () => {
  const { view } = fakeView();
  const bad = await runLoop({ view, task, model: "m", callModel: async () => reply({ type: "navigate", url: "file:///x" }), limits: { maxSteps: 2, maxActiveMs: 60000 } });
  assert.deepEqual(bad.history, ["invalid_action", "invalid_action"]);
  const err = await runLoop({ view, task, model: "m", callModel: async () => { throw Object.assign(new Error("x"), { code: "model_http_401" }); }, limits });
  assert.equal(err.errorCode, "model_http_401");
  assert.equal(err.finished, false);
});

test("callAnthropic retries a 429 once then returns, and fails fast on 401", async () => {
  let n = 0;
  const ok = await callAnthropic({}, "k", async () => (++n === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => ({ ok: 1 }) }));
  assert.deepEqual(ok, { ok: 1 });
  await assert.rejects(callAnthropic({}, "k", async () => ({ ok: false, status: 401 })), { code: "model_http_401" });
});
