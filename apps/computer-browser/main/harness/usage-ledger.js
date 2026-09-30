"use strict";

// Host-owned running totals of planner usage per provider and per task. Only
// numbers from shared/usage.js are stored; the file is rewritten atomically and
// a corrupt or missing file simply starts an empty ledger.

const fs = require("node:fs/promises");
const path = require("node:path");
const { PROVIDERS, emptyTotals, addUsage, normalizeUsage } = require("../../shared/usage");

const MAX_TASKS = 500;

class UsageLedger {
  constructor({ storageRoot } = {}) {
    this._file = storageRoot ? path.join(storageRoot, "usage-ledger.json") : null;
    this._byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, emptyTotals()]));
    this._byTask = new Map();
    this._writing = Promise.resolve();
  }

  async load() {
    if (!this._file) return this;
    try {
      const data = JSON.parse(await fs.readFile(this._file, "utf8"));
      for (const p of PROVIDERS) if (data.byProvider?.[p]) Object.assign(this._byProvider[p], emptyTotals(), data.byProvider[p]);
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

  summary({ taskId } = {}) {
    const clone = (o) => JSON.parse(JSON.stringify(o));
    return {
      byProvider: clone(this._byProvider),
      ...(taskId ? { task: clone(this._byTask.get(taskId) ?? Object.fromEntries(PROVIDERS.map((p) => [p, emptyTotals()]))) } : {}),
    };
  }

  _persist() {
    if (!this._file) return;
    const body = JSON.stringify({ byProvider: this._byProvider, byTask: Object.fromEntries(this._byTask) });
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

module.exports = { UsageLedger };
