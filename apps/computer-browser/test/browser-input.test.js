"use strict";

// browser-input.js: forwarded user input for the human page surfaces. The one
// editing command that needs special routing is select-all: a synthesized raw
// key event does not reliably trigger Blink's editing command, so Cmd/Ctrl+A
// goes through the engine's selectAll() helper (same reason cdp-web-contents
// sends commands:["selectAll"]).

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateBrowserInput, dispatchBrowserInput } = require("../main/harness/browser-input");

test("Cmd/Ctrl+A performs selectAll instead of a raw key event", () => {
  let selected = 0;
  const events = [];
  const wc = { sendInputEvent: (event) => events.push(event), insertText: () => {}, selectAll: () => { selected += 1; } };

  assert.equal(dispatchBrowserInput(wc, { width: 800, height: 600 }, { type: "keyDown", key: "a", modifiers: ["meta"] }), true);
  assert.equal(selected, 1);
  assert.equal(events.length, 0, "no raw key event is sent for the chord");

  assert.equal(dispatchBrowserInput(wc, { width: 800, height: 600 }, { type: "keyDown", key: "A", modifiers: ["control"] }), true);
  assert.equal(selected, 2, "case-insensitive and control counts as the primary modifier");
});

test("plain keys and modified non-chord keys still go through sendInputEvent", () => {
  const events = [];
  const wc = { sendInputEvent: (event) => events.push(event), insertText: () => {}, selectAll: () => { throw new Error("must not run"); } };

  assert.equal(dispatchBrowserInput(wc, { width: 800, height: 600 }, { type: "keyDown", key: "a" }), true);
  assert.equal(events.at(-1).keyCode, "a");
  assert.equal(dispatchBrowserInput(wc, { width: 800, height: 600 }, { type: "keyDown", key: "a", modifiers: ["shift"] }), true);
  assert.equal(events.at(-1).modifiers[0], "shift");
});

test("a surface without selectAll still forwards the chord as a raw key event", () => {
  const events = [];
  const wc = { sendInputEvent: (event) => events.push(event), insertText: () => {} };
  assert.equal(dispatchBrowserInput(wc, { width: 800, height: 600 }, { type: "keyDown", key: "a", modifiers: ["meta"] }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].keyCode, "a");
});

test("validateBrowserInput still rejects unknown shapes", () => {
  assert.throws(() => validateBrowserInput({ type: "keyDown", key: "" }), { code: "invalid_field" });
  assert.throws(() => validateBrowserInput({ type: "eval" }), { code: "invalid_field" });
});
