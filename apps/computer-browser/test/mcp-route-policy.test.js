"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decideRoute, MCP_ROUTE_PREFERENCES, McpRoutePolicyError } = require("../main/harness/mcp-route-policy");

test("mcp_first prefers MCP when connected and the browser otherwise", () => {
  assert.deepEqual(
    decideRoute({ url: "https://docs.test/guide", mcpAvailable: true }),
    { path: "mcp", domain: "docs.test", reason: "mcp_connected" });
  assert.deepEqual(
    decideRoute({ url: "https://docs.test/guide", mcpAvailable: false }),
    { path: "browser", domain: "docs.test", reason: "mcp_unavailable" });
  // The default preference is mcp_first.
  assert.equal(decideRoute({ url: "https://docs.test/", mcpAvailable: true }).path, "mcp");
});

test("explicit preferences override availability", () => {
  assert.equal(decideRoute({ url: "https://a.test/", mcpAvailable: true, preference: "browser_first" }).path, "browser");
  assert.equal(decideRoute({ url: "https://a.test/", mcpAvailable: false, preference: "browser_first" }).reason, "route_preference");
  assert.deepEqual(
    decideRoute({ url: "https://a.test/", mcpAvailable: true, preference: "always_ask" }),
    { path: "ask", domain: "a.test", reason: "route_preference" });
});

test("non-http pages and missing urls yield a null domain, never a throw", () => {
  assert.deepEqual(decideRoute({ url: "about:blank", mcpAvailable: true }),
    { path: "mcp", domain: null, reason: "mcp_connected" });
  assert.deepEqual(decideRoute({ mcpAvailable: false }), { path: "browser", domain: null, reason: "mcp_unavailable" });
  assert.deepEqual(decideRoute({ domain: "pinned.test", mcpAvailable: true }),
    { path: "mcp", domain: "pinned.test", reason: "mcp_connected" });
});

test("unknown preferences fail closed", () => {
  assert.deepEqual([...MCP_ROUTE_PREFERENCES], ["mcp_first", "browser_first", "always_ask"]);
  assert.throws(() => decideRoute({ url: "https://a.test/", preference: "mcp_only" }),
    (error) => error instanceof McpRoutePolicyError && error.code === "invalid_route_preference");
});
