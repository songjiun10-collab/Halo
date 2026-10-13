"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { TIERS, TIER_POLICY, tierOf, applyPrivacyTiers, containsTier3, maskTier3, isSecretField, typingBlock, rrnMatches } = require("../main/harness/pii-tiers");

test("Tier 3: card numbers and resident registration numbers are detected and fully hidden", () => {
  assert.equal(containsTier3("901231-1234567"), true);
  assert.equal(containsTier3("901231 1234567"), true);
  assert.equal(containsTier3("4111 1111 1111 1111"), true);
  assert.equal(containsTier3("주문 20241013 번호 1234567"), false);
  assert.equal(maskTier3("주민번호 901231-1234567 입니다"), "주민번호 [주민등록번호 숨김] 입니다");
  assert.equal(rrnMatches("901301-1234567").length, 0, "month 13 is not a date");
});

test("secret fields are recognised by type and by Korean or English label", () => {
  for (const el of [{ inputType: "password", name: "x" }, { name: "비밀번호" }, { name: "인증번호" }, { name: "주민등록번호 뒷자리" }, { name: "Account number" }, { name: "Card number" }, { name: "OTP" }]) assert.equal(isSecretField(el), true, JSON.stringify(el));
  assert.equal(isSecretField({ name: "Search" }), false);
  assert.equal(isSecretField({ name: "Email" }), false);
});

test("applyPrivacyTiers hides secret values, masks numbers, leaves ordinary and Tier 2 values visible", () => {
  const obs = { id: "o", text: "주민 901231-1234567 / 문의 010-1234-5678", elements: [
    { elementId: "1", role: "textbox", name: "비밀번호", inputType: "password", value: "hunter2" },
    { elementId: "2", role: "textbox", name: "Email", inputType: "email", value: "a@b.com" },
  ] };
  const out = applyPrivacyTiers(obs);
  assert.equal(out.elements[0].value, undefined);
  assert.equal(out.elements[0].valueHidden, true);
  assert.equal(out.elements[1].value, "a@b.com");
  assert.equal(out.text, "주민 [주민등록번호 숨김] / 문의 010-1234-5678");
  assert.equal(obs.elements[0].value, "hunter2");
});

test("typing: Tier 3 is always the person's; Tier 2 only when the user supplied that exact value", () => {
  assert.equal(typingBlock({ text: "hunter2", element: { name: "Password", inputType: "password" }, userText: "로그인해줘" }).tier, 3);
  assert.equal(typingBlock({ text: "901231-1234567", element: { name: "메모" }, userText: "" }).tier, 3);
  const asked = "010-1234-5678 로 배송 정보 넣어줘";
  assert.equal(typingBlock({ text: "01012345678", element: { name: "연락처" }, userText: asked }), null, "same number without dashes is still the user's");
  assert.equal(typingBlock({ text: "010-9999-8888", element: { name: "연락처" }, userText: asked }).tier, 2);
  assert.equal(typingBlock({ text: "me@x.com", element: { name: "Email" }, userText: "ME@X.COM 으로 가입해줘" }), null);
  assert.equal(typingBlock({ text: "boss@corp.com", element: { name: "Email" }, userText: "가입해줘" }).tier, 2);
  assert.equal(typingBlock({ text: "shoes", element: { name: "Search" }, userText: "" }), null);
});

test("the tier table is explicit and tierOf follows it", () => {
  assert.deepEqual(Object.keys(TIER_POLICY).sort(), ["0", "2", "3"]);
  assert.equal(TIER_POLICY[TIERS.SECRET].planner, "hidden");
  assert.equal(TIER_POLICY[TIERS.PERSONAL].planner, "visible");
  assert.equal(tierOf("4111 1111 1111 1111"), 3);
  assert.equal(tierOf("901231-1234567"), 3);
  assert.equal(tierOf("연락처 010-1234-5678"), 2);
  assert.equal(tierOf("a@b.com"), 2);
  assert.equal(tierOf("안녕하세요"), 0);
  assert.throws(() => { TIER_POLICY[3].planner = "visible"; }, TypeError, "the table is frozen");
});
