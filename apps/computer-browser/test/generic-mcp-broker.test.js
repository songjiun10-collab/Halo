"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { GenericMcpBroker } = require("../main/harness/generic-mcp-broker");

function fixture(overrides = {}) {
  let context = { taskId: "task", goalVersion: 1, policyRevision: 1 };
  let schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
  const events = [], calls = [];
  const provider = {
    async listConnections() { return [{ id: "codex:codex_apps", provider: "codex", server: "codex_apps", status: "connected", generation: 1 }]; },
    async listTools() { return [{ name: "notes.create", description: "create a note", inputSchema: schema, connectorId: "notes" }]; },
    async describeTool() { return { name: "notes.create", inputSchema: schema, connectorId: "notes" }; },
    async call(connectionId, tool, args) { calls.push({ connectionId, tool, args }); return { content: [{ type: "text", text: "created" }] }; },
    async close() {}, ...overrides.provider,
  };
  const broker = new GenericMcpBroker({ providers: [provider], getContext: () => context,
    validateArguments: (_schema, args) => Object.keys(args).length === 1 && typeof args.text === "string",
    requestApproval: async () => ({ allowed: true, kind: "human" }),
    journal: { async append(event) { events.push(event); } }, ...overrides.options });
  return { broker, events, calls, setContext: (value) => { context = value; }, setSchema: (value) => { schema = value; } };
}
const request = () => ({ connectionId: "codex:codex_apps", toolName: "notes.create", arguments: { text: "hello" } });

test("search exposes bounded descriptions, never all tool schemas", async () => {
  const f = fixture();
  const results = await f.broker.searchTools("notes");
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "notes.create");
  assert.equal(JSON.stringify(results).includes("inputSchema"), false);
});
test("an exact human-approved snapshot is claimed before dispatch and cannot replay", async () => {
  const f = fixture();
  const req = request();
  const approval = await f.broker.proposeCall(req);
  req.arguments.text = "changed";
  const result = await f.broker.dispatchApproved(approval.id);
  assert.equal(result.text, "created");
  assert.equal(result.authority, "untrusted_connector");
  assert.equal(f.calls[0].args.text, "hello");
  assert.deepEqual(f.events.map((e) => e.type), ["mcp_call_started", "mcp_call_outcome"]);
  assert.equal(JSON.stringify(f.events).includes("hello"), false);
  await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "invalid_approval" });
});
test("changed goal, schema or expired approval never executes", async () => {
  for (const change of ["goal", "schema", "expiry"]) {
    let now = 1;
    const f = fixture({ options: { now: () => now } });
    const approval = await f.broker.proposeCall(request());
    if (change === "goal") f.setContext({ taskId: "task", goalVersion: 2, policyRevision: 1 });
    if (change === "schema") f.setSchema({ type: "object", properties: {} });
    if (change === "expiry") now = 60002;
    await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "stale_approval" });
    assert.equal(f.calls.length, 0);
  }
});
test("annotations never bypass human review or invalid argument checks", async () => {
  const f = fixture({ options: { requestApproval: async () => ({ allowed: true, kind: "policy" }) } });
  await assert.rejects(f.broker.proposeCall(request()), { code: "approval_denied" });
  const bad = request(); bad.arguments.extra = true;
  await assert.rejects(f.broker.proposeCall(bad), { code: "invalid_arguments" });
  assert.equal(f.calls.length, 0);
});
test("failed pre-dispatch journal prevents execution; post-dispatch failure is uncertain", async () => {
  for (const failAt of [1, 2]) {
    let appendCount = 0;
    const f = fixture({ options: { journal: { async append() { if (++appendCount === failAt) throw Error("disk"); } } } });
    const approval = await f.broker.proposeCall(request());
    await assert.rejects(f.broker.dispatchApproved(approval.id), { code: failAt === 1 ? "journal_failed" : "execution_uncertain" });
    assert.equal(f.calls.length, failAt === 1 ? 0 : 1);
    await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "invalid_approval" });
  }
});
test("oversized schemas and remote refs fail closed", async () => {
  for (const schema of [{ $ref: "https://example.com/schema" }, { type: "object", description: "x".repeat(17000) }]) {
    const f = fixture(); f.setSchema(schema);
    await assert.rejects(f.broker.proposeCall(request()), { code: "unsupported_schema" });
    assert.equal(f.calls.length, 0);
  }
});
test("hung dispatched call is uncertain and is not automatically retried", async () => {
  const f = fixture({ options: { deadlineMs: 25 }, provider: { call: () => new Promise(() => {}) } });
  const approval = await f.broker.proposeCall(request());
  await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "execution_uncertain" });
  await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "invalid_approval" });
});
test("goal changed during durable claim is rejected before the tool starts", async () => {
  let f;
  f = fixture({ options: { journal: { async append() { f.setContext({ taskId: "task", goalVersion: 2, policyRevision: 1 }); } } } });
  const approval = await f.broker.proposeCall(request());
  await assert.rejects(f.broker.dispatchApproved(approval.id), { code: "stale_approval" });
  assert.equal(f.calls.length, 0);
});
test("human review is not cancelled by the provider execution deadline", async () => {
  const f = fixture({ options: { deadlineMs: 20, requestApproval: async () => {
    await new Promise((resolve) => setTimeout(resolve, 40)); return { allowed: true, kind: "human" };
  } } });
  const approval = await f.broker.proposeCall(request());
  assert.equal((await f.broker.dispatchApproved(approval.id)).text, "created");
});
test("close cancels a hung human review without leaving an approval", async () => {
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const f = fixture({ options: { requestApproval: () => { entered(); return new Promise(() => {}); } } });
  const pending = f.broker.proposeCall(request());
  const rejected = assert.rejects(pending, { code: "cancelled" });
  await ready; await f.broker.close(); await rejected;
});
test("structured MCP data is returned instead of an acknowledgement", async () => {
  const f = fixture({ provider: { async call() {
    return { content: [{ type: "text", text: "Action completed." }], structuredContent: { value: "source data" } };
  } } });
  const approval = await f.broker.proposeCall(request());
  const result = await f.broker.dispatchApproved(approval.id);
  assert.equal(result.text, '{"value":"source data"}');
  assert.equal(result.requestId, approval.id);
  assert.equal(typeof result.latencyMs, "number");
});
