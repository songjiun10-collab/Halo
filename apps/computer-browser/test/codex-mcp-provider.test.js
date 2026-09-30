"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexMcpProvider, MAX_SCHEMA_BYTES, MAX_ARGS_BYTES } = require("../main/harness/providers/codex-mcp-provider");

const NOTION_ID = "connector_notion";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function tools() {
  return {
    "notion.search": { name: "notion.search", description: "Search pages", _meta: { connector_id: NOTION_ID },
      annotations: { readOnlyHint: true, title: "ignored" }, inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    "notion.create_page": { name: "notion.create_page", description: "Create", _meta: { connector_id: NOTION_ID },
      inputSchema: { type: "object" } },
  };
}

function fixture({ overrides = {}, provider: options = {}, transport: transportOverrides = {} } = {}) {
  const requests = [];
  let starts = 0;
  let closes = 0;
  const responses = {
    "thread/start": { thread: { id: "owned-ephemeral" } },
    "app/installed": { apps: [{ id: NOTION_ID, enabled: true, callable: true }] },
    "mcpServerStatus/list": { data: [
      { name: "codex_apps", authStatus: "oAuth", tools: tools() },
      { name: "local_docs", authStatus: "unsupported", tools: { "docs.read": { name: "docs.read", inputSchema: { type: "object" } } } },
      { name: "node_repl", authStatus: "unsupported", tools: { eval: { name: "eval", inputSchema: { type: "object" } } } },
    ] },
    "mcpServer/tool/call": { content: [{ type: "text", text: "raw" }], structuredContent: { ok: 1 }, isError: false },
    ...overrides,
  };
  const transport = {
    start: async () => { starts += 1; },
    close: async () => { closes += 1; },
    connectorThreadConfig: async () => ({ "mcp_servers.local_docs.enabled": false, "mcp_servers.node_repl.enabled": false }),
    request: async (method, params, opts) => {
      requests.push({ method, params, options: opts });
      const result = responses[method];
      return typeof result === "function" ? result(params, opts) : result;
    },
    ...transportOverrides,
  };
  const provider = new CodexMcpProvider({ transport, ...options });
  return { provider, requests, responses, transport, starts: () => starts, closes: () => closes };
}

test("connections use stable codex:<server> ids; only codex_apps and approved local servers are enabled", async () => {
  const f = fixture();
  const connections = await f.provider.listConnections();
  assert.deepEqual(connections, [
    { id: "codex:codex_apps", provider: "codex", server: "codex_apps", status: "connected", generation: 1 },
    { id: "codex:local_docs", provider: "codex", server: "local_docs", status: "disabled", generation: 1 },
    { id: "codex:node_repl", provider: "codex", server: "node_repl", status: "disabled", generation: 1 },
  ]);
  const start = f.requests.find((r) => r.method === "thread/start").params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "untrusted");
  assert.deepEqual(start.config, { "mcp_servers.local_docs.enabled": false, "mcp_servers.node_repl.enabled": false });
  assert.equal(f.requests.some((r) => r.method === "turn/start"), false);
});

test("an approved local server from the trusted constructor is kept enabled for the owned thread only", async () => {
  const f = fixture({ provider: { localServers: ["local_docs"] } });
  const connections = await f.provider.listConnections();
  assert.equal(connections.find((c) => c.server === "local_docs").status, "connected");
  assert.equal(connections.find((c) => c.server === "node_repl").status, "disabled");
  assert.deepEqual(f.requests.find((r) => r.method === "thread/start").params.config, { "mcp_servers.node_repl.enabled": false });
  for (const localServers of [["codex_apps"], ["bad name"], ["../x"], "local_docs", Array(17).fill("a")]) {
    assert.throws(() => new CodexMcpProvider({ transport: f.transport, localServers }), { code: "invalid_config" });
  }
});

test("auth and failure states are reported without leaking config or auth fields", async () => {
  const f = fixture({ overrides: { "mcpServerStatus/list": { data: [
    { name: "codex_apps", authStatus: "notLoggedIn", tools: {}, config: { token: "SECRET" } },
  ] } }, provider: { localServers: ["local_docs"] } });
  const connections = await f.provider.listConnections();
  assert.deepEqual(connections, [
    { id: "codex:codex_apps", provider: "codex", server: "codex_apps", status: "needs_auth", generation: 1 },
    { id: "codex:local_docs", provider: "codex", server: "local_docs", status: "failed", generation: 1 },
  ]);
  assert.equal(JSON.stringify(connections).includes("SECRET"), false);
  await assert.rejects(f.provider.listTools("codex:codex_apps"), { code: "needs_auth" });
});

test("listTools and describeTool return only bounded generic fields, not raw inventory", async () => {
  const f = fixture();
  const list = await f.provider.listTools("codex:codex_apps");
  assert.deepEqual(list.map((t) => t.name), ["notion.create_page", "notion.search"]);
  assert.deepEqual(Object.keys(list[1]).sort(), ["connectorId", "description", "inputSchema", "name", "schemaTooLarge"]);
  assert.equal(list[1].connectorId, NOTION_ID);
  const descriptor = await f.provider.describeTool("codex:codex_apps", "notion.search");
  assert.deepEqual(descriptor, { connectionId: "codex:codex_apps", provider: "codex", server: "codex_apps",
    name: "notion.search", description: "Search pages", connectorId: NOTION_ID,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true } });
  await assert.rejects(f.provider.describeTool("codex:codex_apps", "missing"), { code: "tool_unavailable" });
  await assert.rejects(f.provider.describeTool("codex:codex_apps", "toString"), { code: "tool_unavailable" });
});

test("an oversized schema is marked in lists and refused for describe and call", async () => {
  const big = { type: "object", description: "x".repeat(MAX_SCHEMA_BYTES) };
  const inventory = tools();
  inventory["notion.search"].inputSchema = big;
  const f = fixture({ overrides: { "mcpServerStatus/list": { data: [{ name: "codex_apps", tools: inventory }] } } });
  const entry = (await f.provider.listTools("codex:codex_apps")).find((t) => t.name === "notion.search");
  assert.equal(entry.inputSchema, null);
  assert.equal(entry.schemaTooLarge, true);
  await assert.rejects(f.provider.describeTool("codex:codex_apps", "notion.search"), { code: "schema_too_large" });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "schema_too_large" });
  assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
});

test("disabled, unknown or malformed connections are refused without starting a worker", async () => {
  const f = fixture();
  for (const id of ["codex:node_repl", "codex:local_docs"]) {
    await assert.rejects(f.provider.listTools(id), { code: "connection_disabled" });
    await assert.rejects(f.provider.call(id, "eval", {}), { code: "connection_disabled" });
  }
  for (const id of ["claude:codex_apps", "codex:", "codex:../x", "codex_apps", 7]) {
    await assert.rejects(f.provider.listTools(id), { code: "unknown_connection" });
  }
  assert.equal(f.starts(), 0);
  assert.equal(f.requests.length, 0);
});

test("a generic hosted call rechecks the connector app and returns the raw MCP result", async () => {
  const f = fixture();
  const result = await f.provider.call("codex:codex_apps", "notion.search", { query: "roadmap" });
  assert.deepEqual(result, f.responses["mcpServer/tool/call"]);
  const methods = f.requests.map((r) => r.method);
  assert.ok(methods.indexOf("app/installed") < methods.indexOf("mcpServer/tool/call"));
  const call = f.requests.at(-1).params;
  assert.deepEqual(call, { threadId: "owned-ephemeral", server: "codex_apps", tool: "notion.search", arguments: { query: "roadmap" } });
  await f.provider.call("codex:codex_apps", "notion.search", { query: "again" });
  assert.equal(f.requests.filter((r) => r.method === "app/installed").length, 2);
  assert.equal(f.starts(), 1);
});

test("a disabled, non-callable or missing connector app blocks the hosted call", async () => {
  for (const apps of [[{ id: NOTION_ID, enabled: false, callable: true }], [{ id: NOTION_ID, enabled: true, callable: false }], []]) {
    const f = fixture({ overrides: { "app/installed": { apps } } });
    await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "app_unavailable" });
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
  }
  const inventory = tools();
  delete inventory["notion.search"]._meta;
  const f = fixture({ overrides: { "mcpServerStatus/list": { data: [{ name: "codex_apps", tools: inventory }] } } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "tool_unavailable" });
});

test("an approved local server call needs no hosted app check", async () => {
  const f = fixture({ provider: { localServers: ["local_docs"] } });
  await f.provider.call("codex:local_docs", "docs.read", { path: "a" });
  assert.equal(f.requests.some((r) => r.method === "app/installed"), false);
  assert.equal(f.requests.at(-1).params.server, "local_docs");
});

test("invalid arguments and tool names are rejected before any request", async () => {
  const f = fixture();
  for (const args of [null, [], "x", 1, { big: "x".repeat(MAX_ARGS_BYTES) }]) {
    await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", args), { code: "invalid_arguments" });
  }
  for (const name of ["", 3, "x".repeat(257)]) {
    await assert.rejects(f.provider.call("codex:codex_apps", name, {}), { code: "invalid_tool" });
  }
  assert.equal(f.requests.length, 0);
});

test("inventory pagination is bounded and a repeated cursor is invalid", async () => {
  let page = 0;
  const f = fixture({ overrides: { "mcpServerStatus/list": (params) => {
    page += 1;
    return { data: [{ name: `srv${page}`, tools: {} }], nextCursor: params.cursor === "c1" ? "c1" : "c1" };
  } } });
  await assert.rejects(f.provider.listConnections(), { code: "invalid_inventory" });
  let n = 0;
  const g = fixture({ overrides: { "mcpServerStatus/list": () => ({ data: [], nextCursor: `c${++n}` }) } });
  await assert.rejects(g.provider.listConnections(), { code: "catalog_too_large" });
  assert.ok(n <= 20);
});

test("a catalog over the tool budget fails closed", async () => {
  const many = {};
  for (let i = 0; i < 1001; i += 1) many[`t${i}`] = { name: `t${i}`, inputSchema: { type: "object" } };
  const f = fixture({ overrides: { "mcpServerStatus/list": { data: [{ name: "codex_apps", tools: many }] } } });
  await assert.rejects(f.provider.listTools("codex:codex_apps"), { code: "catalog_too_large" });
});

test("a hung dispatched call is execution_uncertain, discarded and never replayed", async () => {
  let calls = 0;
  const f = fixture({ provider: { deadlineMs: 30 }, overrides: { "mcpServer/tool/call": () => { calls += 1; return new Promise(() => {}); } } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}),
    (error) => error.code === "execution_uncertain" && error.reason === "deadline" && error.dispatched === true);
  assert.equal(calls, 1);
  assert.equal(f.closes(), 1);
  while (f.provider.closing) await tick();
  await f.provider.call("codex:codex_apps", "notion.search", {}).catch(() => {});
  assert.equal(calls, 2);
  assert.equal(f.starts(), 2);
});

test("a hang before dispatch is a plain deadline, not uncertain execution", async () => {
  const f = fixture({ provider: { deadlineMs: 30 }, overrides: { "mcpServerStatus/list": () => new Promise(() => {}) } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}),
    (error) => error.code === "deadline" && error.dispatched !== true);
  assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
});

test("an rpc error after dispatch is marked dispatched so the broker never assumes no side effect", async () => {
  const f = fixture({ overrides: { "mcpServer/tool/call": () => { const e = new Error("x"); e.code = "rpc_error"; throw e; } } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}),
    (error) => error.code === "rpc_error" && error.dispatched === true);
});

test("an oversized or malformed result is refused after dispatch", async () => {
  const f = fixture({ overrides: { "mcpServer/tool/call": { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] } } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}),
    (error) => error.code === "result_too_large" && error.dispatched === true);
  const g = fixture({ overrides: { "mcpServer/tool/call": "not an object" } });
  await assert.rejects(g.provider.call("codex:codex_apps", "notion.search", {}),
    (error) => error.code === "invalid_result" && error.dispatched === true);
});

test("caller abort mid-call is uncertain and closes the transport", async () => {
  let entered;
  const f = fixture({ overrides: { "mcpServer/tool/call": () => { entered = true; return new Promise(() => {}); } } });
  const controller = new AbortController();
  const pending = f.provider.call("codex:codex_apps", "notion.search", {}, { signal: controller.signal });
  while (!entered) await tick();
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "execution_uncertain" && error.reason === "cancelled");
  assert.equal(f.closes(), 1);
});

test("single flight, memory pressure and pre-aborted signals are refused", async () => {
  let release;
  const f = fixture({ overrides: { "mcpServer/tool/call": () => new Promise((resolve) => { release = resolve; }) } });
  const first = f.provider.call("codex:codex_apps", "notion.search", {});
  await assert.rejects(f.provider.listConnections(), { code: "busy" });
  while (!release) await tick();
  release({ content: [] });
  await first;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.provider.listConnections({ signal: controller.signal }), { code: "cancelled" });
  let allowed = true;
  const g = fixture({ provider: { canRun: () => allowed } });
  allowed = false;
  await assert.rejects(g.provider.listConnections(), { code: "memory_pressure" });
  assert.equal(g.starts(), 0);
  let checks = 0;
  const h = fixture({ provider: { canRun: () => (checks += 1) < 2 } });
  await assert.rejects(h.provider.call("codex:codex_apps", "notion.search", {}), { code: "memory_pressure" });
  assert.equal(h.requests.some((r) => r.method === "mcpServer/tool/call"), false);
});

test("teardown is an admission barrier and a rejected teardown fails closed", async () => {
  let releaseClose;
  const f = fixture({ provider: { deadlineMs: 20 }, overrides: { "mcpServer/tool/call": () => new Promise(() => {}) },
    transport: { close: () => new Promise((resolve) => { releaseClose = resolve; }) } });
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "execution_uncertain" });
  await assert.rejects(f.provider.listConnections(), { code: "busy" });
  releaseClose();
  while (f.provider.closing) await tick();
  const g = fixture({ provider: { deadlineMs: 20 }, overrides: { "mcpServer/tool/call": () => new Promise(() => {}) },
    transport: { close: async () => { throw new Error("close failed"); } } });
  await assert.rejects(g.provider.call("codex:codex_apps", "notion.search", {}), { code: "execution_uncertain" });
  while (g.provider.closing) await tick();
  await assert.rejects(g.provider.listConnections(), { code: "teardown_failed" });
});

test("close aborts active work, waits for teardown and refuses later use", async () => {
  const f = fixture({ transport: { start: () => new Promise(() => {}) } });
  const pending = f.provider.listConnections();
  await tick();
  await f.provider.close();
  await assert.rejects(pending, { code: "cancelled" });
  await assert.rejects(f.provider.listConnections(), { code: "cancelled" });
  assert.equal(f.closes(), 1);
});

test("connection generation is stable per worker and changes after the worker is replaced", async () => {
  const f = fixture({ provider: { deadlineMs: 30 } });
  const first = (await f.provider.listConnections()).find((c) => c.server === "codex_apps");
  const again = (await f.provider.listConnections()).find((c) => c.server === "codex_apps");
  assert.equal(first.generation, again.generation);
  f.responses["mcpServer/tool/call"] = () => new Promise(() => {});
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "execution_uncertain" });
  while (f.provider.closing) await tick();
  const replaced = (await f.provider.listConnections()).find((c) => c.server === "codex_apps");
  assert.notEqual(replaced.generation, first.generation);
});

test("the approved schema, connector and generation are rechecked before dispatch", async () => {
  const approved = tools()["notion.search"];
  const expected = { expectedSchema: { properties: { query: { type: "string" } }, type: "object" },
    expectedConnectorId: NOTION_ID, expectedGeneration: 1 };
  const ok = fixture();
  await ok.provider.call("codex:codex_apps", "notion.search", {}, expected);
  assert.equal(ok.requests.filter((r) => r.method === "mcpServer/tool/call").length, 1);

  const changed = tools();
  changed["notion.search"].inputSchema = { ...approved.inputSchema, properties: { query: { type: "string" }, sendTo: { type: "string" } } };
  const moved = tools();
  moved["notion.search"]._meta = { connector_id: "connector_other" };
  for (const [label, overrides, options] of [
    ["schema", { "mcpServerStatus/list": { data: [{ name: "codex_apps", tools: changed }] } }, expected],
    ["connector", { "mcpServerStatus/list": { data: [{ name: "codex_apps", tools: moved }] }, "app/installed": { apps: [{ id: "connector_other", enabled: true, callable: true }] } }, expected],
    ["generation", {}, { ...expected, expectedGeneration: 2 }],
    ["schema type", {}, { ...expected, expectedSchema: { type: "object", properties: { query: { type: "number" } } } }],
    ["connector null", {}, { ...expected, expectedConnectorId: null }],
  ]) {
    const f = fixture({ overrides });
    await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}, options),
      (error) => error.code === "stale_binding" && error.dispatched !== true, label);
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false, label);
  }
});

test("a worker replaced before dispatch makes the approved generation stale", async () => {
  const f = fixture({ provider: { deadlineMs: 30 } });
  await f.provider.listConnections();
  f.responses["mcpServer/tool/call"] = () => new Promise(() => {});
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}), { code: "execution_uncertain" });
  while (f.provider.closing) await tick();
  f.responses["mcpServer/tool/call"] = { content: [] };
  await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}, { expectedGeneration: 1 }), { code: "stale_binding" });
  assert.equal(f.requests.filter((r) => r.method === "mcpServer/tool/call").length, 1);
});

test("malformed expected bindings are rejected before any request", async () => {
  const f = fixture();
  for (const options of [{ expectedGeneration: "1" }, { expectedGeneration: -1 }, { expectedConnectorId: 3 }, { expectedSchema: [] }]) {
    await assert.rejects(f.provider.call("codex:codex_apps", "notion.search", {}, options), { code: "invalid_binding" });
  }
  assert.equal(f.requests.length, 0);
});

test("invalid deadline config is rejected", () => {
  for (const deadlineMs of [0, -1, 1.5, 120001, "10"]) {
    assert.throws(() => new CodexMcpProvider({ transport: {}, deadlineMs }), { code: "invalid_config" });
  }
});
