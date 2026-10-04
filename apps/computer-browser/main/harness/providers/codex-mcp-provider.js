"use strict";

const { CodexAppServer, CodexAppServerError } = require("./codex-app-server");

// Internal Codex backend for the generic MCP broker. Nothing here grants
// permission: the root broker approves each call before `call` runs, and no
// method is exposed to renderer IPC or the model.
const PROVIDER = "codex";
const HOSTED_SERVER = "codex_apps";
const SERVER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LOCAL_SERVERS = 16;
const MAX_TOOL_NAME = 256;
const MAX_DESCRIPTION = 1024;
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;
const MAX_TOOLS = 1000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_ARGS_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_DEADLINE_MS = 10000;
const MAX_DEADLINE_MS = 120000;
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
// A request that ended this way may still be running inside Codex, so the
// connection is uncertain and must not carry another request.
const UNCERTAIN = new Set(["cancelled", "deadline", "timeout", "closed", "transport_closed", "invalid_frame",
  "frame_too_large", "unknown_response", "write_failed", "read_failed", "spawn_failed", "worker_registration_failed"]);

function failure(code, extra = {}) {
  return Object.assign(new CodexAppServerError(code), extra);
}

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value) ?? ""); } catch { return Infinity; }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Strict JSON identity with sorted keys; anything that is not plain JSON has
// no canonical form and can never match an approved binding.
function canonical(value, depth = 0) {
  if (depth > 32) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, depth + 1));
    return items.includes(undefined) ? undefined : `[${items.join(",")}]`;
  }
  if (isPlainObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.keys(value).sort().map((key) => {
      const item = canonical(value[key], depth + 1);
      return item === undefined ? undefined : `${JSON.stringify(key)}:${item}`;
    });
    return entries.includes(undefined) ? undefined : `{${entries.join(",")}}`;
  }
  return undefined;
}

function serverOf(connectionId) {
  if (typeof connectionId !== "string" || !connectionId.startsWith(`${PROVIDER}:`)) throw failure("unknown_connection");
  const server = connectionId.slice(PROVIDER.length + 1);
  if (!SERVER_RE.test(server)) throw failure("unknown_connection");
  return server;
}

function connectorIdOf(tool) {
  const id = tool?._meta?.connector_id;
  return typeof id === "string" && id ? id : null;
}

function summary(name, tool) {
  const schemaTooLarge = !isPlainObject(tool.inputSchema) || jsonBytes(tool.inputSchema) > MAX_SCHEMA_BYTES;
  return { name, description: typeof tool.description === "string" ? tool.description.slice(0, MAX_DESCRIPTION) : "",
    inputSchema: schemaTooLarge ? null : tool.inputSchema, schemaTooLarge, connectorId: connectorIdOf(tool) };
}

class CodexMcpProvider {
  constructor({ transport, transportFactory, now = Date.now, canRun = () => true, localServers = [],
    deadlineMs = DEFAULT_DEADLINE_MS, ...transportOptions } = {}) {
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) throw failure("invalid_config");
    // Local servers start processes, so only a trusted host caller may enable
    // them; nothing discovered at runtime is started automatically.
    if (!Array.isArray(localServers) || localServers.length > MAX_LOCAL_SERVERS ||
        localServers.some((name) => typeof name !== "string" || !SERVER_RE.test(name) || name === HOSTED_SERVER)) {
      throw failure("invalid_config");
    }
    this.enabled = new Set([HOSTED_SERVER, ...localServers]);
    this.localServers = new Set(localServers);
    this.makeTransport = transportFactory || (transport ? () => transport : () => new CodexAppServer(transportOptions));
    this.transport = transport || null;
    this.deadlineMs = deadlineMs;
    this.now = now;
    this.canRun = canRun;
    this.threadId = null;
    this.generation = 0;
    this.busy = false;
    this.closing = null;
    this.teardownFailed = false;
    this.active = null;
    this.closed = false;
  }

  async listConnections({ signal } = {}) {
    return this._run(async (s) => {
      const servers = await this._inventory(s);
      const connections = [];
      const generation = this.generation;
      for (const [server, entry] of servers) {
        connections.push({ id: `${PROVIDER}:${server}`, provider: PROVIDER, server,
          status: this.enabled.has(server) ? this._status(entry) : "disabled", generation });
      }
      for (const server of this.enabled) {
        if (!servers.has(server)) connections.push({ id: `${PROVIDER}:${server}`, provider: PROVIDER, server, status: "failed", generation });
      }
      return connections.sort((a, b) => a.server.localeCompare(b.server));
    }, signal);
  }

  async listTools(connectionId, { signal } = {}) {
    const server = this._enabledServer(connectionId);
    return this._run(async (s) => {
      const tools = await this._tools(server, s);
      return Object.keys(tools).sort().map((name) => summary(name, tools[name]));
    }, signal);
  }

  async describeTool(connectionId, toolName, { signal } = {}) {
    const server = this._enabledServer(connectionId);
    this._checkToolName(toolName);
    return this._run(async (s) => {
      const tool = this._tool(await this._tools(server, s), toolName);
      const { description, inputSchema, schemaTooLarge, connectorId } = summary(toolName, tool);
      if (schemaTooLarge) throw failure("schema_too_large");
      const annotations = {};
      for (const hint of HINTS) if (typeof tool.annotations?.[hint] === "boolean") annotations[hint] = tool.annotations[hint];
      // Annotations are untrusted provider claims; policy is decided by the host.
      return { connectionId, provider: PROVIDER, server, name: toolName, description, connectorId, inputSchema, annotations };
    }, signal);
  }

  async call(connectionId, toolName, args, { signal, expectedSchema, expectedConnectorId, expectedGeneration } = {}) {
    const server = this._enabledServer(connectionId);
    this._checkToolName(toolName);
    if (!isPlainObject(args) || jsonBytes(args) > MAX_ARGS_BYTES) throw failure("invalid_arguments");
    if ((expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 0)) ||
        (expectedConnectorId !== undefined && expectedConnectorId !== null && typeof expectedConnectorId !== "string") ||
        (expectedSchema !== undefined && canonical(expectedSchema)?.[0] !== "{")) {
      throw failure("invalid_binding");
    }
    return this._run(async (s, state) => {
      const tool = this._tool(await this._tools(server, s), toolName);
      if (summary(toolName, tool).schemaTooLarge) throw failure("schema_too_large");
      // The broker approved a specific worker, connector and schema. Discovery
      // here is fresh, so anything that changed since approval is refused
      // before dispatch instead of running under a stale approval.
      if ((expectedGeneration !== undefined && this.generation !== expectedGeneration) ||
          (expectedConnectorId !== undefined && connectorIdOf(tool) !== expectedConnectorId) ||
          (expectedSchema !== undefined && canonical(tool.inputSchema) !== canonical(expectedSchema))) {
        throw failure("stale_binding");
      }
      if (!this.localServers.has(server)) {
        // Hosted connectors can be revoked at any time; recheck right before the call.
        const connectorId = connectorIdOf(tool);
        if (!connectorId) throw failure("tool_unavailable");
        const installed = await this._request("app/installed", { threadId: this.threadId, forceRefresh: false }, s);
        if (!installed?.apps?.some((app) => app.id === connectorId && app.enabled === true && app.callable === true)) {
          throw failure("app_unavailable");
        }
      }
      if (!this.canRun()) throw failure("memory_pressure");
      state.dispatched = true;
      const result = await this._request("mcpServer/tool/call", {
        threadId: this.threadId, server, tool: toolName, arguments: args,
      }, s);
      if (this.closed || s.aborted) throw failure("cancelled");
      if (!isPlainObject(result)) throw failure("invalid_result");
      if (jsonBytes(result) > MAX_RESULT_BYTES) throw failure("result_too_large");
      return result;
    }, signal);
  }

  _enabledServer(connectionId) {
    const server = serverOf(connectionId);
    if (!this.enabled.has(server)) throw failure("connection_disabled");
    return server;
  }

  _checkToolName(toolName) {
    if (typeof toolName !== "string" || !toolName || toolName.length > MAX_TOOL_NAME) throw failure("invalid_tool");
  }

  _status(entry) {
    if (entry.authStatus === "notLoggedIn") return "needs_auth";
    return isPlainObject(entry.tools) ? "connected" : "failed";
  }

  _tool(tools, toolName) {
    const tool = Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
    if (!isPlainObject(tool) || (tool.name !== undefined && tool.name !== toolName)) throw failure("tool_unavailable");
    return tool;
  }

  async _tools(server, signal) {
    const entry = (await this._inventory(signal)).get(server);
    if (!entry) throw failure("connection_unavailable");
    const status = this._status(entry);
    if (status !== "connected") throw failure(status);
    if (Object.keys(entry.tools).length > MAX_TOOLS) throw failure("catalog_too_large");
    return entry.tools;
  }

  // Inventory stays in host memory for one operation and is never returned raw.
  async _inventory(signal) {
    const servers = new Map();
    const seen = new Set();
    let cursor = null;
    let bytes = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this._request("mcpServerStatus/list", {
        threadId: this.threadId, cursor, limit: PAGE_LIMIT, detail: "toolsAndAuthOnly",
      }, signal);
      if (!Array.isArray(result?.data)) throw failure("invalid_inventory");
      bytes += jsonBytes(result.data);
      if (bytes > MAX_CATALOG_BYTES) throw failure("catalog_too_large");
      for (const entry of result.data) {
        if (isPlainObject(entry) && typeof entry.name === "string" && SERVER_RE.test(entry.name)) servers.set(entry.name, entry);
      }
      cursor = result.nextCursor;
      if (!cursor) return servers;
      if (typeof cursor !== "string" || seen.has(cursor)) throw failure("invalid_inventory");
      seen.add(cursor);
    }
    throw failure("catalog_too_large");
  }

  // Every transport step races the operation signal, so a transport that
  // ignores abort can never hold an operation past its deadline.
  _bounded(step, signal) {
    if (signal.aborted) return Promise.reject(failure("cancelled"));
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(step).then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  _request(method, params, signal) {
    return this._bounded(() => this.transport.request(method, params, { signal }), signal);
  }

  // `closing` is an admission barrier: no new worker starts before the old one
  // is reaped, and a rejected close blocks new workers for good.
  _discardTransport() {
    const transport = this.transport;
    this.transport = null;
    this.threadId = null;
    if (!transport || this.closing) return;
    const closing = Promise.resolve().then(() => transport.close())
      .then(() => { if (this.closing === closing) this.closing = null; },
        () => { this.teardownFailed = true; if (this.closing === closing) this.closing = null; });
    this.closing = closing;
  }

  async _initialize(signal) {
    if (this.threadId) return;
    if (!this.transport) this.transport = this.makeTransport();
    await this._bounded(() => this.transport.start({ signal }), signal);
    if (signal.aborted || this.closed) throw failure("cancelled");
    // Per-thread overrides only; global Codex configuration is never written
    // and its values never leave this method.
    const overrides = typeof this.transport.connectorThreadConfig === "function"
      ? await this._bounded(() => this.transport.connectorThreadConfig({ signal }), signal) : {};
    if (signal.aborted || this.closed) throw failure("cancelled");
    const config = { ...(isPlainObject(overrides) ? overrides : {}) };
    for (const server of this.localServers) delete config[`mcp_servers.${server}.enabled`];
    const result = await this._request("thread/start", {
      ephemeral: true, sandbox: "read-only", approvalPolicy: "untrusted", config,
      ...(this.transport.cwd ? { cwd: this.transport.cwd } : {}),
    }, signal);
    if (typeof result?.thread?.id !== "string" || !result.thread.id) throw failure("invalid_thread");
    this.threadId = result.thread.id;
    // A new worker may carry different auth or configuration, so approvals
    // bound to the previous generation must not carry over.
    this.generation += 1;
  }

  async _run(work, callerSignal) {
    if (this.closed || callerSignal?.aborted) throw failure("cancelled");
    if (this.teardownFailed) throw failure("teardown_failed");
    if (this.busy || this.closing) throw failure("busy");
    if (!this.canRun()) throw failure("memory_pressure");
    this.busy = true;
    const controller = new AbortController();
    this.active = controller;
    const signal = controller.signal;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.deadlineMs);
    const state = { dispatched: false };
    try {
      await this._initialize(signal);
      return await work(signal, state);
    } catch (error) {
      const code = timedOut ? "deadline" : (signal.aborted || this.closed ? "cancelled" : (error?.code || "provider_error"));
      const uncertain = UNCERTAIN.has(code) || UNCERTAIN.has(error?.code);
      // Never replay an uncertain request; a later explicit call gets a fresh worker.
      if (uncertain) this._discardTransport();
      // After dispatch no error proves the tool had no external effect.
      if (state.dispatched) {
        throw uncertain ? failure("execution_uncertain", { reason: code, dispatched: true }) : failure(code, { dispatched: true });
      }
      throw failure(code);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (this.active === controller) this.active = null;
      this.busy = false;
    }
  }

  async close() {
    this.closed = true;
    this.active?.abort();
    const transport = this.transport;
    this.transport = null;
    await Promise.all([transport?.close(), this.closing]);
  }
}

module.exports = { CodexMcpProvider, PROVIDER, HOSTED_SERVER, MAX_SCHEMA_BYTES, MAX_ARGS_BYTES, MAX_RESULT_BYTES,
  MAX_TOOLS, MAX_PAGES };
