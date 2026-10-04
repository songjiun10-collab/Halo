"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexMcpAdapter, parseRepositories, githubFileRequest, compactResult,
  boundedUtf8, MAX_TEXT_BYTES, GITHUB_APP_ID, TOOL, SERVER } = require("../main/harness/providers/codex-mcp-adapter");
const URL = "https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md";
const REPO = "deepseek-ai/deepseek-harness";

function fixture(overrides = {}) {
  const requests = [];
  let starts = 0;
  let closes = 0;
  const tool = { name: TOOL, _meta: { connector_id: GITHUB_APP_ID }, annotations: { readOnlyHint: true },
    inputSchema: { properties: { repository_full_name: { type: "string" }, path: { type: "string" } } } };
  const responses = {
    "thread/start": { thread: { id: "owned-ephemeral" } },
    "app/installed": { apps: [{ id: GITHUB_APP_ID, enabled: true, callable: true }] },
    "mcpServerStatus/list": { data: [{ name: SERVER, tools: { [TOOL]: tool } }] },
    "mcpServer/tool/call": { content: [{ type: "text", text: "Action completed." }],
      structuredContent: { content: "# source file\n", encoding: "utf-8" }, isError: false },
    ...overrides,
  };
  const transport = {
    start: async () => { starts += 1; }, close: async () => { closes += 1; },
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      const result = responses[method];
      return typeof result === "function" ? result(params, options) : result;
    },
  };
  const adapter = new CodexMcpAdapter({ repositories: [REPO], transport });
  return { adapter, requests, responses, tool, starts: () => starts, closes: () => closes };
}

test("trusted repository scope is bounded, exact and case insensitive", () => {
  assert.deepEqual(parseRepositories("Owner/Repo,owner/repo"), ["owner/repo"]);
  assert.deepEqual(parseRepositories(""), []);
  for (const value of ["*", "owner/*", "../owner/repo", "owner/repo,not-a-repo", "a".repeat(8193)]) {
    assert.throws(() => parseRepositories(value), { code: "invalid_scope" });
  }
});

test("file mapping extracts exact scope/ref/path with a finite line range", () => {
  const args = githubFileRequest(URL, new Set([REPO]));
  assert.deepEqual(args, { repository_full_name: REPO, path: "README.md", ref: "master",
    encoding: "utf-8", start_line: 1, end_line: 100 });
});

test("URL tricks, private cross-scope requests and ambiguous paths never start Codex", async () => {
  const f = fixture();
  for (const url of [
    URL.replace("https:", "http:"), URL.replace("github.com", "github.com.evil.test"),
    URL.replace("github.com", "user:secret@github.com"), URL.replace("github.com", "github.com:444"),
    URL + "?token=secret", URL + "#L200", URL.replace("README", "%2fREADME"),
    URL.replace("README.md", "../README.md"), URL.replace("README.md", "./README.md"),
    URL.replace("deepseek-ai", "other-owner"), URL.replace("/blob/", "/tree/"),
    URL.replace("README.md", "\\README.md"), "file:///etc/passwd",
  ]) assert.equal(await f.adapter.readFile(url), null, url);
  assert.equal(f.starts(), 0);
  assert.equal(f.requests.length, 0);
});

test("uses existing connector auth through RPC and returns file data, not acknowledgement", async () => {
  const f = fixture();
  const result = await f.adapter.readFile(URL);
  assert.equal(result.text, "# source file\n");
  assert.equal(result.authority, "untrusted_connector");
  assert.equal(f.requests[0].params.ephemeral, true);
  assert.equal(f.requests[0].params.sandbox, "read-only");
  const call = f.requests.at(-1);
  assert.equal(call.method, "mcpServer/tool/call");
  assert.equal(call.params.threadId, "owned-ephemeral");
  assert.equal(call.params.server, SERVER);
  assert.equal(call.params.tool, TOOL);
  assert.equal(call.params.arguments.repository_full_name, REPO);
  assert.equal(f.requests.some((r) => r.method === "turn/start"), false);
  await f.adapter.readFile(URL);
  assert.equal(f.starts(), 1);
  assert.equal(f.requests.filter((r) => r.method === "app/installed").length, 2);
  await f.adapter.close();
  assert.equal(f.closes(), 1);
});

test("disabled, non-callable and mismatched apps cannot execute a tool", async () => {
  for (const app of [
    { id: GITHUB_APP_ID, enabled: false, callable: true },
    { id: GITHUB_APP_ID, enabled: true, callable: false },
    { id: "other-app", enabled: true, callable: true },
  ]) {
    const f = fixture({ "app/installed": { apps: [app] } });
    await assert.rejects(f.adapter.readFile(URL), { code: "app_unavailable" });
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
  }
});

test("readOnlyHint alone never grants authority to a different tool or connector", async () => {
  for (const mutate of [
    (t) => { t.name = "github.delete_file"; },
    (t) => { t._meta.connector_id = "malicious-app"; },
    (t) => { t.annotations.readOnlyHint = false; },
    (t) => { t.inputSchema.properties.path.type = "object"; },
  ]) {
    const f = fixture();
    mutate(f.tool);
    await assert.rejects(f.adapter.readFile(URL), { code: "tool_unavailable" });
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
  }
});

test("inventory pagination is bounded and repeating cursors fail closed", async () => {
  const f = fixture({ "mcpServerStatus/list": () => ({ data: [], nextCursor: "again" }) });
  await assert.rejects(f.adapter.readFile(URL), { code: "invalid_inventory" });
  assert.equal(f.requests.filter((r) => r.method === "mcpServerStatus/list").length, 2);
});

test("UTF-8 output cannot exceed 4KiB or introduce a split character", () => {
  for (const text of ["한".repeat(4000), "🙂".repeat(4000), "a".repeat(8000)]) {
    const result = boundedUtf8(text);
    assert.ok(Buffer.byteLength(result.text) <= MAX_TEXT_BYTES);
    assert.equal(result.text.includes("\ufffd"), false);
    assert.equal(result.truncated, true);
    assert.equal(result.sourceBytes, Buffer.byteLength(text));
  }
});

test("tool errors, acknowledgements and binary responses never masquerade as file text", () => {
  for (const response of [
    { isError: true, content: [] },
    { content: [{ type: "text", text: "Action completed." }] },
    { content: [], structuredContent: { content: "ZXZpbA==", encoding: "base64" } },
  ]) assert.throws(() => compactResult(response));
});

test("shared broker rejects concurrent calls instead of launching more workers", async () => {
  let release;
  const f = fixture({ "mcpServer/tool/call": () => new Promise((resolve) => { release = resolve; }) });
  const first = f.adapter.readFile(URL);
  await assert.rejects(f.adapter.readFile(URL), { code: "busy" });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release(fixture().responses["mcpServer/tool/call"]);
  await first;
  assert.equal(f.starts(), 1);
});

test("memory pressure prevents worker creation and is rechecked before execution", async () => {
  const f = fixture();
  f.adapter.canRun = () => false;
  await assert.rejects(f.adapter.readFile(URL), { code: "memory_pressure" });
  assert.equal(f.starts(), 0);
  let calls = 0;
  f.adapter.canRun = () => ++calls === 1;
  await assert.rejects(f.adapter.readFile(URL), { code: "memory_pressure" });
  assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false);
});

test("thread/start carries only the transport's per-thread MCP overrides under the call signal", async () => {
  const f = fixture();
  let configSignal;
  f.adapter.transport.connectorThreadConfig = async ({ signal }) => {
    configSignal = signal;
    return { "mcp_servers.node_repl.enabled": false };
  };
  await f.adapter.readFile(URL);
  assert.ok(configSignal instanceof AbortSignal);
  const start = f.requests.find((r) => r.method === "thread/start");
  assert.deepEqual(start.params.config, { "mcp_servers.node_repl.enabled": false });
  assert.equal(start.params.ephemeral, true);
});

test("a transport without connectorThreadConfig starts the thread with an empty override", async () => {
  const f = fixture();
  await f.adapter.readFile(URL);
  assert.deepEqual(f.requests.find((r) => r.method === "thread/start").params.config, {});
});

test("a hung lookup is bounded by a finite deadline, never replayed, and the transport is discarded", async () => {
  let toolCalls = 0;
  let seenSignal;
  const transports = [];
  const factory = () => {
    const f = fixture({ "mcpServer/tool/call": (params, options) => {
      toolCalls += 1;
      seenSignal = options.signal;
      return transports.length === 1 ? new Promise(() => {}) : fixture().responses["mcpServer/tool/call"];
    } });
    transports.push(f);
    return f.adapter.transport;
  };
  const adapter = new CodexMcpAdapter({ repositories: [REPO], transportFactory: factory, deadlineMs: 30 });
  const started = Date.now();
  await assert.rejects(adapter.readFile(URL), { code: "deadline" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(seenSignal.aborted, true);
  assert.equal(toolCalls, 1);
  // Only an explicit new request, after the old worker is reaped, reaches a fresh transport; nothing is replayed.
  while (adapter.closing) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transports[0].closes(), 1);
  const result = await adapter.readFile(URL);
  assert.equal(result.text, "# source file\n");
  assert.equal(transports.length, 2);
  assert.equal(toolCalls, 2);
});

test("caller abort mid-call rejects as cancelled and discards the uncertain transport", async () => {
  const f = fixture({ "mcpServer/tool/call": () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = f.adapter.readFile(URL, { signal: controller.signal });
  while (!f.requests.some((r) => r.method === "mcpServer/tool/call")) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(f.closes(), 1);
  assert.equal(f.adapter.busy, false);
});

test("an app revoked between calls is rechecked and blocks the second tool call", async () => {
  let enabled = true;
  const f = fixture({ "app/installed": () => ({ apps: [{ id: GITHUB_APP_ID, enabled, callable: true }] }) });
  await f.adapter.readFile(URL);
  enabled = false;
  await assert.rejects(f.adapter.readFile(URL), { code: "app_unavailable" });
  assert.equal(f.requests.filter((r) => r.method === "mcpServer/tool/call").length, 1);
});

test("an oversize multibyte file is truncated on a character boundary and flagged", async () => {
  const f = fixture({ "mcpServer/tool/call": { content: [{ type: "text", text: "Action completed." }],
    structuredContent: { content: "가".repeat(3000), encoding: "utf-8" }, isError: false } });
  const result = await f.adapter.readFile(URL);
  assert.equal(result.truncated, true);
  assert.equal(result.sourceBytes, 9000);
  assert.ok(Buffer.byteLength(result.text) <= MAX_TEXT_BYTES);
  assert.equal(result.text.includes("�"), false);
  assert.deepEqual(result.range, { startLine: 1, endLine: 100 });
});

test("a large inventory stays in the host and none of it is returned", async () => {
  const noise = Object.fromEntries(Array.from({ length: 396 }, (_, i) => [`noise.tool_${i}`, { name: `noise.tool_${i}`, inputSchema: { type: "object" } }]));
  const f = fixture();
  f.responses["mcpServerStatus/list"] = { data: [{ name: "other", tools: noise }, { name: SERVER, tools: { ...noise, [TOOL]: f.tool } }] };
  const result = await f.adapter.readFile(URL);
  const serialized = JSON.stringify(result);
  for (const needle of ["noise.tool_0", "noise.tool_395", "inputSchema", "connector_id", "readOnlyHint"]) assert.equal(serialized.includes(needle), false, needle);
});

test("a hung transport start or thread config is bounded by the lookup deadline", async () => {
  for (const hang of ["start", "connectorThreadConfig"]) {
    let startSignal;
    const f = fixture();
    const transport = f.adapter.transport;
    if (hang === "start") transport.start = async (options) => { startSignal = options?.signal; return new Promise(() => {}); };
    else transport.connectorThreadConfig = () => new Promise(() => {});
    const adapter = new CodexMcpAdapter({ repositories: [REPO], transport, deadlineMs: 30 });
    const started = Date.now();
    await assert.rejects(adapter.readFile(URL), { code: "deadline" }, hang);
    assert.ok(Date.now() - started < 1000, hang);
    if (hang === "start") assert.equal(startSignal.aborted, true);
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false, hang);
    assert.equal(f.closes(), 1, hang);
  }
});

test("a slow teardown blocks new workers until the old one is reaped, without replay", async () => {
  let finishClose;
  const transports = [];
  const factory = () => {
    const index = transports.length;
    const f = fixture({ "mcpServer/tool/call": index === 0 ? () => new Promise(() => {}) : fixture().responses["mcpServer/tool/call"] });
    if (index === 0) f.adapter.transport.close = () => new Promise((resolve) => { finishClose = resolve; });
    transports.push(f);
    return f.adapter.transport;
  };
  const adapter = new CodexMcpAdapter({ repositories: [REPO], transportFactory: factory, deadlineMs: 30 });
  await assert.rejects(adapter.readFile(URL), { code: "deadline" });
  while (!finishClose) await new Promise((resolve) => setImmediate(resolve));
  // Old worker still closing: an immediate lookup is refused, not queued, and spawns nothing.
  await assert.rejects(adapter.readFile(URL), { code: "busy" });
  assert.equal(transports.length, 1);
  finishClose();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await adapter.readFile(URL);
  assert.equal(result.text, "# source file\n");
  assert.equal(transports.length, 2);
  assert.equal(transports[0].requests.filter((r) => r.method === "mcpServer/tool/call").length, 1);
  assert.equal(transports[1].requests.filter((r) => r.method === "mcpServer/tool/call").length, 1);
});

test("closing the adapter waits for an in-progress teardown", async () => {
  let finishClose;
  const f = fixture({ "mcpServer/tool/call": () => new Promise(() => {}) });
  f.adapter.transport.close = () => new Promise((resolve) => { finishClose = resolve; });
  const adapter = new CodexMcpAdapter({ repositories: [REPO], transport: f.adapter.transport, deadlineMs: 30 });
  await assert.rejects(adapter.readFile(URL), { code: "deadline" });
  let closed = false;
  const closing = adapter.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finishClose();
  await closing;
  assert.equal(closed, true);
});

test("a rejected teardown is not treated as reaped and permanently blocks new workers", async () => {
  const transports = [];
  const factory = () => {
    const f = fixture({ "mcpServer/tool/call": () => new Promise(() => {}) });
    f.adapter.transport.close = async () => { throw new Error("kill failed"); };
    transports.push(f);
    return f.adapter.transport;
  };
  const adapter = new CodexMcpAdapter({ repositories: [REPO], transportFactory: factory, deadlineMs: 30 });
  await assert.rejects(adapter.readFile(URL), { code: "deadline" });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(adapter.readFile(URL), { code: "teardown_failed" });
  await assert.rejects(adapter.readFile(URL), { code: "teardown_failed" });
  assert.equal(transports.length, 1);
});

test("close() aborts a lookup stuck in start or config promptly instead of waiting for the deadline", async () => {
  for (const hang of ["start", "connectorThreadConfig"]) {
    const f = fixture();
    const transport = f.adapter.transport;
    let entered = false;
    if (hang === "start") transport.start = () => { entered = true; return new Promise(() => {}); };
    else transport.connectorThreadConfig = () => { entered = true; return new Promise(() => {}); };
    const adapter = new CodexMcpAdapter({ repositories: [REPO], transport, deadlineMs: 60000 });
    const pending = adapter.readFile(URL);
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await adapter.close();
    await assert.rejects(pending, { code: "cancelled" }, hang);
    assert.ok(Date.now() - started < 1000, hang);
    assert.equal(f.requests.some((r) => r.method === "mcpServer/tool/call"), false, hang);
  }
});

test("invalid deadline configuration is rejected", () => {
  for (const deadlineMs of [0, -1, 1.5, 120001, "10"]) {
    assert.throws(() => new CodexMcpAdapter({ repositories: [REPO], transport: fixture().adapter.transport, deadlineMs }), { code: "invalid_config" });
  }
});

test("cancelled or closed adapter cannot return a late result", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.adapter.readFile(URL, { signal: controller.signal }), { code: "cancelled" });
  await f.adapter.close();
  await assert.rejects(f.adapter.readFile(URL), { code: "cancelled" });
});
