"use strict";

const { spawn } = require("node:child_process");

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const ENV_KEYS = Object.freeze(["HOME", "PATH", "LANG", "TZ", "TMPDIR"]);

class CodexAppServerError extends Error {
  constructor(code) {
    super(`Codex app-server: ${code}`);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

// Internal host transport. This is not exposed to renderer IPC or the model.
// Codex owns authentication and connector execution. HALO never reads tokens.
class CodexAppServer {
  constructor({ command = "codex", cwd, spawnFn = spawn, timeoutMs = 15000,
    onWorkerStart = () => {}, onWorkerExit = () => {} } = {}) {
    if (typeof command !== "string" || !command || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CodexAppServerError("invalid_config");
    }
    this.command = command;
    this.cwd = cwd;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.onWorkerStart = onWorkerStart;
    this.onWorkerExit = onWorkerExit;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.poisoned = false;
    this.closed = false;
  }

  async start({ signal } = {}) {
    if (signal?.aborted) throw new CodexAppServerError("cancelled");
    if (this.closed || this.poisoned) throw new CodexAppServerError("closed");
    if (this.starting) return this.starting;
    this.starting = this._start(signal);
    return this.starting;
  }

  async _start(signal) {
    const env = {};
    for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    let child;
    try {
      child = this.spawnFn(this.command, ["app-server", "--listen", "stdio://"], {
        cwd: this.cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      this.poisoned = true;
      throw new CodexAppServerError("spawn_failed");
    }
    this.child = child;
    const identity = { pid: child.pid, creationTime: Date.now(), label: "codex-mcp" };
    this.exitPromise = new Promise((resolve) => {
      child.once("close", () => {
        this.child = null;
        clearTimeout(this.killTimer);
        this._fail("transport_closed");
        try { this.onWorkerExit(identity); } catch { /* Lifecycle reporting cannot revive a process. */ }
        resolve();
      });
    });
    child.on("error", () => this._fail("spawn_failed"));
    child.stdin.on("error", () => this._fail("write_failed"));
    child.stdout.on("error", () => this._fail("read_failed"));
    child.stdout.on("data", (bytes) => this._receive(bytes));
    // Drain diagnostics without retaining or logging credential-bearing output.
    child.stderr.on("data", () => {});
    try { this.onWorkerStart(identity); } catch {
      this._fail("worker_registration_failed");
      throw new CodexAppServerError("worker_registration_failed");
    }
    await this.request("initialize", {
      clientInfo: { name: "halo_mcp_adapter", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, { signal });
    this._write({ method: "initialized" });
  }

  _kill(signal) {
    const child = this.child;
    if (!child) return;
    // Include locally configured MCP descendants in shutdown, when possible.
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* Fall back for test doubles / already exited groups. */ }
    }
    try { child.kill(signal); } catch { /* Already exited. */ }
  }

  _fail(code) {
    this.poisoned = true;
    this.buffer = Buffer.alloc(0);
    for (const entry of this.pending.values()) entry.finish(new CodexAppServerError(code));
    this._kill("SIGTERM");
    if (this.child && !this.killTimer) this.killTimer = setTimeout(() => this._kill("SIGKILL"), 500);
  }

  _write(message) {
    if (!this.child || this.poisoned || this.closed) throw new CodexAppServerError("closed");
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new CodexAppServerError("request_too_large");
    this.child.stdin.write(encoded);
  }

  _receive(bytes) {
    if (this.poisoned || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    let index;
    while ((index = this.buffer.indexOf(10)) !== -1) {
      if (index > MAX_FRAME_BYTES) return this._fail("frame_too_large");
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (!line.length) continue;
      let message;
      try { message = JSON.parse(line.toString("utf8")); } catch { return this._fail("invalid_frame"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return this._fail("invalid_frame");
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          // No tool may obtain user permissions through this read-only adapter.
          try {
            this._write({ id: message.id, error: { code: -32601, message: "HALO read-only adapter declines server requests" } });
          } catch { return this._fail("write_failed"); }
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return this._fail("unknown_response");
      if (message.error) pending.finish(new CodexAppServerError("rpc_error"));
      else if (!Object.hasOwn(message, "result")) return this._fail("invalid_frame");
      else pending.finish(null, message.result);
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this._fail("frame_too_large");
  }

  request(method, params, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new CodexAppServerError("cancelled"));
    if (!this.child || this.closed || this.poisoned) return Promise.reject(new CodexAppServerError("closed"));
    if (this.pending.size >= 4) return Promise.reject(new CodexAppServerError("busy"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => this._fail("cancelled");
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      this.pending.set(id, { finish });
      timer = setTimeout(() => this._fail("timeout"), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try { this._write({ id, method, params }); } catch (error) { finish(error); }
    });
  }

  async connectorThreadConfig({ signal } = {}) {
    // Thread-scoped overrides: configured local MCPs are unnecessary for a
    // direct connector read and can otherwise cold-start npm/REPL workers.
    // Keep global configuration and managed policy untouched. In app-server
    // these keys are flat dotted overrides, not a nested mcp_servers object.
    const result = await this.request("config/read", {}, { signal });
    const servers = result?.config?.mcp_servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length > 64) {
      throw new CodexAppServerError("invalid_config");
    }
    const overrides = {};
    for (const name of Object.keys(servers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new CodexAppServerError("unsupported_server_name");
      if (name !== "codex_apps") overrides[`mcp_servers.${name}.enabled`] = false;
    }
    return overrides;
  }

  async close() {
    this.closed = true;
    this._fail("closed");
    if (!this.child) return;
    await this.exitPromise;
  }
}

module.exports = { CodexAppServer, CodexAppServerError, ENV_KEYS, MAX_FRAME_BYTES };
