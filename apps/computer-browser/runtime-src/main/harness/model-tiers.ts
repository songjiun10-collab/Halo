"use strict";

// Five capability/cost tiers for planner models, used when an orchestrator has
// to pick a model for a role. This module only classifies; it never selects.
// 1 = top ... 5 = ultralight. The ids mirror the host
// allowlists (providers/*-models.js); a test fails when an allowlisted model
// has no tier, so a new model cannot slip in unclassified.

type ModelTier = 1 | 2 | 3 | 4 | 5;

const TIER_LABELS: Readonly<Record<ModelTier, string>> = Object.freeze({
  1: "top",
  2: "high-performance balanced",
  3: "computer-use balanced",
  4: "efficient",
  5: "ultralight, low latency",
});

// What each tier is for (the tiers describe fit, not just price).
const TIER_USE: Readonly<Record<ModelTier, string>> = Object.freeze({
  1: "complex, ambiguous multi-step UI work",
  2: "ordinary multi-step work",
  3: "computer-use-centred work",
  4: "narrow, repetitive work",
  5: "simple UI work where response time matters",
});

// Gemini 3.8 Flash (`gemini-3.8-flash`, computer use in preview) is the intended
// tier 3 member and Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) the intended
// tier 5 member. Neither is host-allowlisted yet; the Gemini-backed
// antigravity-default stands in for tier 3 until they are.
// Placement notes (researched 2026-10-04): Fable 5.1 sits above Opus 5.5; Kimi K3
// leads the open models on agentic benchmarks while DeepSeek V4 Pro/Flash and
// Nemotron 3 Super score well below it; GPT-6 Luna is the cheap tier of GPT-6.
// DeepSeek V4.1 Flash jumps well past V4 (Deep-SWE 74.2% vs 54.4%), so it takes
// tier 2. cursor-auto and opencode-default run whatever the CLI selects, so they take
// the ordinary tier.
const MODEL_TIERS: Readonly<Record<string, ModelTier>> = Object.freeze({
  // 1: top
  "gpt-6-astra": 1,
  "claude-opus-5-5": 1,
  "claude-fable-5-1": 1,
  // 2: high-performance balanced, plus older strong models and ordinary workhorses
  "gpt-6.1-sol": 2,
  "claude-sonnet-5-5": 2,
  "deepseek-ai/deepseek-v4.1-flash": 2,
  "claude-opus-4-5-20251101": 2,
  "claude-opus-4-1-20250805": 2,
  "claude-opus-4-20250514": 2,
  "claude-sonnet-4-5-20250929": 2,
  "gpt-6-sol": 2,
  "gpt-5.6-sol": 2,
  "moonshotai/kimi-k3": 2,
  "cursor-auto": 2,
  "opencode-default": 2,
  // 3: computer-use balanced
  "antigravity-default": 3,
  // 4: efficient
  "gpt-6-luna": 4,
  "gpt-5.6-luna": 4,
  "gpt-5.6-terra": 4,
  "gpt-5.5": 4,
  "claude-3-7-sonnet-20250219": 4,
  "claude-sonnet-4-20250514": 4,
  "nvidia/nemotron-3-super-120b-a12b": 4,
  "deepseek-ai/deepseek-v4-pro": 4,
  "deepseek-ai/deepseek-v4-flash": 4,
  // 5: ultralight
  "claude-haiku-5-5": 5,
  "claude-haiku-4-5-20251001": 5,
  "claude-3-5-haiku-20241022": 5,
});

// An unknown or unset model is treated as the ordinary tier rather than
// rejected: tiers guide choice, they are not an allowlist.
const UNKNOWN_MODEL_TIER: ModelTier = 2;

function tierOf(model: unknown): ModelTier {
  return typeof model === "string" && Object.hasOwn(MODEL_TIERS, model) ? MODEL_TIERS[model] : UNKNOWN_MODEL_TIER;
}

function modelsInTier(tier: ModelTier): string[] {
  return Object.keys(MODEL_TIERS).filter((model) => MODEL_TIERS[model] === tier);
}

export = { MODEL_TIERS, TIER_LABELS, TIER_USE, UNKNOWN_MODEL_TIER, tierOf, modelsInTier };
