"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runChecklist } = require("../main/harness/completion-checklist");

const base = { goalText: "Find the price of Widget on shop", answer: "Widget costs 120 dollars, see https://shop.example/widget", observedTexts: ["Widget price 120 dollars"], observedUrls: ["https://shop.example/widget", "https://review.example/w"], observation: { url: "https://shop.example/widget", title: "Widget", text: "Widget 120" } };

test("without minScore every failure blocks, and the score is reported", () => {
  const ok = runChecklist(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.score, 7);
  const bad = runChecklist({ ...base, answer: "Widget costs 999 dollars" });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((f) => f.code === "value_not_on_opened_pages"));
});

test("with minScore a soft failure is submitted when the score is high enough", () => {
  const r = runChecklist({ ...base, answer: "Widget costs 999 dollars, see https://shop.example/widget", minScore: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.score, 6);
});

test("with minScore a thin answer below the threshold is sent back to investigate", () => {
  const r = runChecklist({ ...base, observedUrls: ["https://shop.example/widget"], answer: "Widget costs 999 dollars", minScore: 6 });
  assert.equal(r.ok, false);
  assert.ok(r.failures.every((f) => /investigate more/.test(f.guidance)));
  assert.ok(r.score < 6);
});

test("hard failures block regardless of the score", () => {
  for (const answer of ["", "I could not find it"]) {
    const r = runChecklist({ ...base, answer, minScore: 1 });
    assert.equal(r.ok, false);
  }
  const blocked = runChecklist({ ...base, observation: { url: "https://shop.example/", title: "Access denied", text: "Access denied" }, minScore: 1 });
  assert.equal(blocked.ok, false);
});
