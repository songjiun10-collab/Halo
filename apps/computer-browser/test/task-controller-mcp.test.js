"use strict";

// Controller integration for host-scoped generic MCP calls: every call is
// queued for human review through the existing approve()/deny() queue, is
// bound to the task's admission epoch and goal, and is journaled as
// value-free notes before and after the single tracked dispatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { GenericMcpBroker } = require("../main/harness/generic-mcp-broker");

const SCHEMA = { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false };
const REQUEST = Object.freeze({ connectionId: "codex:docs", toolName: "search", arguments: { q: "secret-query-value" } });
const RAW_RESULT_TEXT = "raw-connector-result-text";

function fakeProvider({ call } = {}) {
  const calls = [];
  return {
    calls,
    listConnections: async () => [{ id: "codex:docs", provider: "codex", server: "docs", status: "connected", generation: 1 }],
    listTools: async () => [{ name: "search", description: "Search docs", inputSchema: SCHEMA, connectorId: null }],
    describeTool: async (_connectionId, name) => ({ name, description: "Search docs", inputSchema: SCHEMA, connectorId: null }),
    call: async (...args) => {
      calls.push(args);
      return call ? call(...args) : { content: [{ type: "text", text: RAW_RESULT_TEXT }], isError: false };
    },
    close: async () => {},
  };
}

function brokerFactory(provider, captured = {}) {
  return (hooks) => {
    captured.hooks = hooks;
    captured.broker = new GenericMcpBroker({
      providers: [provider],
      validateArguments: async (_schema, args) => typeof args.q === "string",
      ...hooks,
    });
    return captured.broker;
  };
}

async function makeStore() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-task-controller-mcp-"));
  const store = await TaskStore.create({ originalRequest: "MCP 작업" }, { storageRoot });
  return { store, storageRoot };
}

function blockedPlanner() {
  return { next: () => new Promise(() => {}) };
}

function makeController(store, overrides = {}) {
  return new TaskController({
    store,
    planner: blockedPlanner(),
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) },
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
    ...overrides,
  });
}

async function waitFor(predicate, label = "condition") {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Capture the rejection immediately so a transition that settles it before
// assert.rejects() attaches is not reported as an unhandled rejection.
function settled(promise) {
  promise.catch(() => {});
  return promise;
}

async function queuedMcp(controller) {
  await waitFor(() => controller.getSnapshot().approvalQueue.some((item) => item.action === "mcp_call"), "queued MCP review");
  return controller.getSnapshot().approvalQueue.find((item) => item.action === "mcp_call");
}

async function notes(store, kind) {
  const events = await store.getEvents();
  return events.filter((event) => event.type === "note" && event.payload.kind === kind);
}

async function allEvents(store) {
  return store.getEvents();
}

test("an MCP proposal is queued for human review and dispatches exactly once after approve(), even in full permission mode", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const controller = makeController(store, { permissionMode: "full", makeMcpBroker: brokerFactory(provider) });

  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  assert.deepEqual({ action: item.action, target: item.target }, { action: "mcp_call", target: "docs/search" });
  assert.equal(provider.calls.length, 0, "nothing runs before a human approves");
  assert.equal(controller.getSnapshot().state, "idle", "an MCP review does not rewrite browser task state");
  const review = controller.describeMcpApproval(item.id);
  assert.equal(review.toolName, "search");
  assert.deepEqual(review.arguments, REQUEST.arguments);
  assert.equal(review.risk, "unknown");

  await controller.approve(item.id);
  const result = await pending;
  assert.equal(result.outcome, "ok");
  assert.equal(result.authority, "untrusted_connector");
  assert.equal(provider.calls.length, 1);
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);

  const [started] = await notes(store, "mcp_call_started");
  const [outcome] = await notes(store, "mcp_call_outcome");
  assert.equal(started.payload.toolName, "search");
  assert.equal(outcome.payload.requestId, started.payload.requestId);
  assert.equal(outcome.payload.outcome, "ok");
  const serialized = JSON.stringify(await allEvents(store));
  assert.ok(!serialized.includes("secret-query-value"), "arguments never reach the journal");
  assert.ok(!serialized.includes(RAW_RESULT_TEXT), "raw results never reach the journal");
  await controller.closeMcp();
  await store.close();
});

test("deny() rejects the proposal and the provider is never called", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  await controller.deny(item.id);
  await assert.rejects(pending, { code: "approval_denied" });
  assert.equal(provider.calls.length, 0);
  assert.equal((await notes(store, "mcp_call_started")).length, 0);
  await controller.closeMcp();
  await store.close();
});

test("a goal amendment cancels a pending MCP review durably and nothing is called", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  await controller.amend({ text: "목표 변경" });
  await assert.rejects(pending, { code: "approval_denied" });
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  const cancelled = (await allEvents(store)).filter((event) => event.type === "approval_cancelled");
  assert.equal(cancelled.length, 1);
  assert.deepEqual(
    { requestId: cancelled[0].payload.requestId, actionType: cancelled[0].payload.actionType, reason: cancelled[0].payload.reason },
    { requestId: item.id, actionType: "mcp_call", reason: "goal_amended" },
  );
  await controller.approve(item.id);
  assert.equal(provider.calls.length, 0);
  await controller.closeMcp();
  await store.close();
});

for (const transition of ["takeOver", "pause"]) {
  test(`${transition}() cancels a pending MCP review durably and nothing is called`, async () => {
    const { store } = await makeStore();
    const provider = fakeProvider();
    const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
    controller.start();
    await waitFor(() => controller.getSnapshot().state === "running", "running");
    const pending = settled(controller.proposeMcpCall(REQUEST));
    const item = await queuedMcp(controller);
    await controller[transition]();
    await assert.rejects(pending, { code: "approval_denied" });
    assert.equal(controller.getSnapshot().state, "paused");
    assert.equal(controller.getSnapshot().approvalQueue.length, 0);
    const cancelled = (await allEvents(store)).filter((event) => event.type === "approval_cancelled");
    assert.deepEqual(cancelled.map((event) => event.payload.requestId), [item.id]);
    assert.equal(provider.calls.length, 0);
    await controller.closeMcp();
    await store.close();
  });
}

test("a failed durable mcp_call_started preclaim means the provider is never called", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const append = store.append.bind(store);
  store.append = async (input, options) => {
    if (input.type === "note" && input.payload?.kind === "mcp_call_started") throw new Error("disk full");
    return append(input, options);
  };
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  await controller.approve(item.id);
  await assert.rejects(pending, { code: "journal_failed" });
  assert.equal(provider.calls.length, 0);
  assert.equal((await notes(store, "mcp_call_started")).length, 0);
  assert.equal(controller.getSnapshot().state, "idle", "a definite no-call does not claim execution_uncertain");
  await controller.closeMcp();
  store.append = append;
  await store.close();
});

test("takeOver() drains an admitted MCP dispatch and records its real outcome before checkpointing", async () => {
  const { store } = await makeStore();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = fakeProvider({ call: async () => { await gate; return { content: [{ type: "text", text: "late" }], isError: false }; } });
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  controller.start();
  await waitFor(() => controller.getSnapshot().state === "running", "running");
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  const approved = controller.approve(item.id);
  await waitFor(() => provider.calls.length === 1, "provider dispatch");

  let tookOver = false;
  const takeOver = controller.takeOver().then(() => { tookOver = true; });
  // Long enough for an undrained transition's checkpoint to land.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(tookOver, false, "takeOver must wait for the in-flight MCP call");
  release();
  await takeOver;
  await approved;
  const result = await pending;
  assert.equal(result.outcome, "ok");
  assert.equal((await notes(store, "mcp_call_outcome")).length, 1);
  assert.equal(controller.getSnapshot().state, "paused");
  await controller.closeMcp();
  await store.close();
});

test("an approval that goes stale (expiry) before approve() never dispatches", async () => {
  const { store } = await makeStore();
  let clock = Date.now();
  const provider = fakeProvider();
  const controller = makeController(store, { now: () => clock, makeMcpBroker: brokerFactory(provider) });
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  clock += 61_000;
  await controller.approve(item.id);
  await assert.rejects(pending, { code: "approval_denied" });
  assert.equal(provider.calls.length, 0);
  await controller.closeMcp();
  await store.close();
});

test("invalid, disabled, terminal, and uncorrelated MCP requests are rejected without queueing or calls", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const captured = {};
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider, captured) });
  await assert.rejects(controller.proposeMcpCall({ ...REQUEST, approval: { allowed: true } }), { code: "invalid_mcp_proposal" });
  await assert.rejects(controller.proposeMcpCall({ ...REQUEST, arguments: { q: "x".repeat(20_000) } }), { code: "invalid_mcp_proposal" });
  assert.equal(captured.broker, undefined, "an invalid proposal never reaches the broker");

  await controller.listMcpConnections();
  // A broker callback invoked outside a controller proposal cannot mint approval.
  const decision = await captured.hooks.requestApproval({ connectionId: "codex:docs", toolName: "search", arguments: {}, signal: new AbortController().signal });
  assert.deepEqual(decision, { allowed: false });
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  await assert.rejects(captured.hooks.journal.append({ type: "unexpected", requestId: "x" }), { code: "invalid_mcp_journal_event" });
  // A well-formed preclaim outside a controller-approved dispatch is refused too.
  await assert.rejects(captured.hooks.journal.append({
    type: "mcp_call_started",
    requestId: "44444444-4444-4444-8444-444444444444",
    binding: { connectionId: "codex:docs", provider: "codex", server: "docs", generation: 1, toolName: "search", connectorId: null,
      schemaDigest: "a".repeat(64), argsDigest: "b".repeat(64), contextDigest: "c".repeat(64) },
  }), { code: "invalid_mcp_journal_event" });
  assert.equal((await notes(store, "mcp_call_started")).length, 0);

  const disabled = makeController(store);
  await assert.rejects(disabled.proposeMcpCall(REQUEST), { code: "mcp_disabled" });
  await assert.rejects(disabled.listMcpConnections(), { code: "mcp_disabled" });

  await controller.stop();
  await assert.rejects(controller.proposeMcpCall(REQUEST), { code: "invalid_state" });
  assert.equal(provider.calls.length, 0);
  await controller.closeMcp();
  await store.close();
});

test("host catalog methods pass through the broker and closeMcp() aborts a pending review", async () => {
  const { store } = await makeStore();
  const provider = fakeProvider();
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  assert.deepEqual((await controller.listMcpConnections()).map((c) => c.id), ["codex:docs"]);
  assert.deepEqual((await controller.searchMcpTools("search")).map((t) => t.name), ["search"]);
  assert.equal((await controller.describeMcpTool("codex:docs", "search")).toolName, "search");
  const pending = settled(controller.proposeMcpCall(REQUEST));
  await queuedMcp(controller);
  await controller.closeMcp();
  await assert.rejects(pending);
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  await assert.rejects(controller.proposeMcpCall(REQUEST), { code: "mcp_disabled" });
  assert.equal(provider.calls.length, 0);
  await store.close();
});

test("an uncertain MCP dispatch pauses execution_uncertain and a restart with an open call stays uncertain until confirmed", async () => {
  const { store, storageRoot } = await makeStore();
  const provider = fakeProvider({ call: async () => { throw Object.assign(new Error("lost"), { code: "execution_uncertain" }); } });
  const controller = makeController(store, { makeMcpBroker: brokerFactory(provider) });
  const pending = settled(controller.proposeMcpCall(REQUEST));
  const item = await queuedMcp(controller);
  await controller.approve(item.id);
  await assert.rejects(pending, { code: "execution_uncertain" });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(
    { state: controller.getSnapshot().state, pauseReason: controller.getSnapshot().pauseReason },
    { state: "paused", pauseReason: "execution_uncertain" },
  );
  const taskId = store.taskId;
  await controller.closeMcp();
  await store.close();

  const reloaded = await TaskStore.load(taskId, { storageRoot });
  const recovered = makeController(reloaded);
  assert.equal(recovered.getSnapshot().pauseReason, "execution_uncertain");
  await assert.rejects(recovered.resume(), { code: "confirmation_required" });
  recovered.resume({ confirmed: true });
  await waitFor(() => recovered.getSnapshot().state === "running", "resumed");
  const acknowledged = await notes(reloaded, "mcp_call_outcome");
  assert.deepEqual(acknowledged.map((event) => event.payload.outcome), ["uncertain_acknowledged"]);
  await recovered.stop();
  await reloaded.close();

  const again = await TaskStore.load(taskId, { storageRoot });
  assert.equal(makeController(again).getSnapshot().pauseReason === "execution_uncertain", false);
  await again.close();
});
