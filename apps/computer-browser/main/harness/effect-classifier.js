// Generated from runtime-src/main/harness/effect-classifier.ts. Do not edit; run npm run build:runtime.
"use strict";
// Controls whose click is navigation or editing, if their name raises no flag.
const NAVIGATION_ROLES = new Set(["link", "tab", "menuitem", "option"]);
const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "listbox"]);
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox"]);
// A click on these names can send, spend, delete or publish something.
const EFFECT_NAME = new RegExp([
    "\\b(delete|remove|erase|destroy|discard|clear all|reset|revoke|unsubscribe|deactivate|disable account|close account|cancel (?:order|subscription|booking|plan))\\b",
    "\\b(buy|purchase|pay|checkout|check out|place order|order now|donate|subscribe|upgrade|transfer|withdraw|deposit|send money|book now|reserve)\\b",
    "\\b(send|post|publish|share|submit|confirm|apply|accept|agree|sign out|log out|logout|sign up|register|save changes|invite|reply|comment|tweet|merge|deploy|approve)\\b",
    "삭제|제거|탈퇴|해지|취소 신청|초기화|구매|결제|주문|송금|이체|기부|구독|예약|전송|보내기|게시|등록|공유|제출|확인 및|동의|수락|승인|로그아웃|가입|초대|답글|댓글|병합|배포",
].join("|"), "i");
// A click on these names moves money or destroys an account or its data for
// good. The agent never does this on its own, however the task was phrased:
// it is refused outright (the user can still do it by hand). Only buttons and
// links are judged, so typing into a field that merely mentions one is not.
const IRREVERSIBLE_NAME = new RegExp([
    "\\b(transfer (?:funds|money)|wire (?:funds|money)|send money|withdraw|pay now|confirm payment|place order|complete purchase)\\b",
    "\\b(delete (?:my )?account|close (?:my )?account|permanently delete|delete forever|erase all data|deactivate account)\\b",
    "송금|이체|출금|결제하기|결제 확인|계정 삭제|회원 탈퇴|영구 삭제|계정 폐쇄",
].join("|"), "i");
// The part of the list above that is a purchase (not a transfer, withdrawal or
// account removal). Only a payment the user ordered in chat can be let through
// (see payment-mandate); everything else stays refused.
// The final step of a checkout, in the wording real shops use (corpus: fixtures/payment-button-labels.json,
// measured by test/payment-detection-corpus.test.js). Steps that only move toward checkout ("Proceed to
// checkout", "Add to cart") and settings or history pages are deliberately not payments. A button this misses
// still goes to the human approval gate, so a gap costs friction, not safety; a false match costs more, so
// the short ambiguous words ("Purchase", "결제 진행") only match as the whole label.
const PAYMENT_NAME = new RegExp([
    "\\b(pay now|confirm payment|place (?:your )?order|complete purchase|buy now|pay \\$?[\\d,.]+)\\b",
    "\\b(complete (?:the |your )?(?:order|purchase|payment)|confirm (?:and pay|order|your order|purchase)|submit (?:payment|your order|order))$",
    "^purchase$",
    "결제하기|결제 확인|주문하기|구매하기|바로 구매",
    "^(?:\\d[\\d,]*원\\s*)?결제(?: 진행(?:하기)?)?$",
    "^주문 완료하기$",
    "注文を確定|今すぐ購入|今すぐ支払",
].join("|"), "i");
// A name that also reads as a transfer or account removal is never a purchase.
const IRREVERSIBLE_NAME_NON_PAYMENT = new RegExp([
    "\\b(transfer|wire|send money|withdraw|delete|close (?:my )?account|deactivate)\\b",
    "송금|이체|출금|탈퇴|계정",
].join("|"), "i");
// Buttons that only move around the page or reveal more of it.
const BENIGN_BUTTON = /^(?:search|find|go|next|previous|prev|back|close|cancel|dismiss|menu|more|show(?: more| all)?|hide|expand|collapse|open|filter|sort|view(?: details)?|details|learn more|read more|검색|다음|이전|뒤로|닫기|취소|메뉴|더보기|보기|열기|필터|정렬|자세히(?: 보기)?)$/i;
const normalize = (value) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
function classifyTarget(target, actionType) {
    if (!target)
        return { gate: "ask", effect: "unknown", reason: "no mapped control under the point" };
    if (target.covered)
        return { gate: "ask", effect: "blocked", reason: "the control is covered by another element" };
    if (target.disabled)
        return { gate: "ask", effect: "blocked", reason: "the control is disabled" };
    const role = target.role;
    const name = normalize(target.name);
    if (actionType === "click_at" && (role === "button" || role === "link") && name && IRREVERSIBLE_NAME.test(name)) {
        return { gate: "deny", effect: "irreversible", reason: "the control moves money or destroys an account" };
    }
    if (name && EFFECT_NAME.test(name))
        return { gate: "ask", effect: "effect", reason: "the control name suggests an external effect" };
    if (actionType === "type_at") {
        return TEXT_ENTRY_ROLES.has(role)
            ? { gate: "auto", effect: "input", reason: "typing into a text field" }
            : { gate: "ask", effect: "unknown", reason: "typing target is not a text field" };
    }
    if (INPUT_ROLES.has(role))
        return { gate: "auto", effect: "input", reason: "editing a field" };
    if (NAVIGATION_ROLES.has(role) || role === "link")
        return { gate: "auto", effect: "navigation", reason: "navigation control" };
    if (role === "button" && BENIGN_BUTTON.test(name))
        return { gate: "auto", effect: "navigation", reason: "button that only moves around the page" };
    return { gate: "ask", effect: "unknown", reason: role === "button" ? "a button the host cannot rule out as effect-bearing" : "not a recognized interactive control" };
}
function isPaymentControl(target) {
    if (!target || target.covered || target.disabled)
        return false;
    if (target.role !== "button" && target.role !== "link")
        return false;
    const name = normalize(target.name);
    return !!name && PAYMENT_NAME.test(name) && !IRREVERSIBLE_NAME_NON_PAYMENT.test(name);
}
module.exports = { classifyTarget, isPaymentControl };
