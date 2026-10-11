"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { MODEL_TIERS, TIER_LABELS, UNKNOWN_MODEL_TIER, ULTRACODE_TIER, tierOf, modelsInTier, ultracodeEligible } = require("../main/harness/model-tiers");
const { CLAUDE_MODELS, CLAUDE_API_MODELS } = require("../main/harness/providers/claude-models");
const { CODEX_MODELS } = require("../main/harness/providers/codex-models");
const { NVIDIA_MODELS } = require("../main/harness/providers/nvidia-models");

test("every allowlisted planner model has a tier", () => {
  const ids = [
    ...CLAUDE_MODELS.map((model) => model.id),
    ...CLAUDE_API_MODELS.map((model) => model.id), // hidden from pickers, tier kept
    ...CODEX_MODELS.map((model) => model.id),
    ...NVIDIA_MODELS.map((model) => model.id),
    "antigravity-default", "cursor-auto", "opencode-default",
  ];
  for (const id of ids) assert.ok(Object.hasOwn(MODEL_TIERS, id), `${id} has no tier`);
  for (const id of Object.keys(MODEL_TIERS)) assert.ok(ids.includes(id), `${id} is tiered but not allowlisted`);
});

test("there are exactly six tiers (1, 2, 3, 3.5, 4, 5) and each has at least one model", () => {
  assert.deepEqual(Object.keys(TIER_LABELS).map(Number).sort((a, b) => a - b), [1, 2, 3, 3.5, 4, 5]);
  for (const tier of [1, 2, 3, 3.5, 4, 5]) assert.ok(modelsInTier(tier).length > 0, `tier ${tier} is empty`);
});

test("tiers follow the agreed assignment", () => {
  assert.equal(tierOf("gpt-6-astra"), 1);
  assert.equal(tierOf("claude-opus-5-5"), 1);
  assert.equal(tierOf("gpt-6.1-sol"), 2);
  assert.equal(tierOf("claude-sonnet-5-5"), 2);
  assert.equal(tierOf("antigravity-default"), 3);
  assert.equal(tierOf("claude-haiku-5-5"), 3.5);
  assert.equal(tierOf("gpt-6-luna"), 3.5);
  assert.equal(tierOf("claude-haiku-4-5-20251001"), 5);
});

test("unknown ids fall back to the ordinary tier and never read prototype keys", () => {
  assert.equal(tierOf("not-a-model"), UNKNOWN_MODEL_TIER);
  assert.equal(tierOf(undefined), UNKNOWN_MODEL_TIER);
  assert.equal(tierOf("__proto__"), UNKNOWN_MODEL_TIER);
  assert.equal(UNKNOWN_MODEL_TIER, 2);
});

test("ultracode is tier 0, outside the six model tiers, and only for long tasks on a tier-1 model", () => {
  assert.equal(ULTRACODE_TIER, 0);
  assert.equal(Object.hasOwn(TIER_LABELS, 0), false);
  assert.equal(ultracodeEligible("claude-opus-5-5", "long"), true);
  assert.equal(ultracodeEligible("claude-opus-5-5", "fast"), false);
  assert.equal(ultracodeEligible("claude-sonnet-5-5", "long"), false);
  assert.equal(ultracodeEligible(undefined, "long"), false);
});
