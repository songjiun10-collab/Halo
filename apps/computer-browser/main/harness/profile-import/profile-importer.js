"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeDomain, normalizeAllowlistEntry, domainMatches } = require("./domain-utils");
const { injectSessions } = require("./session-injector");
const { ProfileImportError } = require("./chrome-cookie-reader");

const DEFAULT_ALLOWLIST = Object.freeze(["claude.ai", "chatgpt.com"]);
const MAX_ALLOWLIST = 20;
const MAX_OPT_IN = 2000;
const BROWSERS = new Set(["chrome", "safari"]);

const invalid = (message) => new ProfileImportError("invalid_config", message);

class SessionConfigStore {
  constructor({ storageRoot } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw invalid("storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "session-config.json");
    this._chain = Promise.resolve();
  }

  async _read() {
    let text;
    try { text = await fs.readFile(this._file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { allowlist: [...DEFAULT_ALLOWLIST], optIn: [], importedSettings: null }; throw error; }
    try {
      const data = JSON.parse(text);
      const allowlist = Array.isArray(data.allowlist) ? data.allowlist.map(normalizeAllowlistEntry).filter(Boolean) : null;
      const optIn = Array.isArray(data.optIn) ? data.optIn.filter((id) => typeof id === "string" && id) : [];
      if (!allowlist || allowlist.length > MAX_ALLOWLIST) throw new Error("bad allowlist");
      const importedSettings = data.importedSettings && typeof data.importedSettings === "object" ? data.importedSettings : null;
      return { allowlist, optIn, importedSettings };
    } catch {
      throw new ProfileImportError("config_corrupt", "session configuration is unreadable");
    }
  }

  async _write(data) {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this._directory, `.session-config-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, this._file); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }

  _mutate(fn) {
    const op = this._chain.then(async () => { const data = await this._read(); const result = fn(data); await this._write(data); return result; });
    this._chain = op.catch(() => {});
    return op;
  }

  async getAllowlist() { return (await this._read()).allowlist; }

  setAllowlist(domains) {
    return this._mutate((data) => {
      if (!Array.isArray(domains)) throw invalid("allowlist must be an array of domains");
      const normalized = domains.map((d) => { const n = normalizeAllowlistEntry(d); if (!n) throw invalid("allowlist entries must be registrable domains (not a public suffix such as co.uk or github.io)"); return n; });
      const unique = [...new Set(normalized)];
      if (unique.length > MAX_ALLOWLIST) throw invalid("allowlist is too long");
      data.allowlist = unique;
      return unique;
    });
  }

  async getImportedSettings() { return (await this._read()).importedSettings; }

  setImportedSettings(settings) {
    return this._mutate((data) => { data.importedSettings = settings; return true; });
  }

  async hasOptIn(taskId) { return (await this._read()).optIn.includes(taskId); }

  removeOptIn(taskId) {
    return this._mutate((data) => {
      const before = data.optIn.length;
      data.optIn = data.optIn.filter((id) => id !== taskId);
      return data.optIn.length !== before;
    });
  }

  addOptIn(taskId) {
    return this._mutate((data) => {
      if (typeof taskId !== "string" || !taskId || taskId.length > 100) throw invalid("task ID is required");
      if (!data.optIn.includes(taskId)) data.optIn.push(taskId);
      data.optIn = data.optIn.slice(-MAX_OPT_IN);
      return true;
    });
  }
}

class ProfileImporter {
  constructor({ vault, config, readers, settingsReaders = {} } = {}) {
    if (!vault || !config || !readers) throw invalid("vault, config and readers are required");
    this._vault = vault;
    this._config = config;
    this._readers = readers;
    this._settingsReaders = settingsReaders;
    this._liveSessions = new Map();
  }

  async importSettings({ browser, profile = "Default" } = {}) {
    if (!BROWSERS.has(browser)) throw invalid("unsupported browser");
    const empty = { browser, bookmarks: 0, searchEngines: 0, startupUrls: 0, homepage: false };
    const reader = this._settingsReaders[browser];
    if (typeof reader !== "function") return { status: "unsupported", ...empty };
    const result = await reader({ profile });
    if (result.status !== "ok") return { status: result.status, ...empty };
    // A section whose source was unreadable (as opposed to legitimately empty)
    // keeps its previously imported value instead of being overwritten.
    const failed = Array.isArray(result.failed) ? result.failed : [];
    if (failed.length >= 3) return { status: "read_failed", ...empty, failed };
    const previous = (await this._config.getImportedSettings()) || {};
    const stored = {
      browser, importedAt: new Date().toISOString(),
      bookmarks: failed.includes("bookmarks") ? (previous.bookmarks ?? []) : result.bookmarks,
      searchEngines: failed.includes("searchEngines") ? (previous.searchEngines ?? []) : result.searchEngines,
      homepage: failed.includes("preferences") ? (previous.homepage ?? null) : result.homepage,
      startupUrls: failed.includes("preferences") ? (previous.startupUrls ?? []) : result.startupUrls,
    };
    await this._config.setImportedSettings(stored);
    return {
      status: failed.length ? "partial" : "ok", browser, bookmarks: stored.bookmarks.length, searchEngines: stored.searchEngines.length,
      startupUrls: stored.startupUrls.length, homepage: stored.homepage !== null,
      ...(failed.length ? { failed } : {}),
    };
  }

  getSettings() { return this._config.getImportedSettings(); }

  async import({ browser, profile = "Default" } = {}) {
    if (!BROWSERS.has(browser)) throw invalid("unsupported browser");
    const reader = this._readers[browser];
    if (typeof reader !== "function") return { status: "unsupported", imported: 0, browser };
    const domains = await this._config.getAllowlist();
    if (!domains.length) throw invalid("session allowlist is empty");
    const result = await reader({ domains, profile });
    if (result.status !== "ok") return { status: result.status, imported: 0, browser };
    const skipped = Number.isSafeInteger(result.skipped) && result.skipped > 0 ? result.skipped : 0;
    const partitioned = Number.isSafeInteger(result.partitioned) && result.partitioned > 0 ? result.partitioned : 0;
    const { imported } = await this._vault.replaceFromImport({ source: browser, cookies: result.cookies, replaceDomains: domains, preserve: result.failed });
    return { status: skipped > 0 ? "partial" : "ok", imported, browser, ...(skipped > 0 ? { skipped } : {}), ...(partitioned > 0 ? { partitioned } : {}) };
  }

  list() { return this._vault.listSessions(); }

  // Removing a domain must also revoke what was already copied into running
  // tasks' own sessions; deleting only the encrypted vault record would leave
  // those tasks signed in. Every live session is attempted, and any that could
  // not be purged is reported rather than swallowed.
  async remove(domain) {
    const removed = await this._vault.removeDomain(domain);
    const group = normalizeDomain(domain);
    let incomplete = 0;
    for (const session of [...this._liveSessions.values()]) {
      try {
        for (const item of await session.cookies.get({})) {
          if (!domainMatches(item.domain, [group])) continue;
          const host = String(item.domain).replace(/^\./, "");
          await session.cookies.remove(`${item.secure ? "https" : "http"}://${host}${item.path || "/"}`, item.name);
        }
      } catch { incomplete += 1; }
    }
    if (incomplete > 0) throw new ProfileImportError("purge_incomplete", `removed from the vault, but ${incomplete} active task session(s) could not be purged`);
    return removed;
  }
  getAllowlist() { return this._config.getAllowlist(); }
  setAllowlist(domains) { return this._config.setAllowlist(domains); }
  markTaskOptIn(taskId) { return this._config.addOptIn(taskId); }
  unmarkTaskOptIn(taskId) { return this._config.removeOptIn(taskId); }
  releaseTask(taskId) { this._liveSessions.delete(taskId); }
  hasTaskOptIn(taskId) { return this._config.hasOptIn(taskId); }

  async prepareTask(taskId, session) {
    if (!(await this._config.hasOptIn(taskId))) return null;
    const summary = await injectSessions({ vault: this._vault, session, domains: await this._config.getAllowlist() });
    this._liveSessions.set(taskId, session);
    return summary;
  }
}

module.exports = { ProfileImporter, SessionConfigStore, DEFAULT_ALLOWLIST };
