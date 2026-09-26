"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { looksLikeCaptcha } = require("../shared/captcha-heuristics");

test("flags a known CAPTCHA vendor host", () => {
  assert.equal(looksLikeCaptcha("https://www.google.com/recaptcha/api2/anchor", ""), true);
  assert.equal(looksLikeCaptcha("https://hcaptcha.com/checkbox", ""), true);
  assert.equal(looksLikeCaptcha("https://challenges.cloudflare.com/turnstile", ""), true);
});

test("flags a known anti-bot interstitial title", () => {
  assert.equal(looksLikeCaptcha("https://example.com/", "Just a moment..."), true);
  assert.equal(looksLikeCaptcha("https://example.com/", "Attention Required! | Cloudflare"), true);
  assert.equal(looksLikeCaptcha("https://example.com/", "Please verify you are human"), true);
});

test("is case-insensitive on both url and title", () => {
  assert.equal(looksLikeCaptcha("https://WWW.GOOGLE.COM/RECAPTCHA/x", ""), true);
  assert.equal(looksLikeCaptcha("https://example.com/", "JUST A MOMENT"), true);
});

test("does not flag an ordinary page", () => {
  assert.equal(looksLikeCaptcha("https://example.com/", "Example Domain"), false);
  assert.equal(looksLikeCaptcha("https://news.example.com/article/42", "Today's Headlines"), false);
});

test("tolerates missing or non-string url/title without throwing", () => {
  assert.equal(looksLikeCaptcha(undefined, undefined), false);
  assert.equal(looksLikeCaptcha(null, null), false);
  assert.equal(looksLikeCaptcha("", ""), false);
});
