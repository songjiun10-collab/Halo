"use strict";

// Cross-team communication policy. Teams talk only through their leads;
// a cross-team channel exists only under an explicit, expiring, directed
// lease. Pure and in-memory: the coordinator supplies team membership.

class TeamCommsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TeamCommsError";
    this.code = code;
  }
}

const DEFAULT_MAX_DEPTH = 2;

function teamOf(teams, taskId) {
  return teams.find((team) => team.members.includes(taskId)) ?? null;
}

function decideTeamRoute({ teams, from, to, hops = 0, maxDepth = DEFAULT_MAX_DEPTH }) {
  const sender = teamOf(teams, from);
  const recipient = teamOf(teams, to);
  if (!sender || !recipient) throw new TeamCommsError("unknown_task", "sender or recipient belongs to no team");
  if (hops > maxDepth) throw new TeamCommsError("depth_limit", `relay depth ${hops} exceeds ${maxDepth}`);
  if (sender.teamId === recipient.teamId) return { route: "direct" };
  const via = [];
  if (from !== sender.leadTaskId) via.push(sender.leadTaskId);
  if (to !== recipient.leadTaskId) via.push(recipient.leadTaskId);
  return via.length === 0 ? { route: "lead_to_lead" } : { route: "via_leads", via };
}

class CrossTeamLeases {
  constructor({ ttlMs = 600000, now = () => Date.now() } = {}) {
    this._ttl = ttlMs;
    this._now = now;
    this._leases = new Map();
  }

  active(fromTeam, toTeam) {
    const lease = this._leases.get(`${fromTeam}>${toTeam}`);
    if (!lease) return false;
    if (this._now() >= lease.expiresAt) {
      this._leases.delete(`${fromTeam}>${toTeam}`);
      return false;
    }
    return true;
  }

  grant(fromTeam, toTeam, purpose) {
    if (this.active(fromTeam, toTeam)) throw new TeamCommsError("lease_exists", `${fromTeam}>${toTeam} already leased`);
    this._leases.set(`${fromTeam}>${toTeam}`, { purpose, expiresAt: this._now() + this._ttl });
  }

  revoke(fromTeam, toTeam) {
    return this._leases.delete(`${fromTeam}>${toTeam}`);
  }
}

// request-team-help: a lead asks another team's lead for help.
function requestTeamHelp({ teams, leases, from, toTeamId, text }) {
  const sender = teamOf(teams, from);
  if (!sender) throw new TeamCommsError("unknown_task", "sender belongs to no team");
  if (sender.leadTaskId !== from) throw new TeamCommsError("not_lead", "only a team lead may request help from another team");
  const target = teams.find((team) => team.teamId === toTeamId);
  if (!target) throw new TeamCommsError("unknown_team", `no team ${toTeamId}`);
  if (!leases.active(sender.teamId, toTeamId)) throw new TeamCommsError("no_lease", "no active cross-team lease");
  return { recipientTaskId: target.leadTaskId, messageKind: "question", text };
}

class TeamConversationLog {
  constructor() {
    this._entries = [];
  }

  record(entry) {
    this._entries.push({ ...entry });
  }

  list(fromTeam, toTeam) {
    return this._entries.filter((e) => e.fromTeam === fromTeam && e.toTeam === toTeam);
  }

  revoke(fromTeam, toTeam) {
    this._entries = this._entries.filter((e) => !(e.fromTeam === fromTeam && e.toTeam === toTeam));
  }
}

module.exports = { DEFAULT_MAX_DEPTH, TeamCommsError, decideTeamRoute, CrossTeamLeases, requestTeamHelp, TeamConversationLog };
