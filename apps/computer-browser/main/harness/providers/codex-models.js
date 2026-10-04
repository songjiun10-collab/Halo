"use strict";

// Host-owned Codex planner model allowlist (visibility "list" models only).
// The standalone CLI's bundled `codex debug models` list (0.153.4) lags the
// server catalog, so the server catalog is the source. Whether
// an id runs still depends on the user's Codex account; a refusal surfaces
// as a normal planner_error.

const HOST_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const entry = (id, label, legacy, description, efforts) => Object.freeze({ id, label, family: "gpt", legacy, description, efforts: Object.freeze(efforts) });
const UP_TO_MAX = ["low", "medium", "high", "xhigh", "max"];
const UP_TO_ULTRA = [...UP_TO_MAX, "ultra"];

// Ids, order and descriptions follow the Codex server catalog
// (~/.codex/models_cache.json, client 0.159.2, fetched 2026-10-02); labels
// are spelled as the Codex app's model menu shows them. legacy marks the
// models the catalog calls "Older"/"Legacy".
const CODEX_MODELS = Object.freeze([
  entry("gpt-6.1-sol", "GPT-6.1 Sol", false, "Latest workhorse model for coding and everyday work.", UP_TO_ULTRA),
  entry("gpt-6-astra", "GPT-6 Astra", false, "Frontier intelligence for the most demanding work.", UP_TO_ULTRA),
  entry("gpt-6-sol", "GPT-6 Sol", false, "Previous generation workhorse model.", UP_TO_ULTRA),
  entry("gpt-6-luna", "GPT-6 Luna", false, "Fast and affordable model for easier tasks.", UP_TO_MAX),
  entry("gpt-5.6-sol", "GPT-5.6 Sol", true, "Older generation workhorse model.", UP_TO_ULTRA),
  entry("gpt-5.6-terra", "GPT-5.6 Terra", true, "Older balanced model for straightforward work.", UP_TO_ULTRA),
  entry("gpt-5.6-luna", "GPT-5.6 Luna", true, "Older fast and efficient model.", UP_TO_MAX),
  entry("gpt-5.5", "GPT-5.5", true, "Legacy coding model.", ["low", "medium", "high", "xhigh"]),
]);
const CODEX_MODEL_IDS = Object.freeze(CODEX_MODELS.map((model) => model.id));
const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";

const isCodexModel = (value) => typeof value === "string" && CODEX_MODEL_IDS.includes(value);

// The host effort, lowered to the highest level this model supports.
function codexEffort(model, effort) {
  const supported = CODEX_MODELS.find((m) => m.id === model)?.efforts ?? [];
  for (let i = HOST_EFFORTS.indexOf(effort); i >= 0; i -= 1) {
    if (supported.includes(HOST_EFFORTS[i])) return HOST_EFFORTS[i];
  }
  return "low";
}

module.exports = { CODEX_MODELS, CODEX_MODEL_IDS, DEFAULT_CODEX_MODEL, codexEffort, isCodexModel };
