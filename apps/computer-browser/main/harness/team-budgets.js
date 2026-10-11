"use strict";

// Per-team and cross-team budgets with release. Teams are registered lazily on
// first spend from the per-team template; release() returns the unspent part to
// the shared pool and forgets the team so a retired team cannot keep spending.

class TeamBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TeamBudgetError";
    this.code = code;
  }
}

class TeamBudgets {
  constructor({ perTeam = {}, crossTeam = {}, pool = {} } = {}) {
    this._template = { ...perTeam };
    this._crossTemplate = { ...crossTeam };
    this._pool = { ...pool };
    this._teams = new Map();
    this._cross = new Map();
    this._released = new Set();
  }

  _team(teamId) {
    if (this._released.has(teamId)) throw new TeamBudgetError("unknown_team", `${teamId} was released`);
    if (!this._teams.has(teamId)) this._teams.set(teamId, { ...this._template });
    return this._teams.get(teamId);
  }

  _take(bucket, key, amount, label) {
    if (!(key in bucket) || !Number.isFinite(amount) || amount < 0) throw new TeamBudgetError("budget_exhausted", `${label}: no ${key} budget`);
    if (bucket[key] < amount) throw new TeamBudgetError("budget_exhausted", `${label}: ${key} exhausted`);
    bucket[key] -= amount;
  }

  spend(teamId, key, amount = 1) {
    this._take(this._team(teamId), key, amount, teamId);
  }

  spendCrossTeam(fromTeam, toTeam, key, amount = 1) {
    const id = `${fromTeam}>${toTeam}`;
    if (!this._cross.has(id)) this._cross.set(id, { ...this._crossTemplate });
    this._take(this._cross.get(id), key, amount, id);
  }

  remaining(teamId) {
    return { ...this._team(teamId) };
  }

  poolRemaining() {
    return { ...this._pool };
  }

  release(teamId) {
    const left = { ...this._team(teamId) };
    for (const [key, value] of Object.entries(left)) this._pool[key] = (this._pool[key] ?? 0) + value;
    this._teams.delete(teamId);
    this._released.add(teamId);
    return left;
  }
}

module.exports = { TeamBudgets, TeamBudgetError };
