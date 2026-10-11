"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDomOutline, resolveOutlineTarget, signatureOf } = require("../main/harness/dom-outline");

const elements = [
  { elementId: "0", role: "textbox", name: 'Email "work"', inputType: "email", depth: 1 },
  { elementId: "1", role: "button", name: "Sign in", depth: 2 },
  { elementId: "2", role: "button", name: "Broken", disabled: true },
  { elementId: "3", role: "link", name: "Covered", }
];
const geometry = [
  { elementId: "0", x: 0.1, y: 0.2, w: 0.4, h: 0.05 },
  { elementId: "1", x: 0.1, y: 0.3, w: 0.2, h: 0.04 },
  { elementId: "2", x: 0.1, y: 0.4, w: 0.2, h: 0.04 },
  { elementId: "3", x: 0.1, y: 0.5, w: 0.2, h: 0.04, covered: true },
];

test("renders an indexed coordinate outline; role and name stay in elements", () => {
  const { text, entries, targets } = buildDomOutline(elements, geometry);
  const lines = text.split("\n");
  assert.equal(entries, 4);
  assert.match(lines[0], /^\[0\] \tat 0\.300,0\.225 size 0\.400x0\.050 \[type=email\]$/);
  assert.match(lines[1], /^\[1\] \t\tat 0\.200,0\.320 size 0\.200x0\.040$/);
  assert.match(lines[2], /\[disabled\]$/);
  assert.match(lines[3], /\[covered\]$/);
  assert.equal(text.includes("Email work"), false, "a name is never sent twice (elements carries it)");
  assert.equal(text.includes("Sign in"), false);
  assert.equal(targets.length, 4);
  assert.equal(targets[0].name, "Email work", "the host-side target list still carries role/name for hit-testing");
});

test("marks controls that appeared since the previous observation, and nothing when there is no previous", () => {
  const first = buildDomOutline(elements, geometry);
  const second = buildDomOutline(elements, geometry, { previousSignatures: first.signatures });
  assert.equal(second.text.includes("*"), false, "unchanged controls are not marked new");

  const moved = geometry.map((box) => (box.elementId === "1" ? { ...box, y: 0.35 } : box));
  const third = buildDomOutline(elements, moved, { previousSignatures: first.signatures });
  const newLines = third.text.split("\n").filter((line) => line.startsWith("*"));
  assert.equal(newLines.length, 1);
  assert.match(newLines[0], /^\*\[1\]/);
});

test("signatureOf changes when role, name or bounds change", () => {
  const box = { x: 0, y: 0, w: 0.1, h: 0.1 };
  const base = signatureOf({ role: "button", name: "Go" }, box);
  assert.notEqual(base, signatureOf({ role: "link", name: "Go" }, box));
  assert.notEqual(base, signatureOf({ role: "button", name: "Stop" }, box));
  assert.notEqual(base, signatureOf({ role: "button", name: "Go" }, { ...box, x: 0.2 }));
  assert.equal(base, signatureOf({ role: "button", name: "Go", disabled: true }, box), "display-only fields do not change identity");
});

test("scrollable distances are bounded and only positive axes are printed", () => {
  const [scrolled] = buildDomOutline([
    { elementId: "0", role: "button", name: "Feed", scrollable: { up: 120, down: 48000, left: 0, right: -5 } },
  ], [{ elementId: "0", x: 0, y: 0, w: 0.1, h: 0.1 }]).text.split("\n");
  assert.match(scrolled, /scrollable=\[up:120,down:48000\]$/);
  const overflow = buildDomOutline([{ elementId: "0", role: "div", name: "x", scrollable: { down: Infinity } }], [{ elementId: "0", x: 0, y: 0, w: 0.1, h: 0.1 }]);
  assert.equal(overflow.text.includes("scrollable"), false, "non-finite distances are dropped");
});

test("respects the entry and byte budget", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ elementId: String(index), role: "button", name: `b${index}` }));
  const boxes = many.map((element, index) => ({ elementId: element.elementId, x: 0, y: index / 200, w: 0.1, h: 0.004 }));
  const byEntries = buildDomOutline(many, boxes, { maxEntries: 5 });
  assert.equal(byEntries.entries, 5);
  const byBytes = buildDomOutline(many, boxes, { maxBytes: 200 });
  assert.ok(byBytes.entries > 0 && Buffer.byteLength(byBytes.text, "utf8") <= 200);
});

test("sparse and actionable counts follow the coordinate-action contract", () => {
  const onlyText = buildDomOutline([{ elementId: "0", role: "heading", name: "Title" }], [{ elementId: "0", x: 0, y: 0, w: 0.5, h: 0.05 }]);
  assert.equal(onlyText.actionable, 0);
  assert.equal(onlyText.sparse, true);
  const two = buildDomOutline(elements.slice(0, 2), geometry.slice(0, 2));
  assert.equal(two.actionable, 2);
  assert.equal(two.sparse, false);
  const disabledOnly = buildDomOutline([elements[2]], [geometry[2]]);
  assert.equal(disabledOnly.actionable, 0);
  assert.equal(disabledOnly.sparse, true);
});

test("drops boxes without a matching element, zero size, or out-of-range coordinates", () => {
  const { entries } = buildDomOutline(elements, [
    { elementId: "9", x: 0, y: 0, w: 0.1, h: 0.1 },
    { elementId: "0", x: 0, y: 0, w: 0, h: 0.1 },
    { elementId: "1", x: -1, y: 0, w: 0.1, h: 0.1 },
    { elementId: "2", x: 0, y: 0, w: 2, h: 0.1 },
    null,
  ]);
  assert.equal(entries, 0);
});

test("resolveOutlineTarget picks the smallest containing box", () => {
  const outer = { x: 0, y: 0, w: 1, h: 1 };
  const inner = { x: 0.4, y: 0.4, w: 0.1, h: 0.1 };
  assert.equal(resolveOutlineTarget([outer, inner], 0.45, 0.45), inner);
  assert.equal(resolveOutlineTarget([outer, inner], 0.05, 0.05), outer);
  assert.equal(resolveOutlineTarget([outer], 1.5, 0.5), null);
});
