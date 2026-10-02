"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { SharedMcpProvider } = require("../main/harness/shared-mcp-provider");
const { McpCatalogCache } = require("../main/harness/mcp-catalog-cache");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeProvider() {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gates = [];
  const provider = {
    generation: 1,
    closed: 0,
    calls,
    get maxInFlight() { return maxInFlight; },
    hold() { const gate = deferred(); gates.push(gate); return gate; },
    async _op(name, args, signal, value) {
      calls.push({ name, args, signal });
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const gate = gates.shift();
        if (gate) {
          await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener("abort",
            () => reject(Object.assign(new Error("aborted"), { code: "cancelled" })), { once: true }))]);
        }
        return value();
      } finally { inFlight -= 1; }
    },
    listConnections({ signal }) {
      return this._op("listConnections", [], signal, () => [{ id: "codex:a", provider: "codex", server: "a", status: "connected", generation: this.generation }]);
    },
    listTools(id, { signal }) { return this._op("listTools", [id], signal, () => [{ name: "t", description: "d", inputSchema: { type: "object" } }]); },
    describeTool(id, name, { signal }) { return this._op("describeTool", [id, name], signal, () => ({ name, inputSchema: { type: "object" } })); },
    call(id, name, args, { signal }) { return this._op("call", [id, name, args], signal, () => ({ content: [] })); },
    close() { this.closed += 1; },
  };
  return provider;
}

test("leases from different tasks reach the shared provider strictly one at a time, FIFO", async () => {
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache() });
  const first = shared.lease(), second = shared.lease();
  const gate = provider.hold();
  const signal = new AbortController().signal;
  const order = [];
  const a = first.listConnections({ signal }).then(() => order.push("a"));
  const b = second.call("codex:a", "t", {}, { signal }).then(() => order.push("b"));
  const c = first.call("codex:a", "t", { n: 1 }, { signal }).then(() => order.push("c"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.calls.length, 1);
  gate.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(provider.maxInFlight, 1);
});

test("a full queue fails fast with busy and is never retried", async () => {
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache(), maxQueue: 1 });
  const lease = shared.lease();
  const gate = provider.hold();
  const signal = new AbortController().signal;
  const running = lease.call("codex:a", "t", {}, { signal });
  const queued = lease.call("codex:a", "t", {}, { signal });
  await assert.rejects(lease.call("codex:a", "t", {}, { signal }), { code: "busy" });
  gate.resolve();
  await Promise.all([running, queued]);
  assert.equal(provider.calls.length, 2);
});

test("memory pressure refuses new provider work but cached catalog reads still answer", async () => {
  const provider = fakeProvider();
  let normal = true;
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache(), canRun: () => normal });
  const lease = shared.lease();
  const signal = new AbortController().signal;
  await lease.listConnections({ signal });
  await lease.listTools("codex:a", { signal });
  normal = false;
  assert.equal((await lease.listTools("codex:a", { signal })).length, 1);
  await assert.rejects(lease.listConnections({ signal }), { code: "memory_pressure" });
  await assert.rejects(lease.call("codex:a", "t", {}, { signal }), { code: "memory_pressure" });
  assert.deepEqual(provider.calls.map((call) => call.name), ["listConnections", "listTools"]);
});

test("the catalog is shared across leases and invalidated when the generation changes", async () => {
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache() });
  const first = shared.lease(), second = shared.lease();
  const signal = new AbortController().signal;
  await first.listConnections({ signal });
  await first.describeTool("codex:a", "t", { signal });
  await second.listConnections({ signal });
  await second.describeTool("codex:a", "t", { signal });
  assert.equal(provider.calls.filter((call) => call.name === "describeTool").length, 1);
  provider.generation = 2;
  await second.listConnections({ signal });
  await second.describeTool("codex:a", "t", { signal });
  assert.equal(provider.calls.filter((call) => call.name === "describeTool").length, 2);
  // Calls are never cached: the provider re-verifies schema/generation itself.
  await first.call("codex:a", "t", {}, { signal });
  await second.call("codex:a", "t", {}, { signal });
  assert.equal(provider.calls.filter((call) => call.name === "call").length, 2);
});

test("a caller abort removes queued work and cancels running work", async () => {
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache() });
  const lease = shared.lease();
  const gate = provider.hold();
  const running = new AbortController(), queued = new AbortController();
  const a = lease.call("codex:a", "t", {}, { signal: running.signal });
  const b = lease.call("codex:a", "t", {}, { signal: queued.signal });
  queued.abort();
  await assert.rejects(b, { code: "cancelled" });
  running.abort();
  await assert.rejects(a, { code: "cancelled" });
  gate.resolve();
  assert.equal(provider.calls.length, 1);
  await assert.rejects(lease.call("codex:a", "t", {}, { signal: queued.signal }), { code: "cancelled" });
});

test("closing one task's lease never closes the shared provider or other leases", async () => {
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache() });
  const first = shared.lease(), second = shared.lease();
  const gate = provider.hold();
  const signal = new AbortController().signal;
  const active = first.call("codex:a", "t", {}, { signal });
  const queued = first.call("codex:a", "t", {}, { signal });
  const other = second.call("codex:a", "t", {}, { signal });
  await first.close();
  await assert.rejects(active, { code: "cancelled" });
  await assert.rejects(queued, { code: "cancelled" });
  await assert.rejects(first.listConnections({ signal }), { code: "cancelled" });
  gate.resolve();
  await other;
  assert.equal(provider.closed, 0);
  await shared.close();
  assert.equal(provider.closed, 1);
  await assert.rejects(second.call("codex:a", "t", {}, { signal }), { code: "cancelled" });
  assert.throws(() => shared.lease(), { code: "closed" });
});

test("invalid configuration is rejected", () => {
  assert.throws(() => new SharedMcpProvider({ provider: {}, cache: new McpCatalogCache() }), { code: "invalid_config" });
  assert.throws(() => new SharedMcpProvider({ provider: fakeProvider() }), { code: "invalid_config" });
  assert.throws(() => new SharedMcpProvider({ provider: fakeProvider(), cache: new McpCatalogCache(), maxQueue: 0 }), { code: "invalid_config" });
});

test("real per-task brokers share one provider and its catalog without closing it", async () => {
  const { GenericMcpBroker } = require("../main/harness/generic-mcp-broker");
  const provider = fakeProvider();
  const shared = new SharedMcpProvider({ provider, cache: new McpCatalogCache() });
  const makeBroker = () => new GenericMcpBroker({
    providers: [shared.lease()], getContext: () => ({ taskId: "t" }), validateArguments: async () => true,
    requestApproval: async () => ({ allowed: false }), journal: { append() {} },
  });
  const first = makeBroker(), second = makeBroker();
  assert.equal((await first.searchTools("t")).length, 1);
  assert.equal((await second.searchTools("t")).length, 1);
  assert.equal((await first.describeTool("codex:a", "t")).toolName, "t");
  assert.equal((await second.describeTool("codex:a", "t")).toolName, "t");
  assert.equal(provider.calls.filter((call) => call.name === "listTools").length, 1);
  assert.equal(provider.calls.filter((call) => call.name === "describeTool").length, 1);
  await first.close();
  assert.equal(provider.closed, 0);
  assert.equal((await second.describeTool("codex:a", "t")).toolName, "t");
  await second.close();
  await shared.close();
  assert.equal(provider.closed, 1);
});
