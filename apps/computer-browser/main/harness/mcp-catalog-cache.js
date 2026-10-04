"use strict";

// Host-wide MCP catalog cache shared by every task's broker (docs/superpowers/
// specs/2026-10-01-routed-mcp-tool-sharing-design.md). It only saves repeat
// listTools/describeTool round trips: the broker still re-validates every
// value, and the provider re-verifies schema and generation right before a
// call, so a cached entry can never authorize anything by itself.
//
// An entry is only kept for a connection generation the host has observed
// from a live listConnections(); a new generation or a vanished connection
// drops all of that connection's entries.

const DEFAULT_MAX_TOOLS = 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

class McpCatalogCacheError extends Error {
  constructor(code) {
    super(code);
    this.name = "McpCatalogCacheError";
    this.code = code;
  }
}

class McpCatalogCache {
  constructor({ maxTools = DEFAULT_MAX_TOOLS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!Number.isInteger(maxTools) || maxTools <= 0 || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new McpCatalogCacheError("invalid_config");
    }
    this._maxTools = maxTools;
    this._maxBytes = maxBytes;
    this._generations = new Map();
    // Insertion order doubles as age for eviction. Values are stored as JSON
    // text so neither a writer nor a reader can mutate a shared entry.
    this._entries = new Map();
    this._tools = 0;
    this._bytes = 0;
  }

  observeConnections(connections) {
    if (!Array.isArray(connections)) return;
    const seen = new Map();
    for (const connection of connections) {
      if (typeof connection?.id === "string") seen.set(connection.id, connection.generation ?? 0);
    }
    for (const [id, generation] of this._generations) {
      if (!seen.has(id) || seen.get(id) !== generation) this._purge(id);
    }
    this._generations = seen;
  }

  getTools(connectionId) {
    return this._get(connectionId, "tools", "");
  }

  setTools(connectionId, tools) {
    if (Array.isArray(tools)) this._set(connectionId, "tools", "", tools, tools.length);
  }

  getTool(connectionId, toolName) {
    return this._get(connectionId, "tool", toolName);
  }

  setTool(connectionId, toolName, tool) {
    if (typeof toolName === "string" && tool && typeof tool === "object") this._set(connectionId, "tool", toolName, tool, 1);
  }

  stats() {
    return { entries: this._entries.size, tools: this._tools, bytes: this._bytes };
  }

  _key(connectionId, kind, toolName) {
    return JSON.stringify([connectionId, kind, toolName]);
  }

  _get(connectionId, kind, toolName) {
    if (!this._generations.has(connectionId)) return undefined;
    const entry = this._entries.get(this._key(connectionId, kind, toolName));
    return entry ? JSON.parse(entry.json) : undefined;
  }

  _set(connectionId, kind, toolName, value, tools) {
    if (!this._generations.has(connectionId)) return;
    let json;
    try { json = JSON.stringify(value); } catch { return; }
    if (typeof json !== "string") return;
    const bytes = Buffer.byteLength(json);
    if (tools > this._maxTools || bytes > this._maxBytes) return;
    const key = this._key(connectionId, kind, toolName);
    this._delete(key);
    while (this._entries.size && (this._tools + tools > this._maxTools || this._bytes + bytes > this._maxBytes)) {
      this._delete(this._entries.keys().next().value);
    }
    this._entries.set(key, { connectionId, json, tools, bytes });
    this._tools += tools;
    this._bytes += bytes;
  }

  _delete(key) {
    const entry = this._entries.get(key);
    if (!entry) return;
    this._entries.delete(key);
    this._tools -= entry.tools;
    this._bytes -= entry.bytes;
  }

  _purge(connectionId) {
    for (const [key, entry] of [...this._entries]) {
      if (entry.connectionId === connectionId) this._delete(key);
    }
  }
}

module.exports = { McpCatalogCache, McpCatalogCacheError };
