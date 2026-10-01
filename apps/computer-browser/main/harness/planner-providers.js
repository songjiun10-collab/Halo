"use strict";

// Host-owned planner provider allowlist (docs/superpowers/specs/
// 2026-10-01-planner-router-design.md). The UI, pages and the model may only
// pick an id from this list through host settings; they can never supply a
// command, worker path or argument. Adding a provider means adding one frozen
// entry here and one worker that speaks the existing PlannerStdioAdapter JSONL
// protocol.

const path = require("node:path");

const PLANNER_PROVIDERS = Object.freeze(Object.assign(Object.create(null), {
  claude_code: Object.freeze({
    id: "claude_code",
    workerPath: path.join(__dirname, "providers", "claude-code-worker.js"),
    usageProvider: "claude",
  }),
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
function selectPlannerLaunch({ override, providerId, nodeCommand }) {
  if (override) {
    // A broken operator override never silently falls back to settings.
    return override.configured
      ? { source: "operator", command: override.command, args: [...override.args], usageProvider: null }
      : unavailable("operator_invalid");
  }
  if (providerId === undefined || providerId === "none") return unavailable("none");
  const entry = typeof providerId === "string" && Object.hasOwn(PLANNER_PROVIDERS, providerId) ? PLANNER_PROVIDERS[providerId] : null;
  if (!entry) return unavailable("invalid_provider");
  return { source: "settings", command: nodeCommand, args: [entry.workerPath], usageProvider: entry.usageProvider };
}

module.exports = { PLANNER_PROVIDER_IDS, PLANNER_PROVIDERS, parseOperatorOverride, selectPlannerLaunch };
