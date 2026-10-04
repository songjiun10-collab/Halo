"use strict";

// Prompt-cache friendliness (GPT-6 Astra direction): every planner turn of
// every task should start with the same static instruction bytes; anything
// that varies by task (action bound, MCP availability) comes after them, and
// the per-turn context JSON comes last with the stable goal before progress.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt } = require("../main/harness/providers/claude-code-bridge");

function context(progress = {}) {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    goalVersion: 1,
    goal: { originalRequest: "x", amendments: [], constraints: [], criteria: [] },
    progress: { plannerEffort: "medium", ...progress },
    recentEvents: [],
    observation: { id: "obs" },
  };
}

function commonPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

test("task-specific instructions come after the shared static instructions", () => {
  const variants = [
    buildPrompt(context()),
    buildPrompt(context({ maxActionsPerProposal: 8 })),
    buildPrompt(context({ mcp: { enabled: true, actions: ["mcp_search", "mcp_describe", "mcp_propose"] } })),
  ];
  const staticEnd = variants[0].indexOf("context.untrustedSummary, if present");
  assert.ok(staticEnd > 0);
  for (const other of variants.slice(1)) {
    assert.ok(commonPrefixLength(variants[0], other) > staticEnd, "the static block is byte-identical across tasks");
  }
  assert.ok(variants[1].includes("propose 1-8 browser actions"));
  assert.ok(variants[2].indexOf("mcp_search") > staticEnd);
});

test("the context JSON is last and puts the stable goal before per-turn progress", () => {
  const prompt = buildPrompt(context());
  const json = prompt.slice(prompt.indexOf("Context (JSON):\n") + "Context (JSON):\n".length);
  const keys = Object.keys(JSON.parse(json));
  assert.ok(keys.indexOf("goal") < keys.indexOf("progress"));
  assert.ok(keys.indexOf("goal") < keys.indexOf("observation"));
});
