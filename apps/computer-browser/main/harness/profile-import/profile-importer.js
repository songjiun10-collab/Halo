"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeDomain } = require("./domain-utils");
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
    catch (error) { if (error.code === "ENOENT") return { allowlist: [...DEFAULT_ALLOWLIST], optIn: [] }; throw error; }
    try {
      const data = JSON.parse(text);
      const allowlist = Array.isArray(data.allowlist) ? data.allowlist.map(normalizeDomain).filter(Boolean) : null;
      const optIn = Array.isArray(data.optIn) ? data.optIn.filter((id) => typeof id === "string" && id) : [];
      if (!allowlist || allowlist.length > MAX_ALLOWLIST) throw new Error("bad allowlist");
      return { allowlist, optIn };
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
      const normalized = domains.map((d) => { const n = normalizeDomain(d); if (!n) throw invalid("allowlist contains an invalid domain"); return n; });
      const unique = [...new Set(normalized)];
      if (unique.length > MAX_ALLOWLIST) throw invalid("allowlist is too long");
      data.allowlist = unique;
      return unique;
    });
  }

  async hasOptIn(taskId) { return (await this._read()).optIn.includes(taskId); }

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
  constructor({ vault, config, readers } = {}) {
    if (!vault || !config || !readers) throw invalid("vault, config and readers are required");
    this._vault = vault;
    this._config = config;
    this._readers = readers;
  }

  async import({ browser, profile = "Default" } = {}) {
    if (!BROWSERS.has(browser)) throw invalid("unsupported browser");
    const reader = this._readers[browser];
    if (typeof reader !== "function") return { status: "unsupported", imported: 0, browser };
    const domains = await this._config.getAllowlist();
    if (!domains.length) throw invalid("session allowlist is empty");
    const result = await reader({ domains, profile });
    if (result.status !== "ok") return { status: result.status, imported: 0, browser };
    const { imported } = await this._vault.replaceFromImport({ source: browser, cookies: result.cookies, replaceDomains: domains });
    return { status: "ok", imported, browser };
  }

  list() { return this._vault.listSessions(); }
  remove(domain) { return this._vault.removeDomain(domain); }
  getAllowlist() { return this._config.getAllowlist(); }
  setAllowlist(domains) { return this._config.setAllowlist(domains); }
  markTaskOptIn(taskId) { return this._config.addOptIn(taskId); }
  hasTaskOptIn(taskId) { return this._config.hasOptIn(taskId); }

  async prepareTask(taskId, session) {
    if (!(await this._config.hasOptIn(taskId))) return null;
    return injectSessions({ vault: this._vault, session, domains: await this._config.getAllowlist() });
  }
}

module.exports = { ProfileImporter, SessionConfigStore, DEFAULT_ALLOWLIST };
