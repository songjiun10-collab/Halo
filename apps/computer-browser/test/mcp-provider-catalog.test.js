"use strict";

// The Agent "Tools" picker needs the MCP providers an Agent may narrow to:
// every known provider with a display label and whether the host has it on.
// Narrow-only: a provider the host has off is listed but not selectable.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { MCP_PROVIDER_IDS, MCP_PROVIDER_CATALOG } = require("../main/harness/host-settings");

function makeHost(mcpProviders) {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-mcp-catalog-")).then((storageRoot) => new TaskHost({
    storageRoot,
    mcpProviders,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async () => { throw new Error("unused"); } }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  }));
}

test("the catalog covers every provider id with a label", () => {
  assert.deepEqual(MCP_PROVIDER_CATALOG.map((entry) => entry.id), [...MCP_PROVIDER_IDS]);
  for (const entry of MCP_PROVIDER_CATALOG) {
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0);
    assert.ok(Object.isFrozen(entry));
  }
});

test("listMcpProviders reports which providers the host has enabled", async () => {
  const on = await makeHost(["codex"]);
  try {
    assert.deepEqual(await on.listMcpProviders(), [{ id: "codex", label: "Codex", enabled: true }]);
  } finally {
    await on.close();
  }
  const off = await makeHost([]);
  try {
    assert.deepEqual(await off.listMcpProviders(), [{ id: "codex", label: "Codex", enabled: false }]);
    // The returned list is a copy; editing it changes nothing in the host.
    (await off.listMcpProviders())[0].enabled = true;
    assert.equal((await off.listMcpProviders())[0].enabled, false);
  } finally {
    await off.close();
  }
});

test("listMcpProviders is exposed through ipc, preload and the background service", async () => {
  const { TASK_HOST_METHODS } = require("../main/harness/background-runtime-service");
  assert.ok(TASK_HOST_METHODS.has("listMcpProviders"));
  const ipcSource = await fs.readFile(path.join(__dirname, "..", "main", "ipc.js"), "utf8");
  const preloadSource = await fs.readFile(path.join(__dirname, "..", "preload", "index.js"), "utf8");
  assert.match(ipcSource, /"halo:listMcpProviders": "listMcpProviders"/);
  assert.match(preloadSource, /"listMcpProviders"/);
});
