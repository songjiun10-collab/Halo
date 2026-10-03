"use strict";

// Codex CLI planner bridge. Shares ClaudeCodeBridge's process lifecycle and
// proposal validation; only argv, env and output parsing differ.
//
// Codex is an agent with its own tools, so the lockdown is layered:
// - shell/exec, plugins, apps, browser/computer use, sub-agents, memories,
//   hooks and web search are switched off by flag;
// - user config, rules and AGENTS.md are not loaded;
// - the sandbox is read-only with approval_policy "never", and the working
//   root is an empty 0700 temp directory owned by this bridge.
// A probe on codex-cli 0.153.4 (2026-10-02) showed shell gone but
// `apply_patch` and `request_user_input` still offered; the read-only
// sandbox plus "never" approval is what stops a patch from being written.
// The final message is still only a candidate: the host validates it like
// any other planner proposal.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contracts = require("../../../shared/harness-contracts");
const { normalizeUsage } = require("../../../shared/usage");
const { ClaudeCodeBridge, ClaudeCodeBridgeError, ENV_ALLOWLIST, stripCodeFence } = require("./claude-code-bridge");
const { codexEffort, isCodexModel } = require("./codex-models");
const { validateScreenshotAttachment } = require("../computer-use-contract");

const CODEX_DISABLED_FEATURES = Object.freeze([
  "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin",
  "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image",
  "goals", "hooks", "memories", "multi_agent", "multi_agent_v2", "skill_search",
  "skill_mcp_dependency_install", "sleep_tool", "tool_suggest", "in_app_browser",
  "in_app_chat", "in_app_local_automation",
]);
// CODEX_HOME only locates Codex's own login; HALO never reads it.
const CODEX_ENV_ALLOWLIST = Object.freeze([...ENV_ALLOWLIST, "CODEX_HOME"]);

class CodexPlannerBridge extends ClaudeCodeBridge {
  constructor({ command = "codex", spawnFn, model, fast = false } = {}) {
    if (!isCodexModel(model)) {
      throw new ClaudeCodeBridgeError("invalid_model", "model is not an allowlisted Codex model");
    }
    super({ command, spawnFn });
    this._model = model;
    this._promptProvider = "codex";
    this._promptModel = model;
    this._fast = fast === true;
    this.supportsImageAttachments = true;
    this._turnImages = [];
    this._workDir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-codex-planner-"));
    fs.chmodSync(this._workDir, 0o700);
    this._cwd = this._workDir;
  }

  _buildEnv() {
    const env = {};
    for (const key of CODEX_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
  }

  _argsFor(effort) {
    const disables = CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
    return [
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
      "-s", "read-only", "-C", this._workDir, "-m", this._model,
      "-c", `model_reasoning_effort="${codexEffort(this._model, effort)}"`,
      // Fast mode: Codex's priority service tier, offered on every allowlisted model.
      ...(this._fast ? ["-c", 'service_tier="priority"'] : []),
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
      // No --output-schema: Codex's strict structured output rejects the
      // proposal schema's optional fields. The prompt spells out the shape
      // and validateProposalEnvelope stays the real gate.
      ...disables,
      ...this._turnImages.flatMap((attachment) => ["--image", attachment.path]),
      "-",
    ];
  }

  async start(context, { signal, attachments } = {}) {
    const requested = attachments ?? [];
    if (!Array.isArray(requested) || requested.length > 1) {
      throw new ClaudeCodeBridgeError("computer_use_provider_unavailable", "Codex image input accepts one private HALO screenshot per turn");
    }
    const normalized = [];
    try {
      for (const attachment of requested) {
        const image = await validateScreenshotAttachment(attachment);
        const binding = context?.observation?.computerUse;
        if (!binding || binding.taskId !== context.taskId || binding.observationId !== context.observation?.id ||
            binding.documentEpoch !== context.observation?.documentEpoch || binding.digest !== image.digest) {
          throw new Error("screenshot is not bound to this planner observation");
        }
        normalized.push(image);
      }
    } catch {
      throw new ClaudeCodeBridgeError("computer_use_provider_unavailable", "Codex image attachment is missing, unsafe, or does not match the current observation");
    }
    this._turnImages = normalized;
    try {
      return await super.start(context, { signal });
    } finally {
      this._turnImages = [];
    }
  }

  _events(stdout) {
    const events = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (contracts.isPlainObject(event)) events.push(event);
      } catch {
        // Non-JSON lines are diagnostics, never protocol data.
      }
    }
    return events;
  }

  _failure(events) {
    const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
    if (!failed) return null;
    const message = failed.error?.message ?? failed.message;
    return typeof message === "string" ? message.slice(0, 500) : "codex turn failed";
  }

  _exitMessage(stdout, code) {
    return this._failure(this._events(stdout)) ?? `codex CLI exited with code ${code}`;
  }

  _readOutput(stdout) {
    const events = this._events(stdout);
    const failure = this._failure(events);
    if (failure) throw new ClaudeCodeBridgeError("cli_error", failure);
    const messages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string");
    if (!messages.length) throw new ClaudeCodeBridgeError("invalid_cli_output", "codex CLI printed no final agent message");
    const done = events.find((e) => e.type === "turn.completed");
    return { text: stripCodeFence(messages.at(-1).item.text), usage: done ? normalizeUsage("codex", done) : null };
  }

  async close(options) {
    await super.close(options);
    fs.rmSync(this._workDir, { recursive: true, force: true });
  }
}

module.exports = { CodexPlannerBridge, CODEX_DISABLED_FEATURES, CODEX_ENV_ALLOWLIST };
