"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeCodeBridge, ClaudeCodeBridgeError, stripCodeFence } = require("./claude-code-bridge");

const EXTERNAL_MODELS = Object.freeze({ antigravity: "antigravity-default", cursor: "cursor-auto" });
const DENY = Object.freeze({
  antigravity: ["read_file(*)", "write_file(*)", "command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
  cursor: ["Read(**)", "Read(/**)", "Write(**)", "Write(/**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
});

// Policy isolation, not an OS sandbox. Never load the user's HOME/config/MCP/
// plugins/hooks: the CLI receives a new private HOME for every bridge. Phase 1
// uses an explicitly supplied provider API key; cached desktop login is not
// copied. Credentials never enter planner context or the renderer.
class ExternalPlannerBridge extends ClaudeCodeBridge {
  constructor({ provider, model, command, spawnFn, env = process.env } = {}) {
    if (!Object.hasOwn(EXTERNAL_MODELS, provider) || (model !== undefined && model !== EXTERNAL_MODELS[provider])) {
      throw new ClaudeCodeBridgeError("invalid_model", "unknown external planner provider or model");
    }
    super({ command: command || (provider === "cursor" ? "agent" : "agy"), spawnFn });
    this._provider = provider;
    this._sourceEnv = env;
    this._workDir = fs.mkdtempSync(path.join(os.tmpdir(), `halo-${provider}-planner-`));
    fs.chmodSync(this._workDir, 0o700);
    this._cwd = path.join(this._workDir, "workspace");
    fs.mkdirSync(this._cwd, { mode: 0o700 });
    this._configDir = provider === "cursor" ? path.join(this._workDir, ".cursor") : path.join(this._workDir, ".gemini", "antigravity-cli");
    fs.mkdirSync(this._configDir, { recursive: true, mode: 0o700 });
    const config = { permissions: { allow: [], deny: [...DENY[provider]], ask: [] } };
    if (provider === "cursor") Object.assign(config, { version: 1, editor: { vimMode: false } });
    else Object.assign(config, { toolPermission: "strict", allowNonWorkspaceAccess: false, enableTelemetry: false, modelProvider: "gemini" });
    fs.writeFileSync(path.join(this._configDir, provider === "cursor" ? "cli-config.json" : "settings.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
  }

  _buildEnv() {
    const env = { HOME: this._workDir, TMPDIR: this._workDir };
    for (const key of ["PATH", "LANG", "TZ"]) if (this._sourceEnv[key] !== undefined) env[key] = this._sourceEnv[key];
    if (this._provider === "cursor") env.CURSOR_CONFIG_DIR = this._configDir;
    const key = this._provider === "cursor" ? "CURSOR_API_KEY" : "GEMINI_API_KEY";
    if (this._sourceEnv[key]) env[key] = this._sourceEnv[key];
    return env;
  }

  _argsFor(effort) {
    if (this._provider === "cursor") return ["--print", "--output-format", "json", "--mode", "ask", "--workspace", this._cwd, "--model", "auto"];
    const mapped = ["none", "minimal", "low"].includes(effort) ? "low" : effort === "medium" ? "medium" : "high";
    return ["--print", "--output-format", "json", "--input-format", "text", "--effort", mapped, "--print-timeout", "60s", "--disable-slash-commands"];
  }

  _readOutput(stdout) {
    let data;
    try { data = JSON.parse(stdout); } catch { throw new ClaudeCodeBridgeError("invalid_cli_output", "planner did not return one JSON result"); }
    const cursor = this._provider === "cursor";
    if (!data || (cursor ? data.type !== "result" || data.subtype !== "success" || data.is_error !== false : data.status !== "SUCCESS")) {
      throw new ClaudeCodeBridgeError("cli_error", "external planner did not complete successfully");
    }
    const text = cursor ? data.result : data.response;
    if (typeof text !== "string") throw new ClaudeCodeBridgeError("invalid_cli_output", "external planner result has no text");
    // No invented usage: upstream token fields differ; usage support is a
    // separate follow-up. Execution still charges HALO's planner-call budget.
    return { text: stripCodeFence(text), usage: null };
  }

  async close(options) {
    await super.close(options);
    fs.rmSync(this._workDir, { recursive: true, force: true });
  }
}
module.exports = { ExternalPlannerBridge, EXTERNAL_MODELS };
