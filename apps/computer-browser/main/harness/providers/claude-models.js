"use strict";

// Host-owned Claude planner model allowlist. Host settings, the worker argv
// and ClaudeCodeBridge only ever accept an id from this list, so no page,
// model output or renderer string can become a `claude --model` argument.
// Whether a given id actually runs depends on the user's Claude account and
// CLI version; an unavailable model surfaces as a normal planner_error.

const entry = (id, label, family, legacy) => Object.freeze({ id, label, family, legacy });

const CLAUDE_MODELS = Object.freeze([
  entry("claude-opus-5-5", "Opus 5.5", "opus", false),
  entry("claude-sonnet-5-5", "Sonnet 5.5", "sonnet", false),
  entry("claude-haiku-4-5-20251001", "Haiku 4.5", "haiku", false),
  entry("claude-fable-5-1", "Fable 5.1", "fable", false),
  entry("claude-opus-4-5-20251101", "Opus 4.5", "opus", true),
  entry("claude-opus-4-1-20250805", "Opus 4.1", "opus", true),
  entry("claude-opus-4-20250514", "Opus 4", "opus", true),
  entry("claude-sonnet-4-5-20250929", "Sonnet 4.5", "sonnet", true),
  entry("claude-sonnet-4-20250514", "Sonnet 4", "sonnet", true),
  entry("claude-3-7-sonnet-20250219", "Sonnet 3.7", "sonnet", true),
  entry("claude-3-5-haiku-20241022", "Haiku 3.5", "haiku", true),
]);
const CLAUDE_MODEL_IDS = Object.freeze(CLAUDE_MODELS.map((model) => model.id));
// What an unset plannerModel means in the UI; the bridge itself keeps the
// CLI's "opus" alias when no model is pinned.
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

const isClaudeModel = (value) => typeof value === "string" && CLAUDE_MODEL_IDS.includes(value);

module.exports = { CLAUDE_MODELS, CLAUDE_MODEL_IDS, DEFAULT_CLAUDE_MODEL, isClaudeModel };
