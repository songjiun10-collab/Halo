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
  assert.equal(m.deadline, 1000 + 30 * 60_000);
  assert.equal(m.expiresAt, 9_000_000 + 30 * 60_000);
  for (const bad of [
    { origin: "http://shop.example" }, { origin: "javascript:alert(1)" }, { origin: "not a url" },
    { currency: "BTC" }, { currency: "usd" },
    { maxAmountMinor: 0 }, { maxAmountMinor: -5 }, { maxAmountMinor: 12.5 }, { maxAmountMinor: MAX_AMOUNT_MINOR + 1 }, { maxAmountMinor: "50" },
    { minutes: 0 }, { minutes: 61 }, { minutes: 1.5 },
  ]) assert.throws(() => mandate(bad), (e) => e.name === "MandateError", JSON.stringify(bad));
});

test("a mandate dies by time (monotonic), use and revocation", () => {
  const m = mandate();
  assert.equal(isMandateLive(m, 1000 + 1_799_999), true);
  assert.equal(isMandateLive(m, 1000 + 1_800_000), false);
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
  assert.equal(why([m], req(), 1000 + 1_800_000), "no_mandate", "expired");
  assert.equal(why([m], req({ origin: "https://evil.example" })), "origin_mismatch");
  assert.equal(why([m], req({ origin: "https://shop.example.evil.com" })), "origin_mismatch");
  assert.equal(why([m], req({ amount: null })), "amount_unreadable");
  assert.equal(why([m], req({ amount: { currency: "EUR", amountMinor: 100 } })), "currency_mismatch");
  assert.equal(why([m], req({ amount: { currency: "USD", amountMinor: 5001 } })), "over_limit");
  consumeMandate(m);
  assert.equal(why([m], req()), "no_mandate", "a used mandate authorizes nothing");
});

test("when several mandates cover a payment the one expiring first is used", () => {
  const late = mandate({ id: "late", minutes: 45 });
  const early = mandate({ id: "early", minutes: 5 });
  const r = authorizePayment({ mandates: [late, early], request: { origin: "https://shop.example", amount: { currency: "USD", amountMinor: 100 } }, now: 1500 });
  assert.equal(r.mandate.id, "early");
});

const { mandateFromUserRequest, parseRequestAmount, decidePayment, findPayableAmount } = require("../main/harness/payment-mandate");

test("Korean and symbol amounts in a chat request parse to one cap, or to null when unclear", () => {
  assert.deepEqual(parseRequestAmount("3만원 이하"), { currency: "KRW", amountMinor: 30000 });
  assert.deepEqual(parseRequestAmount("3만 5천원 이하"), { currency: "KRW", amountMinor: 35000 });
  assert.deepEqual(parseRequestAmount("5천원"), { currency: "KRW", amountMinor: 5000 });
  assert.deepEqual(parseRequestAmount("12,000원 안에서"), { currency: "KRW", amountMinor: 12000 });
  assert.deepEqual(parseRequestAmount("$20 이하"), { currency: "USD", amountMinor: 2000 });
  for (const text of ["", "물티슈", "$20 or $30", "3만원 아니면 5만원", 5]) assert.equal(parseRequestAmount(text), null, String(text));
});

test("a clear chat order becomes a mandate; anything unclear becomes a question", () => {
  const ask = (text, opts) => mandateFromUserRequest(text, opts);
  assert.deepEqual(ask("coupang.com에서 물티슈 3만원 이하로 결제해줘"), { kind: "mandate", origin: "https://coupang.com", currency: "KRW", maxAmountMinor: 30000 });
  assert.deepEqual(ask("https://shop.example 에서 $20 이하로 사줘"), { kind: "mandate", origin: "https://shop.example", currency: "USD", maxAmountMinor: 2000 });
  assert.deepEqual(ask("물티슈 3만원 이하로 사줘", { entryUrl: "https://shop.example/item/1" }), { kind: "mandate", origin: "https://shop.example", currency: "KRW", maxAmountMinor: 30000 }, "the task's own entry page names the merchant");
  assert.equal(ask("쿠팡에서 물티슈 사줘").reason, "no_merchant");
  assert.equal(ask("shop.example에서 물티슈 사줘").reason, "no_amount");
  assert.equal(ask("a.com 하고 b.com 에서 비교하고 2만원 이하로 구매해줘").reason, "many_merchants");
  assert.deepEqual(ask("shop.example 결제 직전까지만 해줘 3만원"), { kind: "none", reason: "payment_declined" });
  assert.equal(ask("shop.example에서 $20 or $30 이하로 buy").reason, "no_amount");
  for (const text of ["철수에게 5만원 송금해줘", "send money to Kim $50 at bank.example"]) assert.equal(ask(text).reason, "transfer", text);
  for (const text of ["날씨 알려줘", "shop.example에서 사지 마 3만원", "", "   ", null]) assert.equal(ask(text).kind, "none", String(text));
  for (const q of [ask("쿠팡에서 물티슈 사줘"), ask("철수에게 송금해줘")]) assert.ok(q.question.length > 0);
});

test("a covered payment runs, an odd one asks the user, and one nobody asked for is refused", () => {
  const m = mandate();
  const at = (amount, origin = "https://shop.example") => decidePayment({ mandates: [m], request: { origin, amount }, now: 2000 });
  assert.equal(at({ currency: "USD", amountMinor: 4000 }).decision, "pay");
  assert.equal(at({ currency: "USD", amountMinor: 6000 }).decision, "ask");
  assert.equal(at({ currency: "USD", amountMinor: 6000 }).reason, "over_limit");
  assert.equal(at(null).reason, "amount_unreadable");
  assert.equal(at({ currency: "EUR", amountMinor: 1 }).reason, "currency_mismatch");
  assert.equal(at({ currency: "USD", amountMinor: 1 }, "https://evil.example").reason, "origin_mismatch");
  for (const reason of ["over_limit", "amount_unreadable", "currency_mismatch", "origin_mismatch"]) assert.ok(decidePayment({ mandates: [m], request: { origin: reason === "origin_mismatch" ? "https://x.example" : "https://shop.example", amount: reason === "amount_unreadable" ? null : { currency: reason === "currency_mismatch" ? "EUR" : "USD", amountMinor: reason === "over_limit" ? 9999 : 1 } }, now: 2000 }).question);
  assert.deepEqual(decidePayment({ mandates: [], request: { origin: "https://shop.example", amount: { currency: "USD", amountMinor: 1 } }, now: 2000 }), { decision: "refuse", reason: "no_mandate" });
});

test("the payable amount comes from the button label or a single total line, never a guess", () => {
  assert.deepEqual(findPayableAmount("Pay $12.50", "Total $99.00"), { currency: "USD", amountMinor: 1250 }, "the label wins");
  assert.deepEqual(findPayableAmount("Place order", "Item $10.00\nShipping $2.50\nTotal $12.50"), { currency: "USD", amountMinor: 1250 });
  assert.deepEqual(findPayableAmount("결제하기", "상품 10,000원\n총 결제금액 12,500원"), { currency: "KRW", amountMinor: 12500 });
  assert.equal(findPayableAmount("Place order", "Item $10.00\nShipping $2.50"), null, "no total line");
  assert.equal(findPayableAmount("Place order", "Total $12.50\nTotal $13.50"), null, "two different totals");
  assert.equal(findPayableAmount("Place order", null), null);
});

test("a real observation shows page text as elements: a total element, or a Total label followed by a lone price", () => {
  const el = (name, role = "text") => ({ role, name });
  assert.deepEqual(findPayableAmount("Place order", { text: "", elements: [el("Item $10.00"), el("Shipping $2.50"), el("Total $12.50"), el("Place order", "button")] }), { currency: "USD", amountMinor: 1250 });
  assert.deepEqual(findPayableAmount("Place order", { text: "", elements: [el("Subtotal"), el("$10.00"), el("Total"), el("$12.50"), el("Place order", "button")] }), { currency: "USD", amountMinor: 1250 });
  assert.equal(findPayableAmount("Place order", { text: "", elements: [el("Total"), el("Place order", "button")] }), null, "a button is not a price");
  assert.equal(findPayableAmount("Place order", { text: "", elements: [el("Total $12.50"), el("Total $14.00")] }), null, "two different totals");
  assert.equal(findPayableAmount("Place order", { text: "", elements: [el("Total $12.50", "button")] }), null, "controls are not page text");
});
