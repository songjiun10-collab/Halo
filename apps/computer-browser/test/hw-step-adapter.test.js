"use strict";

// hw_step through the real BrowserAdapter: the host authorizes the *resolved*
// element (never the locator string), so this drives runHwStep with a scripted
// page inside the adapter's execute() path.

const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const PAGE = { url: "https://example.test/", title: "t", nodes: 5, textLength: 10, focus: "", valueLength: -1 };

function fakeWc({ resolves = [], snapshots = [PAGE], holds = false, text = { ok: true, text: "" } } = {}) {
  const events = [];
  const texts = [];
  let snap = 0;
  const wc = {
    getURL: () => PAGE.url,
    sendInputEvent: (event) => events.push(event),
    insertText: (text) => texts.push(text),
    selectAll: () => {},
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("halowrightGetText")) return JSON.stringify(text);
      if (code.includes("location.href")) return JSON.stringify(snapshots[Math.min(snap++, snapshots.length - 1)]);
      if (code.includes("scrollingElement")) return JSON.stringify({ y: 0, w: 800, h: 600 });
      if (code.includes("isContentEditable")) return holds;
      return JSON.stringify(resolves.shift() ?? { status: "not_found" });
    },
  };
  return { wc, events, texts };
}

const adapter = (wc) => new BrowserAdapter({ view: { webContents: wc }, permissionMode: "full" });

test("hw_step click: resolve, authorize the element, dispatch once, report the observed effect", async () => {
  const hit = { status: "resolved", x: 10, y: 20, tag: "BUTTON", role: "button", name: "save" };
  const { wc, events } = fakeWc({ resolves: [hit, hit], snapshots: [PAGE, { ...PAGE, title: "after" }] });
  const result = await adapter(wc).execute({ type: "hw_step", step: { op: "click", locator: { role: "button", name: "Save" } } });
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((e) => e.type), ["mouseMove", "mouseDown", "mouseUp"]);
});

test("hw_step fill: typing happens only after authorization and the field must hold the text", async () => {
  const hit = { status: "resolved", x: 3, y: 4, tag: "INPUT", role: "textbox", name: "title" };
  const { wc, texts } = fakeWc({ resolves: [hit, hit], snapshots: [PAGE, { ...PAGE, valueLength: 2 }], holds: true });
  const result = await adapter(wc).execute({ type: "hw_step", step: { op: "fill", locator: { role: "textbox", name: "Title" }, text: "hi" } });
  assert.equal(result.status, "ok");
  assert.deepEqual(texts, ["hi"]);
});

test("hw_step fill into a password field is refused before any input", async () => {
  const hit = { status: "resolved", x: 3, y: 4, tag: "INPUT", role: "textbox", name: "password", inputType: "password" };
  const { wc, texts, events } = fakeWc({ resolves: [hit, hit] });
  const result = await adapter(wc).execute({ type: "hw_step", step: { op: "fill", locator: { label: "Password" }, text: "secret" } });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "not_authorized");
  assert.deepEqual(texts, []);
  assert.deepEqual(events, []);
});

test("hw_step click on an irreversible control is refused even though the locator is not an elementId", async () => {
  const hit = { status: "resolved", x: 1, y: 2, tag: "BUTTON", role: "button", name: "delete my account" };
  const { wc, events } = fakeWc({ resolves: [hit, hit] });
  const result = await adapter(wc).execute({ type: "hw_step", step: { op: "click", locator: { role: "button", name: "Delete my account" } } });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "not_authorized");
  assert.deepEqual(events, []);
});

test("hw_step refuses a malformed step and an ambiguous locator without touching the page", async () => {
  const { wc, events } = fakeWc();
  const bad = await adapter(wc).execute({ type: "hw_step", step: { op: "eval" } });
  assert.equal(bad.status, "failed");
  assert.equal(bad.errorCode, "invalid_op");
  assert.deepEqual(events, []);

  const ambiguousWc = fakeWc({ resolves: [{ status: "ambiguous", count: 2, candidates: ["button#a", "button#b"] }] });
  const ambiguous = await adapter(ambiguousWc.wc).execute({ type: "hw_step", step: { op: "click", locator: { role: "button" } } });
  assert.equal(ambiguous.status, "failed");
  assert.equal(ambiguous.errorCode, "locator_ambiguous");
  assert.deepEqual(ambiguous.candidates, ["button#a", "button#b"]);
  assert.deepEqual(ambiguousWc.events, []);
});

test("hw_step honors the Intent Lock as the action it performs (click), before any page contact", async () => {
  const engine = adapter(fakeWc().wc);
  engine.setIntentLock({ rules: [{ kind: "deny_action", action: "click" }] });
  const result = await engine.execute({ type: "hw_step", step: { op: "click", locator: { role: "button", name: "Search" } } });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "intent_lock_denied");
});

test("hw_step get_text reads the resolved element and sends no input", async () => {
  const hit = { status: "resolved", x: 10, y: 20, tag: "H1", role: "heading", name: "refund policy", stable: true };
  const { wc, events, texts } = fakeWc({ resolves: [hit], text: { ok: true, text: "Refund policy" } });
  const result = await adapter(wc).execute({ type: "hw_step", step: { op: "get_text", locator: { testid: "policy-heading" } } });
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Refund policy");
  assert.equal(result.truncated, false);
  assert.deepEqual(events, []);
  assert.deepEqual(texts, []);
});

test("hw_step get_text honors the Intent Lock as a find", async () => {
  const engine = adapter(fakeWc().wc);
  engine.setIntentLock({ rules: [{ kind: "deny_action", action: "find" }] });
  const result = await engine.execute({ type: "hw_step", step: { op: "get_text", locator: { text: "x" } } });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "intent_lock_denied");
});
