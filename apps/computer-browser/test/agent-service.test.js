"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AgentStore, AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");
const { AgentService } = require("../main/harness/agent-service");
const { normalizeGoalSpec } = require("../shared/harness-contracts");

const avatar = { shape: AGENT_SHAPES[1], color: AGENT_COLORS[2] };
const TASK_IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

async function setup() {
  const store = new AgentStore({ storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-svc-")) });
  const created = [];
  const service = new AgentService({
    store,
    createTask: async (goalInput, selectors) => {
      const taskId = TASK_IDS[created.length];
      // The host must still be able to normalize the goal it receives.
      normalizeGoalSpec(structuredClone(goalInput), { taskId, goalVersion: 1, createdAt: new Date().toISOString() });
      created.push({ goalInput, selectors });
      return { taskId, snapshot: { state: "running" } };
    },
    listTasks: async () => created.map((_, index) => ({ taskId: TASK_IDS[index], originalRequest: `r${index}`, state: "running", createdAt: "2026-10-01T00:00:00.000Z" })),
  });
  return { store, service, created };
}

const agent = (store, overrides = {}) => store.saveAgent({
  name: "Work Assistant", title: "비서", description: "업무 정리", avatar,
  instructions: "가".repeat(1200), capabilityId: "browser", ...overrides,
});

test("an agent task uses the agent capability and carries its role only as goal constraints", async () => {
  const { store, service, created } = await setup();
  const saved = await agent(store);
  const result = await service.startAgentTask({ agentId: saved.id, request: "내일 일정 정리" });
  assert.equal(result.taskId, TASK_IDS[0]);
  const [{ goalInput, selectors }] = created;
  assert.deepEqual(selectors, { requestedCapabilityProfile: "browser" });
  assert.equal(goalInput.originalRequest, "내일 일정 정리");
  assert.deepEqual(Object.keys(goalInput).sort(), ["constraints", "originalRequest"]);
  assert.ok(goalInput.constraints.length >= 3);
  for (const constraint of goalInput.constraints) {
    assert.match(constraint.id, /^agent-role-\d+$/);
    assert.ok(constraint.text.length <= 512);
  }
  const links = await store.listLinks({ kind: "agent", ownerId: saved.id });
  assert.deepEqual(links.map(({ taskId, generation }) => ({ taskId, generation })), [{ taskId: TASK_IDS[0], generation: 1 }]);
});

test("a team task starts a multi_agent parent that splits work by member role", async () => {
  const { store, service, created } = await setup();
  const a = await agent(store, { name: "Researcher", instructions: "자료 조사" });
  const b = await agent(store, { name: "Writer", capabilityId: "browser", instructions: "초안 작성" });
  const team = await store.saveTeam({ name: "Content Planning", title: "", description: "", avatar, memberAgentIds: [a.id, b.id] });
  await service.startAgentTask({ teamId: team.id, request: "블로그 글 기획" });
  const [{ goalInput, selectors }] = created;
  assert.deepEqual(selectors, { requestedCapabilityProfile: "multi_agent" });
  const texts = goalInput.constraints.map((constraint) => constraint.text);
  assert.ok(texts.some((value) => value.includes("자식 작업")));
  assert.ok(texts.some((value) => value.includes("Researcher") && value.includes("자료 조사")));
  assert.ok(texts.some((value) => value.includes("Writer") && value.includes("초안 작성")));
  assert.ok(goalInput.constraints.every((constraint) => constraint.text.length <= 512));
  assert.equal((await store.listLinks({ kind: "team", ownerId: team.id }))[0].generation, team.generation);
});

test("archived agents, teams, or members refuse to start and create nothing", async () => {
  const { store, service, created } = await setup();
  const a = await agent(store);
  const b = await agent(store);
  const team = await store.saveTeam({ name: "T", title: "", description: "", avatar, memberAgentIds: [a.id, b.id] });
  await store.archiveAgent(b.id);
  await assert.rejects(service.startAgentTask({ teamId: team.id, request: "x" }), { code: "team_member_unavailable" });
  await assert.rejects(service.startAgentTask({ agentId: b.id, request: "x" }), { code: "agent_unavailable" });
  await store.archiveTeam(team.id);
  await assert.rejects(service.startAgentTask({ teamId: team.id, request: "x" }), { code: "agent_unavailable" });
  assert.equal(created.length, 0);
});

test("start input must name exactly one target and a request", async () => {
  const { store, service, created } = await setup();
  const a = await agent(store);
  for (const bad of [{ request: "x" }, { agentId: a.id, teamId: a.id, request: "x" }, { agentId: a.id }, { agentId: a.id, request: "" }, { agentId: a.id, request: "x", extra: 1 }, null]) {
    await assert.rejects(service.startAgentTask(bad), { code: "invalid_start" });
  }
  assert.equal(created.length, 0);
});

test("conversations join links with current task summaries, newest first", async () => {
  const { store, service } = await setup();
  const a = await agent(store);
  await service.startAgentTask({ agentId: a.id, request: "one" });
  await service.startAgentTask({ agentId: a.id, request: "two" });
  const conversations = await service.listAgentConversations({ agentId: a.id });
  assert.deepEqual(conversations.map((item) => item.taskId), [TASK_IDS[1], TASK_IDS[0]]);
  assert.equal(conversations[0].task.state, "running");
  assert.equal(conversations[0].generation, 1);
  await assert.rejects(service.listAgentConversations({}), { code: "invalid_start" });
});

// The goal is re-sent to the planner every turn (context-builder), so role
// text is kept compact: whitespace runs collapse and team lines are budgeted.
test("agent role text is whitespace-compacted before it becomes constraints", async () => {
  const { store, service, created } = await setup();
  const saved = await agent(store, { instructions: "  메일을    정리하고\n\n\n\n   요약한다\t\t끝  " });
  await service.startAgentTask({ agentId: saved.id, request: "x" });
  assert.deepEqual(created[0].goalInput.constraints.map((item) => item.text), ["메일을 정리하고\n\n요약한다 끝"]);
});

test("whitespace-only instructions add no constraints", async () => {
  const { store, service, created } = await setup();
  const saved = await agent(store, { instructions: " \n\t " });
  await service.startAgentTask({ agentId: saved.id, request: "x" });
  assert.equal(created[0].goalInput.constraints, undefined);
});

test("a full six-member team stays within a fixed role budget", async () => {
  const { store, service, created } = await setup();
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push((await agent(store, { name: `M${i}`.padEnd(64, "x"), title: "t".repeat(64), description: "d".repeat(1000), instructions: "역".repeat(2000) })).id);
  }
  const team = await store.saveTeam({ name: "Big".padEnd(64, "x"), title: "", description: "", avatar, memberAgentIds: ids });
  await service.startAgentTask({ teamId: team.id, request: "x" });
  const texts = created[0].goalInput.constraints.map((item) => item.text);
  assert.equal(texts.length, 7);
  assert.ok(texts.slice(1).every((value) => value.length <= 240), "member lines are capped");
  assert.ok(texts.join("").length <= 1700, `team role text is ${texts.join("").length} chars`);
  // Instructions are the role; the description is only a fallback.
  assert.ok(texts[1].includes("역") && !texts[1].includes("ddd"));
});

test("a member without instructions falls back to its description", async () => {
  const { store, service, created } = await setup();
  const a = await agent(store, { name: "Scout", description: "시장 조사 담당", instructions: "" });
  const team = await store.saveTeam({ name: "T", title: "", description: "", avatar, memberAgentIds: [a.id] });
  await service.startAgentTask({ teamId: team.id, request: "x" });
  assert.ok(created[0].goalInput.constraints[1].text.includes("시장 조사 담당"));
});

function rosterSetup(summaries) {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-roster-")).then((root) => {
    const store = new AgentStore({ storageRoot: root });
    let next = 0;
    const service = new AgentService({
      store,
      createTask: async () => ({ taskId: TASK_IDS[next++] }),
      listTasks: async () => summaries.value,
    });
    return { store, service };
  });
}

const summary = (index, state, extra = {}) => ({ taskId: TASK_IDS[index], originalRequest: `r${index}`, state, pauseReason: null, active: true, createdAt: "2026-10-01T00:00:00.000Z", ...extra });

test("the roster summarizes running, awaiting-user, unread, and last conversation per agent", async () => {
  const summaries = { value: [] };
  const { store, service } = await rosterSetup(summaries);
  const busy = await agent(store, { name: "Busy" });
  const idle = await agent(store, { name: "Idle" });
  await service.startAgentTask({ agentId: busy.id, request: "one" });
  await service.startAgentTask({ agentId: busy.id, request: "two" });
  await service.startAgentTask({ agentId: busy.id, request: "three" });
  summaries.value = [summary(0, "completed"), summary(1, "awaiting_approval"), summary(2, "running")];

  const roster = await service.getAgentRoster();
  const busyEntry = roster.agents.find((item) => item.id === busy.id);
  assert.deepEqual(busyEntry.status, {
    running: 1,
    awaitingUser: 1,
    hasUnread: true,
    lastConversation: { taskId: TASK_IDS[2], createdAt: busyEntry.status.lastConversation.createdAt, originalRequest: "r2", state: "running" },
  });
  assert.deepEqual(roster.agents.find((item) => item.id === idle.id).status, { running: 0, awaitingUser: 0, hasUnread: false, lastConversation: null });
  // Agents with recent conversations come first.
  assert.deepEqual(roster.agents.map((item) => item.name), ["Busy", "Idle"]);
  assert.deepEqual(roster.teams, []);
});

test("marking conversations read clears unread until a task state changes again", async () => {
  const summaries = { value: [] };
  const { store, service } = await rosterSetup(summaries);
  const a = await agent(store);
  await service.startAgentTask({ agentId: a.id, request: "one" });
  summaries.value = [summary(0, "completed")];
  assert.equal((await service.getAgentRoster()).agents[0].status.hasUnread, true);
  await service.markAgentConversationsRead({ agentId: a.id });
  assert.equal((await service.getAgentRoster()).agents[0].status.hasUnread, false);
  summaries.value = [summary(0, "stopped")];
  assert.equal((await service.getAgentRoster()).agents[0].status.hasUnread, true);
  await assert.rejects(service.markAgentConversationsRead({ agentId: a.id, request: "x" }), { code: "invalid_start" });
});

test("pinned entries sort first and archived entries sort last", async () => {
  const { store, service } = await rosterSetup({ value: [] });
  await agent(store, { name: "First" });
  const pinned = await agent(store, { name: "Pinned" });
  const gone = await agent(store, { name: "Gone" });
  await store.setPinned({ kind: "agent", id: pinned.id, pinned: true });
  await store.archiveAgent(gone.id);
  assert.deepEqual((await service.getAgentRoster()).agents.map((item) => item.name), ["Pinned", "First", "Gone"]);
});

test("a task whose summary is gone is still listed with task null", async () => {
  const store = new AgentStore({ storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-agent-svc-")) });
  const service = new AgentService({ store, createTask: async () => ({ taskId: TASK_IDS[0] }), listTasks: async () => [] });
  const a = await agent(store);
  await service.startAgentTask({ agentId: a.id, request: "x" });
  assert.deepEqual((await service.listAgentConversations({ agentId: a.id })).map((item) => item.task), [null]);
});
