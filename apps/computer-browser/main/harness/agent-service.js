"use strict";

// Starts tasks on behalf of a saved Agent or Team (docs/superpowers/specs/
// 2026-10-01-agent-roster-and-teams-design.md). It only composes ordinary
// TaskHost.createTask input: the capability comes from the Agent's own
// host-validated capabilityId (or multi_agent for a Team parent), and the
// role text is added as goal constraints the user authored. Children of a
// Team parent are still created by the existing child plan path, so their
// observe+scroll policy is unchanged.

const { AgentStoreError } = require("./agent-store");
const { DEFAULT_LIMITS } = require("../../shared/harness-contracts");

const CONSTRAINT_CHARS = 512;
const START_FIELDS = ["agentId", "teamId", "request"];

class AgentServiceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "AgentServiceError";
    this.code = code;
  }
}

function chunks(value, size) {
  const parts = [];
  for (let index = 0; index < value.length; index += size) parts.push(value.slice(index, index + size));
  return parts;
}

function target(input, { requireRequest }) {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !START_FIELDS.includes(key) || (!requireRequest && key === "request"))) {
    throw new AgentServiceError("invalid_start", "input has unknown fields");
  }
  const hasAgent = input.agentId !== undefined;
  const hasTeam = input.teamId !== undefined;
  if (hasAgent === hasTeam) throw new AgentServiceError("invalid_start", "exactly one of agentId or teamId is required");
  if (requireRequest && (typeof input.request !== "string" || input.request.trim().length === 0)) {
    throw new AgentServiceError("invalid_start", "request must be a non-empty string");
  }
  return hasAgent ? { kind: "agent", ownerId: input.agentId } : { kind: "team", ownerId: input.teamId };
}

// The goal (constraints included) is re-sent on every planner turn, so role
// text is compacted once here instead of paying for stray whitespace per turn.
function compact(value) {
  return value
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// A team leader only needs each member's role to split the work, so a member
// line is capped well below a constraint's limit (6 members ≈ 1.5k chars).
const MEMBER_LINE_CHARS = 240;

function memberLine(agent) {
  const head = `멤버 ${agent.name}${agent.title ? `(${agent.title})` : ""}`;
  const role = compact(agent.instructions) || compact(agent.description);
  return clip(role ? `${head}: ${role}` : head, MEMBER_LINE_CHARS);
}

// States the user should look at: an approval or check is waiting on them.
const AWAITING_USER = new Set(["awaiting_approval", "awaiting_verification", "paused"]);
const IN_PROGRESS = new Set(["running", "idle"]);

function rosterStatus(links, summaries) {
  let running = 0;
  let awaitingUser = 0;
  let hasUnread = false;
  for (const link of links) {
    const task = summaries.get(link.taskId);
    if (!task) continue;
    if (IN_PROGRESS.has(task.state)) { running += 1; continue; }
    if (AWAITING_USER.has(task.state)) awaitingUser += 1;
    if (task.state !== link.seenState) hasUnread = true;
  }
  const latest = links[0];
  const latestTask = latest ? summaries.get(latest.taskId) : null;
  return {
    running,
    awaitingUser,
    hasUnread,
    lastConversation: latest ? {
      taskId: latest.taskId,
      createdAt: latest.createdAt,
      originalRequest: latestTask?.originalRequest ?? null,
      state: latestTask?.state ?? null,
    } : null,
  };
}

// Active before archived, pinned first, then entries with conversations by
// most recent conversation, then oldest-created first for a stable order.
function rosterOrder(a, b) {
  if (a.archived !== b.archived) return a.archived ? 1 : -1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aLast = a.status.lastConversation?.createdAt ?? null;
  const bLast = b.status.lastConversation?.createdAt ?? null;
  if ((aLast === null) !== (bLast === null)) return aLast === null ? 1 : -1;
  if (aLast !== bLast) return aLast < bLast ? 1 : -1;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

class AgentService {
  constructor({ store, createTask, listTasks } = {}) {
    if (!store || typeof createTask !== "function" || typeof listTasks !== "function") {
      throw new AgentServiceError("invalid_config", "store, createTask and listTasks are required");
    }
    this._store = store;
    this._createTask = createTask;
    this._listTasks = listTasks;
  }

  // unattended is host-internal (the Agent scheduler), never renderer input:
  // {reviewFallback: "queue"|"deny", maxPlannerCalls} from a saved schedule.
  async startAgentTask(input, unattended = null) {
    const { kind, ownerId } = target(input, { requireRequest: true });
    const plan = kind === "agent" ? await this._agentPlan(ownerId) : await this._teamPlan(ownerId);
    const constraints = plan.constraints.map((textValue, index) => ({ id: `agent-role-${index + 1}`, text: textValue }));
    const result = await this._createTask(
      {
        originalRequest: input.request,
        ...(constraints.length ? { constraints } : {}),
        ...(unattended ? { limits: { ...DEFAULT_LIMITS, maxPlannerCalls: unattended.maxPlannerCalls } } : {}),
      },
      {
        requestedCapabilityProfile: plan.capabilityId,
        ...(plan.mcpProviders ? { mcpProviders: plan.mcpProviders } : {}),
        ...(plan.model ? { plannerModel: plan.model } : {}),
        ...(unattended ? { reviewFallback: unattended.reviewFallback } : {}),
      },
    );
    // Display grouping only. A crash before this write leaves a normal task
    // that simply does not appear in the Agent's conversation list.
    await this._store.linkTask({ taskId: result.taskId, kind, ownerId, generation: plan.generation });
    return result;
  }

  async listAgentConversations(input) {
    const { kind, ownerId } = target(input, { requireRequest: false });
    const links = await this._store.listLinks({ kind, ownerId });
    const summaries = new Map((await this._listTasks()).map((summary) => [summary.taskId, summary]));
    return links.map((link) => ({ ...link, task: summaries.get(link.taskId) ?? null }));
  }

  // One read of the roster, links, and task summaries, folded into per-entry
  // status for the Agent home. Pure display: nothing here starts or resumes.
  async getAgentRoster() {
    const [{ agents, teams, links }, summaryList] = await Promise.all([this._store.snapshot(), this._listTasks()]);
    const summaries = new Map(summaryList.map((item) => [item.taskId, item]));
    const byOwner = new Map();
    for (const link of links) {
      const key = `${link.kind}:${link.ownerId}`;
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(link);
    }
    const entries = (kind, records) => records
      .map((record) => ({ ...record, status: rosterStatus(byOwner.get(`${kind}:${record.id}`) ?? [], summaries) }))
      .sort(rosterOrder);
    return { agents: entries("agent", agents), teams: entries("team", teams) };
  }

  async markAgentConversationsRead(input) {
    const { kind, ownerId } = target(input, { requireRequest: false });
    const states = {};
    for (const item of await this._listTasks()) {
      if (typeof item.taskId === "string" && typeof item.state === "string") states[item.taskId] = item.state;
    }
    return this._store.markLinksSeen({ kind, ownerId, states });
  }

  async _load(getter, id) {
    try { return await getter.call(this._store, id); }
    catch (error) {
      if (error instanceof AgentStoreError && ["not_found", "invalid_id"].includes(error.code)) {
        throw new AgentServiceError("agent_unavailable", error.message);
      }
      throw error;
    }
  }

  async _agentPlan(agentId) {
    const agent = await this._load(this._store.getAgent, agentId);
    if (agent.archived) throw new AgentServiceError("agent_unavailable", "archived agents cannot start tasks");
    return {
      capabilityId: agent.capabilityId,
      mcpProviders: agent.mcpProviders ?? null,
      // A team parent plans with the host model; only a single Agent pins one.
      model: agent.model ?? null,
      generation: agent.generation,
      constraints: chunks(compact(agent.instructions), CONSTRAINT_CHARS),
    };
  }

  async _teamPlan(teamId) {
    const team = await this._load(this._store.getTeam, teamId);
    if (team.archived) throw new AgentServiceError("agent_unavailable", "archived teams cannot start tasks");
    const members = [];
    for (const id of team.memberAgentIds) {
      let member;
      try { member = await this._store.getAgent(id); }
      catch { member = null; }
      if (!member || member.archived) throw new AgentServiceError("team_member_unavailable", "every team member must be available");
      members.push(member);
    }
    // A team narrows only when every member does: the union of their subsets.
    const scoped = members.every((member) => Array.isArray(member.mcpProviders));
    return {
      capabilityId: "multi_agent",
      mcpProviders: scoped ? [...new Set(members.flatMap((member) => member.mcpProviders))] : null,
      generation: team.generation,
      constraints: [
        `팀 ${team.name}: 목표를 멤버 역할별로 나눠 자식 작업으로 진행하고 결과를 합친다.`,
        ...members.map(memberLine),
      ],
    };
  }
}

module.exports = { AgentService, AgentServiceError };
