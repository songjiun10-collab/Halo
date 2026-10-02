"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { McpCatalogCache } = require("../main/harness/mcp-catalog-cache");

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: "object" }, ...extra });

test("entries exist only for a connection generation the host has observed", () => {
  const cache = new McpCatalogCache();
  cache.setTools("codex:a", [tool("x")]);
  assert.equal(cache.getTools("codex:a"), undefined);
  cache.observeConnections([{ id: "codex:a", generation: 1 }]);
  cache.setTools("codex:a", [tool("x")]);
  cache.setTool("codex:a", "x", tool("x"));
  assert.deepEqual(cache.getTools("codex:a"), [tool("x")]);
  assert.deepEqual(cache.getTool("codex:a", "x"), tool("x"));
});

test("a generation change or a vanished connection purges that connection only", () => {
  const cache = new McpCatalogCache();
  cache.observeConnections([{ id: "codex:a", generation: 1 }, { id: "codex:b", generation: 1 }]);
  cache.setTools("codex:a", [tool("x")]);
  cache.setTool("codex:a", "x", tool("x"));
  cache.setTools("codex:b", [tool("y")]);
  cache.observeConnections([{ id: "codex:a", generation: 2 }, { id: "codex:b", generation: 1 }]);
  assert.equal(cache.getTools("codex:a"), undefined);
  assert.equal(cache.getTool("codex:a", "x"), undefined);
  assert.deepEqual(cache.getTools("codex:b"), [tool("y")]);
  cache.observeConnections([{ id: "codex:a", generation: 2 }]);
  assert.equal(cache.getTools("codex:b"), undefined);
  cache.setTools("codex:b", [tool("y")]);
  assert.equal(cache.getTools("codex:b"), undefined);
});

test("cached values are isolated copies in both directions", () => {
  const cache = new McpCatalogCache();
  cache.observeConnections([{ id: "codex:a", generation: 0 }]);
  const stored = [tool("x")];
  cache.setTools("codex:a", stored);
  stored[0].name = "mutated";
  const read = cache.getTools("codex:a");
  read[0].description = "mutated";
  assert.deepEqual(cache.getTools("codex:a"), [tool("x")]);
});

test("tool and byte caps evict the oldest entries and skip an oversized one", () => {
  const cache = new McpCatalogCache({ maxTools: 3, maxBytes: 4096 });
  cache.observeConnections([{ id: "codex:a", generation: 0 }]);
  cache.setTool("codex:a", "one", tool("one"));
  cache.setTool("codex:a", "two", tool("two"));
  cache.setTools("codex:a", [tool("three"), tool("four")]);
  assert.equal(cache.getTool("codex:a", "one"), undefined);
  assert.deepEqual(cache.getTool("codex:a", "two"), tool("two"));
  assert.equal(cache.getTools("codex:a").length, 2);
  cache.setTool("codex:a", "huge", tool("huge", { description: "x".repeat(5000) }));
  assert.equal(cache.getTool("codex:a", "huge"), undefined);
  assert.deepEqual(cache.getTool("codex:a", "two"), tool("two"));
  const stats = cache.stats();
  assert.ok(stats.tools <= 3 && stats.bytes <= 4096);
});

test("malformed connection lists and keys are ignored rather than trusted", () => {
  const cache = new McpCatalogCache();
  cache.observeConnections([{ id: "codex:a", generation: 0 }]);
  cache.setTools("codex:a", [tool("x")]);
  cache.observeConnections("not a list");
  assert.deepEqual(cache.getTools("codex:a"), [tool("x")]);
  cache.observeConnections([{ id: 5, generation: 0 }, null]);
  assert.equal(cache.getTools("codex:a"), undefined);
  cache.observeConnections([{ id: "__proto__", generation: 0 }]);
  cache.setTools("__proto__", "not tools");
  assert.equal(cache.getTools("__proto__"), undefined);
  assert.throws(() => new McpCatalogCache({ maxTools: 0 }), { code: "invalid_config" });
});
