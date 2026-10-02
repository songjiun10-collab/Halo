"use strict";

// Host-owned roster of user-defined Agents and Teams (docs/superpowers/specs/
// 2026-10-01-agent-roster-and-teams-design.md). Everything here is display
// and routing data: an Agent's instructions only become goal constraints of
// a task the user starts, and a task link only groups tasks into an Agent's
// conversation list. Neither grants a permission, capability, or approval.

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getCapabilityProfile } = require("../../shared/capability-registry");
const { MCP_PROVIDER_IDS } = require("./host-settings");
const { PLANNER_PROVIDERS } = require("./planner-providers");

const SCHEMA_VERSION = 3;
const STORE_FIELDS = ["schemaVersion", "agents", "teams", "links"];
const AGENT_FIELDS = ["id", "name", "title", "description", "avatar", "instructions", "capabilityId", "mcpProviders", "model", "generation", "createdAt", "updatedAt", "archived", "pinned"];
// model is optional on stored records: ones saved before it existed inherit.
const AGENT_REQUIRED_FIELDS = AGENT_FIELDS.filter((key) => key !== "model");
const TEAM_FIELDS = ["id", "name", "title", "description", "avatar", "memberAgentIds", "generation", "createdAt", "updatedAt", "archived", "pinned"];
const LINK_FIELDS = ["taskId", "kind", "ownerId", "generation", "createdAt", "seenState"];
// Task states as reported by TaskHost summaries; only used for read markers.
const TASK_STATES = ["idle", "running", "awaiting_approval", "awaiting_verification", "paused", "stopped", "completed"];
const AGENT_INPUT_FIELDS = ["id", "name", "title", "description", "avatar", "instructions", "capabilityId", "mcpProviders", "model"];
const TEAM_INPUT_FIELDS = ["id", "name", "title", "description", "avatar", "memberAgentIds"];

const AGENT_SHAPES = Object.freeze(["circle", "square", "bag", "star", "drop", "cloud", "triangle", "hex"]);
const AGENT_COLORS = Object.freeze(["brown", "yellow", "blue", "gray", "red", "green", "purple", "orange"]);
// Multi-agent is the team parent's capability, never a single Agent's.
const AGENT_CAPABILITIES = Object.freeze(["browser", "research", "computer_use"]);
const MAX_TEAM_MEMBERS = 6;
const ARCHIVED_HEADROOM = 10;
const LIMITS = Object.freeze({ name: 64, title: 64, description: 1000, instructions: 2000 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class AgentStoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "AgentStoreError";
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function exactKeys(value, fields, required, code, label) {
  if (!isPlainObject(value)) throw new AgentStoreError(code, `${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new AgentStoreError(code, `${label} has unknown field "${key}"`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new AgentStoreError(code, `${label}.${key} is required`);
  }
}

function text(value, max, { min = 0 } = {}, code, label) {
  if (typeof value !== "string" || value.length < min || value.length > max || (min > 0 && value.trim().length === 0)) {
    throw new AgentStoreError(code, `${label} must be a string of ${min}..${max} characters`);
  }
  return value;
}

function uuid(value, code, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new AgentStoreError(code, `${label} must be a UUID`);
  return value;
}

function avatar(value, code, label) {
  exactKeys(value, ["shape", "color"], ["shape", "color"], code, label);
  if (!AGENT_SHAPES.includes(value.shape) || !AGENT_COLORS.includes(value.color)) {
    throw new AgentStoreError(code, `${label} must use a host-listed shape and color`);
  }
  return { shape: value.shape, color: value.color };
}

function profileFields(input, code, label) {
  return {
    name: text(input.name, LIMITS.name, { min: 1 }, code, `${label}.name`),
    title: text(input.title ?? "", LIMITS.title, {}, code, `${label}.title`),
    description: text(input.description ?? "", LIMITS.description, {}, code, `${label}.description`),
    avatar: avatar(input.avatar, code, `${label}.avatar`),
  };
}

function stamp(value, label) {
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || typeof value.archived !== "boolean" ||
      typeof value.pinned !== "boolean") {
    throw new AgentStoreError("invalid_store", `${label} has invalid bookkeeping fields`);
  }
}

function validateAgentRecord(value, label) {
  exactKeys(value, AGENT_FIELDS, AGENT_REQUIRED_FIELDS, "invalid_store", label);
  uuid(value.id, "invalid_store", `${label}.id`);
  profileFields(value, "invalid_store", label);
  text(value.instructions, LIMITS.instructions, {}, "invalid_store", `${label}.instructions`);
  if (!AGENT_CAPABILITIES.includes(value.capabilityId)) throw new AgentStoreError("invalid_store", `${label}.capabilityId is unknown`);
  mcpSubset(value.mcpProviders, "invalid_store", `${label}.mcpProviders`);
  if (Object.hasOwn(value, "model")) plannerModel(value.model, "invalid_store", `${label}.model`);
  stamp(value, label);
}

// null runs the host's planner setting; otherwise an id from one planner
// provider's allowlist (the task host derives the provider from it).
function plannerModel(value, code, label) {
  if (value === null) return null;
  if (!Object.values(PLANNER_PROVIDERS).some((provider) => provider.isModel(value))) {
    throw new AgentStoreError(code, `${label} must be null or an allowlisted planner model id`);
  }
  return value;
}

// null inherits the host's enabled MCP providers; an array may only narrow
// them (the task host intersects it with its own setting at task start).
function mcpSubset(value, code, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((id) => !MCP_PROVIDER_IDS.includes(id)) || new Set(value).size !== value.length) {
    throw new AgentStoreError(code, `${label} must be null or distinct known MCP provider ids`);
  }
  return [...value];
}

function validateTeamRecord(value, label) {
  exactKeys(value, TEAM_FIELDS, TEAM_FIELDS, "invalid_store", label);
  uuid(value.id, "invalid_store", `${label}.id`);
  profileFields(value, "invalid_store", label);
  memberIds(value.memberAgentIds, "invalid_store", `${label}.memberAgentIds`);
  stamp(value, label);
}

function memberIds(value, code, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TEAM_MEMBERS) {
    throw new AgentStoreError(code, `${label} must list 1..${MAX_TEAM_MEMBERS} agents`);
  }
  value.forEach((id, index) => uuid(id, code, `${label}[${index}]`));
  if (new Set(value).size !== value.length) throw new AgentStoreError(code, `${label} must not repeat an agent`);
  return [...value];
}

function validateLink(value, code, label) {
  exactKeys(value, LINK_FIELDS, LINK_FIELDS, code, label);
  uuid(value.taskId, code, `${label}.taskId`);
  if (value.kind !== "agent" && value.kind !== "team") throw new AgentStoreError(code, `${label}.kind must be agent or team`);
  uuid(value.ownerId, code, `${label}.ownerId`);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new AgentStoreError(code, `${label}.generation is invalid`);
  if (typeof value.createdAt !== "string") throw new AgentStoreError(code, `${label}.createdAt is invalid`);
  if (value.seenState !== null && !TASK_STATES.includes(value.seenState)) throw new AgentStoreError(code, `${label}.seenState is invalid`);
}

// v1 had no display prefs and v2 no MCP subset; fill their defaults before
// strict validation.
function upgrade(value) {
  if (!isPlainObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return value;
  const fill = (records, defaults) => (Array.isArray(records)
    ? records.map((record) => (isPlainObject(record) ? { ...defaults, ...record } : record))
    : records);
  return {
    ...value,
    schemaVersion: SCHEMA_VERSION,
    agents: fill(value.agents, { pinned: false, mcpProviders: null }),
    teams: fill(value.teams, { pinned: false }),
    links: fill(value.links, { seenState: null }),
  };
}

function validateStore(value) {
  exactKeys(value, STORE_FIELDS, STORE_FIELDS, "invalid_store", "agents.json");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new AgentStoreError("invalid_store", "agents.json has an unknown schemaVersion");
  for (const key of ["agents", "teams", "links"]) {
    if (!Array.isArray(value[key])) throw new AgentStoreError("invalid_store", `agents.json ${key} must be an array`);
  }
  value.agents.forEach((agent, index) => validateAgentRecord(agent, `agents[${index}]`));
  value.teams.forEach((team, index) => validateTeamRecord(team, `teams[${index}]`));
  value.links.forEach((link, index) => validateLink(link, "invalid_store", `links[${index}]`));
  return value;
}

const copy = (value) => structuredClone(value);

class AgentStore {
  constructor({ storageRoot, maxAgents = 50, maxTeams = 20, maxLinks = 500, now = () => new Date().toISOString() } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new AgentStoreError("invalid_config", "storageRoot is required");
    for (const limit of [maxAgents, maxTeams, maxLinks]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new AgentStoreError("invalid_config", "limits must be positive integers");
    }
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "agents.json");
    this._limits = { maxAgents, maxTeams, maxLinks };
    this._now = now;
    this._chain = Promise.resolve();
  }

  async listAgents() { return copy((await this._read()).agents); }
  async listTeams() { return copy((await this._read()).teams); }

  async getAgent(id) {
    uuid(id, "invalid_id", "agent id");
    const agent = (await this._read()).agents.find((item) => item.id === id);
    if (!agent) throw new AgentStoreError("not_found", "agent does not exist");
    return copy(agent);
  }

  async getTeam(id) {
    uuid(id, "invalid_id", "team id");
    const team = (await this._read()).teams.find((item) => item.id === id);
    if (!team) throw new AgentStoreError("not_found", "team does not exist");
    return copy(team);
  }

  saveAgent(input) {
    return this._mutate((state) => {
      exactKeys(input, AGENT_INPUT_FIELDS, ["name", "avatar", "capabilityId"], "invalid_agent", "agent");
      const fields = profileFields(input, "invalid_agent", "agent");
      fields.instructions = text(input.instructions ?? "", LIMITS.instructions, {}, "invalid_agent", "agent.instructions");
      if (!AGENT_CAPABILITIES.includes(input.capabilityId)) throw new AgentStoreError("invalid_agent", "agent.capabilityId is not selectable");
      // Stored records may keep a capability that later becomes unavailable
      // (task start then fails closed in the router); new saves may not.
      if (!getCapabilityProfile(input.capabilityId).available) {
        throw new AgentStoreError("capability_unavailable", `${input.capabilityId} capability is not available`);
      }
      fields.capabilityId = input.capabilityId;
      // Omitted on an edit keeps the saved subset; omitted on create inherits.
      if (Object.hasOwn(input, "mcpProviders")) fields.mcpProviders = mcpSubset(input.mcpProviders, "invalid_agent", "agent.mcpProviders");
      else if (input.id === undefined) fields.mcpProviders = null;
      if (Object.hasOwn(input, "model")) fields.model = plannerModel(input.model, "invalid_agent", "agent.model");
      else if (input.id === undefined) fields.model = null;
      return this._upsert(state.agents, input.id, fields, this._limits.maxAgents, "agent");
    });
  }

  saveTeam(input) {
    return this._mutate((state) => {
      exactKeys(input, TEAM_INPUT_FIELDS, ["name", "avatar", "memberAgentIds"], "invalid_team", "team");
      const fields = profileFields(input, "invalid_team", "team");
      fields.memberAgentIds = memberIds(input.memberAgentIds, "invalid_team", "team.memberAgentIds");
      for (const id of fields.memberAgentIds) {
        const agent = state.agents.find((item) => item.id === id);
        if (!agent || agent.archived) throw new AgentStoreError("unknown_member", "every team member must be an existing, unarchived agent");
      }
      return this._upsert(state.teams, input.id, fields, this._limits.maxTeams, "team");
    });
  }

  archiveAgent(id) { return this._archive("agents", id, "agent"); }
  archiveTeam(id) { return this._archive("teams", id, "team"); }

  linkTask(input) {
    return this._mutate((state) => {
      const link = { ...input, createdAt: this._now(), seenState: null };
      validateLink(link, "invalid_link", "link");
      state.links.push(link);
      if (state.links.length > this._limits.maxLinks) state.links.splice(0, state.links.length - this._limits.maxLinks);
      return link;
    });
  }

  // Display preference only: no generation bump, so links stay comparable.
  setPinned(input) {
    return this._mutate((state) => {
      exactKeys(input, ["kind", "id", "pinned"], ["kind", "id", "pinned"], "invalid_pin", "pin");
      if ((input.kind !== "agent" && input.kind !== "team") || typeof input.pinned !== "boolean") {
        throw new AgentStoreError("invalid_pin", "pin needs kind agent|team and a boolean pinned");
      }
      uuid(input.id, "invalid_id", `${input.kind} id`);
      const record = state[input.kind === "agent" ? "agents" : "teams"].find((item) => item.id === input.id);
      if (!record) throw new AgentStoreError("not_found", `${input.kind} does not exist`);
      record.pinned = input.pinned;
      return record;
    });
  }

  duplicateAgent(id) {
    return this._mutate((state) => {
      uuid(id, "invalid_id", "agent id");
      const source = state.agents.find((item) => item.id === id);
      if (!source) throw new AgentStoreError("not_found", "agent does not exist");
      if (source.archived) throw new AgentStoreError("archived", "archived agents cannot be duplicated");
      if (!getCapabilityProfile(source.capabilityId).available) {
        throw new AgentStoreError("capability_unavailable", `${source.capabilityId} capability is not available`);
      }
      const suffix = " 사본";
      const fields = {
        name: `${source.name.slice(0, LIMITS.name - suffix.length)}${suffix}`,
        title: source.title,
        description: source.description,
        avatar: { ...source.avatar },
        instructions: source.instructions,
        capabilityId: source.capabilityId,
        mcpProviders: source.mcpProviders === null ? null : [...source.mcpProviders],
        model: source.model ?? null,
      };
      return this._upsert(state.agents, undefined, fields, this._limits.maxAgents, "agent");
    });
  }

  // states: {taskId: TaskState} as currently reported by the host; links of
  // this owner whose task is listed get that state as their read marker.
  markLinksSeen({ kind, ownerId, states } = {}) {
    return this._mutate((state) => {
      if (kind !== "agent" && kind !== "team") throw new AgentStoreError("invalid_link", "kind must be agent or team");
      uuid(ownerId, "invalid_id", "ownerId");
      if (!isPlainObject(states) || Object.values(states).some((value) => !TASK_STATES.includes(value))) {
        throw new AgentStoreError("invalid_link", "states must map task ids to task states");
      }
      let marked = 0;
      for (const link of state.links) {
        if (link.kind === kind && link.ownerId === ownerId && Object.hasOwn(states, link.taskId)) {
          link.seenState = states[link.taskId];
          marked += 1;
        }
      }
      return { marked };
    });
  }

  // One consistent read of the whole roster, newest links first.
  async snapshot() {
    const state = await this._read();
    return copy({ agents: state.agents, teams: state.teams, links: [...state.links].reverse() });
  }

  async listLinks({ kind, ownerId }) {
    if (kind !== "agent" && kind !== "team") throw new AgentStoreError("invalid_link", "kind must be agent or team");
    uuid(ownerId, "invalid_id", "ownerId");
    return copy((await this._read()).links.filter((link) => link.kind === kind && link.ownerId === ownerId).reverse());
  }

  _upsert(records, id, fields, limit, label) {
    const at = this._now();
    if (id === undefined) {
      // Archiving frees a slot (the UI counts active records only). A fixed
      // multiple of the limit still bounds the file, archived records included.
      if (records.filter((item) => !item.archived).length >= limit) throw new AgentStoreError("limit_reached", `at most ${limit} ${label}s can be active; archive one to make room`);
      if (records.length >= limit * ARCHIVED_HEADROOM) throw new AgentStoreError("limit_reached", `too many archived ${label}s are stored`);
      const record = { id: randomUUID(), ...fields, generation: 1, createdAt: at, updatedAt: at, archived: false, pinned: false };
      records.push(record);
      return record;
    }
    uuid(id, "invalid_id", `${label} id`);
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) throw new AgentStoreError("not_found", `${label} does not exist`);
    const current = records[index];
    if (current.archived) throw new AgentStoreError("archived", `archived ${label}s cannot be edited`);
    if (!Number.isSafeInteger(current.generation + 1)) throw new AgentStoreError("generation_exhausted", `${label} generation exhausted`);
    records[index] = { ...current, ...fields, generation: current.generation + 1, updatedAt: at };
    return records[index];
  }

  _archive(key, id, label) {
    return this._mutate((state) => {
      uuid(id, "invalid_id", `${label} id`);
      const record = state[key].find((item) => item.id === id);
      if (!record) throw new AgentStoreError("not_found", `${label} does not exist`);
      if (!record.archived) {
        record.archived = true;
        record.updatedAt = this._now();
      }
      return record;
    });
  }

  // Every write re-reads, applies, validates the whole next state, then
  // persists, all on one chain so concurrent saves cannot lose each other.
  _mutate(apply) {
    const operation = this._chain.then(async () => {
      const state = await this._read();
      const result = apply(state);
      validateStore(state);
      await this._write(state);
      return copy(result);
    });
    this._chain = operation.catch(() => {});
    return operation;
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentStoreError("unsafe_path", "agent directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }

  async _read() {
    await this._ensureDirectory();
    let textValue;
    try {
      const handle = await fs.open(this._file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { textValue = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, agents: [], teams: [], links: [] };
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new AgentStoreError("unsafe_path", "agents.json must not be a symlink");
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(textValue); }
    catch { throw new AgentStoreError("invalid_store", "agents.json is not valid JSON"); }
    return validateStore(upgrade(parsed));
  }

  async _write(state) {
    try {
      const existing = await fs.lstat(this._file);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new AgentStoreError("unsafe_path", "agents.json must be a regular file");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(this._directory, `.agents.json-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(state), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this._file);
      const directory = await fs.open(this._directory, fsConstants.O_RDONLY);
      try { await directory.sync(); }
      catch (error) { if (!["EINVAL", "EISDIR"].includes(error.code)) throw error; }
      finally { await directory.close(); }
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  AgentStore, AgentStoreError, AGENT_SHAPES, AGENT_COLORS, AGENT_CAPABILITIES, MAX_TEAM_MEMBERS, LIMITS, TASK_STATES,
};
