"use strict";

// MCP-first routing: when the target has a connected MCP path the planner
// should prefer it and fall back to the browser only with a journaled reason.
// Pure: the caller journals and acts. The preference plugs into host settings
// later; the controller default is mcp_first.

class McpRoutePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpRoutePolicyError";
    this.code = code;
  }
}

const MCP_ROUTE_PREFERENCES = Object.freeze(["mcp_first", "browser_first", "always_ask"]);

function domainOf(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.hostname : null;
  } catch {
    return null;
  }
}

// decideRoute picks the planner's path for one page. mcpAvailable means the
// host currently offers mcp_* actions to this task (broker open and enabled);
// it says nothing about a tool fitting this domain, so an mcp path that finds
// nothing still falls back to the browser with its own journal reason.
function decideRoute({ url, domain, preference = "mcp_first", mcpAvailable = false } = {}) {
  if (!MCP_ROUTE_PREFERENCES.includes(preference)) {
    throw new McpRoutePolicyError("invalid_route_preference", `unknown MCP route preference: ${String(preference)}`);
  }
  const host = typeof domain === "string" && domain ? domain : domainOf(url);
  if (preference === "browser_first") return { path: "browser", domain: host, reason: "route_preference" };
  if (preference === "always_ask") return { path: "ask", domain: host, reason: "route_preference" };
  if (!mcpAvailable) return { path: "browser", domain: host, reason: "mcp_unavailable" };
  return { path: "mcp", domain: host, reason: "mcp_connected" };
}

module.exports = { McpRoutePolicyError, MCP_ROUTE_PREFERENCES, decideRoute };
