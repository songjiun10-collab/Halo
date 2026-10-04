"use strict";

// Agent MCP pinning is narrow-only: an Agent may name a subset of MCP
// providers, the task gets (Agent subset ∩ host-enabled providers), and the
// choice is written to the task journal so a resumed task keeps it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { AgentStore, AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");

const avatar = { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] };
const agentInput = { name: "A", title: "", description: "", avatar, instructions: "", capabilityId: "browser" };

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function findMcpEnabled(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.mcp && typeof value.mcp.enabled === "boolean") return value.mcp.enabled;
  for (const child of Object.values(value)) {
    const found = findMcpEnabled(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function makeHost(storageRoot, { mcpProviders = ["codex"], seen = [], brokerCalls = [] } = {}) {
  return new TaskHost({
    storageRoot,
    mcpProviders,
    makeMcpBroker: (taskId, hooks, options) => { brokerCalls.push(options); return null; },
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => {
        seen.push(findMcpEnabled(context));
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
}

async function settle(host, taskId) {
  for (let i = 0; i < 100; i += 1) {
    const detail = await host.getTaskDetail(taskId);
    if (detail.snapshot && !["idle", "running", "queued"].includes(detail.snapshot.state)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not settle");
}

test("AgentStore keeps an optional, validated MCP provider subset", async () => {
  const store = new AgentStore({ storageRoot: await tempDir("halo-agent-mcp-store-") });
  const inherit = await store.saveAgent(agentInput);
  assert.equal(inherit.mcpProviders, null);
  const none = await store.saveAgent({ ...agentInput, mcpProviders: [] });
  assert.deepEqual(none.mcpProviders, []);
  const codex = await store.saveAgent({ ...agentInput, mcpProviders: ["codex"] });
  assert.deepEqual(codex.mcpProviders, ["codex"]);
  for (const bad of [["claude"], ["codex", "codex"], "codex", [1]]) {
    await assert.rejects(store.saveAgent({ ...agentInput, mcpProviders: bad }), { code: "invalid_agent" });
  }
  const copy = await store.duplicateAgent(codex.id);
  assert.deepEqual(copy.mcpProviders, ["codex"]);
  // Editing without the field keeps inheriting; null clears a subset.
  const cleared = await store.saveAgent({ ...agentInput, id: codex.id, mcpProviders: null });
  assert.equal(cleared.mcpProviders, null);
});

test("AgentStore upgrades v2 records to inherit host MCP providers", async () => {
  const root = await tempDir("halo-agent-mcp-upgrade-");
  const at = "2026-10-01T00:00:00.000Z";
  const v2 = {
    schemaVersion: 2,
    agents: [{ id: "11111111-1111-4111-8111-111111111111", name: "A", title: "", description: "", avatar, instructions: "", capabilityId: "browser", generation: 1, createdAt: at, updatedAt: at, archived: false, pinned: false }],
    teams: [],
    links: [],
  };
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, "agents.json"), JSON.stringify(v2), { mode: 0o600 });
  const [agent] = await new AgentStore({ storageRoot: root }).listAgents();
  assert.equal(agent.mcpProviders, null);
});

test("createTask narrows MCP providers to the requested subset of host providers", async () => {
  const seen = [];
  const brokerCalls = [];
  const host = makeHost(await tempDir("halo-agent-mcp-host-"), { seen, brokerCalls });
  try {
    await assert.rejects(host.createTask({ originalRequest: "x" }, { mcpProviders: ["claude"] }), { code: "invalid_selector" });
    const narrowed = await host.createTask({ originalRequest: "x" }, { mcpProviders: [] });
    await settle(host, narrowed.taskId);
    assert.equal(seen.at(-1), false);
  } finally {
    await host.close();
  }
  const seenDefault = [];
  const other = makeHost(await tempDir("halo-agent-mcp-host-"), { seen: seenDefault });
  try {
    const plain = await other.createTask({ originalRequest: "x" });
    await settle(other, plain.taskId);
    assert.equal(seenDefault.at(-1), true);
  } finally {
    await other.close();
  }
});

test("a subset can never enable a provider the host has turned off", async () => {
  const seen = [];
  const host = makeHost(await tempDir("halo-agent-mcp-off-"), { mcpProviders: [], seen });
  try {
    const created = await host.createTask({ originalRequest: "x" }, { mcpProviders: ["codex"] });
    await settle(host, created.taskId);
    assert.equal(seen.at(-1), false);
  } finally {
    await host.close();
  }
});

test("the narrowed MCP scope is journaled and survives a host restart", async () => {
  const root = await tempDir("halo-agent-mcp-resume-");
  const first = makeHost(root, { mcpProviders: ["codex"] });
  let taskId;
  try {
    ({ taskId } = await first.createTask({ originalRequest: "x" }, { mcpProviders: [] }));
    await settle(first, taskId);
    const events = await first.getTaskEvents(taskId);
    const items = Array.isArray(events) ? events : events.events;
    assert.ok(items.some((event) => event.type === "note" && event.payload?.kind === "mcp_scope_selected" &&
      JSON.stringify(event.payload.providers) === "[]"));
  } finally {
    await first.close();
  }
  const seen = [];
  const second = makeHost(root, { mcpProviders: ["codex"], seen });
  try {
    await second.resumeSavedTask(taskId);
    await settle(second, taskId);
    assert.equal(seen.at(-1), false);
  } finally {
    await second.close();
  }
});

test("startAgentTask applies the Agent's MCP subset", async () => {
  const seen = [];
  const host = makeHost(await tempDir("halo-agent-mcp-start-"), { seen });
  try {
    const agent = await host.saveAgent({ ...agentInput, mcpProviders: [] });
    const created = await host.startAgentTask({ agentId: agent.id, request: "x" });
    await settle(host, created.taskId);
    assert.equal(seen.at(-1), false);
  } finally {
    await host.close();
  }
  // A finished task keeps its slot, so the inheriting case uses its own host.
  const seenOpen = [];
  const other = makeHost(await tempDir("halo-agent-mcp-start-"), { seen: seenOpen });
  try {
    const open = await other.saveAgent(agentInput);
    const created = await other.startAgentTask({ agentId: open.id, request: "y" });
    await settle(other, created.taskId);
    assert.equal(seenOpen.at(-1), true);
  } finally {
    await other.close();
  }
});

test("a team narrows MCP only when every member does, to the union of their subsets", async () => {
  const { AgentService } = require("../main/harness/agent-service");
  const store = new AgentStore({ storageRoot: await tempDir("halo-agent-mcp-team-") });
  const calls = [];
  const service = new AgentService({
    store,
    createTask: async (goal, selectors) => { calls.push(selectors); return { taskId: "33333333-3333-4333-8333-333333333333" }; },
    listTasks: async () => [],
  });
  const none = await store.saveAgent({ ...agentInput, mcpProviders: [] });
  const codex = await store.saveAgent({ ...agentInput, mcpProviders: ["codex"] });
  const open = await store.saveAgent(agentInput);
  const scopedTeam = await store.saveTeam({ name: "T", title: "", description: "", avatar, memberAgentIds: [none.id, codex.id] });
  const mixedTeam = await store.saveTeam({ name: "U", title: "", description: "", avatar, memberAgentIds: [none.id, open.id] });
  await service.startAgentTask({ teamId: scopedTeam.id, request: "x" });
  await service.startAgentTask({ teamId: mixedTeam.id, request: "x" });
  assert.deepEqual(calls[0].mcpProviders, ["codex"]);
  assert.equal(Object.hasOwn(calls[1], "mcpProviders"), false);
});
