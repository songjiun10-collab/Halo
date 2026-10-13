"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isPaymentControl } = require("../main/harness/effect-classifier");
const { labels } = require("../fixtures/payment-button-labels.json");

const detect = (name, extra = {}) => isPaymentControl({ role: "button", name, covered: false, disabled: false, ...extra });

test("every final checkout label in the corpus is recognised as a payment (nothing missed)", () => {
  const missed = labels.filter((l) => l.payment && !detect(l.label)).map((l) => l.label);
  assert.deepEqual(missed, []);
});

test("nothing that only moves toward checkout, edits settings or shows history is taken for a payment (no false positives)", () => {
  const wrong = labels.filter((l) => !l.payment && detect(l.label)).map((l) => l.label);
  assert.deepEqual(wrong, []);
});

test("the corpus is big enough to mean something, in three languages, with both kinds of label", () => {
  const payments = labels.filter((l) => l.payment);
  assert.ok(payments.length >= 30 && labels.length - payments.length >= 60);
  assert.ok(labels.some((l) => /[가-힣]/.test(l.label)) && labels.some((l) => /[ぁ-んァ-ン]/.test(l.label)) && labels.some((l) => /^[A-Za-z]/.test(l.label)));
  assert.equal(new Set(labels.map((l) => l.label)).size, labels.length, "no duplicate labels");
});

test("case, spacing and role: links count like buttons, a disabled or covered control never does", () => {
  assert.equal(detect("PLACE YOUR ORDER"), true);
  assert.equal(detect("  Place   your  order "), true);
  assert.equal(isPaymentControl({ role: "link", name: "Place your order", covered: false, disabled: false }), true);
  assert.equal(isPaymentControl({ role: "textbox", name: "Place your order", covered: false, disabled: false }), false);
  assert.equal(detect("Place your order", { disabled: true }), false);
  assert.equal(detect("Place your order", { covered: true }), false);
  assert.equal(isPaymentControl(null), false);
});

test("a name that also reads as a transfer or an account removal is never a payment, even with payment words", () => {
  for (const name of ["Transfer funds and pay now", "Delete account - complete order", "송금하기 결제하기"]) assert.equal(detect(name), false, name);
});
