"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runChecklist, WEIGHTS, SCORE_MAX } = require("../main/harness/completion-checklist");

const base = { goalText: "Find the price of Widget on shop", answer: "Widget costs 120 dollars, see https://shop.example/widget", observedTexts: ["Widget price 120 dollars"], observedUrls: ["https://shop.example/widget", "https://review.example/w"], observation: { url: "https://shop.example/widget", title: "Widget", text: "Widget 120" } };

test("without minScore every failure blocks, and the score is reported", () => {
  const ok = runChecklist(base);
  assert.equal(ok.ok, true);
  assert.equal(SCORE_MAX, 10);
  assert.equal(ok.score, 10);
  const bad = runChecklist({ ...base, answer: "Widget costs 999 dollars" });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((f) => f.code === "value_not_on_opened_pages"));
});

test("with minScore a soft failure is submitted when the score is high enough", () => {
  const r = runChecklist({ ...base, answer: "Widget costs 999 dollars, see https://shop.example/widget", minScore: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.score, SCORE_MAX - WEIGHTS.valuesSeen);
});

test("with minScore a thin answer below the threshold is sent back to investigate", () => {
  const r = runChecklist({ ...base, observedUrls: ["https://shop.example/widget"], answer: "Widget costs 999 dollars", minScore: 7 });
  assert.equal(r.ok, false);
  assert.ok(r.failures.every((f) => /investigate more/.test(f.guidance)));
  assert.ok(r.score < 7);
});

test("hard failures block regardless of the score", () => {
  for (const answer of ["", "I could not find it"]) {
    const r = runChecklist({ ...base, answer, minScore: 1 });
    assert.equal(r.ok, false);
  }
  const blocked = runChecklist({ ...base, observation: { url: "https://shop.example/", title: "Access denied", text: "Access denied" }, minScore: 1 });
  assert.equal(blocked.ok, false);
});

test("items carry different weights: missing values costs more than missing a second site", () => {
  const noSecondSite = runChecklist({ ...base, observedUrls: ["https://shop.example/widget"] });
  const wrongValue = runChecklist({ ...base, answer: "Widget costs 999 dollars, see https://shop.example/widget" });
  assert.equal(noSecondSite.score, SCORE_MAX - WEIGHTS.twoSites);
  assert.ok(wrongValue.score < noSecondSite.score);
});

test("an answer that hands the question back, or cites only third-party sites, is blocked", () => {
  const { asksUser } = require("../main/harness/completion-checklist");
  assert.equal(asksUser("열어본 출처: x. 어떻게 진행할까요? (1) A (2) B (3) C 중 선택해 주세요?"), true);
  assert.equal(asksUser("Shall I search Amazon instead?"), true);
  assert.equal(asksUser("가격은 $20입니다. 더 필요하시면 알려 주세요."), false);
  const seen = ["Plans Standard $100 per month"];
  const urls = ["https://www.flightaware.com/commercial/aeroapi/", "https://www.softwr.com/software/flightaware"];
  const third = runChecklist({ answer: "Standard $100 per month (https://www.softwr.com/software/flightaware)", goalText: "compare plans", observedTexts: seen, observedUrls: urls });
  assert.ok(third.failures.some((f) => f.code === "official_not_cited"));
  const both = runChecklist({ answer: "Standard $100 per month (https://www.flightaware.com/commercial/aeroapi/)", goalText: "compare plans", observedTexts: seen, observedUrls: urls });
  assert.ok(!both.failures.some((f) => f.code === "official_not_cited"));
  const ask = runChecklist({ answer: "확인하지 못했습니다. 진행할까요?", goalText: "x", observedTexts: seen, observedUrls: urls });
  assert.ok(ask.failures.some((f) => f.code === "answer_asks_user"));
});
