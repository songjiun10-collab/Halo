"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMandate, isMandateLive, parsePageAmount, authorizePayment, consumeMandate, MAX_AMOUNT_MINOR } = require("../main/harness/payment-mandate");

const base = { id: "m1", taskId: "t1", origin: "https://shop.example", currency: "USD", maxAmountMinor: 5000, now: 1000, wallNow: 9_000_000 };
const mandate = (over = {}) => createMandate({ ...base, ...over });

test("a mandate is https-only, single-use, short-lived and bounded", () => {
  const m = mandate();
  assert.equal(m.origin, "https://shop.example");
  assert.equal(m.usesLeft, 1);
  assert.equal(m.deadline, 1000 + 10 * 60_000);
  assert.equal(m.expiresAt, 9_000_000 + 10 * 60_000);
  for (const bad of [
    { origin: "http://shop.example" }, { origin: "javascript:alert(1)" }, { origin: "not a url" },
    { currency: "BTC" }, { currency: "usd" },
    { maxAmountMinor: 0 }, { maxAmountMinor: -5 }, { maxAmountMinor: 12.5 }, { maxAmountMinor: MAX_AMOUNT_MINOR + 1 }, { maxAmountMinor: "50" },
    { minutes: 0 }, { minutes: 16 }, { minutes: 1.5 },
  ]) assert.throws(() => mandate(bad), (e) => e.name === "MandateError", JSON.stringify(bad));
});

test("a mandate dies by time (monotonic), use and revocation", () => {
  const m = mandate();
  assert.equal(isMandateLive(m, 1000 + 599_999), true);
  assert.equal(isMandateLive(m, 1000 + 600_000), false);
  consumeMandate(m);
  assert.equal(isMandateLive(m, 1001), false);
  assert.throws(() => consumeMandate(m), (e) => e.code === "mandate_used");
  const r = mandate();
  r.revoked = true;
  assert.equal(isMandateLive(r, 1001), false);
});

test("page prices parse only when exactly one unambiguous amount is shown", () => {
  const ok = [
    ["Total $12.50", "USD", 1250], ["Total: €1,234.50", "EUR", 123450], ["USD 12.5", "USD", 1250], ["12.50 USD", "USD", 1250],
    ["결제 금액 12,000원", "KRW", 12000], ["₩12,000", "KRW", 12000], ["KRW 12000", "KRW", 12000], ["$12.50 and $12.50", "USD", 1250],
  ];
  for (const [text, currency, amountMinor] of ok) assert.deepEqual(parsePageAmount(text), { currency, amountMinor }, text);
  for (const text of ["$5 or $6", "10.999 USD", "free", "$1,23", "US$5", "$12.505", "₩12,000.50", "", 5, null, "x".repeat(201)]) {
    assert.equal(parsePageAmount(text), null, String(text));
  }
});

test("authorizePayment needs a live mandate for this origin, currency and amount, and says why not", () => {
  const m = mandate();
  const req = (over = {}) => ({ origin: "https://shop.example", amount: { currency: "USD", amountMinor: 4999 }, ...over });
  assert.deepEqual(authorizePayment({ mandates: [m], request: req(), now: 2000 }), { ok: true, mandate: m });
  assert.equal(authorizePayment({ mandates: [m], request: req({ amount: { currency: "USD", amountMinor: 5000 } }), now: 2000 }).ok, true, "the cap itself is allowed");
  const why = (mandates, request, now = 2000) => authorizePayment({ mandates, request, now }).reason;
  assert.equal(why([], req()), "no_mandate");
  assert.equal(why([m], req(), 1000 + 600_000), "no_mandate", "expired");
  assert.equal(why([m], req({ origin: "https://evil.example" })), "origin_mismatch");
  assert.equal(why([m], req({ origin: "https://shop.example.evil.com" })), "origin_mismatch");
  assert.equal(why([m], req({ amount: null })), "amount_unreadable");
  assert.equal(why([m], req({ amount: { currency: "EUR", amountMinor: 100 } })), "currency_mismatch");
  assert.equal(why([m], req({ amount: { currency: "USD", amountMinor: 5001 } })), "over_limit");
  consumeMandate(m);
  assert.equal(why([m], req()), "no_mandate", "a used mandate authorizes nothing");
});

test("when several mandates cover a payment the one expiring first is used", () => {
  const late = mandate({ id: "late", minutes: 15 });
  const early = mandate({ id: "early", minutes: 5 });
  const r = authorizePayment({ mandates: [late, early], request: { origin: "https://shop.example", amount: { currency: "USD", amountMinor: 100 } }, now: 1500 });
  assert.equal(r.mandate.id, "early");
});
