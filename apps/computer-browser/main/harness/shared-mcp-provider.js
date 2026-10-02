"use strict";

// One app-wide MCP provider (one Codex app-server inside the RSS budget)
// shared by every task's broker (docs/superpowers/specs/2026-10-01-routed-mcp-
// tool-sharing-design.md). Each broker gets its own lease:
//
// - provider work from all leases runs strictly one at a time, FIFO, because
//   the provider admits a single operation; a full queue fails fast with
//   `busy` and nothing is retried;
// - closing a lease (a broker's close, including its own deadline teardown)
//   cancels only that lease's work and never the shared provider;
// - listTools/describeTool answers come from the host catalog cache when the
//   connection generation is unchanged. call() is never cached: the provider
//   re-verifies schema, connector and generation right before dispatch.

const DEFAULT_MAX_QUEUE = 8;

class SharedMcpProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "SharedMcpProviderError";
    this.code = code;
  }
}

const fail = (code) => Promise.reject(new SharedMcpProviderError(code));

class SharedMcpProvider {
  constructor({ provider, cache, canRun = () => true, maxQueue = DEFAULT_MAX_QUEUE } = {}) {
    if (!provider || ["listConnections", "listTools", "describeTool", "call", "close"].some((name) => typeof provider[name] !== "function") ||
        !cache || ["observeConnections", "getTools", "setTools", "getTool", "setTool"].some((name) => typeof cache[name] !== "function") ||
        typeof canRun !== "function" || !Number.isInteger(maxQueue) || maxQueue <= 0) {
      throw new SharedMcpProviderError("invalid_config");
    }
    this._provider = provider;
    this._cache = cache;
    this._canRun = canRun;
    this._maxQueue = maxQueue;
    this._queue = [];
    this._active = null;
    this._leases = new Set();
    this._closed = false;
    this._closing = null;
  }

  lease() {
    if (this._closed) throw new SharedMcpProviderError("closed");
    const lease = new SharedMcpLease(this);
    this._leases.add(lease);
    return lease;
  }

  close() {
    if (this._closing) return this._closing;
    this._closed = true;
    for (const lease of [...this._leases]) lease._cancelAll();
    this._leases.clear();
    this._closing = Promise.resolve().then(() => this._provider.close());
    return this._closing;
  }

  _submit(lease, signal, operation) {
    if (this._closed || lease._closed || signal?.aborted) return fail("cancelled");
    if (!this._canRun()) return fail("memory_pressure");
    if (this._queue.length >= this._maxQueue) return fail("busy");
    return new Promise((resolve, reject) => {
      const job = { lease, operation, resolve, reject, settled: false, controller: new AbortController(), signal };
      job.onAbort = () => this._cancel(job);
      signal?.addEventListener("abort", job.onAbort, { once: true });
      this._queue.push(job);
      this._pump();
    });
  }

  _settle(job, outcome, value) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener("abort", job.onAbort);
    if (outcome === "resolve") job.resolve(value);
    else job.reject(value);
  }

  _cancel(job) {
    const index = this._queue.indexOf(job);
    if (index !== -1) this._queue.splice(index, 1);
    // A running job keeps the provider slot until the provider itself settles,
    // so cancellation can never let two operations overlap.
    job.controller.abort();
    this._settle(job, "reject", new SharedMcpProviderError("cancelled"));
  }

  _pump() {
    if (this._active || !this._queue.length) return;
    const job = this._active = this._queue.shift();
    Promise.resolve()
      .then(() => job.operation(job.controller.signal))
      .then((value) => this._settle(job, "resolve", value), (error) => this._settle(job, "reject", error))
      .finally(() => {
        this._active = null;
        this._pump();
      });
  }
}

class SharedMcpLease {
  constructor(shared) {
    this._shared = shared;
    this._closed = false;
  }

  async listConnections({ signal } = {}) {
    const shared = this._shared;
    const connections = await shared._submit(this, signal, (s) => shared._provider.listConnections({ signal: s }));
    shared._cache.observeConnections(connections);
    return connections;
  }

  async listTools(connectionId, { signal } = {}) {
    const shared = this._shared;
    if (this._closed || signal?.aborted) return fail("cancelled");
    const cached = shared._cache.getTools(connectionId);
    if (cached) return cached;
    const tools = await shared._submit(this, signal, (s) => shared._provider.listTools(connectionId, { signal: s }));
    shared._cache.setTools(connectionId, tools);
    return tools;
  }

  async describeTool(connectionId, toolName, { signal } = {}) {
    const shared = this._shared;
    if (this._closed || signal?.aborted) return fail("cancelled");
    const cached = shared._cache.getTool(connectionId, toolName);
    if (cached) return cached;
    const tool = await shared._submit(this, signal, (s) => shared._provider.describeTool(connectionId, toolName, { signal: s }));
    if (tool?.name === toolName) shared._cache.setTool(connectionId, toolName, tool);
    return tool;
  }

  call(connectionId, toolName, args, options = {}) {
    const shared = this._shared;
    return shared._submit(this, options.signal, (s) => shared._provider.call(connectionId, toolName, args, { ...options, signal: s }));
  }

  // Ends this task's use only; the shared provider stays up for other tasks.
  close() {
    this._cancelAll();
    this._shared._leases.delete(this);
    return Promise.resolve();
  }

  _cancelAll() {
    this._closed = true;
    const shared = this._shared;
    for (const job of [...shared._queue]) if (job.lease === this) shared._cancel(job);
    if (shared._active?.lease === this) shared._cancel(shared._active);
  }
}

module.exports = { SharedMcpProvider, SharedMcpProviderError };
