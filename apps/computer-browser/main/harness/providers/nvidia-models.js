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
const DEFAULT_NVIDIA_MODEL = NVIDIA_MODELS[0].id;
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
const listNvidiaModels = () => [
  ...NVIDIA_MODELS.map((entry) => ({ id: entry.id, label: entry.label, discovered: false })),
  ...[...discovered].sort().map((id) => ({ id, label: id, discovered: true })),
];
const isNvidiaModel = (model) => NVIDIA_MODELS.some((entry) => entry.id === model) || (typeof model === "string" && discovered.has(model));
module.exports = { NVIDIA_MODELS, DEFAULT_NVIDIA_MODEL, isNvidiaModel, setDiscoveredNvidiaModels, loadDiscoveredNvidiaModels, saveDiscoveredNvidiaModels, listNvidiaModels };
