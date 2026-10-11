// Generated from runtime-src/main/harness/model-tiers.ts. Do not edit; run npm run build:runtime.
"use strict";
const TIER_LABELS = Object.freeze({
    1: "top",
    2: "high-performance balanced",
    3: "computer-use balanced",
    3.5: "fast and capable",
    4: "efficient",
    5: "ultralight, low latency",
});
// What each tier is for (the tiers describe fit, not just price).
const TIER_USE = Object.freeze({
    1: "complex, ambiguous multi-step UI work",
    2: "ordinary multi-step work",
    3: "computer-use-centred work",
    3.5: "short multi-step work where speed matters but quality still counts",
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
const MODEL_TIERS = Object.freeze({
    // 1: top
    "gpt-6-astra": 1,
    "claude-opus-5-5": 1,
    "claude-fable-5-1": 1,
    // 2: high-performance balanced, plus older strong models and ordinary workhorses
    "gpt-6.1-sol": 2,
    "claude-sonnet-5": 2,
    "claude-opus-5": 2,
    "claude-fable-5": 2,
    "claude-opus-4-8": 2,
    "claude-opus-4-7": 2,
    "claude-opus-4-6": 2,
    "claude-sonnet-4-6": 2,
    "claude-opus-4-5-20251101": 2,
    "claude-opus-4-1-20250805": 2,
    "claude-opus-4-20250514": 2,
    "claude-sonnet-4-5-20250929": 2,
    "claude-sonnet-5-5": 2,
    "deepseek-ai/deepseek-v4.1-flash": 2,
    "gpt-6-sol": 2,
    "gpt-5.6-sol": 2,
    "moonshotai/kimi-k3": 2,
    "cursor-auto": 2,
    "opencode-default": 2,
    // 3: computer-use balanced
    "antigravity-default": 3,
    // 3.5: fast and capable (between computer-use balanced and efficient)
    "claude-haiku-5-5": 3.5,
    "gpt-6-luna": 3.5,
    // 4: efficient
    "gpt-5.6-luna": 4,
    "gpt-5.6-terra": 4,
    "gpt-5.5": 4,
    "claude-3-7-sonnet-20250219": 4,
    "claude-sonnet-4-20250514": 4,
    "nvidia/nemotron-3-super-120b-a12b": 4,
    "deepseek-ai/deepseek-v4-pro": 4,
    "deepseek-ai/deepseek-v4-flash": 4,
    // 5: ultralight
    "claude-haiku-4-5-20251001": 5,
    "claude-3-5-haiku-20241022": 5,
});
// An unknown or unset model is treated as the ordinary tier rather than
// rejected: tiers guide choice, they are not an allowlist.
const UNKNOWN_MODEL_TIER = 2;
function tierOf(model) {
    return typeof model === "string" && Object.hasOwn(MODEL_TIERS, model) ? MODEL_TIERS[model] : UNKNOWN_MODEL_TIER;
}
function modelsInTier(tier) {
    return Object.keys(MODEL_TIERS).filter((model) => MODEL_TIERS[model] === tier);
}
// Tier 0 is not a model: it is an execution mode layered on a tier-1 model
// (fan-out into child tasks, each verified by an independent read-only child).
// It lives outside MODEL_TIERS/TIER_LABELS so the model tiers and the
// allowlist coverage test stay as they are. This only classifies eligibility;
// the host decides whether to run it.
const ULTRACODE_TIER = 0;
const ULTRACODE = Object.freeze({
    tier: ULTRACODE_TIER,
    label: "ultracode (orchestrated, verified)",
    use: "large goals that split into independent parts and need cross-checked results",
    baseTier: 1,
    durations: Object.freeze(["long"]),
});
function ultracodeEligible(model, durationId) {
    return tierOf(model) === ULTRACODE.baseTier && typeof durationId === "string" && ULTRACODE.durations.includes(durationId);
}
module.exports = { MODEL_TIERS, TIER_LABELS, TIER_USE, UNKNOWN_MODEL_TIER, ULTRACODE_TIER, ULTRACODE, tierOf, modelsInTier, ultracodeEligible };
