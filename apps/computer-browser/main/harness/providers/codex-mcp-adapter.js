"use strict";

const { CodexAppServer, CodexAppServerError } = require("./codex-app-server");

const GITHUB_APP_ID = "connector_76869538009648d5b282a4bb21c3d157";
const SERVER = "codex_apps";
const TOOL = "github.fetch_file";
const MAX_TEXT_BYTES = 4096;
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseRepositories(value = "") {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192) throw new CodexAppServerError("invalid_scope");
  const repos = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (repos.length > 64 || repos.some((repo) => !REPOSITORY_RE.test(repo))) throw new CodexAppServerError("invalid_scope");
  return [...new Set(repos.map((repo) => repo.toLowerCase()))];
}

function githubFileRequest(rawUrl, repositories) {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096 || /[\\\x00-\x20]/.test(rawUrl)) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
  // Ref/path segmentation is deliberately narrow; encoded separators and dot
  // traversal must not change the meaning between Chromium and the connector.
  if (/%|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawUrl)) return null;
  const parts = url.pathname.split("/").slice(1);
  if (parts.length < 5 || parts[2] !== "blob" || parts.some((s) => !s)) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if (!REPOSITORY_RE.test(repo) || !repositories.has(repo.toLowerCase())) return null;
  const ref = parts[3];
  const path = parts.slice(4).join("/");
  if (!/^[A-Za-z0-9_.-]+$/.test(ref) || !/^[A-Za-z0-9_./-]+$/.test(path)) return null;
  return { repository_full_name: repo, path, ref, encoding: "utf-8", start_line: 1, end_line: 100 };
}

function boundedUtf8(value, max = MAX_TEXT_BYTES) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= max) return { text: value, truncated: false, sourceBytes: bytes.length };
  let end = max;
  // Avoid replacing a partial multibyte character with U+FFFD.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true, sourceBytes: bytes.length };
}

function compactResult(result) {
  if (!result || result.isError || !Array.isArray(result.content)) throw new CodexAppServerError("tool_error");
  // Codex connectors return an acknowledgement in content and the actual
  // file in structuredContent. An acknowledgement is never file evidence.
  const file = result.structuredContent;
  if (typeof file?.content !== "string" || file.encoding !== "utf-8") throw new CodexAppServerError("unsupported_result");
  return boundedUtf8(file.content);
}

const DEFAULT_DEADLINE_MS = 10000;
const MAX_DEADLINE_MS = 120000;
// A request that ended this way may still be running inside Codex, so the
// connection is uncertain and must not carry another request.
const UNCERTAIN = new Set(["cancelled", "deadline", "timeout", "closed", "transport_closed", "invalid_frame",
  "frame_too_large", "unknown_response", "write_failed", "read_failed", "spawn_failed", "worker_registration_failed"]);

class CodexMcpAdapter {
  constructor({ repositories = [], transport, transportFactory, now = Date.now, canRun = () => true,
    deadlineMs = DEFAULT_DEADLINE_MS, ...transportOptions } = {}) {
    if (!Array.isArray(repositories) || repositories.length > 64 || repositories.some((repo) => typeof repo !== "string" || !REPOSITORY_RE.test(repo))) {
      throw new CodexAppServerError("invalid_scope");
    }
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) throw new CodexAppServerError("invalid_config");
    this.repositories = new Set(repositories.map((repo) => repo.toLowerCase()));
    this.makeTransport = transportFactory || (transport ? () => transport : () => new CodexAppServer(transportOptions));
    this.transport = transport || null;
    this.deadlineMs = deadlineMs;
    this.now = now;
    this.canRun = canRun;
    this.threadId = null;
    this.busy = false;
    this.closing = null;
    this.teardownFailed = false;
    this.active = null;
    this.closed = false;
  }

  // Every transport step (start, config, RPC) races the lookup signal, so a
  // transport that ignores abort can never hold a lookup past its deadline.
  _bounded(step, signal) {
    if (signal.aborted) return Promise.reject(new CodexAppServerError("cancelled"));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new CodexAppServerError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(step).then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  _request(method, params, signal) {
    return this._bounded(() => this.transport.request(method, params, { signal }), signal);
  }

  // The old worker must be reaped before another may start: `closing` is an
  // admission barrier, so a slow close never overlaps a fresh worker.
  _discardTransport() {
    const transport = this.transport;
    this.transport = null;
    this.threadId = null;
    if (!transport || this.closing) return;
    // A rejected close does not prove the worker exited, so admission stays
    // blocked for the adapter's lifetime rather than risking two workers.
    const closing = Promise.resolve().then(() => transport.close())
      .then(() => { if (this.closing === closing) this.closing = null; },
        () => { this.teardownFailed = true; if (this.closing === closing) this.closing = null; });
    this.closing = closing;
  }

  async _initialize(signal) {
    if (this.threadId) return;
    if (!this.transport) this.transport = this.makeTransport();
    await this._bounded(() => this.transport.start({ signal }), signal);
    if (signal.aborted || this.closed) throw new CodexAppServerError("cancelled");
    // Per-thread overrides from the transport (e.g. disabling unrelated local
    // MCP servers); global Codex configuration is never written.
    const config = typeof this.transport.connectorThreadConfig === "function"
      ? await this._bounded(() => this.transport.connectorThreadConfig({ signal }), signal) : {};
    if (signal.aborted || this.closed) throw new CodexAppServerError("cancelled");
    const result = await this._request("thread/start", {
      ephemeral: true, sandbox: "read-only", approvalPolicy: "untrusted", config: config || {},
      ...(this.transport.cwd ? { cwd: this.transport.cwd } : {}),
    }, signal);
    if (typeof result?.thread?.id !== "string" || !result.thread.id) throw new CodexAppServerError("invalid_thread");
    this.threadId = result.thread.id;
  }

  async readFile(url, { signal: callerSignal } = {}) {
    const args = githubFileRequest(url, this.repositories);
    if (!args) return null;
    if (this.closed || callerSignal?.aborted) throw new CodexAppServerError("cancelled");
    if (this.teardownFailed) throw new CodexAppServerError("teardown_failed");
    if (this.busy || this.closing) throw new CodexAppServerError("busy");
    if (!this.canRun()) throw new CodexAppServerError("memory_pressure");
    this.busy = true;
    const startedAt = this.now();
    const controller = new AbortController();
    this.active = controller;
    const signal = controller.signal;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.deadlineMs);
    try {
      return await this._lookup(url, args, signal, startedAt);
    } catch (error) {
      const code = timedOut ? "deadline" : (signal.aborted || this.closed ? "cancelled" : error?.code);
      // Never replay an uncertain request; a later explicit call gets a fresh transport.
      if (UNCERTAIN.has(code) || UNCERTAIN.has(error?.code)) this._discardTransport();
      if (code !== error?.code) throw new CodexAppServerError(code);
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (this.active === controller) this.active = null;
      this.busy = false;
    }
  }

  async _lookup(url, args, signal, startedAt) {
    await this._initialize(signal);
    const installed = await this._request("app/installed", { threadId: this.threadId, forceRefresh: false }, signal);
    if (!installed?.apps?.some((app) => app.id === GITHUB_APP_ID && app.enabled === true && app.callable === true)) {
      throw new CodexAppServerError("app_unavailable");
    }
    // Inventory remains in the host. Never send its schemas/instructions to
    // the planner. Do not infer permission from readOnlyHint alone.
    let cursor = null;
    let tool;
    const seen = new Set();
    for (let page = 0; page < 8; page += 1) {
      const inventory = await this._request("mcpServerStatus/list", {
        threadId: this.threadId, cursor, limit: 50, detail: "toolsAndAuthOnly",
      }, signal);
      if (!Array.isArray(inventory?.data)) throw new CodexAppServerError("invalid_inventory");
      tool = inventory.data.find((server) => server.name === SERVER)?.tools?.[TOOL];
      if (tool) break;
      cursor = inventory.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== "string" || seen.has(cursor)) throw new CodexAppServerError("invalid_inventory");
      seen.add(cursor);
    }
    if (tool?.name !== TOOL || tool._meta?.connector_id !== GITHUB_APP_ID || tool.annotations?.readOnlyHint !== true ||
        tool.inputSchema?.properties?.repository_full_name?.type !== "string" || tool.inputSchema?.properties?.path?.type !== "string") {
      throw new CodexAppServerError("tool_unavailable");
    }
    if (!this.canRun()) throw new CodexAppServerError("memory_pressure");
    const result = await this._request("mcpServer/tool/call", {
      threadId: this.threadId, server: SERVER, tool: TOOL, arguments: args,
    }, signal);
    if (this.closed || signal.aborted) throw new CodexAppServerError("cancelled");
    const { text, truncated, sourceBytes } = compactResult(result);
    return { text, truncated, sourceBytes, authority: "untrusted_connector", sourceUrl: url,
      server: SERVER, tool: TOOL, latencyMs: Math.max(0, this.now() - startedAt),
      range: { startLine: 1, endLine: 100 } };
  }

  async close() {
    this.closed = true;
    this.active?.abort();
    const transport = this.transport;
    this.transport = null;
    await Promise.all([transport?.close(), this.closing]);
  }
}

module.exports = { CodexMcpAdapter, parseRepositories, githubFileRequest, compactResult,
  boundedUtf8, MAX_TEXT_BYTES, GITHUB_APP_ID, SERVER, TOOL };
