"use strict";

// Constrained adapter for the user's already-authenticated OpenCode CLI.
// HALO sends the planner packet over stdin (never argv), runs a private
// standalone server in an empty temporary directory, and denies every
// OpenCode tool/MCP permission. OpenCode still owns provider credentials and
// its own local session database; HALO never copies those credentials.

const { spawn: nodeSpawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contracts = require("../../../shared/harness-contracts");
const { buildPrompt, buildRoomPrompt, isRoomTurn, parseRoomTurn, parseAndValidateProposal, MAX_CLI_STDOUT_BYTES } = require("./claude-code-bridge");

class OpenCodePlannerError extends Error {
  constructor(code, message) { super(message); this.name = "OpenCodePlannerError"; this.code = code; }
}

const MODEL_ID = "opencode-default";
const AGENT_ID = "halo-planner";
const MAX_OUTPUT_BYTES = MAX_CLI_STDOUT_BYTES;
const ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "TZ", "TMPDIR"]);

// OpenCode's custom agent is a second boundary, not the HALO approval gate.
// Deny wildcard first and pin the agent's own permission set as well. The
// project config is disabled and the temp config directory has no extensions.
// Host-level MCP definitions can still initialize; all tool calls remain denied.
const RESTRICTED_CONFIG = Object.freeze({
  "$schema": "https://opencode.ai/config.json",
  "default_agent": AGENT_ID,
  "permission": { "*": "deny" },
  "tools": { "*": false },
  "mcp": {},
  "plugin": [],
  "agent": {
    [AGENT_ID]: {
      "mode": "primary",
      "permission": { "*": "deny" },
    },
  },
});

function buildOpenCodeEnv({ workDir, baseEnv = process.env } = {}) {
  if (typeof workDir !== "string" || !path.isAbsolute(workDir)) {
    throw new OpenCodePlannerError("invalid_config", "OpenCode work directory must be an absolute path");
  }
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(RESTRICTED_CONFIG);
  env.OPENCODE_CONFIG_DIR = path.join(workDir, "config");
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  fs.mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: false, mode: 0o700 });
  fs.chmodSync(env.OPENCODE_CONFIG_DIR, 0o700);
  return env;
}

function resolveOpenCodeCommand({ home = process.env.HOME, pathValue = process.env.PATH ?? "" } = {}) {
  const candidates = [
    ...pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "opencode")),
    ...(typeof home === "string" && home ? [path.join(home, ".opencode", "bin", "opencode")] : []),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try the next fixed/path-derived candidate */ }
  }
  throw new OpenCodePlannerError("spawn_failed", "OpenCode CLI was not found on the host PATH or in its standard install directory");
}

function parseOpenCodeEvents(stdout, { room = false } = {}) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    throw new OpenCodePlannerError("output_too_large", "OpenCode JSON event stream exceeded its output limit");
  }
  const text = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      throw new OpenCodePlannerError("invalid_cli_output", "OpenCode returned a malformed JSON event");
    }
    if (!contracts.isPlainObject(event) || typeof event.type !== "string") {
      throw new OpenCodePlannerError("invalid_cli_output", "OpenCode returned an unknown event shape");
    }
    if (event.type === "tool_use") {
      throw new OpenCodePlannerError("tool_attempted", "OpenCode attempted to invoke a tool; refusing the planner result");
    }
    if (event.type === "error") {
      throw new OpenCodePlannerError("cli_error", "OpenCode reported a planner error");
    }
    if (event.type === "text" && contracts.isPlainObject(event.part) && typeof event.part.text === "string") {
      text.push(event.part.text);
    }
  }
  const result = text.join("\n").trim();
  if (!result) throw new OpenCodePlannerError("invalid_cli_output", "OpenCode returned no completed text part");
  return { text: result, usage: null, room };
}

class OpenCodePlannerBridge {
  constructor({ command, model = MODEL_ID, spawnFn } = {}) {
    if (model !== MODEL_ID) throw new OpenCodePlannerError("invalid_model", "model is not an allowlisted OpenCode model");
    this._command = command ?? resolveOpenCodeCommand();
    this._spawnFn = spawnFn || nodeSpawn;
    this._lastUsage = null;
    this._closed = false;
    this._child = null;
    this._inFlight = null;
    this._workDir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-opencode-planner-"));
    fs.chmodSync(this._workDir, 0o700);
    try {
      this._env = buildOpenCodeEnv({ workDir: this._workDir });
    } catch (error) {
      fs.rmSync(this._workDir, { recursive: true, force: true });
      throw error;
    }
  }

  isBusy() { return this._child !== null; }

  async start(context, { signal } = {}) {
    if (this._closed) throw new OpenCodePlannerError("closed", "OpenCode planner is closed");
    if (this.isBusy()) throw new OpenCodePlannerError("busy", "only one OpenCode request may be in flight");
    if (!contracts.isPlainObject(context)) throw new OpenCodePlannerError("invalid_field", "context must be a plain object");
    const effort = context.progress?.plannerEffort ?? "medium";
    if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
      throw new OpenCodePlannerError("invalid_effort", "planner effort is not recognized");
    }
    const room = isRoomTurn(context);
    const prompt = room ? buildRoomPrompt(context, null) : buildPrompt(context, null);
    const args = Object.freeze(["--standalone", "run", "--format", "json", "--agent", AGENT_ID]);

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let child;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        this._inFlight = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        fn(value);
      };
      const onAbort = () => {
        settle(reject, new OpenCodePlannerError("cancelled", "OpenCode request was cancelled"));
        try { child?.kill(); } catch { /* close() retains the reap barrier */ }
      };
      this._inFlight = { reject: (error) => settle(reject, error) };
      if (signal?.aborted) { onAbort(); return; }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        child = this._spawnFn(this._command, args, {
          cwd: this._workDir,
          env: this._env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        settle(reject, new OpenCodePlannerError("spawn_failed", error.message));
        return;
      }
      this._child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
          try { child.kill(); } catch { /* best effort */ }
          settle(reject, new OpenCodePlannerError("output_too_large", "OpenCode JSON event stream exceeded its output limit"));
        }
      });
      child.stderr.on("data", () => {}); // Never relay raw prompts, paths, or credentials.
      child.on("error", (error) => settle(reject, new OpenCodePlannerError("spawn_failed", error.message)));
      child.on("close", (code) => {
        this._child = null;
        if (settled) return;
        if (code !== 0) { settle(reject, new OpenCodePlannerError("cli_exit_nonzero", `OpenCode exited with code ${code}`)); return; }
        try {
          const parsed = parseOpenCodeEvents(stdout, { room });
          const proposal = room ? parseRoomTurn(parsed.text) : parseAndValidateProposal(parsed.text);
          this._lastUsage = parsed.usage;
          settle(resolve, proposal);
        } catch (error) { settle(reject, error); }
      });
      child.stdin.on("error", (error) => {
        if (settled) return;
        try { child.kill(); } catch { /* best effort */ }
        settle(reject, new OpenCodePlannerError("stdin_write_failed", error.message));
      });
      // OpenCode run reads a piped prompt from stdin; goals and observations
      // never appear in argv or shell history.
      child.stdin.end(prompt, "utf8");
    });
  }

  takeUsage() { const usage = this._lastUsage; this._lastUsage = null; return usage; }

  cancel() {
    if (!this._inFlight) return;
    this._inFlight.reject(new OpenCodePlannerError("cancelled", "OpenCode request was cancelled"));
    try { this._child?.kill(); } catch { /* best effort */ }
  }

  async close({ killTimeoutMs = 5000 } = {}) {
    this._closed = true;
    const child = this._child;
    if (child) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        child.once("close", finish);
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, killTimeoutMs);
        if (this._inFlight) this.cancel(); else { try { child.kill(); } catch {} }
      });
    }
    fs.rmSync(this._workDir, { recursive: true, force: true });
  }
}

module.exports = { OpenCodePlannerBridge, OpenCodePlannerError, buildOpenCodeEnv, parseOpenCodeEvents, resolveOpenCodeCommand, RESTRICTED_CONFIG, MODEL_ID, AGENT_ID, MAX_OUTPUT_BYTES };
