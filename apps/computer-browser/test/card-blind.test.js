"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { containsCardNumber, maskCardNumbers, isCardField, blindObservation } = require("../main/harness/card-blind");

test("a Luhn-valid card number is masked down to its last four; other digit runs are left alone", () => {
  assert.equal(maskCardNumbers("카드 4111 1111 1111 1111 로 결제"), "카드 [카드번호 ••••1111] 로 결제");
  assert.equal(maskCardNumbers("4111-1111-1111-1111"), "[카드번호 ••••1111]");
  assert.equal(maskCardNumbers("주문번호 1234567890123456"), "주문번호 1234567890123456");
  assert.equal(maskCardNumbers("전화 010-1234-5678"), "전화 010-1234-5678");
  assert.equal(containsCardNumber("5555555555554444"), true);
  assert.equal(containsCardNumber("hello"), false);
});

test("card fields are recognised by label, autocomplete flag or Korean labels", () => {
  for (const name of ["Card number", "카드 번호", "CVC", "보안코드", "유효기간 MM/YY", "Expiration date"]) assert.equal(isCardField({ name }), true, name);
  assert.equal(isCardField({ name: "Search" }), false);
  assert.equal(isCardField({ name: "x", cardField: true }), true);
});

test("blindObservation hides card field values and masks numbers in text, and leaves the input untouched", () => {
  const obs = { id: "o", url: "https://shop.example/pay", text: "Saved: 4111 1111 1111 1111", elements: [
    { elementId: "1", role: "textbox", name: "Card number", value: "4111111111111111" },
    { elementId: "2", role: "textbox", name: "Search", value: "shoes" },
    { elementId: "3", role: "text", name: "Visa 4111 1111 1111 1111" },
  ] };
  const out = blindObservation(obs);
  assert.equal(out.elements[0].value, undefined);
  assert.equal(out.elements[0].valueHidden, true);
  assert.equal(out.elements[1].value, "shoes");
  assert.equal(out.elements[2].name, "Visa [카드번호 ••••1111]");
  assert.equal(out.text, "Saved: [카드번호 ••••1111]");
  assert.equal(obs.elements[0].value, "4111111111111111", "the original is not mutated");
  assert.equal(JSON.stringify(out).includes("4111111111111111"), false);
});
