"use strict";
// Official hosted NIM catalog, checked 2026-10-03. Model availability still
// depends on the NVIDIA account; unsupported models never silently fall back.
const NVIDIA_MODELS = Object.freeze([
  { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k3", label: "Kimi K3" },
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super" },
].map(Object.freeze));
const DEFAULT_NVIDIA_MODEL = NVIDIA_MODELS[0].id;
const isNvidiaModel = (model) => NVIDIA_MODELS.some((entry) => entry.id === model);
module.exports = { NVIDIA_MODELS, DEFAULT_NVIDIA_MODEL, isNvidiaModel };
