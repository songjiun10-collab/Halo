"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runHwStep, validateStep, gateActionFor } = require("../main/harness/halowright");

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
const opts = { sleep: async () => {}, timeoutMs: 500, authorize: () => true };

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

test("a step without a host authorize callback never touches the page", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, title: "after" }] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, { sleep: async () => {}, timeoutMs: 500 });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "authorization_required");
  assert.equal(events.length, 0);
});

test("a denied authorization fails closed and sends no input", async () => {
  for (const step of [{ locator: { role: "button", name: "Save" }, op: "click" }, { locator: { label: "Email" }, op: "fill", text: "a" }]) {
    const { wc, events, texts } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, valueLength: 5 }] });
    const result = await runHwStep(wc, step, { sleep: async () => {}, timeoutMs: 500, authorize: () => false });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "not_authorized");
    assert.equal(events.length, 0);
    assert.equal(texts.length, 0);
  }
});

test("authorize sees the resolved target and runs before any input", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, title: "after" }] });
  let seen = null;
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, { sleep: async () => {}, timeoutMs: 500, authorize: (request) => { assert.equal(events.length, 0); seen = request; return true; } });
  assert.equal(result.status, "ok");
  assert.deepEqual(seen, { step: { op: "click" }, target: { x: 10, y: 20, tag: "BUTTON" } });
  assert.deepEqual(events.map((e) => e.type), ["mouseMove", "mouseDown", "mouseUp"]);
});

test("an authorize callback that throws fails closed", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, title: "after" }] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, { sleep: async () => {}, timeoutMs: 500, authorize: () => { throw new Error("gate unavailable"); } });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "not_authorized");
  assert.equal(events.length, 0);
});

// ---- bundle 1 ops: hover, press, check/uncheck, select, scroll ----
function scriptedPage({ resolves = [], snapshots = [page], select, holds = false, text = { ok: true, text: "" }, scrolls = [{ y: 0, w: 800, h: 600 }] }) {
  const events = [];
  let snap = 0, scroll = 0;
  const wc = {
    sendInputEvent: (e) => events.push(e),
    insertText() {}, selectAll() {},
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("halowrightGetText")) return JSON.stringify(text);
      if (code.includes("location.href")) return JSON.stringify(snapshots[Math.min(snap++, snapshots.length - 1)]);
      if (code.includes("scrollingElement")) return JSON.stringify(scrolls[Math.min(scroll++, scrolls.length - 1)]);
      if (code.includes("sel.selectedIndex")) return JSON.stringify(select);
      if (code.includes("isContentEditable")) return holds;
      return JSON.stringify(resolves.shift() ?? { status: "not_found" });
    },
  };
  return { wc, events };
}
const stable = { ...hit, stable: true };

test("hover moves the pointer only and is ok without a page effect", async () => {
  const { wc, events } = scriptedPage({ resolves: [stable] });
  const result = await runHwStep(wc, { locator: { text: "Menu" }, op: "hover" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((e) => e.type), ["mouseMove"]);
});

test("press sends only an allowlisted key to the focused element and checks the effect", async () => {
  const { wc, events } = scriptedPage({ snapshots: [page, { ...page, url: "https://p.test/next" }] });
  const result = await runHwStep(wc, { op: "press", key: "Enter" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((e) => e.type), ["keyDown", "char", "keyUp"]);
  for (const key of ["F12", "Control", 5, undefined]) {
    const bad = await runHwStep(scriptedPage({}).wc, { op: "press", key }, opts);
    assert.equal(bad.errorCode, "invalid_key");
  }
});

test("check clicks only when the state differs and confirms the new state; already-checked sends nothing", async () => {
  const off = { ...stable, tag: "INPUT", checked: false }, on = { ...off, checked: true };
  const first = scriptedPage({ resolves: [off, on] });
  assert.equal((await runHwStep(first.wc, { locator: { label: "Agree" }, op: "check" }, opts)).status, "ok");
  assert.equal(first.events.filter((e) => e.type === "mouseDown").length, 1);
  const already = scriptedPage({ resolves: [on] });
  assert.equal((await runHwStep(already.wc, { locator: { label: "Agree" }, op: "check" }, opts)).status, "ok");
  assert.equal(already.events.length, 0);
  const stuck = scriptedPage({ resolves: [off, off] });
  assert.equal((await runHwStep(stuck.wc, { locator: { label: "Agree" }, op: "check" }, opts)).status, "uncertain");
  const plain = scriptedPage({ resolves: [stable] });
  assert.equal((await runHwStep(plain.wc, { locator: { text: "Go" }, op: "uncheck" }, opts)).errorCode, "not_checkable");
});

test("uncheck turns a checked box off", async () => {
  const on = { ...stable, tag: "INPUT", checked: true };
  const { wc } = scriptedPage({ resolves: [on, { ...on, checked: false }] });
  assert.equal((await runHwStep(wc, { locator: { label: "Agree" }, op: "uncheck" }, opts)).status, "ok");
});

test("select reports a missing option as a failure and a chosen option as ok; no pointer input is sent", async () => {
  const hitSelect = { ...stable, tag: "SELECT" };
  const good = scriptedPage({ resolves: [hitSelect], select: { ok: true, text: "Korea" } });
  assert.equal((await runHwStep(good.wc, { locator: { label: "Country" }, op: "select", value: "Korea" }, opts)).status, "ok");
  assert.equal(good.events.length, 0);
  const missing = scriptedPage({ resolves: [hitSelect], select: { ok: false, reason: "no_option" } });
  assert.equal((await runHwStep(missing.wc, { locator: { label: "Country" }, op: "select", value: "Mars" }, opts)).errorCode, "option_not_found");
  assert.equal((await runHwStep(scriptedPage({}).wc, { locator: { label: "Country" }, op: "select", value: "" }, opts)).errorCode, "invalid_value");
});

test("select embeds the model's value only as a JSON literal", async () => {
  let seen = "";
  const { wc } = scriptedPage({ resolves: [{ ...stable, tag: "SELECT" }], select: { ok: true } });
  const run = wc.executeJavaScriptInIsolatedWorld;
  wc.executeJavaScriptInIsolatedWorld = async (w, s) => { if (s[0].code.includes("sel.selectedIndex")) seen = s[0].code; return run(w, s); };
  const hostile = '"); globalThis.__pwn=1;//';
  await runHwStep(wc, { locator: { label: "Country" }, op: "select", value: hostile }, opts);
  assert.ok(seen.endsWith(`, ${JSON.stringify(hostile)})`));
  assert.equal(seen.split(JSON.stringify(hostile)).length, 2);
});

test("scroll is ok only when the page position actually moved, and bounds dy", async () => {
  const moved = scriptedPage({ scrolls: [{ y: 0, w: 800, h: 600 }, { y: 0, w: 800, h: 600 }, { y: 400, w: 800, h: 600 }] });
  const ok = await runHwStep(moved.wc, { op: "scroll", dy: 400 }, opts);
  assert.equal(ok.status, "ok");
  const wheel = moved.events.find((e) => e.type === "mouseWheel");
  assert.deepEqual([wheel.x, wheel.y, wheel.deltaY], [400, 300, -400]);
  const still = scriptedPage({});
  assert.equal((await runHwStep(still.wc, { op: "scroll", dy: 400 }, opts)).status, "uncertain");
  for (const dy of [0, 5001, 1.5, "9"]) assert.equal((await runHwStep(scriptedPage({}).wc, { op: "scroll", dy }, opts)).errorCode, "invalid_scroll");
});

test("every new op fails closed without authorization and sends nothing", async () => {
  for (const step of [
    { op: "hover", locator: { text: "x" } }, { op: "press", key: "Tab" }, { op: "check", locator: { label: "x" } },
    { op: "uncheck", locator: { label: "x" } }, { op: "select", locator: { label: "x" }, value: "v" }, { op: "scroll", dy: 10 },
    { op: "get_text", locator: { text: "x" } },
  ]) {
    const { wc, events } = scriptedPage({ resolves: [{ ...stable, tag: "INPUT", checked: false }], text: { ok: true, text: "x" } });
    assert.equal((await runHwStep(wc, step, { ...opts, authorize: undefined })).errorCode, "authorization_required");
    assert.equal((await runHwStep(wc, step, { ...opts, authorize: () => false })).errorCode, "not_authorized");
    assert.equal(events.length, 0);
  }
});

test("fill is confirmed by the field holding the text even when a previous field had the same value length", async () => {
  // Focus moved from a field whose value had the same length, so the length-based snapshot diff sees no valueLength change.
  const same = { ...page, focus: "INPUT#ag", valueLength: 2 };
  const withFocusOnly = scriptedPage({ resolves: [stable], snapshots: [same, { ...same, focus: "INPUT#e" }], holds: true });
  assert.equal((await runHwStep(withFocusOnly.wc, { locator: { placeholder: "Query" }, op: "fill", text: "hi" }, opts)).status, "ok");
  const notTyped = scriptedPage({ resolves: [stable], snapshots: [same, { ...same, focus: "INPUT#e" }], holds: false });
  assert.equal((await runHwStep(notTyped.wc, { locator: { placeholder: "Query" }, op: "fill", text: "hi" }, opts)).status, "uncertain");
});

test("get_text reads the element's text and sends no input", async () => {
  const { wc, events } = scriptedPage({ resolves: [stable], text: { ok: true, text: "Refund policy" } });
  const result = await runHwStep(wc, { op: "get_text", locator: { role: "heading", name: "Refund policy" } }, opts);
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Refund policy");
  assert.equal(result.truncated, false);
  assert.equal(events.length, 0);
});

test("get_text truncates to 4096 UTF-8 bytes without splitting a character", async () => {
  const long = "é".repeat(3000);
  const { wc } = scriptedPage({ resolves: [stable], text: { ok: true, text: long } });
  const result = await runHwStep(wc, { op: "get_text", locator: { text: "x" } }, opts);
  assert.equal(result.status, "ok");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 4096);
});

test("get_text needs a locator and reports an unreadable element as uncertain", async () => {
  assert.equal((await runHwStep(scriptedPage({}).wc, { op: "get_text" }, opts)).errorCode, "invalid_locator");
  const { wc, events } = scriptedPage({ resolves: [stable], text: { ok: false, text: "" } });
  const result = await runHwStep(wc, { op: "get_text", locator: { text: "x" } }, opts);
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "text_unreadable");
  assert.equal(events.length, 0);
});

// -- the host-side shape gate for hw_step (validateStep / gateActionFor) ------

test("validateStep bounds a hw_step the same way runHwStep does, and gateActionFor maps every op", () => {
  assert.deepEqual(validateStep({ op: "click", locator: { role: "button", name: "Save" } }), { ok: true, step: { op: "click", locator: { role: "button", name: "Save" } } });
  assert.deepEqual(validateStep({ op: "get_text", locator: { testid: "price" } }), { ok: true, step: { op: "get_text", locator: { testid: "price" } } });
  for (const [step, code] of [
    [null, "invalid_step"],
    ["click", "invalid_step"],
    [{ op: "eval", locator: { text: "x" } }, "invalid_op"],
    [{ op: "fill", locator: { label: "Email" }, text: "x".repeat(4097) }, "invalid_text"],
    [{ op: "press", key: "F5" }, "invalid_key"],
    [{ op: "select", locator: { role: "combobox" }, value: "" }, "invalid_value"],
    [{ op: "scroll", dy: 0 }, "invalid_scroll"],
    [{ op: "click", locator: {} }, "invalid_locator"],
    [{ op: "get_text" }, "invalid_locator"],
  ]) {
    const out = validateStep(step);
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, code);
  }
  for (const [op, gate] of [["click", "click"], ["fill", "type"], ["press", "press_key"], ["scroll", "scroll"], ["check", "click"], ["uncheck", "click"], ["select", "click"], ["hover", "scroll"], ["get_text", "find"]]) {
    assert.equal(gateActionFor(op), gate);
  }
  assert.equal(gateActionFor("nope"), null);
  assert.equal(gateActionFor(7), null);
});
