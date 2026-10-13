"use strict";

// Payment Mandate: the one way money can move in a task. The REAL user creates
// it (a trusted UI action, never the planner, a page, a routine or a schedule)
// naming a merchant origin, a currency and a maximum amount, for a few minutes
// and exactly one payment. A payment-like click is then allowed to reach the
// human approval step only if a live mandate covers its origin, its currency
// and the amount the HOST read from the page; the approval itself still has to
// be given by the user. Pure helpers: the task controller owns the list and
// journals every grant, check, use and expiry. No card data lives here.

const MANDATE_DEFAULTS = Object.freeze({ minutes: 10, maxMinutes: 15 });
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

function consumeMandate(mandate) {
  if (mandate.usesLeft < 1) throw new MandateError("mandate_used", "this mandate was already used");
  mandate.usesLeft -= 1;
}

module.exports = { MANDATE_DEFAULTS, CURRENCY_EXPONENT, MAX_AMOUNT_MINOR, MandateError, createMandate, isMandateLive, parsePageAmount, authorizePayment, consumeMandate };
