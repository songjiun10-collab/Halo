"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PERMISSION_MODES } = require("./permission-policy");

const PLANNER_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const EXECUTION_MODES = Object.freeze(["sequential", "parallel"]);
const MEMORY_POLICIES = Object.freeze(["budgeted", "user_override"]);
const SCHEMA_VERSION = 2;
const MAX_AUDIT_RECORDS = 200;
const DEFAULT_SETTINGS = Object.freeze({
  version: SCHEMA_VERSION,
  executionMode: "sequential",
  permissionMode: "browse",
  plannerEffort: "medium",
  memoryPolicy: "budgeted",
});
const SETTINGS_FIELDS = ["executionMode", "memoryPolicy", "permissionMode", "plannerEffort", "version"];
const LEGACY_V1_FIELDS = "executionMode,permissionMode,plannerEffort,version";

class HostSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostSettingsError";
    this.code = code;
  }
}

function isPlainObjectLike(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(value) {
  if (!isPlainObjectLike(value) || value.version !== SCHEMA_VERSION) {
    throw new HostSettingsError("invalid_settings", "settings file has an unsupported shape or version");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== SETTINGS_FIELDS.join(",")) {
    throw new HostSettingsError("invalid_settings", "settings file contains missing or unknown fields");
  }
  if (!PERMISSION_MODES.includes(value.permissionMode)) {
    throw new HostSettingsError("invalid_permission_mode", "permissionMode is not recognized");
  }
  if (!PLANNER_EFFORTS.includes(value.plannerEffort)) {
    throw new HostSettingsError("invalid_planner_effort", "plannerEffort is not recognized");
  }
  if (!EXECUTION_MODES.includes(value.executionMode)) {
    throw new HostSettingsError("invalid_execution_mode", "executionMode is not recognized");
  }
  if (!MEMORY_POLICIES.includes(value.memoryPolicy)) {
    throw new HostSettingsError("invalid_memory_policy", "memoryPolicy is not recognized");
  }
  return {
    version: SCHEMA_VERSION,
    executionMode: value.executionMode,
    permissionMode: value.permissionMode,
    plannerEffort: value.plannerEffort,
    memoryPolicy: value.memoryPolicy,
  };
}

// A v1 file predates memoryPolicy entirely. Migrate ONLY a file that matches
// the old shape exactly -- anything else (corrupt, hand-edited, or from some
// future schema we don't know about) is rejected rather than guessed at, the
// same fail-closed stance validateSettings already takes for the current
// version.
function migrateFromV1(value) {
  if (!isPlainObjectLike(value) || value.version !== 1) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== LEGACY_V1_FIELDS) {
    throw new HostSettingsError("invalid_settings", "legacy v1 settings file has an unsupported shape");
  }
  return validateSettings({ ...value, version: SCHEMA_VERSION, memoryPolicy: "budgeted" });
}

class HostSettingsStore {
  constructor({ storageRoot } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) {
      throw new HostSettingsError("invalid_config", "storageRoot is required");
    }
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "host-settings.json");
    this._auditFile = path.join(this._directory, "host-settings-audit.json");
    this._writeChain = Promise.resolve();
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HostSettingsError("unsafe_path", "settings directory must be a real directory");
    }
    await fs.chmod(this._directory, 0o700);
  }

  async _readJsonFile(filePath) {
    let text;
    try {
      const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      if (["ELOOP", "EMLINK"].includes(error.code)) {
        throw new HostSettingsError("unsafe_path", `${path.basename(filePath)} must not be a symlink`);
      }
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new HostSettingsError("invalid_settings", `${path.basename(filePath)} is not valid JSON`);
    }
  }

  async load() {
    await this._ensureDirectory();
    const parsed = await this._readJsonFile(this._file);
    if (parsed === undefined) return { ...DEFAULT_SETTINGS };
    const migrated = migrateFromV1(parsed);
    if (migrated) {
      await this._writeJsonFile(this._file, migrated);
      return migrated;
    }
    return validateSettings(parsed);
  }

  update(patch, { actor } = {}) {
    const operation = this._writeChain.then(async () => {
      if (!isPlainObjectLike(patch)) {
        throw new HostSettingsError("invalid_settings", "settings patch must be an object");
      }
      const unknown = Object.keys(patch).filter((key) => !["executionMode", "permissionMode", "plannerEffort", "memoryPolicy"].includes(key));
      if (unknown.length) throw new HostSettingsError("invalid_settings", "settings patch contains unknown fields");
      const current = await this.load();
      const changingMemoryPolicy = Object.prototype.hasOwnProperty.call(patch, "memoryPolicy") && patch.memoryPolicy !== current.memoryPolicy;
      if (changingMemoryPolicy && (typeof actor !== "string" || actor.length === 0)) {
        throw new HostSettingsError("actor_required", "a trusted actor is required to change memoryPolicy");
      }
      const next = validateSettings({ ...current, ...patch });
      // Recorded BEFORE the new value is persisted as the default, so a crash
      // between these two writes leaves an audit trail for a change that
      // never actually took effect rather than a silent, untracked one.
      if (changingMemoryPolicy) await this._appendMemoryPolicyAudit({ actor, mode: next.memoryPolicy });
      return this._writeJsonFile(this._file, next);
    });
    this._writeChain = operation.catch(() => {});
    return operation;
  }

  async _appendMemoryPolicyAudit({ actor, mode }) {
    const existing = await this._readJsonFile(this._auditFile);
    const records = Array.isArray(existing) ? existing : [];
    records.push({ eventId: randomUUID(), actor, mode, at: new Date().toISOString() });
    const trimmed = records.length > MAX_AUDIT_RECORDS ? records.slice(records.length - MAX_AUDIT_RECORDS) : records;
    await this._writeJsonFile(this._auditFile, trimmed);
  }

  async listMemoryPolicyAudit() {
    await this._ensureDirectory();
    const parsed = await this._readJsonFile(this._auditFile);
    return Array.isArray(parsed) ? parsed : [];
  }

  async getMemoryPolicySelection() {
    // Wait for an in-flight update so callers cannot pair a new default
    // with the previous audit (or observe the audit before its setting).
    await this._writeChain;
    const settings = await this.load();
    const audit = await this.listMemoryPolicyAudit();
    const record = [...audit].reverse().find((item) => item?.mode === settings.memoryPolicy);
    if (settings.memoryPolicy === "user_override" && (!record || record.actor !== "user" || typeof record.eventId !== "string")) {
      throw new HostSettingsError("audit_missing", "user_override requires its durable user audit record");
    }
    return {
      mode: settings.memoryPolicy,
      auditEventId: record?.eventId ?? null,
      actor: record?.actor ?? null,
      at: record?.at ?? null,
    };
  }

  async _writeJsonFile(filePath, value) {
    await this._ensureDirectory();
    try {
      const existing = await fs.lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new HostSettingsError("unsafe_path", `${path.basename(filePath)} must be a regular file`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(this._directory, `.${path.basename(filePath)}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, filePath);
      const dirHandle = await fs.open(this._directory, fsConstants.O_RDONLY);
      try {
        await dirHandle.sync();
      } catch (error) {
        if (!new Set(["EINVAL", "EISDIR"]).has(error.code)) throw error;
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    return Array.isArray(value) ? [...value] : { ...value };
  }
}

module.exports = { DEFAULT_SETTINGS, EXECUTION_MODES, PLANNER_EFFORTS, MEMORY_POLICIES, HostSettingsError, HostSettingsStore, validateSettings };
