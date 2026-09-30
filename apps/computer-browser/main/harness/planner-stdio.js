"use strict";

// Model-independent JSONL stdio transport to a locally-spawned Planner
// worker (design doc section 6). This module knows nothing about any
// specific model provider -- it only frames/deframes JSON lines over a
// child process's stdin/stdout and enforces the wire-level safety rules:
// argv comes only from trusted host config (never the UI, a page, or the
// model itself), the child is spawned with shell:false, its environment is
// an explicit allowlist (app secrets like HALO_APPROVER_KEY/
// HALO_EXECUTOR_KEY never reach it), at most one request is in flight,
// frames are capped at MAX_PLANNER_FRAME_BYTES, and a truncated/wrong-id/
// duplicate/late response is never accepted as the answer to a live
// request. With no command configured this stays honestly "unavailable"
// rather than fabricating a natural-language-sounding proposal.
//
// A same-UID local worker is NOT OS-sandboxed and may have ordinary
// filesystem access -- this module makes no isolation claim beyond keeping
// app secrets out of its environment (design doc section 6, "이 버전은
// 악성 worker 격리를 주장하지 않는다").

const { spawn: nodeSpawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const contracts = require("../../shared/harness-contracts");
const { normalizeUsage } = require("../../shared/usage");

const STDERR_TAIL_MAX_BYTES = 4096;

class PlannerTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlannerTransportError";
    this.code = code;
  }
}

// Only pass through what a plain worker process needs to actually run.
// Never inherit the full parent environment.
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TZ", "TMPDIR"];
const SECRET_ENV_PATTERN = /^HALO_(APPROVER|EXECUTOR)_KEY/i;

function buildWorkerEnv(extraEnv) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (SECRET_ENV_PATTERN.test(key)) {
        throw new PlannerTransportError("invalid_config", `refusing to pass secret-shaped env var "${key}" to a planner worker`);
      }
      env[key] = value;
    }
  }
  return env;
}

const PLANNER_ROLES = ["parent", "child"];

class PlannerStdioAdapter {
  constructor({ command, args = [], cwd, env, timeoutMs, spawnFn, onWorkerStart, onWorkerExit, onUsage, role = "parent" } = {}) {
    if (!PLANNER_ROLES.includes(role)) {
      throw new PlannerTransportError("invalid_config", `role must be one of ${PLANNER_ROLES.join("|")}`);
    }
    this._command = command || null;
    this._args = args;
    this._cwd = cwd;
    this._env = env;
    this._timeoutMs = typeof timeoutMs === "number" ? timeoutMs : contracts.PLANNER_RESPONSE_TIMEOUT_MS;
    this._spawnFn = spawnFn || nodeSpawn;
    this._onWorkerStart = typeof onWorkerStart === "function" ? onWorkerStart : null;
    this._onWorkerExit = typeof onWorkerExit === "function" ? onWorkerExit : null;
    this._onUsage = typeof onUsage === "function" ? onUsage : null;
    this._role = role;
    this._child = null;
    this._inFlight = null; // { requestId, resolve, reject, timer, onAbort, signal }
    this._stdoutBuffer = "";
    this._stderrTail = ""; // bounded diagnostic tail only, never parsed as protocol data
  }

  isConnected() {
    return this._command !== null;
  }

  // Start the trusted worker before the first planner request so process
  // startup can overlap with the browser's initial observation. This does
  // not send a prompt or execute any worker action.
  warm() {
    if (!this._command) return false;
    this._ensureChild();
    return true;
  }

  getStderrTail() {
    return this._stderrTail;
  }

  _ensureChild() {
    if (this._child) return this._child;
    if (!this._command) {
      throw new PlannerTransportError("planner_unavailable", "no planner worker is configured");
    }
    const child = this._spawnFn(this._command, this._args, {
      cwd: this._cwd,
      env: buildWorkerEnv(this._env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const creationTime = Date.now();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdoutData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES);
    });
    // A spawn that fails asynchronously (missing/non-executable path, etc.)
    // emits 'error' on the child; Node terminates the whole process on an
    // unhandled child 'error' event, so this needs its own listener just
    // like 'exit' -- and, depending on platform, 'error' and 'exit' can both
    // fire for the same failure, so `settled` makes cleanup run once.
    let settled = false;
    const handleTermination = (err) => {
      if (settled) return;
      settled = true;
      this._child = null;
      this._failInFlight(err ?? new PlannerTransportError("transport_closed", "planner worker exited while a request was in flight"));
      if (this._onWorkerExit && Number.isInteger(child.pid)) {
        try {
          this._onWorkerExit({ pid: child.pid, creationTime });
        } catch {
          // Worker teardown must not throw from an event callback. Host-side
          // accounting owns its own error reporting and is best-effort here.
        }
      }
    };
    child.on("exit", () => handleTermination());
    child.on("error", (err) => handleTermination(new PlannerTransportError("planner_unavailable", `planner worker failed to start or crashed: ${err.message}`)));
    this._child = child;
    if (this._onWorkerStart && Number.isInteger(child.pid)) {
      try {
        this._onWorkerStart({ pid: child.pid, creationTime });
      } catch (error) {
        this._child = null;
        try {
          child.kill();
        } catch {
          // Preserve the registration failure; the child is no longer trusted
          // to be accounted by the host memory budget.
        }
        throw new PlannerTransportError("worker_registration_failed", `planner worker could not be registered for memory accounting: ${error.message}`);
      }
    }
    return child;
  }

  _onStdoutData(chunk) {
    this._stdoutBuffer += chunk;
    let idx;
    while ((idx = this._stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this._stdoutBuffer.slice(0, idx);
      this._stdoutBuffer = this._stdoutBuffer.slice(idx + 1);
      this._handleLine(line);
    }
    if (this._stdoutBuffer.length > contracts.MAX_PLANNER_FRAME_BYTES) {
      this._failInFlight(new PlannerTransportError("frame_too_large", "planner response line exceeds the frame limit"));
      this._stdoutBuffer = "";
    }
  }

  _handleLine(line) {
    if (!this._inFlight) return; // unsolicited/late line with nothing waiting: drop it
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this._failInFlight(new PlannerTransportError("invalid_response", "planner response is not valid JSON"));
      return;
    }
    if (!contracts.isPlainObject(parsed) || typeof parsed.requestId !== "string") {
      this._failInFlight(new PlannerTransportError("invalid_response", "planner response is missing requestId"));
      return;
    }
    if (parsed.requestId !== this._inFlight.requestId) {
      // Wrong / duplicate / late requestId: never accepted as the answer to
      // the current request. Keep waiting for the real one (or the timeout).
      return;
    }
    // Multi-agent background runtime plan, Task 3: a child agent's planner
    // must never be able to spawn grandchildren. child_plan is a parent-only
    // proposal kind (see shared/harness-contracts.js); a child-role transport
    // rejects it here at the wire boundary rather than trusting the worker
    // process (which is untrusted model-provider code) to police its own role.
    if (this._role === "child" && contracts.isPlainObject(parsed.proposal) && parsed.proposal.kind === "child_plan") {
      this._failInFlight(new PlannerTransportError("child_plan_forbidden", "a child planner returned a forbidden child_plan proposal"));
      return;
    }
    // Subagent communication protocol Task 3 (spec section 10): steer is a
    // parent-to-child-only message kind. Same rationale as the child_plan
    // gate above -- reject it at the wire boundary rather than trusting the
    // (untrusted model-provider) worker process to police its own role.
    // Recipient-relationship/stale-goal checks stay out of scope here; this
    // transport has no authoritative task-relationship view (Task 4's job).
    if (
      this._role === "child" &&
      contracts.isPlainObject(parsed.proposal) &&
      parsed.proposal.kind === "send_message" &&
      parsed.proposal.messageKind === "steer"
    ) {
      this._failInFlight(new PlannerTransportError("steer_forbidden", "a child planner returned a forbidden steer send_message proposal"));
      return;
    }
    if (this._onUsage && parsed.usage !== undefined) {
      const usage = normalizeUsage(parsed.usage && parsed.usage.provider, parsed.usage);
      if (usage) {
        try { this._onUsage(usage); } catch { /* accounting must never fail a proposal */ }
      }
    }
    this._resolveInFlight(parsed.proposal);
  }

  _clearInFlight() {
    if (!this._inFlight) return null;
    const inFlight = this._inFlight;
    clearTimeout(inFlight.timer);
    if (inFlight.signal) inFlight.signal.removeEventListener("abort", inFlight.onAbort);
    this._inFlight = null;
    return inFlight;
  }

  _resolveInFlight(proposal) {
    const inFlight = this._clearInFlight();
    if (inFlight) inFlight.resolve(proposal);
  }

  _failInFlight(err) {
    const inFlight = this._clearInFlight();
    if (inFlight) inFlight.reject(err);
  }

  async next(context, { signal } = {}) {
    if (this._inFlight) {
      throw new PlannerTransportError("transport_busy", "only one planner request may be in flight at a time");
    }
    const child = this._ensureChild();
    const requestId = randomUUID();
    const line = `${JSON.stringify({ requestId, context })}\n`;
    if (Buffer.byteLength(line, "utf8") > contracts.MAX_PLANNER_FRAME_BYTES) {
      throw new PlannerTransportError("frame_too_large", "outgoing planner request exceeds the frame limit");
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._failInFlight(new PlannerTransportError("timeout", `planner did not respond within ${this._timeoutMs}ms`));
      }, this._timeoutMs);

      const onAbort = () => this._failInFlight(new PlannerTransportError("aborted", "planner request was aborted"));

      this._inFlight = { requestId, resolve, reject, timer, signal, onAbort };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdin.write(line, "utf8", (err) => {
        if (err) this._failInFlight(new PlannerTransportError("transport_write_failed", err.message));
      });
    });
  }

  async close() {
    this._failInFlight(new PlannerTransportError("transport_closed", "planner transport was closed"));
    if (this._child) {
      this._child.stdin.end();
      this._child.kill();
      this._child = null;
    }
  }
}

module.exports = { PlannerStdioAdapter, PlannerTransportError };
