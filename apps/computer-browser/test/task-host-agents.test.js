"use strict";

// TaskHost wiring for the Agent roster (docs/superpowers/specs/
// 2026-10-01-agent-roster-and-teams-design.md): the methods exist on the host,
// stay closed after close(), and an Agent start becomes an ordinary task whose
// goal carries the role constraints.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

async function makeHost() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-agents-"));
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }),
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  hosts.add(host);
  return { host, storageRoot };
}

const agentInput = {
  name: "Mail Assistant", title: "", description: "", avatar: { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] },
  instructions: "중요한 메일만 요약한다", capabilityId: "browser",
};

test("agent and team CRUD is exposed on the host and stored under its storage root", async () => {
  const { host, storageRoot } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  assert.deepEqual((await host.listAgents()).map((agent) => agent.id), [saved.id]);
  await fs.access(path.join(storageRoot, "agents", "agents.json"));
  const team = await host.saveTeam({ name: "T", title: "", description: "", avatar: agentInput.avatar, memberAgentIds: [saved.id] });
  assert.deepEqual((await host.listTeams()).map((item) => item.id), [team.id]);
  assert.equal((await host.archiveTeam(team.id)).archived, true);
  assert.equal((await host.archiveAgent(saved.id)).archived, true);
});

test("startAgentTask creates a normal task carrying the role and lists it as a conversation", async () => {
  const { host } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  const { taskId } = await host.startAgentTask({ agentId: saved.id, request: "받은 메일 정리" });
  const detail = await host.getTaskDetail(taskId);
  assert.equal(detail.goal.originalRequest, "받은 메일 정리");
  assert.deepEqual(detail.goal.constraints.map((constraint) => constraint.text), ["중요한 메일만 요약한다"]);
  const conversations = await host.listAgentConversations({ agentId: saved.id });
  assert.deepEqual(conversations.map((item) => item.taskId), [taskId]);
  assert.equal(conversations[0].task.taskId, taskId);
});

test("the roster, pin, duplicate, and read marker work through the host", async () => {
  const { host } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  const copy = await host.duplicateAgent(saved.id);
  await host.setAgentPinned({ kind: "agent", id: copy.id, pinned: true });
  await host.startAgentTask({ agentId: saved.id, request: "받은 메일 정리" });
  const roster = await host.getAgentRoster();
  assert.deepEqual(roster.agents.map((item) => item.id), [copy.id, saved.id]);
  assert.ok(roster.agents[1].status.lastConversation);
  const { marked } = await host.markAgentConversationsRead({ agentId: saved.id });
  assert.equal(marked, 1);
});

test("agent methods fail closed after close()", async () => {
  const { host } = await makeHost();
  await host.close();
  await assert.rejects(host.listAgents());
  await assert.rejects(host.startAgentTask({ agentId: "x", request: "y" }));
});
