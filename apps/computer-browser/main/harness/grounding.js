"use strict";

// Hallucination detection for unsupported specifics.
//
// The problem this solves: a hand-written blocklist only catches a fabrication
// someone thought to enumerate in advance. `specs-retrieval` forbids M5/Pro/32GB
// because a human wrote those down; a model that invents "M4 Max with 24GB"
// sails through. A host has a better tool than a blocklist: it knows every page
// the planner was actually shown. So any SPECIFIC claim in an answer -- a model
// code, a quantity, a price, a long number -- that never appeared in anything
// observed is unsupported by construction. No judge model, no per-task
// enumeration.
//
// This module is pure logic and is shared by both consumers:
//   - the runtime hallucination device (task-controller `_groundNeedUserAnswer`
//     checks a need_user answer, and a bounded host correction turn asks the
//     planner to revise),
//   - the accuracy harness (integration/accuracy/grounding.js re-exports this
//     module for its own measurement and correction arm).
//
// Limits, stated plainly because this number can be quoted:
//   - It catches unsupported SPECIFICS, not unsupported prose. "It is much
//     faster" is unfalsifiable here and passes.
//   - It cannot catch a fabrication built only from values that DO appear on
//     some observed page (e.g. pairing the wrong two values).
//   - A correct answer that paraphrases a specific ("eleven inches" for
//     "11-inch") is normalized, but an unusual paraphrase can false-positive.
//     That is why the unsupported list is always surfaced, never just counted.

const UNIT_CANON = [
  [/\binch(?:es)?\b/g, "inch"],
  [/\bgigabytes?\b/g, "gb"],
  [/\bterabytes?\b/g, "tb"],
  [/\bmegabytes?\b/g, "mb"],
  [/\bkilograms?\b/g, "kg"],
  [/\bpounds?\b|\blbs?\b/g, "lb"],
  [/\bcentimet(?:er|re)s?\b/g, "cm"],
  [/\bmillimet(?:er|re)s?\b/g, "mm"],
  [/\bdollars?\b|\busd\b/g, "usd"],
  [/\bpercent\b/g, "pct"],
];

// Case, spacing, punctuation and unit plurals are not content. "11-inch",
// "11 inches" and "11inch" all have to land on the same token or every
// correct answer about a screen size would be flagged.
function canon(text) {
  let out = String(text ?? "").toLowerCase();
  for (const [pattern, replacement] of UNIT_CANON) out = out.replace(pattern, replacement);
  return out.replace(/[^a-z0-9%$]/g, "");
}

// The claim shapes worth checking. Chosen so a plausible fabrication lands in
// at least one: "M5" and "32GB" and "$1,299" and "1420" all do.
const CANDIDATES = [
  // Model/version codes: M4, Q3, A17, X200.
  /\b[a-z]{1,5}\d{1,5}[a-z]{0,4}\b/gi,
  // Number-then-letters: 16GB, 4K.
  /\b\d{1,6}[a-z]{2,5}\b/gi,
  // A quantity with a word unit: "30 days", "11 inches", "5 percent".
  /\b\d+(?:\.\d+)?\s*(?:inch(?:es)?|gigabytes?|terabytes?|megabytes?|kilograms?|pounds?|lbs?|percent|dollars?|usd)\b/gi,
  // Money.
  /\$\s?\d[\d,.]*/g,
  // Bare numbers of two or more digits: a zip, a headcount, a year.
  /\b\d{2,}\b/g,
];

/**
 * The specific, checkable claims in an answer.
 * @param {string} answer
 * @returns {string[]} canonical tokens, de-duplicated, in first-seen order
 */
function specificsOf(answer) {
  const text = String(answer ?? "");
  const seen = new Set();
  for (const pattern of CANDIDATES) {
    pattern.lastIndex = 0;
    const found = text.match(pattern);
    if (!found) continue;
    for (const item of found) {
      const token = canon(item);
      // A one-character-or-less token carries no claim; drop noise like "a".
      if (token.replace(/[^a-z0-9]/g, "").length >= 2) seen.add(token);
    }
  }
  return [...seen];
}

/**
 * Is one canonical token supported by the canonical observation corpus?
 *
 * A substring test is right for alphanumeric tokens: "11inch" (from
 * "11 inches") must match a page that wrote "11-inch". It is WRONG for
 * all-digit tokens, and that is not hypothetical -- "42" is a substring of
 * "1420", so plain `includes` grounded a fabricated headcount in a real page's
 * number. Digit tokens therefore need a digit boundary on both sides.
 */
function isSupported(token, corpus) {
  if (!/^\d+$/.test(token)) return corpus.includes(token);
  return new RegExp(`(?:^|[^0-9])${token}(?:[^0-9]|$)`).test(corpus);
}

/**
 * Which specific claims in the answer never appear in anything the planner saw.
 * @param {string} answer
 * @param {readonly string[]} observedTexts every page text, URL and status the
 *   planner was shown during the run
 * @returns {string[]} canonical tokens with no support in the observations
 */
function unsupportedSpecifics(answer, observedTexts) {
  const corpus = canon(Array.isArray(observedTexts) ? observedTexts.join(" \u0000 ") : "");
  if (!corpus) {
    // No observation at all means nothing can be grounded. Say so loudly by
    // returning every specific rather than silently passing the answer.
    return specificsOf(answer);
  }
  return specificsOf(answer).filter((token) => !isSupported(token, corpus));
}

/**
 * The hallucination verdict for one answer, kept separate from whether the
 * task's required facts were present: "found the right page but made up a
 * detail" is a different failure from "did not find the value", and only the
 * first is a hallucination.
 * @param {string} answer
 * @param {readonly string[]} observedTexts
 */
function groundingReport(answer, observedTexts) {
  const specifics = specificsOf(answer);
  const unsupported = unsupportedSpecifics(answer, observedTexts);
  return {
    specifics,
    unsupported,
    hallucinated: unsupported.length > 0,
    // Nothing specific was claimed, so there is nothing to have fabricated.
    proseOnly: specifics.length === 0,
  };
}

module.exports = { canon, specificsOf, unsupportedSpecifics, groundingReport, UNIT_CANON, CANDIDATES };
