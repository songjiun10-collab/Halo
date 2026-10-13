"use strict";

// Payment Mandate: the one way money can move in a task. The REAL user creates
// it (a trusted UI action, never the planner, a page, a routine or a schedule)
// naming a merchant origin, a currency and a maximum amount, for a few minutes
// and exactly one payment. A payment-like click is then allowed to reach the
// human approval step only if a live mandate covers its origin, its currency
// and the amount the HOST read from the page; the approval itself still has to
// be given by the user. Pure helpers: the task controller owns the list and
// journals every grant, check, use and expiry. No card data lives here.

const MANDATE_DEFAULTS = Object.freeze({ minutes: 30, maxMinutes: 60 });
// Smallest currency unit exponent. A currency missing here cannot be mandated.
const CURRENCY_EXPONENT = Object.freeze({ USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, CHF: 2, KRW: 0, JPY: 0 });
const SYMBOL_CURRENCY = Object.freeze({ "$": "USD", "€": "EUR", "£": "GBP", "₩": "KRW", "¥": "JPY", "원": "KRW" });
const MAX_AMOUNT_MINOR = 100_000_000; // a hard ceiling no mandate can exceed

class MandateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MandateError";
    this.code = code;
  }
}

function originOf(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Everything the user supplies is validated; the planner never reaches this.
function createMandate({ id, taskId, origin, currency, maxAmountMinor, minutes = MANDATE_DEFAULTS.minutes, now, wallNow = now }) {
  const safeOrigin = originOf(origin);
  if (!safeOrigin) throw new MandateError("invalid_origin", "a mandate needs an https merchant origin");
  if (!Object.hasOwn(CURRENCY_EXPONENT, currency)) throw new MandateError("invalid_currency", "currency is not supported");
  if (!Number.isSafeInteger(maxAmountMinor) || maxAmountMinor < 1 || maxAmountMinor > MAX_AMOUNT_MINOR) {
    throw new MandateError("invalid_amount", `amount must be a whole number of minor units from 1 to ${MAX_AMOUNT_MINOR}`);
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MANDATE_DEFAULTS.maxMinutes) {
    throw new MandateError("invalid_terms", `a mandate lasts 1 to ${MANDATE_DEFAULTS.maxMinutes} minutes`);
  }
  const durationMs = minutes * 60_000;
  return {
    id, taskId, origin: safeOrigin, currency, maxAmountMinor,
    grantedAt: wallNow, expiresAt: wallNow + durationMs,
    // Authorization uses the monotonic deadline so a clock change cannot extend it.
    deadline: now + durationMs,
    usesLeft: 1, revoked: false,
  };
}

function isMandateLive(mandate, now) {
  return !mandate.revoked && mandate.usesLeft > 0 && now < mandate.deadline;
}

// A price shown on a page is untrusted text. Accept only one unambiguous
// amount with a currency symbol, code or 원 suffix; anything else returns null
// and the payment cannot be authorized by this route.
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const CODE = "USD|EUR|GBP|CAD|AUD|CHF|KRW|JPY";
const PRICE = new RegExp(
  String.raw`(?<![\w.,])(?:(${CODE})\s?|([$€£₩¥])\s?)(${NUMBER})(?![\d,]|\.\d)|(?<![\w.,])(${NUMBER})\s?(${CODE}|원)(?![A-Za-z])`,
  "gu",
);

function priceCurrency(code, symbol, suffix) {
  if (code) return code;
  if (symbol) return SYMBOL_CURRENCY[symbol];
  return suffix === "원" ? "KRW" : suffix;
}

function parsePageAmount(text) {
  if (typeof text !== "string" || text.length > 200) return null;
  const found = new Map();
  for (const match of text.matchAll(PRICE)) {
    const currency = priceCurrency(match[1], match[2], match[5]);
    const exponent = CURRENCY_EXPONENT[currency];
    if (exponent === undefined) return null;
    const [whole, fraction = ""] = (match[3] ?? match[4]).replaceAll(",", "").split(".");
    if (fraction.length > exponent) return null; // never round money
    const minor = Number(whole) * 10 ** exponent + (exponent ? Number(fraction.padEnd(exponent, "0")) : 0);
    if (!Number.isSafeInteger(minor)) return null;
    found.set(`${currency}:${minor}`, { currency, amountMinor: minor });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// ---- Reading the user's own chat request ---------------------------------
// The user's message is the authorization. A clear one (it says to pay/buy,
// names where, and caps the amount) becomes a single-use mandate and the
// payment goes through at once; anything unclear becomes a question for the
// user, never a guess. Money transfers to people are always a question.

const PAY_INTENT = /(결제|구매|구입|주문|사\s?줘|사\s?주세요|사\s?와|예약|\bbuy\b|\bpurchase\b|\border\b|\bpay\b|\bcheck\s?out\b)/iu;
const TRANSFER_INTENT = /(송금|이체|입금|환전|\bsend money\b|\bwire\b|\btransfer (?:funds|money)\b)/iu;
// "don't pay", "stop before paying", "결제 직전까지": the user is limiting, not ordering.
const PAY_LIMIT = /(하지\s?(마|말)|말고|말아|않|전까지|직전|직전까지|취소|\bdon'?t\b|\bdo not\b|\bnever\b|\bbefore (?:paying|buying|checkout|ordering)\b|\bwithout (?:paying|buying)\b|\bstop before\b)/iu;
const KO_UNIT = { "만": 10_000, "천": 1_000, "백": 100 };

// "3만 5천원", "1만원", "5천원", "12,000원" -> KRW; other currencies reuse the page parser.
function parseRequestAmount(text) {
  if (typeof text !== "string" || text.length > 2000) return null;
  const found = new Map();
  const add = (currency, amountMinor) => found.set(`${currency}:${amountMinor}`, { currency, amountMinor });
  for (const m of text.matchAll(/(?<![\d,.])((?:\d+\s?만)?\s?(?:\d+\s?천)?\s?(?:\d+\s?백)?)\s?원/gu)) {
    const body = m[1].trim();
    if (!body || !/[만천백]/u.test(body)) continue;
    let total = 0;
    for (const part of body.matchAll(/(\d+)\s?([만천백])/gu)) total += Number(part[1]) * KO_UNIT[part[2]];
    if (total > 0 && Number.isSafeInteger(total)) add("KRW", total);
  }
  for (const m of text.matchAll(/\S{0,24}/gu)) {
    if (!m[0]) continue;
    const one = parsePageAmount(m[0]);
    if (one) add(one.currency, one.amountMinor);
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

function originsIn(text) {
  const origins = new Set();
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)>"']+/giu)) {
    const o = originOf(m[0]);
    if (o) origins.add(o);
  }
  for (const m of text.matchAll(/(?<![\w@/.])((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w.-])/giu)) {
    const o = originOf(`https://${m[1].toLowerCase()}`);
    if (o) origins.add(o);
  }
  return origins;
}

// -> { kind: "none" } no payment asked
//    { kind: "ask", reason, question } unclear: pause and ask the user
//    { kind: "mandate", origin, currency, maxAmountMinor } clear: pay when it comes to it
function mandateFromUserRequest(text, { entryUrl = null } = {}) {
  if (typeof text !== "string" || !text.trim()) return { kind: "none" };
  const transfer = TRANSFER_INTENT.test(text);
  const intent = PAY_INTENT.test(text);
  if (!transfer && !intent) return { kind: "none" };
  if (transfer) return { kind: "ask", reason: "transfer", question: "송금·이체는 받는 사람과 금액을 직접 확인해야 해요. 어디로 얼마를 보낼지 알려 주세요." };
  // "don't pay" / "stop before paying" is a clear instruction, not a question:
  // no mandate, so any payment later is refused.
  if (PAY_LIMIT.test(text)) return { kind: "none", reason: "payment_declined" };
  const origins = originsIn(text);
  if (entryUrl && origins.size === 0) {
    const o = originOf(entryUrl);
    if (o) origins.add(o);
  }
  if (origins.size === 0) return { kind: "ask", reason: "no_merchant", question: "어느 사이트에서 결제할까요? 주소를 알려 주세요." };
  if (origins.size > 1) return { kind: "ask", reason: "many_merchants", question: "결제할 사이트가 여러 곳으로 보여요. 어느 사이트에서 결제할까요?" };
  const amount = parseRequestAmount(text);
  if (!amount) return { kind: "ask", reason: "no_amount", question: "결제 금액 한도를 알려 주세요. 예: 3만원 이하, 또는 $20 이하." };
  if (amount.amountMinor > MAX_AMOUNT_MINOR) return { kind: "ask", reason: "amount_too_large", question: "금액이 너무 커요. 한도를 다시 알려 주세요." };
  return { kind: "mandate", origin: [...origins][0], currency: amount.currency, maxAmountMinor: amount.amountMinor };
}

// The amount a payment button will charge, as the host can read it: a price in
// the button's own label first, otherwise the price on a "total"-style line of the
// page. `page` is the page text or an observation ({ text, elements }); a real
// observation carries visible text mostly as separate elements, so both are read,
// and a "Total" element followed by a lone price element counts too. Exactly one
// distinct amount must come out of it; otherwise null.
const TOTAL_WORD = /(?<![\p{L}])(?:total|amount due|order total|grand total|you pay|합계|총\s?(?:결제\s?)?금액|결제\s?금액|주문\s?금액|최종\s?결제)/iu;
const TOTAL_LINE = new RegExp(`${TOTAL_WORD.source}[^\\n]{0,60}`, "giu");
const TEXT_ROLES = new Set(["text", "heading", "paragraph", "cell", "listitem", "generic", "strong", "label", "status"]);

function findPayableAmount(controlName, page) {
  const fromLabel = parsePageAmount(typeof controlName === "string" ? controlName : "");
  if (fromLabel) return fromLabel;
  const text = typeof page === "string" ? page : page && typeof page.text === "string" ? page.text : "";
  const elements = page && Array.isArray(page.elements) ? page.elements.filter((el) => el && TEXT_ROLES.has(el.role) && typeof el.name === "string") : [];
  const amounts = new Map();
  const take = (candidate) => { if (candidate) amounts.set(`${candidate.currency}:${candidate.amountMinor}`, candidate); };
  for (const line of text.matchAll(TOTAL_LINE)) take(parsePageAmount(line[0]));
  elements.forEach((el, i) => {
    if (!TOTAL_WORD.test(el.name)) return;
    const own = parsePageAmount(el.name);
    if (own) { take(own); return; }
    for (const next of elements.slice(i + 1, i + 3)) {
      if (TOTAL_WORD.test(next.name)) break;
      const one = parsePageAmount(next.name);
      if (one) { take(one); break; }
    }
  });
  return amounts.size === 1 ? [...amounts.values()][0] : null;
}

// Verdict for one payment-like action. `request` carries what the host saw:
// the page origin and the amount parsed from page text (or null).
function authorizePayment({ mandates, request, now }) {
  const live = mandates.filter((m) => isMandateLive(m, now));
  if (live.length === 0) return { ok: false, reason: "no_mandate" };
  const sameOrigin = live.filter((m) => m.origin === request.origin);
  if (sameOrigin.length === 0) return { ok: false, reason: "origin_mismatch" };
  if (!request.amount) return { ok: false, reason: "amount_unreadable" };
  const sameCurrency = sameOrigin.filter((m) => m.currency === request.amount.currency);
  if (sameCurrency.length === 0) return { ok: false, reason: "currency_mismatch" };
  const covering = sameCurrency.filter((m) => request.amount.amountMinor <= m.maxAmountMinor).sort((a, b) => a.deadline - b.deadline);
  if (covering.length === 0) return { ok: false, reason: "over_limit" };
  return { ok: true, mandate: covering[0] };
}

// What the controller does with a payment-like action: pay now, ask the user,
// or refuse (no one asked for a payment). The user's request already authorized
// a clear payment, so nothing else stands between a covered payment and its run.
function decidePayment({ mandates, request, now }) {
  const verdict = authorizePayment({ mandates, request, now });
  if (verdict.ok) return { decision: "pay", mandate: verdict.mandate };
  if (verdict.reason === "no_mandate") return { decision: "refuse", reason: verdict.reason };
  const questions = {
    origin_mismatch: "다른 사이트에서 결제하려고 해요. 이 사이트에서 결제해도 될까요?",
    amount_unreadable: "결제 금액을 화면에서 정확히 읽지 못했어요. 금액을 확인하고 진행할까요?",
    currency_mismatch: "요청하신 통화와 다른 통화로 결제하려고 해요. 계속할까요?",
    over_limit: "결제 금액이 정해 주신 한도를 넘어요. 그래도 진행할까요?",
  };
  return { decision: "ask", reason: verdict.reason, question: questions[verdict.reason] };
}

function consumeMandate(mandate) {
  if (mandate.usesLeft < 1) throw new MandateError("mandate_used", "this mandate was already used");
  mandate.usesLeft -= 1;
}

module.exports = { MANDATE_DEFAULTS, CURRENCY_EXPONENT, MAX_AMOUNT_MINOR, MandateError, createMandate, isMandateLive, parsePageAmount, parseRequestAmount, mandateFromUserRequest, authorizePayment, decidePayment, findPayableAmount, consumeMandate };
