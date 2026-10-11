"use strict";

// Hallucination detection, tested against the exact failure the 2026-10-07
// pilot could not measure: an answer that is well-formed, confident, and
// invented. Where `checkAnswer` needs a human to have enumerated the wrong
// values, this derives them from what the planner actually saw.
const test = require("node:test");
const assert = require("node:assert/strict");
const { canon, specificsOf, unsupportedSpecifics, groundingReport } = require("../integration/accuracy/grounding.js");

const SPECS_PAGE = "Current laptop Chip M4, display 11-inch, memory 16GB.";

test("the specific claims in an answer are extracted, not the prose", () => {
  const found = specificsOf("The chip is M4, the display is 11-inch and memory is 16GB.");
  assert.ok(found.includes(canon("M4")), JSON.stringify(found));
  assert.ok(found.includes(canon("16GB")), JSON.stringify(found));
  // "chip", "display" and "memory" are not claims about the world.
  assert.ok(!found.includes("chip"));
});

test("an answer whose specifics all appear on the observed page is grounded", () => {
  const report = groundingReport("The chip is M4, display 11-inch, memory 16GB.", [SPECS_PAGE]);
  assert.deepEqual(report.unsupported, []);
  assert.equal(report.hallucinated, false);
});

test("a fabricated model code is caught even though no blocklist named it", () => {
  // The point of the whole module: M4 Max / 24GB appear in no fixture's
  // forbidden list, and a model that invents them is still caught.
  const report = groundingReport("The chip is M4 Max with 24GB of memory.", [SPECS_PAGE]);
  assert.equal(report.hallucinated, true, JSON.stringify(report));
  assert.ok(report.unsupported.includes(canon("24GB")), JSON.stringify(report.unsupported));
  // The grounded part of the answer is not reported as fabricated, and the
  // word "Max" carries no digit so it is not a checkable specific in the first
  // place -- the fabricated VALUE is what is caught.
  assert.ok(!report.unsupported.includes(canon("M4")), JSON.stringify(report.unsupported));
});

test("a fabricated model code alone is caught", () => {
  const report = groundingReport("The chip is the M5 with 16GB of memory.", [SPECS_PAGE]);
  assert.deepEqual(report.unsupported, [canon("M5")]);
});

test("a fabricated quantity is caught", () => {
  const report = groundingReport("Headcount in Q3 was 1420 across 42 offices.", ["Headcount in Q3 was 1420."]);
  assert.deepEqual(report.unsupported, [canon("42")]);
});

test("a number that is only a substring of a real one is still unsupported", () => {
  // Regression: plain substring matching grounded "20" in "1420". A fabricated
  // figure must not be rescued by digits it happens to sit next to.
  const observed = ["Revenue was 1420 in Q3."];
  assert.equal(groundingReport("Revenue was 20 in Q3.", observed).hallucinated, true);
  assert.equal(groundingReport("Revenue was 1420 in Q3.", observed).hallucinated, false);
  // A single digit is not a claim at all, so it is not reported either way.
  assert.equal(groundingReport("It has 1 item.", observed).proseOnly, true);
});

test("spacing, case and unit plurals do not create false positives", () => {
  const observed = ["Display 11-inch, memory 16GB, weight 2.7 lb."];
  for (const paraphrase of ["11 inches", "11-INCH", "11inch", "16 gb", "16gb", "2.7 lbs", "2.7 pounds"]) {
    const report = groundingReport(`It is ${paraphrase}.`, observed);
    assert.deepEqual(report.unsupported, [], `paraphrase flagged as fabricated: ${paraphrase} -> ${JSON.stringify(report.unsupported)}`);
  }
});

test("an abstention claims nothing and so fabricates nothing", () => {
  for (const honest of ["That page was not found.", "I could not find the page.", "There is no such page."]) {
    const report = groundingReport(honest, ["Not found. No such page."]);
    assert.equal(report.hallucinated, false, honest);
    assert.equal(report.proseOnly, true, honest);
  }
});

test("with no observation at all, nothing is treated as grounded", () => {
  const report = groundingReport("The chip is M4 and memory is 16GB.", []);
  assert.equal(report.hallucinated, true, "an answer cannot be grounded in nothing");
  assert.ok(report.unsupported.length >= 2, JSON.stringify(report.unsupported));
});

test("money and bare multi-digit numbers are claims too", () => {
  const observed = ["The Standard plan has a $100/month minimum."];
  assert.deepEqual(groundingReport("It costs $100 per month.", observed).unsupported, []);
  assert.equal(groundingReport("It costs $99 per month.", observed).hallucinated, true);
  assert.equal(groundingReport("The minimum is 250.", observed).hallucinated, true);
});

test("a single digit is not treated as a claim", () => {
  // "chapter 2" style ordinals are everywhere and carry no factual assertion
  // worth failing a run over.
  assert.deepEqual(specificsOf("Open chapter 2 of 3."), []);
});

test("a version code the page does state is grounded, including one inside a sentence", () => {
  const observed = ["Chapter 2 of the walkthrough is the boss guide."];
  assert.deepEqual(groundingReport("Chapter 2 has the boss guide.", observed).unsupported, []);
});

test("the unsupported list is de-duplicated and stable", () => {
  const report = groundingReport("M5, M5, and 32GB and 32GB again.", [SPECS_PAGE]);
  assert.deepEqual(report.unsupported, [canon("M5"), canon("32GB")]);
  assert.deepEqual(groundingReport("M5, M5, and 32GB and 32GB again.", [SPECS_PAGE]).unsupported, report.unsupported);
});
