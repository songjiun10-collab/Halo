"use strict";

// Smoke coverage for bench/captcha-defense-bench.js. Everything runs
// in-process against the production heuristic (shared/captcha-heuristics.js);
// no network, no Electron. Pinned assertions follow the accuracy-site.test.js
// precedent: if the hints or their semantics change, these fail loudly here
// instead of the bench silently drifting.

const test = require("node:test");
const assert = require("node:assert/strict");

const bench = require("../bench/captcha-defense-bench");

test("corpora are well-formed: every adversarial entry has a known mechanism and a baseline exists", () => {
  const mechanisms = new Set(["reachable", "structural"]);
  assert.ok(bench.BENIGN.length >= 20);
  assert.ok(bench.ADVERSARIAL.length >= 30);
  assert.ok(bench.ADVERSARIAL.some((e) => e.family === "baseline"), "corpus must contain a baseline family");
  for (const entry of bench.ADVERSARIAL) {
    assert.equal(typeof entry.url, "string", `${entry.name}: url`);
    assert.equal(typeof entry.title, "string", `${entry.name}: title`);
    assert.ok(mechanisms.has(entry.mechanism), `${entry.name}: unknown mechanism ${entry.mechanism}`);
  }
  for (const [name, category, url, title] of bench.BENIGN) {
    assert.equal(typeof name, "string");
    assert.equal(typeof category, "string");
    assert.equal(typeof url, "string");
    assert.equal(typeof title, "string");
  }
});

test("baseline family is fully held (regression floor for the existing hints)", () => {
  const held = bench.evaluateAdversarial().filter((e) => e.family === "baseline");
  assert.ok(held.length >= 10, "baseline corpus shrunk");
  for (const entry of held) {
    assert.equal(entry.held, true, `${entry.name} must stay held`);
  }
});

test("non-near-miss benign pages never flag (no new false pauses)", () => {
  for (const entry of bench.evaluateBenign()) {
    if (entry.category !== "near-miss") {
      assert.equal(entry.flagged, false, `${entry.name} must not flag`);
    }
  }
});

test("near-miss benign pages flag (pinned false-pause cost; update when hints change)", () => {
  const nearMiss = bench.evaluateBenign().filter((e) => e.category === "near-miss");
  assert.ok(nearMiss.length >= 4, "near-miss corpus shrunk");
  for (const entry of nearMiss) {
    assert.equal(entry.flagged, true, `${entry.name} is expected to flag while hints match its substring`);
  }
});

test("structural vectors miss today (pinned open findings of the flat-hint design)", () => {
  for (const entry of bench.evaluateAdversarial()) {
    if (entry.mechanism === "structural") {
      assert.equal(entry.held, false,
        `${entry.name} is expected to miss until the detector gains more than flat substring matching`);
    }
  }
});

test("simulateStream is deterministic per seed and validates its inputs", () => {
  const first = bench.simulateStream({ seed: 7, iterations: 120, prevalence: 0.1 });
  const second = bench.simulateStream({ seed: 7, iterations: 120, prevalence: 0.1 });
  assert.deepEqual(first, second);
  assert.ok(first.challengeCount > 0, "a 10% prevalence stream must contain challenges");
  assert.throws(() => bench.simulateStream({ iterations: 0 }), /iterations/);
  assert.throws(() => bench.simulateStream({ prevalence: 1 }), /prevalence/);
  assert.throws(() => bench.simulateStream({ prevalence: 0 }), /prevalence/);
});

test("wba scenario: a fully-honoring WBA web serves a verified agent zero challenges", () => {
  const stream = bench.simulateStream({ seed: 7, iterations: 200, prevalence: 0.2, wbaSiteShare: 1, signed: true });
  assert.equal(stream.challengeCount, 0, "assumed policy: verified agents are not challenged");
  assert.equal(stream.pauses, stream.benignPaused, "every remaining pause is a false pause");
  assert.ok(stream.verifiedCount > 0, "signed requests verify on honoring sites");
});

test("wba scenario: not signing gains nothing even when sites honor WBA", () => {
  const stream = bench.simulateStream({ seed: 7, iterations: 400, prevalence: 0.2, wbaSiteShare: 1, signed: false });
  assert.equal(stream.verifiedCount, 0);
  assert.ok(stream.challengeCount > 0.1 * 400, "unsigned traffic is still challenged at full prevalence");
});

test("wba scenario: signature verification failures degrade the reduction", () => {
  const clean = bench.simulateStream({ seed: 7, iterations: 400, prevalence: 0.2, wbaSiteShare: 1, signed: true });
  const failing = bench.simulateStream({ seed: 7, iterations: 400, prevalence: 0.2, wbaSiteShare: 1, signed: true, signatureFailureRate: 0.5 });
  assert.ok(failing.challengeCount > clean.challengeCount, "failed signatures are treated as unsigned and challenged");
});

test("wba scenario inputs validate", () => {
  assert.throws(() => bench.simulateStream({ wbaSiteShare: 1.5 }), /wbaSiteShare/);
  assert.throws(() => bench.simulateStream({ signedResidualRate: -0.1 }), /signedResidualRate/);
  assert.throws(() => bench.simulateStream({ signatureFailureRate: 2 }), /signatureFailureRate/);
});
