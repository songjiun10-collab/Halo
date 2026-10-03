"use strict";

// Host-owned planner provider allowlist (docs/superpowers/specs/
// 2026-10-01-planner-router-design.md). The UI, pages and the model may only
// pick an id from this list through host settings; they can never supply a
// command, worker path or argument. Adding a provider means adding one frozen
// entry here and one worker that speaks the existing PlannerStdioAdapter JSONL
// protocol.

const path = require("node:path");
const { isClaudeModel } = require("./providers/claude-models");
const { isCodexModel } = require("./providers/codex-models");
const { isNvidiaModel } = require("./providers/nvidia-models");

const PLANNER_PROVIDERS = Object.freeze(Object.assign(Object.create(null), {
  claude_code: Object.freeze({
    id: "claude_code",
    workerPath: path.join(__dirname, "providers", "claude-code-worker.js"),
    usageProvider: "claude",
    isModel: isClaudeModel,
  }),
  // Codex CLI as a planner (codex-planner-bridge.js), distinct from the
  // "codex" MCP tool provider in host-settings.js.
  codex_cli: Object.freeze({
    id: "codex_cli",
    workerPath: path.join(__dirname, "providers", "codex-planner-worker.js"),
    usageProvider: "codex",
    isModel: isCodexModel,
  }),
  antigravity: Object.freeze({ id: "antigravity", workerPath: path.join(__dirname, "providers", "antigravity-planner-worker.js"), usageProvider: null, supportsFast: false, isModel: (model) => model === "antigravity-default" }),
  cursor: Object.freeze({ id: "cursor", workerPath: path.join(__dirname, "providers", "cursor-planner-worker.js"), usageProvider: null, supportsFast: false, isModel: (model) => model === "cursor-auto" }),
  nvidia: Object.freeze({ id: "nvidia", workerPath: path.join(__dirname, "providers", "nvidia-planner-worker.js"), usageProvider: "nvidia", supportsFast: false, isModel: isNvidiaModel }),
  opencode_cli: Object.freeze({ id: "opencode_cli", workerPath: path.join(__dirname, "providers", "opencode-planner-worker.js"), usageProvider: null, supportsFast: false, isModel: (model) => model === "opencode-default" }),
}));
const PLANNER_PROVIDER_IDS = Object.freeze(["none", ...Object.keys(PLANNER_PROVIDERS)]);

// HALO_PLANNER_COMMAND / HALO_PLANNER_ARGS keep their original meaning: any
// operator override is all-or-nothing and is parsed once per app lifetime.
function parseOperatorOverride(env, command) {
  if (!env.HALO_PLANNER_COMMAND && !env.HALO_PLANNER_ARGS) return null;
  let args = [];
  let configured = Boolean(env.HALO_PLANNER_COMMAND);
  if (env.HALO_PLANNER_ARGS) {
    try {
      args = JSON.parse(env.HALO_PLANNER_ARGS);
      configured = Array.isArray(args) && args.length > 0 && args.every((arg) => typeof arg === "string");
    } catch {
      configured = false;
    }
  }
  return configured ? { configured, command, args } : { configured: false, command: null, args: [] };
}

const unavailable = (source) => ({ source, command: null, args: [], usageProvider: null });

// Called once per task (and per child agent): the result is pinned to that
// planner, so a later settings change only affects tasks started afterwards.
function selectPlannerLaunch({ override, providerId, model, fast = false, nodeCommand }) {
  if (override) {
    // A broken operator override never silently falls back to settings.
    return override.configured
      ? { source: "operator", command: override.command, args: [...override.args], usageProvider: null }
      : unavailable("operator_invalid");
  }
  if (providerId === undefined || providerId === "none") return unavailable("none");
  const entry = typeof providerId === "string" && Object.hasOwn(PLANNER_PROVIDERS, providerId) ? PLANNER_PROVIDERS[providerId] : null;
  if (!entry) return unavailable("invalid_provider");
  // A pinned model is passed only after re-checking the host allowlist.
  if (model !== undefined && !entry.isModel(model)) return unavailable("invalid_model");
  const modelArgs = model === undefined ? [] : ["--model", model];
  const fastArgs = fast === true && entry.supportsFast !== false ? ["--fast"] : [];
  return { source: "settings", command: nodeCommand, args: [entry.workerPath, ...modelArgs, ...fastArgs], usageProvider: entry.usageProvider };
}

// Invoked only by the trusted host factory. Operator overrides and other
// providers do not inherit these keys. This object never enters task context.
function plannerProviderEnv(launch, env = process.env) {
  if (launch.source !== "settings") return {};
  const id = ["antigravity", "cursor", "nvidia"].find((provider) => PLANNER_PROVIDERS[provider].workerPath === launch.args?.[0]);
  if (!id) return {};
  const keys = id === "nvidia" ? ["NVIDIA_API_KEY"] : id === "cursor" ? ["CURSOR_API_KEY", "HALO_CURSOR_CLI_COMMAND"] : ["GEMINI_API_KEY", "HALO_ANTIGRAVITY_CLI_COMMAND"];
  return Object.fromEntries(keys.filter((key) => typeof env[key] === "string" && env[key].length > 0).map((key) => [key, env[key]]));
}

module.exports = { PLANNER_PROVIDER_IDS, PLANNER_PROVIDERS, parseOperatorOverride, selectPlannerLaunch, plannerProviderEnv };
