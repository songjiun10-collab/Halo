"use strict";

// Privacy tiers, applied by the host (the model never decides them). TIER_POLICY below is the
// one written-down table; docs/superpowers/specs/2026-10-13-payment-mandate-design.md mirrors it.

const TIERS = Object.freeze({ SECRET: 3, PERSONAL: 2, ORDINARY: 0 });
const TIER_POLICY = Object.freeze({
  [TIERS.SECRET]: Object.freeze({ label: "비밀", examples: "카드번호, CVC, 주민등록번호, 비밀번호, 인증번호, 계좌번호", planner: "hidden", journal: "hidden", agentTyping: "never (the person types it)" }),
  [TIERS.PERSONAL]: Object.freeze({ label: "개인 식별", examples: "전화번호, 이메일 주소", planner: "visible", journal: "visible", agentTyping: "only a value the user wrote in this task's request" }),
  [TIERS.ORDINARY]: Object.freeze({ label: "일반", examples: "그 외 모든 텍스트", planner: "visible", journal: "visible", agentTyping: "allowed" }),
});

const { containsCardNumber, maskCardNumbers, isCardField } = require("./card-blind");

const RRN_HYPHEN = /(?<!\d)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[- ][1-8]\d{6}(?!\d)/g;
const RRN_PLAIN = /(?<!\d)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[1-8]\d{6}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)(?:\+?82[- ]?)?0?1[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g;
const SECRET_FIELD = /(주민\s*(등록)?\s*번호|외국인\s*등록|resident\s*registration|ssn|비밀번호|password|passcode|\botp\b|인증\s*번호|인증\s*코드|verification\s*code|계좌\s*번호|account\s*number|\bpin\b)/i;

function rrnValid(digits) {
  if (digits.length !== 13) return false;
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = weights.reduce((s, w, i) => s + w * (digits.charCodeAt(i) - 48), 0);
  return (11 - (sum % 11)) % 10 === digits.charCodeAt(12) - 48;
}

function rrnMatches(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const m of text.matchAll(RRN_HYPHEN)) out.push(m[0]);
  for (const m of text.matchAll(RRN_PLAIN)) if (rrnValid(m[0])) out.push(m[0]);
  return out;
}

function containsTier3(text) {
  return containsCardNumber(text) || rrnMatches(text).length > 0;
}

function maskTier3(text) {
  if (typeof text !== "string" || !text) return text;
  // Resident numbers first: one can pass the card Luhn check by chance and would leak its last four.
  let out = text;
  for (const raw of rrnMatches(out)) out = out.split(raw).join("[주민등록번호 숨김]");
  return maskCardNumbers(out);
}

function isSecretField(element) {
  if (!element || typeof element !== "object") return false;
  if (element.inputType === "password") return true;
  if (isCardField(element)) return true;
  return SECRET_FIELD.test([element.name, element.placeholder, element.autocomplete].filter((s) => typeof s === "string").join(" "));
}

// A copy of the observation with Tier 3 values removed.
function applyPrivacyTiers(observation) {
  if (!observation || typeof observation !== "object") return observation;
  const elements = Array.isArray(observation.elements)
    ? observation.elements.map((el) => {
        if (!el || typeof el !== "object") return el;
        const copy = { ...el };
        if (typeof copy.name === "string") copy.name = maskTier3(copy.name);
        if (typeof copy.value === "string") {
          if (isSecretField(el)) { delete copy.value; copy.valueHidden = true; }
          else copy.value = maskTier3(copy.value);
        }
        return copy;
      })
    : observation.elements;
  return { ...observation, ...(typeof observation.text === "string" ? { text: maskTier3(observation.text) } : {}), elements };
}

function digitsOf(s) { return String(s).replace(/\D/g, ""); }

function tier2In(text) {
  if (typeof text !== "string") return [];
  return [...(text.match(EMAIL) ?? []).map((v) => ({ kind: "email", value: v.toLowerCase() })), ...(text.match(PHONE) ?? []).map((v) => ({ kind: "phone", value: digitsOf(v).replace(/^82/, "0") }))];
}

// The tier of one piece of text: 3 secret, 2 personal, 0 ordinary.
function tierOf(text) {
  if (containsTier3(text)) return TIERS.SECRET;
  return tier2In(text).length > 0 ? TIERS.PERSONAL : TIERS.ORDINARY;
}

// Why typing is not allowed here, or null. userText is everything the user wrote for this task.
function typingBlock({ text, element, userText }) {
  if (isSecretField(element) || containsTier3(text)) return { tier: TIERS.SECRET, reason: "[비밀 정보] 카드번호, 주민등록번호, 비밀번호, 인증번호 같은 정보는 직접 입력해 주세요. 입력을 마치면 이어서 진행합니다." };
  const given = tier2In(userText);
  for (const item of tier2In(text)) {
    if (!given.some((g) => g.kind === item.kind && g.value === item.value)) {
      return { tier: TIERS.PERSONAL, reason: `[개인 식별 정보] 요청에 없던 ${item.kind === "email" ? "이메일 주소" : "전화번호"}를 입력하려고 합니다. 직접 입력하거나, 이 정보를 사용해도 된다고 요청에 적어 주세요.` };
    }
  }
  return null;
}

module.exports = { TIERS, TIER_POLICY, tierOf, applyPrivacyTiers, containsTier3, maskTier3, isSecretField, typingBlock, tier2In, rrnMatches };
