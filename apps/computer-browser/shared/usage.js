"use strict";

// Provider-neutral planner usage. A provider worker reports whatever its CLI
// printed; normalizeUsage() is the only place that shape is trusted, and it
// returns bounded non-negative numbers or null. Nothing here holds prompt or
// page text.

const PROVIDERS = ["claude", "codex", "nvidia"];
const MAX_COUNT = 1e12;
const MAX_COST_USD = 1e6;

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), MAX_COUNT) : 0;
}

function normalizeUsage(provider, raw) {
  if (!PROVIDERS.includes(provider) || raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw.usage !== null && typeof raw.usage === "object" && !Array.isArray(raw.usage) ? raw.usage : raw;
  const cost = raw.total_cost_usd ?? raw.costUsd ?? raw.cost_usd;
  const normalized = {
    provider,
    inputTokens: count(u.input_tokens ?? u.prompt_tokens ?? u.inputTokens),
    outputTokens: count(u.output_tokens ?? u.completion_tokens ?? u.outputTokens),
    cacheReadTokens: count(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cacheReadTokens),
    cacheCreationTokens: count(u.cache_creation_input_tokens ?? u.cacheCreationTokens),
    costUsd: Number.isFinite(cost) && cost >= 0 ? Math.min(cost, MAX_COST_USD) : 0,
    durationMs: count(raw.duration_ms ?? raw.durationMs),
  };
  const any = normalized.inputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheCreationTokens + normalized.costUsd + normalized.durationMs;
  return any > 0 ? normalized : null;
}

function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0 };
}

function addUsage(totals, usage) {
  totals.calls += 1;
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "durationMs"]) totals[key] += usage[key];
  return totals;
}

module.exports = { PROVIDERS, normalizeUsage, emptyTotals, addUsage };
