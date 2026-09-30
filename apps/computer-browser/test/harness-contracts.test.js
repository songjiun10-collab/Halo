"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENT_TYPES, validateJournalEvent } = require("../shared/harness-contracts");

const id = "11111111-1111-4111-8111-111111111111";

function event(type, payload) {
  return {
    seq: 1,
    eventId: "22222222-2222-4222-8222-222222222222",
    taskId: id,
    goalVersion: 1,
    type,
    payload,
    at: "2026-09-29T00:00:00.000Z",
  };
}

test("goal_created accepts legacy payloads and the profile-required marker only", () => {
  assert.ok(EVENT_TYPES.includes("task_profile_selected"));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", {})));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", { goalVersion: 1 })));
  assert.doesNotThrow(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: true })));
  assert.throws(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: false })), { code: "invalid_field" });
  assert.throws(() => validateJournalEvent(event("goal_created", { goalVersion: 1, profileRequired: true, other: true })), { code: "unknown_field" });
});

test("task_profile_selected delegates exact payload validation to the profile contract", () => {
  assert.throws(() => validateJournalEvent(event("task_profile_selected", { profileSchemaVersion: 1 })), { code: "invalid_field" });
});

const {
  MCP_CALL_ACTION_TYPE,
  MAX_MCP_ARGUMENT_BYTES,
  validateMcpProposal,
} = require("../shared/harness-contracts");

const hex = (c) => c.repeat(64);
const mcpStarted = (overrides = {}) => ({
  kind: "mcp_call_started",
  requestId: "33333333-3333-4333-8333-333333333333",
  connectionId: "codex:docs",
  provider: "codex",
  server: "docs",
  generation: 1,
  toolName: "search",
  connectorId: null,
  schemaDigest: hex("a"),
  argsDigest: hex("b"),
  contextDigest: hex("c"),
  ...overrides,
});

test("mcp proposal contract accepts exactly connectionId/toolName/arguments within bounds", () => {
  assert.equal(MCP_CALL_ACTION_TYPE, "mcp_call");
  const proposal = validateMcpProposal({ connectionId: "codex:docs", toolName: "search", arguments: { q: "x" } });
  assert.deepEqual(proposal, { connectionId: "codex:docs", toolName: "search", arguments: { q: "x" } });
  for (const bad of [
    null,
    { connectionId: "codex:docs", toolName: "search" },
    { connectionId: "codex:docs", toolName: "search", arguments: [] },
    { connectionId: "", toolName: "search", arguments: {} },
    { connectionId: "codex:docs", toolName: "x".repeat(257), arguments: {} },
    { connectionId: "codex:docs", toolName: "search", arguments: {}, approval: true },
    { connectionId: "codex:docs", toolName: "search", arguments: { big: "x".repeat(MAX_MCP_ARGUMENT_BYTES) } },
  ]) {
    assert.throws(() => validateMcpProposal(bad), { name: "ContractError" });
  }
});

test("mcp journal notes are strictly bounded and never carry arguments or raw results", () => {
  assert.doesNotThrow(() => validateJournalEvent(event("note", mcpStarted())));
  assert.doesNotThrow(() => validateJournalEvent(event("note", mcpStarted({ connectorId: "connector_1" }))));
  assert.throws(() => validateJournalEvent(event("note", mcpStarted({ arguments: { q: "x" } }))), { code: "unknown_field" });
  assert.throws(() => validateJournalEvent(event("note", mcpStarted({ argsDigest: "abc" }))), { code: "invalid_field" });
  assert.throws(() => validateJournalEvent(event("note", mcpStarted({ requestId: "nope" }))));
  const outcome = { kind: "mcp_call_outcome", requestId: "33333333-3333-4333-8333-333333333333" };
  assert.doesNotThrow(() => validateJournalEvent(event("note", { ...outcome, outcome: "ok", resultDigest: hex("d") })));
  assert.doesNotThrow(() => validateJournalEvent(event("note", { ...outcome, outcome: "tool_error", resultDigest: hex("d") })));
  assert.doesNotThrow(() => validateJournalEvent(event("note", { ...outcome, outcome: "not_dispatched", resultDigest: null })));
  assert.doesNotThrow(() => validateJournalEvent(event("note", { ...outcome, outcome: "uncertain_acknowledged", resultDigest: null })));
  assert.throws(() => validateJournalEvent(event("note", { ...outcome, outcome: "ok", resultDigest: null })), { code: "invalid_field" });
  assert.throws(() => validateJournalEvent(event("note", { ...outcome, outcome: "maybe", resultDigest: null })), { code: "unknown_enum" });
  assert.throws(() => validateJournalEvent(event("note", { ...outcome, outcome: "ok", resultDigest: hex("d"), text: "raw" })), { code: "unknown_field" });
  assert.doesNotThrow(() => validateJournalEvent(event("note", { kind: "finish_rejected", rejectedFinishes: 1 })));
});
