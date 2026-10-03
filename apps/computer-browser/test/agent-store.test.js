"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AgentStore, AGENT_SHAPES, AGENT_COLORS, MAX_TEAM_MEMBERS } = require("../main/harness/agent-store");

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-agents-"));
}

const avatar = () => ({ shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] });
const agentInput = (overrides = {}) => ({
  name: "Mail Assistant", title: "", description: "메일 정리", avatar: avatar(),
  instructions: "중요한 메일만 요약한다", capabilityId: "browser", ...overrides,
});

test("saveAgent creates with host-generated ids and bumps generation on update", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const created = await store.saveAgent(agentInput());
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.generation, 1);
  assert.equal(created.archived, false);
  const updated = await store.saveAgent({ ...agentInput({ name: "Mail" }), id: created.id });
  assert.equal(updated.generation, 2);
  assert.equal(updated.createdAt, created.createdAt);
  assert.deepEqual((await store.listAgents()).map((agent) => agent.name), ["Mail"]);
  await assert.rejects(store.saveAgent({ ...agentInput(), id: "00000000-0000-4000-8000-000000000000" }), { code: "not_found" });
});

test("agent fields are validated strictly", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  for (const bad of [
    agentInput({ name: "" }),
    agentInput({ name: "x".repeat(65) }),
    agentInput({ description: "x".repeat(1001) }),
    agentInput({ instructions: "x".repeat(2001) }),
    agentInput({ capabilityId: "multi_agent" }),
    agentInput({ capabilityId: "root" }),
    agentInput({ avatar: { shape: "dragon", color: AGENT_COLORS[0] } }),
    agentInput({ avatar: { shape: AGENT_SHAPES[0], color: "#fff" } }),
    agentInput({ extra: true }),
    { ...agentInput(), generation: 9 },
  ]) {
    await assert.rejects(store.saveAgent(bad), { code: "invalid_agent" }, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(await store.listAgents(), []);
});

test("only capabilities the registry currently offers can be saved", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  for (const capabilityId of ["research"]) {
    await assert.rejects(store.saveAgent(agentInput({ capabilityId })), { code: "capability_unavailable" });
  }
  assert.equal((await store.saveAgent(agentInput({ capabilityId: "browser" }))).capabilityId, "browser");
  assert.equal((await store.saveAgent(agentInput({ capabilityId: "computer_use" }))).capabilityId, "computer_use");
});

test("persistent browser preference defaults off, only accepts booleans, and duplicates default off", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const created = await store.saveAgent(agentInput());
  assert.equal(created.persistentBrowser, false);

  const enabled = await store.saveAgent({ ...agentInput(), id: created.id, persistentBrowser: true });
  assert.equal(enabled.persistentBrowser, true);
  assert.equal(enabled.generation, created.generation + 1);

  const preserved = await store.saveAgent({ ...agentInput({ name: "Updated" }), id: created.id });
  assert.equal(preserved.persistentBrowser, true, "omitting the field on edit preserves the saved preference");
  await assert.rejects(store.saveAgent({ ...agentInput(), id: created.id, persistentBrowser: "yes" }), { code: "invalid_agent" });

  const duplicate = await store.duplicateAgent(created.id);
  assert.equal(duplicate.persistentBrowser, false);
});

test("teams hold 1..6 distinct, existing, unarchived members", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agents = [];
  for (let i = 0; i < MAX_TEAM_MEMBERS + 1; i += 1) agents.push(await store.saveAgent(agentInput({ name: `A${i}` })));
  const team = await store.saveTeam({ name: "Design Review", title: "", description: "", avatar: avatar(), memberAgentIds: [agents[0].id, agents[1].id] });
  assert.equal(team.generation, 1);
  const team2 = await store.saveTeam({ id: team.id, name: "Design Review", title: "", description: "", avatar: avatar(), memberAgentIds: [agents[1].id] });
  assert.equal(team2.generation, 2);
  const base = { name: "T", title: "", description: "", avatar: avatar() };
  await assert.rejects(store.saveTeam({ ...base, memberAgentIds: [] }), { code: "invalid_team" });
  await assert.rejects(store.saveTeam({ ...base, memberAgentIds: agents.map((agent) => agent.id) }), { code: "invalid_team" });
  await assert.rejects(store.saveTeam({ ...base, memberAgentIds: [agents[0].id, agents[0].id] }), { code: "invalid_team" });
  await assert.rejects(store.saveTeam({ ...base, memberAgentIds: ["00000000-0000-4000-8000-000000000000"] }), { code: "unknown_member" });
  await store.archiveAgent(agents[2].id);
  await assert.rejects(store.saveTeam({ ...base, memberAgentIds: [agents[2].id] }), { code: "unknown_member" });
});

test("archive keeps records, and archived records cannot be edited", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agent = await store.saveAgent(agentInput());
  const archived = await store.archiveAgent(agent.id);
  assert.equal(archived.archived, true);
  assert.equal((await store.getAgent(agent.id)).archived, true);
  await assert.rejects(store.saveAgent({ ...agentInput(), id: agent.id }), { code: "archived" });
  await assert.rejects(store.archiveAgent("not-a-uuid"), { code: "invalid_id" });
});

test("count limits are enforced", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot(), maxAgents: 2, maxTeams: 1 });
  const a = await store.saveAgent(agentInput());
  await store.saveAgent(agentInput());
  await assert.rejects(store.saveAgent(agentInput()), { code: "limit_reached" });
  const base = { name: "T", title: "", description: "", avatar: avatar(), memberAgentIds: [a.id] };
  await store.saveTeam(base);
  await assert.rejects(store.saveTeam(base), { code: "limit_reached" });
});

test("task links are bounded and listed newest first per owner", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot(), maxLinks: 2 });
  const agent = await store.saveAgent(agentInput());
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  for (const taskId of ids) await store.linkTask({ taskId, kind: "agent", ownerId: agent.id, generation: agent.generation });
  const links = await store.listLinks({ kind: "agent", ownerId: agent.id });
  assert.deepEqual(links.map((link) => link.taskId), [ids[2], ids[1]]);
  await assert.rejects(store.linkTask({ taskId: ids[0], kind: "robot", ownerId: agent.id, generation: 1 }), { code: "invalid_link" });
});

test("persisted file is 0600, reloads, and rejects symlinks and corrupt content", async () => {
  const root = await tempRoot();
  const store = new AgentStore({ storageRoot: root });
  const agent = await store.saveAgent(agentInput());
  const file = path.join(root, "agents.json");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await new AgentStore({ storageRoot: root }).getAgent(agent.id)).name, agent.name);

  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, agents: [{ ...agent, extra: 1 }], teams: [], links: [] }));
  await assert.rejects(new AgentStore({ storageRoot: root }).listAgents(), { code: "invalid_store" });
  await fs.writeFile(file, "{not json");
  await assert.rejects(new AgentStore({ storageRoot: root }).listAgents(), { code: "invalid_store" });
  assert.equal(await fs.readFile(file, "utf8"), "{not json");

  const other = await tempRoot();
  const target = path.join(other, "target.json");
  await fs.writeFile(target, "{}");
  const linkedRoot = await tempRoot();
  await fs.symlink(target, path.join(linkedRoot, "agents.json"));
  await assert.rejects(new AgentStore({ storageRoot: linkedRoot }).listAgents(), { code: "unsafe_path" });
});

test("pinning is a display preference that does not bump generation", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agent = await store.saveAgent(agentInput());
  assert.equal(agent.pinned, false);
  const pinned = await store.setPinned({ kind: "agent", id: agent.id, pinned: true });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.generation, agent.generation);
  const team = await store.saveTeam({ name: "T", title: "", description: "", avatar: avatar(), memberAgentIds: [agent.id] });
  assert.equal((await store.setPinned({ kind: "team", id: team.id, pinned: true })).pinned, true);
  await assert.rejects(store.setPinned({ kind: "agent", id: agent.id, pinned: "yes" }), { code: "invalid_pin" });
  await assert.rejects(store.setPinned({ kind: "robot", id: agent.id, pinned: true }), { code: "invalid_pin" });
  // A saved edit keeps the pin.
  assert.equal((await store.saveAgent({ ...agentInput({ name: "B" }), id: agent.id })).pinned, true);
});

test("duplicateAgent copies the profile into a new unpinned agent", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agent = await store.saveAgent(agentInput({ name: "x".repeat(64) }));
  await store.setPinned({ kind: "agent", id: agent.id, pinned: true });
  const copyAgent = await store.duplicateAgent(agent.id);
  assert.notEqual(copyAgent.id, agent.id);
  assert.equal(copyAgent.generation, 1);
  assert.equal(copyAgent.pinned, false);
  assert.ok(copyAgent.name.length <= 64);
  assert.match(copyAgent.name, /사본$/);
  assert.equal(copyAgent.instructions, agent.instructions);
  await store.archiveAgent(agent.id);
  await assert.rejects(store.duplicateAgent(agent.id), { code: "archived" });
});

test("markLinksSeen records the task state the user last saw per link", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agent = await store.saveAgent(agentInput());
  const taskId = "11111111-1111-4111-8111-111111111111";
  const link = await store.linkTask({ taskId, kind: "agent", ownerId: agent.id, generation: 1 });
  assert.equal(link.seenState, null);
  await store.markLinksSeen({ kind: "agent", ownerId: agent.id, states: { [taskId]: "completed", "22222222-2222-4222-8222-222222222222": "running" } });
  assert.equal((await store.listLinks({ kind: "agent", ownerId: agent.id }))[0].seenState, "completed");
  await assert.rejects(store.markLinksSeen({ kind: "agent", ownerId: agent.id, states: { [taskId]: 5 } }), { code: "invalid_link" });
});

test("a schema v1 file is upgraded in memory with default prefs", async () => {
  const root = await tempRoot();
  const at = "2026-10-01T00:00:00.000Z";
  const v1Agent = { id: "11111111-1111-4111-8111-111111111111", ...agentInput(), title: "", generation: 1, createdAt: at, updatedAt: at, archived: false };
  const v1Link = { taskId: "22222222-2222-4222-8222-222222222222", kind: "agent", ownerId: v1Agent.id, generation: 1, createdAt: at };
  await fs.writeFile(path.join(root, "agents.json"), JSON.stringify({ schemaVersion: 1, agents: [v1Agent], teams: [], links: [v1Link] }), { mode: 0o600 });
  const store = new AgentStore({ storageRoot: root });
  assert.equal((await store.getAgent(v1Agent.id)).pinned, false);
  assert.equal((await store.listLinks({ kind: "agent", ownerId: v1Agent.id }))[0].seenState, null);
  await store.setPinned({ kind: "agent", id: v1Agent.id, pinned: true });
  assert.equal((await store.getAgent(v1Agent.id)).mcpProviders, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "agents.json"), "utf8")).schemaVersion, 4);
});

test("schema v3 records without persistentBrowser upgrade with persistence disabled", async () => {
  const root = await tempRoot();
  const at = "2026-10-01T00:00:00.000Z";
  const schemaV3Agent = {
    id: "11111111-1111-4111-8111-111111111111", ...agentInput(), title: "", mcpProviders: null, model: null,
    generation: 1, createdAt: at, updatedAt: at, archived: false, pinned: false,
  };
  await fs.writeFile(path.join(root, "agents.json"), JSON.stringify({ schemaVersion: 3, agents: [schemaV3Agent], teams: [], links: [] }), { mode: 0o600 });
  const store = new AgentStore({ storageRoot: root });
  assert.equal((await store.getAgent(schemaV3Agent.id)).persistentBrowser, false);
  await store.setPinned({ kind: "agent", id: schemaV3Agent.id, pinned: true });
  const persisted = JSON.parse(await fs.readFile(path.join(root, "agents.json"), "utf8"));
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(persisted.agents[0].persistentBrowser, false);
});

test("returned records are copies", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot() });
  const agent = await store.saveAgent(agentInput());
  agent.avatar.shape = "mutated";
  assert.equal((await store.getAgent(agent.id)).avatar.shape, AGENT_SHAPES[0]);
});

test("archiving frees an active slot, while total stored records stay bounded", async () => {
  const store = new AgentStore({ storageRoot: await tempRoot(), maxAgents: 2, maxTeams: 1 });
  const a = await store.saveAgent(agentInput());
  await store.saveAgent(agentInput());
  await assert.rejects(store.saveAgent(agentInput()), { code: "limit_reached" });
  await store.archiveAgent(a.id);
  await store.saveAgent(agentInput());
  // 3 stored (1 archived, 2 active); keep cycling until the 10x backstop trips.
  let stored = 3;
  for (;;) {
    const active = (await store.snapshot()).agents.filter((x) => !x.archived);
    await store.archiveAgent(active[0].id);
    try { await store.saveAgent(agentInput()); stored += 1; } catch (e) { assert.equal(e.code, "limit_reached"); break; }
    assert.ok(stored <= 20, "total records must stop at maxAgents * 10");
  }
  assert.equal(stored, 20);
});
