"use strict";

// Semantic effect of a coordinate action, judged from the control it lands on
// (see screen-map.resolveTarget) instead of from the action type. A hint that
// narrows when a human is asked; it never replaces the approver, and anything
// it cannot place is sent to the human (fail closed). Names are page-supplied,
// so a match can only add a question, never remove the approver or the lock.

interface ClassifiedTarget { role: string; name: string; covered?: boolean; disabled?: boolean }
type Gate = "auto" | "ask";
type Effect = "navigation" | "input" | "effect" | "unknown" | "blocked";
interface Classification { gate: Gate; effect: Effect; reason: string }

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

// Buttons that only move around the page or reveal more of it.
const BENIGN_BUTTON = /^(?:search|find|go|next|previous|prev|back|close|cancel|dismiss|menu|more|show(?: more| all)?|hide|expand|collapse|open|filter|sort|view(?: details)?|details|learn more|read more|검색|다음|이전|뒤로|닫기|취소|메뉴|더보기|보기|열기|필터|정렬|자세히(?: 보기)?)$/i;

const normalize = (value: string): string => value.normalize("NFKC").replace(/\s+/g, " ").trim();

function classifyTarget(target: ClassifiedTarget | null, actionType: "click_at" | "type_at"): Classification {
  if (!target) return { gate: "ask", effect: "unknown", reason: "no mapped control under the point" };
  if (target.covered) return { gate: "ask", effect: "blocked", reason: "the control is covered by another element" };
  if (target.disabled) return { gate: "ask", effect: "blocked", reason: "the control is disabled" };
  const role = target.role;
  const name = normalize(target.name);
  if (name && EFFECT_NAME.test(name)) return { gate: "ask", effect: "effect", reason: "the control name suggests an external effect" };
  if (actionType === "type_at") {
    return TEXT_ENTRY_ROLES.has(role)
      ? { gate: "auto", effect: "input", reason: "typing into a text field" }
      : { gate: "ask", effect: "unknown", reason: "typing target is not a text field" };
  }
  if (INPUT_ROLES.has(role)) return { gate: "auto", effect: "input", reason: "editing a field" };
  if (NAVIGATION_ROLES.has(role) || role === "link") return { gate: "auto", effect: "navigation", reason: "navigation control" };
  if (role === "button" && BENIGN_BUTTON.test(name)) return { gate: "auto", effect: "navigation", reason: "button that only moves around the page" };
  return { gate: "ask", effect: "unknown", reason: role === "button" ? "a button the host cannot rule out as effect-bearing" : "not a recognized interactive control" };
}

export = { classifyTarget };
