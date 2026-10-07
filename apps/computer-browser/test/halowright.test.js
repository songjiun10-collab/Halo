"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runHwStep } = require("../main/harness/halowright");

// A scripted page: resolve answers come from `resolves`, snapshots from `snapshots`.
function fakePage({ resolves, snapshots }) {
  const events = [];
  const texts = [];
  const calls = [];
  let snap = 0;
  const wc = {
    sendInputEvent: (e) => { events.push(e); calls.push(e.type); },
    insertText: (t) => { texts.push(t); calls.push("insertText"); },
    selectAll: () => { calls.push("selectAll"); },
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("location.href")) return JSON.stringify(snapshots[Math.min(snap++, snapshots.length - 1)]);
      return JSON.stringify(resolves.shift() ?? { status: "not_found" });
    },
  };
  return { wc, events, texts, calls };
}

const page = { url: "https://p.test/", title: "t", nodes: 5, textLength: 10, focus: "", valueLength: -1 };
const hit = { status: "resolved", x: 10, y: 20, tag: "BUTTON" };
const opts = { sleep: async () => {}, timeoutMs: 500 };

test("click resolves, clicks the center and is ok when the page changes", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, title: "after" }] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((e) => e.type), ["mouseMove", "mouseDown", "mouseUp"]);
  assert.deepEqual(result.effect, { observed: true, changed: ["title"] });
});

test("a click that changes nothing is uncertain and is not repeated", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page] });
  const result = await runHwStep(wc, { locator: { text: "Go" }, op: "click" }, opts);
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
  assert.equal(events.filter((e) => e.type === "mouseDown").length, 1);
});

test("an ambiguous locator fails with candidates and sends no input", async () => {
  const { wc, events } = fakePage({ resolves: [{ status: "ambiguous", count: 2, candidates: ["button#a:save", "button#b:save"] }], snapshots: [page] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "locator_ambiguous");
  assert.deepEqual(result.candidates, ["button#a:save", "button#b:save"]);
  assert.equal(events.length, 0);
});

test("a target that never becomes actionable fails with the reason", async () => {
  const { wc, events } = fakePage({ resolves: Array(20).fill({ status: "not_actionable", reason: "covered" }), snapshots: [page] });
  const result = await runHwStep(wc, { locator: { text: "Go" }, op: "click" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "not_actionable_covered");
  assert.equal(events.length, 0);
});

test("fill clicks the field, selects, inserts and checks the value changed", async () => {
  const { wc, texts } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, valueLength: 5 }] });
  const result = await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "a@b.c" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(texts, ["a@b.c"]);
});

test("malformed steps fail before touching the page", async () => {
  const { wc, events } = fakePage({ resolves: [], snapshots: [page] });
  for (const step of [null, { op: "click" }, { locator: { text: "x" }, op: "drag" }, { locator: { text: "x" }, op: "fill" }, { locator: { text: "x" }, op: "fill", text: "y".repeat(5000) }, { locator: { css: "#a" }, op: "click" }]) {
    const result = await runHwStep(wc, step, opts);
    assert.equal(result.status, "failed");
    assert.match(result.errorCode, /^invalid_/);
  }
  assert.equal(events.length, 0);
});

test("an unreadable before-snapshot fails before any input", async () => {
  const { wc, events, texts } = fakePage({ resolves: [hit, hit, hit, hit], snapshots: [page] });
  wc.executeJavaScriptInIsolatedWorld = ((orig) => async (w, s) => (s[0].code.includes("location.href") ? "not json" : orig(w, s)))(wc.executeJavaScriptInIsolatedWorld);
  for (const step of [{ locator: { role: "button", name: "Save" }, op: "click" }, { locator: { role: "button", name: "Save" }, op: "fill", text: "x" }]) {
    const result = await runHwStep(wc, step, opts);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "effect_unverifiable");
  }
  assert.equal(events.length, 0);
  assert.equal(texts.length, 0);
});

test("fill without insertText fails before any input", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page] });
  delete wc.insertText;
  const result = await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "a" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "input_unsupported");
  assert.equal(events.length, 0);
});

test("fill where only focus changes is uncertain", async () => {
  const { wc } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, focus: "INPUT#e" }] });
  const result = await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "a" }, opts);
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
});

test("fill performs click, selectAll, insertText in order", async () => {
  const { wc, calls } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, valueLength: 1 }] });
  await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "a" }, opts);
  assert.deepEqual(calls, ["mouseMove", "mouseDown", "mouseUp", "selectAll", "insertText"]);
});

test("fill with empty text clearing a field is ok", async () => {
  const { wc } = fakePage({ resolves: [hit, hit], snapshots: [{ ...page, valueLength: 5 }, { ...page, valueLength: 0 }] });
  const result = await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "" }, opts);
  assert.equal(result.status, "ok");
});

test("a missing element fails with locator_not_found", async () => {
  const { wc, events } = fakePage({ resolves: [], snapshots: [page] });
  const result = await runHwStep(wc, { locator: { text: "Nope" }, op: "click" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "locator_not_found");
  assert.equal(events.length, 0);
});
