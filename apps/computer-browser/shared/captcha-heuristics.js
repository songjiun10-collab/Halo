"use strict";

// Best-effort, read-only heuristic: does this page look like it's showing a
// CAPTCHA or anti-bot interstitial? This is used ONLY to decide whether to
// pause and hand the browser to a human -- it never reads DOM content, never
// inspects challenge tokens, and is never used to solve, click through, or
// route around anything. False positives just cause an unnecessary pause
// (safe); false negatives mean the pause doesn't trigger and the page shows
// up as-is (also safe -- the human still sees whatever loaded).
//
// Intentionally conservative and easy to audit: two flat string-hint lists,
// substring matching on the URL and title Electron already reports via
// did-navigate/page-title-updated. No network calls, no vendor SDKs, no
// fingerprinting of any kind.

const CAPTCHA_HOST_HINTS = [
  "google.com/recaptcha",
  "recaptcha.net",
  "hcaptcha.com",
  "challenges.cloudflare.com",
  "geo.captcha-delivery.com", // DataDome
  "arkoselabs.com",
  "funcaptcha.com",
  "px-cdn.net", // PerimeterX
];

const CAPTCHA_TITLE_HINTS = [
  "just a moment",
  "attention required",
  "verify you are human",
  "verify that you are human",
  "checking your browser",
  "unusual traffic",
  "security check",
  "are you a robot",
  "prove you're human",
];

function looksLikeCaptcha(url, title) {
  const haystackUrl = typeof url === "string" ? url.toLowerCase() : "";
  const haystackTitle = typeof title === "string" ? title.toLowerCase() : "";
  if (CAPTCHA_HOST_HINTS.some((hint) => haystackUrl.includes(hint))) return true;
  if (CAPTCHA_TITLE_HINTS.some((hint) => haystackTitle.includes(hint))) return true;
  return false;
}

module.exports = { looksLikeCaptcha, CAPTCHA_HOST_HINTS, CAPTCHA_TITLE_HINTS };
