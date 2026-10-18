"use strict";
// Host-side completion checklist. The model proposes an answer; the host checks it against what the
// browser actually showed before the answer counts as delivered. Each check returns a failure code
// and a short instruction the planner can act on. Nothing here solves or bypasses a CAPTCHA.
const { looksLikeCaptcha } = require("../../shared/captcha-heuristics");

const BLOCK_TEXT = /access denied|forbidden|request blocked|verify you are human|enable javascript and cookies|unusual traffic|are you a robot|temporarily blocked/i;
const GIVE_UP_ANSWER = /^(i (could not|couldn't|was unable|cannot|can't)|unable to|sorry|could not find|not found)\b/i;

function numbersIn(text) {
  const bare = String(text ?? "").replace(/https?:\/\/\S+/gi, " ");
  const out = new Set();
  for (const m of bare.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, "");
    if (n.replace(/\./g, "").length >= 2) out.add(n);
  }
  return out;
}

function pageIsBlocked(observation) {
  if (!observation) return false;
  if (looksLikeCaptcha(observation.url ?? "", observation.title ?? "")) return true;
  if ([403, 429, 503].includes(Number(observation.httpStatus))) return true;
  return BLOCK_TEXT.test(String(observation.text ?? "").slice(0, 600)) && String(observation.text ?? "").length < 1500;
}

const STOP = new Set(["find","show","search","look","get","what","which","who","when","where","how","list","check","open","go","the","a","an","i","if","on","in","at","for","to","and","or","of","with","from","by","is","are","can","please","browse","tell","compare","view","select","add","book","buy","set","use","do"]);

// Conditions the task names outright: quoted text and capitalised names (numbers are thresholds, not text a page must show). Deterministic, so it
// misses conditions written in plain words; it only holds the answer to the ones it can see.
function conditionsIn(goalText) {
  const text = String(goalText ?? "");
  const out = new Set();
  for (const m of text.matchAll(/["\u201c']([^"\u201d']{2,60})["\u201d']/g)) out.add(m[1].toLowerCase());
  const words = text.split(/\s+/);
  words.forEach((w, i) => {
    const clean = w.replace(/[^\p{L}\p{N}-]/gu, "");
    if (i === 0 || clean.length < 3 || !/^\p{Lu}/u.test(clean) || STOP.has(clean.toLowerCase())) return;
    if (/^https?:/i.test(w) || /\.\w{2,}$/.test(w)) return;
    out.add(clean.toLowerCase());
  });
  return [...out];
}

// { ok, failures: [{ code, guidance }] }
function runChecklist({ answer, goalText = "", observation = null, observedTexts = [], observedUrls = [] }) {
  const failures = [];
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!text) failures.push({ code: "answer_empty", guidance: "Report an answer, not an empty message." });
  else if (GIVE_UP_ANSWER.test(text)) failures.push({ code: "answer_gave_up", guidance: "The answer says nothing was found. Try another route, site or search before reporting." });
  if (pageIsBlocked(observation)) failures.push({ code: "final_page_blocked", guidance: "The current page is a block, error or challenge page. Leave it and use another route; it is not evidence for an answer." });
  if (text) {
    const seen = observedTexts.join("\n").replace(/,/g, "");
    const exempt = numbersIn(goalText);
    const missing = [...numbersIn(text)].filter((n) => !exempt.has(n) && !seen.includes(n));
    if (missing.length > 0 && observedTexts.length > 0) {
      failures.push({ code: "value_not_on_opened_pages", guidance: `These values in the answer appear on no page you opened: ${missing.slice(0, 5).join(", ")}. Open the page that shows them or correct the answer.` });
    }
  }
  if (text && observedTexts.length > 0) {
    const haystack = (observedTexts.join("\n") + "\n" + observedUrls.join("\n") + "\n" + (observation?.url ?? "")).toLowerCase().replace(/,/g, "");
    const unseen = conditionsIn(goalText).filter((c) => !haystack.includes(c.replace(/,/g, "")));
    if (unseen.length > 0) failures.push({ code: "condition_not_seen", guidance: `The task names ${unseen.slice(0, 5).map((c) => `"${c}"`).join(", ")}, which no page you opened shows. Apply that condition on the site and confirm it on screen before reporting.` });
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { conditionsIn, runChecklist, pageIsBlocked, numbersIn };
