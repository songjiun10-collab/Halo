"use strict";

// An Agent may pin the planner model its tasks run (Claude or Codex, from the
// host allowlists). null keeps the host setting. The pin is a task selector
// journaled at creation, so a resumed task keeps the same model.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { AgentStore, AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");
const { AgentService } = require("../main/harness/agent-service");

const avatar = { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] };
const agentInput = { name: "A", title: "", description: "", avatar, instructions: "", capabilityId: "browser" };
const tempDir = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test("AgentStore keeps an optional, allowlisted planner model", async () => {
  const store = new AgentStore({ storageRoot: await tempDir("halo-agent-model-store-") });
  const inherit = await store.saveAgent(agentInput);
  assert.equal(inherit.model, null);
  const codex = await store.saveAgent({ ...agentInput, model: "gpt-6.1-sol" });
  assert.equal(codex.model, "gpt-6.1-sol");
  const claude = await store.saveAgent({ ...agentInput, model: "claude-sonnet-5-5" });
  assert.equal(claude.model, "claude-sonnet-5-5");
  for (const bad of ["opus", "gpt-4o", "", 1, ["gpt-5.5"]]) {
    await assert.rejects(store.saveAgent({ ...agentInput, model: bad }), { code: "invalid_agent" }, String(bad));
  }
  // Editing without the field keeps the saved model; null clears it.
  const kept = await store.saveAgent({ ...agentInput, id: codex.id, name: "B" });
  assert.equal(kept.model, "gpt-6.1-sol");
  assert.equal((await store.duplicateAgent(codex.id)).model, "gpt-6.1-sol");
  assert.equal((await store.saveAgent({ ...agentInput, id: codex.id, model: null })).model, null);
});

test("records saved before the model field read as inheriting the host model", async () => {
  const root = await tempDir("halo-agent-model-legacy-");
  const at = "2026-10-01T00:00:00.000Z";
  const v3 = {
    schemaVersion: 3,
    agents: [{ id: "11111111-1111-4111-8111-111111111111", ...agentInput, mcpProviders: null, generation: 1, createdAt: at, updatedAt: at, archived: false, pinned: false }],
    teams: [],
    links: [],
  };
  await fs.writeFile(path.join(root, "agents.json"), JSON.stringify(v3), { mode: 0o600 });
  const [agent] = await new AgentStore({ storageRoot: root }).listAgents();
  assert.equal(agent.model ?? null, null);
});

test("an agent task passes its model as a planner selector; teams and unset agents do not", async () => {
  const store = new AgentStore({ storageRoot: await tempDir("halo-agent-model-svc-") });
  const created = [];
  const service = new AgentService({
    store,
    createTask: async (goalInput, selectors) => { created.push(selectors); return { taskId: `1111111${created.length}-1111-4111-8111-111111111111`, snapshot: {} }; },
    listTasks: async () => [],
  });
  const pinned = await store.saveAgent({ ...agentInput, model: "gpt-6-astra" });
  const plain = await store.saveAgent(agentInput);
  await service.startAgentTask({ agentId: pinned.id, request: "x" });
  await service.startAgentTask({ agentId: plain.id, request: "x" });
  const team = await store.saveTeam({ name: "T", title: "", description: "", avatar, memberAgentIds: [pinned.id, plain.id] });
  await service.startAgentTask({ teamId: team.id, request: "x" });
  assert.equal(created[0].plannerModel, "gpt-6-astra");
  assert.equal(Object.hasOwn(created[1], "plannerModel"), false);
  assert.equal(Object.hasOwn(created[2], "plannerModel"), false);
});

function makeHost(storageRoot, pins) {
  return new TaskHost({
    storageRoot,
    plannerProvider: "claude_code",
    plannerModel: "claude-opus-5-5",
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: (taskId, pin) => {
      pins.push(pin);
      return { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }) };
    },
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

test("createTask pins the selected model and its provider, and journals the choice", async () => {
  const pins = [];
  const host = makeHost(await tempDir("halo-agent-model-host-"), pins);
  try {
    await assert.rejects(host.createTask({ originalRequest: "x" }, { plannerModel: "gpt-4o" }), { code: "invalid_selector" });
    const codex = await host.createTask({ originalRequest: "x" }, { plannerModel: "gpt-6.1-sol" });
    await settle(host, codex.taskId);
    assert.deepEqual(pins.at(-1), { role: "parent", plannerProvider: "codex_cli", plannerModel: "gpt-6.1-sol" });
    const events = await host.getTaskEvents(codex.taskId);
    assert.ok(events.some((event) => event.type === "note" && event.payload.kind === "planner_model_selected" && event.payload.model === "gpt-6.1-sol"));
  } finally {
    await host.close();
  }
  const plainPins = [];
  const other = makeHost(await tempDir("halo-agent-model-host-"), plainPins);
  try {
    const plain = await other.createTask({ originalRequest: "x" });
    await settle(other, plain.taskId);
    assert.deepEqual(plainPins.at(-1), { role: "parent", plannerProvider: "claude_code", plannerModel: "claude-opus-5-5" });
  } finally {
    await other.close();
  }
});
