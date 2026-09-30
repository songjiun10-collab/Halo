"use strict";

// Host-owned running totals of planner usage per provider and per task. Only
// numbers from shared/usage.js are stored; the file is rewritten atomically and
// a corrupt or missing file simply starts an empty ledger.

const fs = require("node:fs/promises");
const path = require("node:path");
const { PROVIDERS, emptyTotals, addUsage, normalizeUsage } = require("../../shared/usage");

const MAX_TASKS = 500;
const MAX_LIMIT_TOKENS = 1e13;
const MAX_LIMIT_COST_USD = 1e7;

class UsageLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UsageLimitError";
    this.code = code;
  }
}

function checkLimit(value, max, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new UsageLimitError("invalid_limit", `${field} must be null or a positive number within bounds`);
  return value;
}

class UsageLedger {
  constructor({ storageRoot } = {}) {
    this._file = storageRoot ? path.join(storageRoot, "usage-ledger.json") : null;
    this._byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, emptyTotals()]));
    this._byTask = new Map();
    this._imported = {}; // provider -> last full import of the CLI's own records
    this._limits = Object.fromEntries(PROVIDERS.map((p) => [p, { tokens: null, costUsd: null }]));
    this._writing = Promise.resolve();
  }

  async load() {
    if (!this._file) return this;
    try {
      const data = JSON.parse(await fs.readFile(this._file, "utf8"));
      for (const p of PROVIDERS) if (data.byProvider?.[p]) Object.assign(this._byProvider[p], emptyTotals(), data.byProvider[p]);
      for (const p of PROVIDERS) {
        const imp = data.imported?.[p];
        if (imp && typeof imp === "object" && imp.provider === p) this._imported[p] = imp;
      }
      for (const p of PROVIDERS) {
        try {
          const l = data.limits?.[p] ?? {};
          this._limits[p] = { tokens: checkLimit(l.tokens, MAX_LIMIT_TOKENS, "tokens") ?? null, costUsd: checkLimit(l.costUsd, MAX_LIMIT_COST_USD, "costUsd") ?? null };
        } catch {
          // ignore a corrupt limit entry
        }
      }
      for (const [taskId, byProvider] of Object.entries(data.byTask ?? {})) this._byTask.set(taskId, byProvider);
    } catch {
      // start empty
    }
    return this;
  }

  record(taskId, provider, raw) {
    const usage = raw && raw.provider === provider ? raw : normalizeUsage(provider, raw);
    if (!usage || typeof taskId !== "string") return null;
    addUsage(this._byProvider[provider], usage);
    let entry = this._byTask.get(taskId);
    if (!entry) {
      entry = Object.fromEntries(PROVIDERS.map((p) => [p, emptyTotals()]));
      this._byTask.set(taskId, entry);
      if (this._byTask.size > MAX_TASKS) this._byTask.delete(this._byTask.keys().next().value);
    }
    addUsage(entry[provider], usage);
    this._persist();
    return usage;
  }

  // Display-only budget the user declares for an account, since neither CLI
  // reports its remaining subscription quota. Nothing here blocks planner calls.
  setLimit(provider, patch) {
    if (!PROVIDERS.includes(provider)) throw new UsageLimitError("invalid_provider", "provider is not recognized");
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) throw new UsageLimitError("invalid_limit", "limit patch must be an object");
    const unknown = Object.keys(patch).filter((k) => k !== "tokens" && k !== "costUsd");
    if (unknown.length) throw new UsageLimitError("invalid_limit", `unknown limit fields: ${unknown.join(",")}`);
    const next = { ...this._limits[provider] };
    const tokens = checkLimit(patch.tokens, MAX_LIMIT_TOKENS, "tokens");
    const costUsd = checkLimit(patch.costUsd, MAX_LIMIT_COST_USD, "costUsd");
    if (tokens !== undefined) next.tokens = tokens;
    if (costUsd !== undefined) next.costUsd = costUsd;
    this._limits[provider] = next;
    this._persist();
    return { ...next };
  }

  // Replaces (never adds to) the provider's imported totals. The CLI's own
  // records already include planner calls the harness made, so limits use them
  // instead of the harness ledger whenever they exist.
  setImported(provider, imported) {
    if (!PROVIDERS.includes(provider) || !imported || imported.provider !== provider) throw new UsageLimitError("invalid_provider", "provider is not recognized");
    this._imported[provider] = { ...imported, syncedAt: Date.now() };
    this._persist();
    return this._imported[provider];
  }

  limitStatus() {
    const out = {};
    for (const p of PROVIDERS) {
      const used = this._imported[p] ?? this._byProvider[p];
      const limit = this._limits[p];
      const usedTokens = used.inputTokens + used.outputTokens;
      const status = { limit: { ...limit }, exceeded: false, basis: this._imported[p] ? "imported" : "harness" };
      if (limit.tokens !== null) {
        status.remainingTokens = Math.max(0, limit.tokens - usedTokens);
        status.tokensUsedRatio = usedTokens / limit.tokens;
        if (usedTokens >= limit.tokens) status.exceeded = true;
      }
      if (limit.costUsd !== null) {
        status.remainingCostUsd = Math.max(0, limit.costUsd - used.costUsd);
        status.costUsedRatio = used.costUsd / limit.costUsd;
        if (used.costUsd >= limit.costUsd) status.exceeded = true;
      }
      out[p] = status;
    }
    return out;
  }

  summary({ taskId } = {}) {
    const clone = (o) => JSON.parse(JSON.stringify(o));
    return {
      byProvider: clone(this._byProvider),
      imported: JSON.parse(JSON.stringify(this._imported)),
      limits: this.limitStatus(),
      ...(taskId ? { task: clone(this._byTask.get(taskId) ?? Object.fromEntries(PROVIDERS.map((p) => [p, emptyTotals()]))) } : {}),
    };
  }

  _persist() {
    if (!this._file) return;
    const body = JSON.stringify({ byProvider: this._byProvider, limits: this._limits, imported: this._imported, byTask: Object.fromEntries(this._byTask) });
    const tmp = `${this._file}.tmp`;
    this._writing = this._writing
      .then(async () => {
        await fs.mkdir(path.dirname(this._file), { recursive: true });
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, this._file);
      })
      .catch(() => {});
  }

  flush() {
    return this._writing;
  }
}

module.exports = { UsageLedger, UsageLimitError };
