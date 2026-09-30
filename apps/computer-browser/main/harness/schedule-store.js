"use strict";

// Durable, host-owned storage for routine schedules: one JSON file per
// schedule under `<storageRoot>/schedules/` (0700 dir, 0600 files), written
// with tmp + fsync + rename + directory fsync. See
// docs/superpowers/specs/2026-09-29-routine-scheduler-design.md.

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const crypto = require("node:crypto");

const { UUID_RE } = require("../../shared/routine-contracts");
const contracts = require("../../shared/schedule-contracts");

class ScheduleStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleStoreError";
    this.code = code;
  }
}

const UPDATABLE_FIELDS = [
  "revision", "overlap", "enabled", "disabledReason", "lastOccurrenceAt", "lastTaskId",
  "lastError", "consecutiveFailures", "skippedCount", "nextRunAt",
];

function wrap(error) {
  return error instanceof contracts.ScheduleContractError ? new ScheduleStoreError(error.code, error.message) : error;
}

async function fsyncDir(dir) {
  const fh = await fsp.open(dir, fsConstants.O_RDONLY);
  try {
    await fh.sync();
  } catch (error) {
    if (error.code !== "EINVAL" && error.code !== "EISDIR") throw error;
  } finally {
    await fh.close();
  }
}

async function writeAtomic(dir, finalPath, contents) {
  const tmpPath = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  const fh = await fsp.open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(contents, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmpPath, finalPath);
    await fsyncDir(dir);
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function readNoFollow(filePath) {
  const fh = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

class ScheduleStore {
  constructor({ storageRoot, now } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new ScheduleStoreError("invalid_config", "storageRoot is required");
    this._storageRoot = path.resolve(storageRoot);
    this._nowMs = typeof now === "function" ? now : () => Date.now();
    this._chain = Promise.resolve();
  }

  _serialize(fn) {
    const operation = this._chain.then(fn);
    this._chain = operation.catch(() => {});
    return operation;
  }

  async _ensureDir() {
    await fsp.mkdir(this._storageRoot, { recursive: true, mode: 0o700 });
    const dir = path.join(this._storageRoot, "schedules");
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ScheduleStoreError("unsafe_path", "schedules root must be a real directory");
    return dir;
  }

  _file(dir, scheduleId) {
    if (typeof scheduleId !== "string" || !UUID_RE.test(scheduleId)) {
      throw new ScheduleStoreError("invalid_schedule_id", `scheduleId must be a UUID: ${JSON.stringify(scheduleId)}`);
    }
    return path.join(dir, `${scheduleId}.json`);
  }

  async _read(dir, scheduleId) {
    const file = this._file(dir, scheduleId);
    let text;
    try {
      text = await readNoFollow(file);
    } catch (error) {
      if (error.code === "ENOENT") throw new ScheduleStoreError("not_found", `schedule ${scheduleId} was not found`);
      throw new ScheduleStoreError("corrupt_schedule", `schedule ${scheduleId} could not be read: ${error.code ?? error.message}`);
    }
    let record;
    try {
      record = contracts.validateScheduleRecord(JSON.parse(text));
    } catch (error) {
      throw new ScheduleStoreError("corrupt_schedule", `schedule ${scheduleId} is corrupt: ${error.message}`);
    }
    if (record.scheduleId !== scheduleId) throw new ScheduleStoreError("corrupt_schedule", `schedule file ${scheduleId} holds a different scheduleId`);
    return record;
  }

  async _write(dir, record) {
    const valid = contracts.validateScheduleRecord(record);
    await writeAtomic(dir, this._file(dir, valid.scheduleId), JSON.stringify(valid));
    return valid;
  }

  _iso() {
    return new Date(this._nowMs()).toISOString();
  }

  create(input) {
    return this._serialize(async () => {
      let valid;
      try {
        valid = contracts.validateScheduleInput(input);
      } catch (error) {
        throw wrap(error);
      }
      const dir = await this._ensureDir();
      const now = this._iso();
      const record = {
        schemaVersion: contracts.SCHEMA_VERSION,
        scheduleId: crypto.randomUUID(),
        routineId: valid.routineId,
        revision: valid.revision,
        enabled: valid.enabled,
        disabledReason: null,
        trigger: valid.trigger,
        overlap: valid.overlap,
        createdAt: now,
        updatedAt: now,
        lastOccurrenceAt: null,
        lastTaskId: null,
        lastError: null,
        consecutiveFailures: 0,
        skippedCount: 0,
        nextRunAt: null,
      };
      const due = contracts.evaluateSchedule(record, this._nowMs());
      const nextMs = due.action === "run" ? due.occurrenceAtMs : due.nextRunAtMs;
      record.nextRunAt = valid.enabled && nextMs !== null ? new Date(nextMs).toISOString() : null;
      try {
        return await this._write(dir, record);
      } catch (error) {
        throw wrap(error);
      }
    });
  }

  async get(scheduleId) {
    const dir = await this._ensureDir();
    return this._read(dir, scheduleId);
  }

  async list() {
    const dir = await this._ensureDir();
    const results = [];
    for (const name of await fsp.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!UUID_RE.test(id)) continue;
      try {
        results.push(await this._read(dir, id));
      } catch {
        continue; // one corrupt schedule must not hide the rest
      }
    }
    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.scheduleId.localeCompare(b.scheduleId));
    return results;
  }

  update(scheduleId, patch) {
    return this._serialize(async () => {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new ScheduleStoreError("invalid_shape", "patch must be an object");
      }
      for (const key of Object.keys(patch)) {
        if (!UPDATABLE_FIELDS.includes(key)) throw new ScheduleStoreError("immutable_field", `field ${JSON.stringify(key)} cannot be updated`);
      }
      const dir = await this._ensureDir();
      const current = await this._read(dir, scheduleId);
      try {
        return await this._write(dir, { ...current, ...patch, updatedAt: this._iso() });
      } catch (error) {
        throw wrap(error);
      }
    });
  }

  delete(scheduleId) {
    return this._serialize(async () => {
      const dir = await this._ensureDir();
      const file = this._file(dir, scheduleId);
      try {
        await fsp.unlink(file);
      } catch (error) {
        if (error.code === "ENOENT") throw new ScheduleStoreError("not_found", `schedule ${scheduleId} was not found`);
        throw error;
      }
      await fsyncDir(dir);
    });
  }

  disableForRoutine(routineId, reason) {
    return this._serialize(async () => {
      const dir = await this._ensureDir();
      const changed = [];
      for (const name of await fsp.readdir(dir)) {
        if (!name.endsWith(".json") || !UUID_RE.test(name.slice(0, -5))) continue;
        let record;
        try {
          record = await this._read(dir, name.slice(0, -5));
        } catch {
          continue;
        }
        if (record.routineId !== routineId || !record.enabled) continue;
        await this._write(dir, { ...record, enabled: false, disabledReason: reason, nextRunAt: null, updatedAt: this._iso() });
        changed.push(record.scheduleId);
      }
      return changed;
    });
  }
}

module.exports = { ScheduleStore, ScheduleStoreError };
