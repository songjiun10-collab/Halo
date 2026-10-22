"use strict";

// The real OsBackend on macOS: a small compiled helper (native/macos-os-helper) speaks one JSON line per
// request over stdin/stdout. The helper has no policy; OsComputerUse decides first. Every input command
// names the app the last observation saw, so a different app in front makes the helper refuse.

const { spawn } = require("node:child_process");

const TIMEOUT_MS = 8000;

class MacOsBackend {
  constructor({ helperPath, spawnFn = spawn, timeoutMs = TIMEOUT_MS } = {}) {
    if (typeof helperPath !== "string" || helperPath.length === 0) throw new TypeError("helperPath is required");
    this._helperPath = helperPath;
    this._spawn = spawnFn;
    this._timeoutMs = timeoutMs;
    this._child = null;
    this._pending = new Map();
    this._nextId = 1;
    this._buffer = "";
    this._bundleId = null;
  }

  _start() {
    if (this._child) return;
    const child = this._spawn(this._helperPath, [], { stdio: ["pipe", "pipe", "ignore"], env: {} });
    this._child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this._buffer += chunk;
      for (let at = this._buffer.indexOf("\n"); at >= 0; at = this._buffer.indexOf("\n")) {
        const line = this._buffer.slice(0, at);
        this._buffer = this._buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = this._pending.get(message.id);
        if (waiter) { this._pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
      }
    });
    const gone = () => {
      this._child = null;
      for (const [, waiter] of this._pending) { clearTimeout(waiter.timer); waiter.reject(Object.assign(new Error("os helper exited"), { code: "os_helper_exited" })); }
      this._pending.clear();
    };
    child.on("exit", gone);
    child.on("error", gone);
  }

  _call(request) {
    this._start();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(Object.assign(new Error("os helper timed out"), { code: "os_helper_timeout" })); }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
    }).then((reply) => {
      if (reply.ok !== true) throw Object.assign(new Error(`os helper: ${reply.error}`), { code: String(reply.error || "os_helper_failed") });
      return reply;
    });
  }

  async observe() {
    const reply = await this._call({ cmd: "observe" });
    this._bundleId = reply.window?.bundleId ?? null;
    return { window: reply.window, controls: reply.controls ?? [] };
  }
  async click(x, y) { await this._call({ cmd: "click", bundleId: this._bundleId, x, y }); }
  async typeText(text) { await this._call({ cmd: "type", bundleId: this._bundleId, text }); }
  async pressKey(key) { await this._call({ cmd: "key", bundleId: this._bundleId, key }); }

  close() { this._child?.kill(); this._child = null; }
}

module.exports = { MacOsBackend };
