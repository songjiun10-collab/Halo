"use strict";
// Official hosted NIM catalog, checked 2026-10-03. Model availability still
// depends on the NVIDIA account; unsupported models never silently fall back.
const NVIDIA_MODELS = Object.freeze([
  { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super" },
  { id: "deepseek-ai/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
].map(Object.freeze));
// DeepSeek V4 Flash/Pro reached end of life on the hosted API (HTTP 410, checked
// 2026-10-04). They stay in the allowlist so saved settings still load, but the
// default must be a model that answers.
//
// moonshotai/kimi-k3 is in the allowlist but is NOT usable as a planner today
// (measured 2026-10-08 against the hosted endpoint with a valid key): a trivial
// "say ok" at max_tokens 8 returned ZERO response bytes in 45s of streaming, and
// a full planner turn did not finish within 150s. That is a non-serving endpoint
// rather than mere slowness -- a slow model still emits a slow first token, the
// same test gave DeepSeek V4.1 Flash its first byte at 30s and Nemotron at 0.25s.
// The most likely cause is account-level access (the catalog comment above notes
// availability depends on the account) rather than the model itself. Selecting
// it spends the 55s bridge timeout on every turn, so keep it only while the
// investigation is open; test/nvidia-planner.test.js asserts only that the id is
// routable, never that it answers.
const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-super-120b-a12b";
// Ids discovered from the hosted /v1/models endpoint (host-fetched and
// shape-checked by nvidia-model-catalog). They extend the built-in list only.
let discovered = new Set();
const setDiscoveredNvidiaModels = (ids) => { discovered = new Set(ids.filter((id) => !NVIDIA_MODELS.some((entry) => entry.id === id))); };
// The discovered list survives restarts: a saved plannerModel that only the
// catalog knew about must still validate when settings load at startup.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const loadDiscoveredNvidiaModels = (file) => {
  try {
    const ids = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    if (Array.isArray(ids)) setDiscoveredNvidiaModels(ids.filter((id) => typeof id === "string" && ID_RE.test(id)).slice(0, 500));
  } catch { /* none saved yet */ }
};
const saveDiscoveredNvidiaModels = (file) => {
  const fs = require("node:fs");
  fs.writeFileSync(file, JSON.stringify([...discovered].sort()), { mode: 0o600 });
};
// Planner effort -> the model's own reasoning knob (chat_template_kwargs), or
// null when the model has none or runs without reasoning unless asked.
// GLM 5.3 Flash cannot turn thinking off and defaults to "max", which blew the
// planner's 60 s response budget; DeepSeek V4.x Flash is non-thinking by default.
const nvidiaReasoningKwargs = (model, effort = "medium") => {
  if (typeof model !== "string") return null;
  if (/(^|\/)glm-5\.3/.test(model)) return { reasoning_effort: effort === "low" || effort === "medium" ? "low" : effort === "high" ? "high" : "max" };
  if (/(^|\/)deepseek-v4/.test(model) && ["high", "xhigh", "max", "ultra"].includes(effort)) return { thinking: true, reasoning_effort: effort === "high" ? "high" : "max" };
  return null;
};
const listNvidiaModels = () => [
  ...NVIDIA_MODELS.map((entry) => ({ id: entry.id, label: entry.label, discovered: false })),
  ...[...discovered].sort().map((id) => ({ id, label: id, discovered: true })),
];
// The host validated the saved model against the catalog; a worker process has
// no copy of the discovered list, so it accepts a well-formed id from its argv.
const isNvidiaModelId = (model) => typeof model === "string" && ID_RE.test(model);
const isNvidiaModel = (model) => NVIDIA_MODELS.some((entry) => entry.id === model) || (typeof model === "string" && discovered.has(model));
module.exports = { nvidiaReasoningKwargs, isNvidiaModelId, NVIDIA_MODELS, DEFAULT_NVIDIA_MODEL, isNvidiaModel, setDiscoveredNvidiaModels, loadDiscoveredNvidiaModels, saveDiscoveredNvidiaModels, listNvidiaModels };
