"use strict";

// Always-on Agents: durable schedules that start an Agent or team
// conversation with nobody watching, plus the small timer loop that runs
// them. Kept apart from the routine Scheduler on purpose: that one adopts or
// stops any triggered task that is not routine-pinned, so Agent runs carry no
// goal.trigger and are tracked here by lastTaskId instead.
//
// Delivery is at-most-once per occurrence: the occurrence is recorded before
// the task is started, so a crash in between skips it rather than risking a
// second unattended run.

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateTrigger, evaluateSchedule, MAX_ERROR_CHARS } = require("../../shared/schedule-contracts");

const SCHEMA_VERSION = 1;
const MAX_SCHEDULES = 20;
const MAX_REQUEST_CHARS = 2000;
const MAX_SCHEDULE_PLANNER_CALLS = 200;
const APPROVAL_CHOICES = Object.freeze(["pause", "deny"]);
const INPUT_FIELDS = ["id", "kind", "ownerId", "request", "trigger", "onApproval", "maxPlannerCalls", "enabled"];
const RECORD_FIELDS = [
  "id", "kind", "ownerId", "request", "trigger", "onApproval", "maxPlannerCalls", "enabled", "disabledReason",
  "armedAt", "createdAt", "updatedAt", "lastOccurrenceAt", "lastTaskId", "lastError", "consecutiveFailures", "skippedCount",
];
const PATCH_FIELDS = ["enabled", "disabledReason", "lastOccurrenceAt", "lastTaskId", "lastError", "consecutiveFailures", "skippedCount"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A run that reached one of these no longer blocks the next occurrence.
const SETTLED_STATES = new Set(["completed", "stopped", "awaiting_verification", "failed", "cancelled"]);
const OWNER_GONE_CODES = new Set(["agent_unavailable", "team_member_unavailable", "not_found", "archived"]);
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_RETRY_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

class AgentScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentScheduleError";
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

function validateInput(input) {
  const bad = (message) => { throw new AgentScheduleError("invalid_schedule", message); };
  if (!isPlainObject(input)) bad("schedule must be a plain object");
  for (const key of Object.keys(input)) if (!INPUT_FIELDS.includes(key)) bad(`schedule has unknown field ${JSON.stringify(key)}`);
  if (input.id !== undefined && (typeof input.id !== "string" || !UUID_RE.test(input.id))) bad("schedule.id must be a UUID");
  if (input.kind !== "agent" && input.kind !== "team") bad("schedule.kind must be agent or team");
  if (typeof input.ownerId !== "string" || !UUID_RE.test(input.ownerId)) bad("schedule.ownerId must be a UUID");
  if (typeof input.request !== "string" || !input.request.trim() || input.request.length > MAX_REQUEST_CHARS) {
    bad(`schedule.request must be 1..${MAX_REQUEST_CHARS} characters`);
  }
  // Both unattended choices are the user's: neither has a default.
  if (!APPROVAL_CHOICES.includes(input.onApproval)) bad("schedule.onApproval must be pause or deny");
  if (!Number.isSafeInteger(input.maxPlannerCalls) || input.maxPlannerCalls < 1 || input.maxPlannerCalls > MAX_SCHEDULE_PLANNER_CALLS) {
    bad(`schedule.maxPlannerCalls must be an integer 1..${MAX_SCHEDULE_PLANNER_CALLS}`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") bad("schedule.enabled must be a boolean");
  let trigger;
  try { trigger = validateTrigger(input.trigger); }
  catch (error) { bad(`schedule.trigger: ${error.message}`); }
  return {
    kind: input.kind,
    ownerId: input.ownerId,
    request: input.request,
    trigger,
    onApproval: input.onApproval,
    maxPlannerCalls: input.maxPlannerCalls,
    enabled: input.enabled ?? true,
  };
}

function validateRecord(record, label) {
  const bad = (message) => { throw new AgentScheduleError("invalid_store", `${label}: ${message}`); };
  if (!isPlainObject(record)) bad("must be an object");
  const keys = Object.keys(record);
  if (keys.length !== RECORD_FIELDS.length || RECORD_FIELDS.some((key) => !Object.hasOwn(record, key))) bad("has unexpected fields");
  const { id, enabled, disabledReason, armedAt, createdAt, updatedAt, lastOccurrenceAt, lastTaskId, lastError, consecutiveFailures, skippedCount, ...rest } = record;
  try { validateInput({ id, enabled, ...rest }); }
  catch (error) { bad(error.message); }
  for (const value of [armedAt, createdAt, updatedAt]) if (typeof value !== "string") bad("timestamps must be strings");
  if (lastOccurrenceAt !== null && typeof lastOccurrenceAt !== "string") bad("lastOccurrenceAt is invalid");
  if (lastTaskId !== null && typeof lastTaskId !== "string") bad("lastTaskId is invalid");
  if (lastError !== null && typeof lastError !== "string") bad("lastError is invalid");
  if (disabledReason !== null && typeof disabledReason !== "string") bad("disabledReason is invalid");
  for (const value of [consecutiveFailures, skippedCount]) if (!Number.isSafeInteger(value) || value < 0) bad("counters must be non-negative integers");
}

function validateState(state) {
  if (!isPlainObject(state) || state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.schedules) || Object.keys(state).length !== 2) {
    throw new AgentScheduleError("invalid_store", "schedules.json has an unknown shape");
  }
  state.schedules.forEach((record, index) => validateRecord(record, `schedules[${index}]`));
  return state;
}

const copy = (value) => structuredClone(value);

function shortMessage(error) {
  const text = String(error?.message ?? error ?? "unknown error");
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text;
}

class AgentScheduleStore {
  constructor({ storageRoot, now = () => Date.now(), maxSchedules = MAX_SCHEDULES } = {}) {
    if (typeof storageRoot !== "string" || !storageRoot) throw new AgentScheduleError("invalid_config", "storageRoot is required");
    this._directory = path.resolve(storageRoot);
    this._file = path.join(this._directory, "schedules.json");
    this._now = now;
    this._maxSchedules = maxSchedules;
    this._chain = Promise.resolve();
  }

  async list() { return copy((await this._read()).schedules); }

  async get(id) {
    const record = (await this._read()).schedules.find((item) => item.id === id);
    if (!record) throw new AgentScheduleError("not_found", "schedule does not exist");
    return copy(record);
  }

  // Create, or replace the definition of an existing schedule. Saving re-arms
  // it: run history is cleared and the next occurrence is counted from now.
  save(input) {
    return this._mutate((state) => {
      const fields = validateInput(input);
      const at = new Date(this._now()).toISOString();
      const fresh = { ...fields, disabledReason: null, armedAt: at, updatedAt: at, lastOccurrenceAt: null, lastError: null, consecutiveFailures: 0, skippedCount: 0 };
      if (input.id === undefined) {
        if (state.schedules.length >= this._maxSchedules) throw new AgentScheduleError("limit_reached", `at most ${this._maxSchedules} schedules can be saved`);
        const record = { id: randomUUID(), ...fresh, createdAt: at, lastTaskId: null };
        state.schedules.push(record);
        return record;
      }
      const index = state.schedules.findIndex((item) => item.id === input.id);
      if (index === -1) throw new AgentScheduleError("not_found", "schedule does not exist");
      state.schedules[index] = { ...state.schedules[index], ...fresh };
      return state.schedules[index];
    });
  }

  remove(id) {
    return this._mutate((state) => {
      const index = state.schedules.findIndex((item) => item.id === id);
      if (index === -1) throw new AgentScheduleError("not_found", "schedule does not exist");
      const [removed] = state.schedules.splice(index, 1);
      return removed;
    });
  }

  // Scheduler bookkeeping only; never changes what a schedule runs.
  update(id, patch) {
    return this._mutate((state) => {
      if (!isPlainObject(patch) || Object.keys(patch).some((key) => !PATCH_FIELDS.includes(key))) {
        throw new AgentScheduleError("invalid_patch", "patch contains fields the scheduler may not change");
      }
      const record = state.schedules.find((item) => item.id === id);
      if (!record) throw new AgentScheduleError("not_found", "schedule does not exist");
      Object.assign(record, patch, { updatedAt: new Date(this._now()).toISOString() });
      return record;
    });
  }

  _mutate(apply) {
    const operation = this._chain.then(async () => {
      const state = await this._read();
      const result = apply(state);
      validateState(state);
      await this._write(state);
      return copy(result);
    });
    this._chain = operation.catch(() => {});
    return operation;
  }

  async _ensureDirectory() {
    await fs.mkdir(this._directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this._directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentScheduleError("unsafe_path", "schedule directory must be a real directory");
    await fs.chmod(this._directory, 0o700);
  }

  async _read() {
    await this._ensureDirectory();
    let textValue;
    try {
      const handle = await fs.open(this._file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { textValue = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) {
      if (error.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, schedules: [] };
      if (["ELOOP", "EMLINK"].includes(error.code)) throw new AgentScheduleError("unsafe_path", "schedules.json must not be a symlink");
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(textValue); }
    catch { throw new AgentScheduleError("invalid_store", "schedules.json is not valid JSON"); }
    return validateState(parsed);
  }

  async _write(state) {
    try {
      const existing = await fs.lstat(this._file);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new AgentScheduleError("unsafe_path", "schedules.json must be a regular file");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(this._directory, `.schedules.json-${randomUUID()}.tmp`);
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

// evaluateSchedule() counts the first interval occurrence from createdAt;
// for Agent schedules that is the last (re)arm time.
const evaluate = (record, nowMs) => evaluateSchedule({ trigger: record.trigger, createdAt: record.armedAt, lastOccurrenceAt: record.lastOccurrenceAt }, nowMs);

class AgentScheduler {
  constructor({ store, startTask, getTaskState, now, setTimer, clearTimer, onEvent, maxConsecutiveFailures, retryMs } = {}) {
    if (!store || typeof startTask !== "function" || typeof getTaskState !== "function") {
      throw new AgentScheduleError("invalid_config", "store, startTask and getTaskState are required");
    }
    this._store = store;
    this._startTask = startTask;
    this._getTaskState = getTaskState;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._setTimer = typeof setTimer === "function" ? setTimer : (fn, ms) => setTimeout(fn, ms);
    this._clearTimer = typeof clearTimer === "function" ? clearTimer : (handle) => clearTimeout(handle);
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._maxFailures = Number.isInteger(maxConsecutiveFailures) && maxConsecutiveFailures >= 1 ? maxConsecutiveFailures : DEFAULT_MAX_FAILURES;
    this._retryMs = Number.isInteger(retryMs) && retryMs > 0 ? retryMs : DEFAULT_RETRY_MS;
    this._running = false;
    this._timer = null;
    this._chain = Promise.resolve();
  }

  async start() {
    this._running = true;
    await this.tick();
  }

  async stop() {
    this._running = false;
    this._disarm();
    await this._chain;
  }

  // Ticks run one at a time; a start is awaited inside its tick, so two
  // ticks can never both see the same occurrence as due.
  tick() {
    const run = this._chain.then(() => this._tick());
    this._chain = run.catch(() => {});
    return run;
  }

  _emit(event) {
    try { this._onEvent(event); } catch { /* observers never affect scheduling */ }
  }

  _disarm() {
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
  }

  _armAt(delayMs) {
    this._disarm();
    if (!this._running) return;
    this._timer = this._setTimer(() => {
      this._timer = null;
      if (!this._running) return;
      this.tick().catch((error) => {
        this._emit({ type: "tick_error", message: shortMessage(error) });
        this._armAt(this._retryMs);
      });
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
  }

  async _tick() {
    const nowMs = this._now();
    for (const record of await this._store.list()) {
      if (!record.enabled) continue;
      const decision = evaluate(record, nowMs);
      if (decision.action === "finished" || decision.action === "missed") {
        await this._store.update(record.id, { enabled: false, disabledReason: decision.action === "finished" ? "completed" : "missed" });
        if (decision.action === "missed") this._emit({ type: "missed", scheduleId: record.id });
        continue;
      }
      if (decision.action === "run") await this._run(record, new Date(decision.occurrenceAtMs).toISOString());
    }
    await this._arm();
  }

  async _run(record, occurrenceAt) {
    if (record.lastTaskId !== null) {
      const state = await this._getTaskState(record.lastTaskId);
      if (state !== null && !SETTLED_STATES.has(state)) {
        await this._store.update(record.id, { lastOccurrenceAt: occurrenceAt, skippedCount: record.skippedCount + 1 });
        this._emit({ type: "skipped", scheduleId: record.id, occurrenceAt });
        return;
      }
    }
    await this._store.update(record.id, { lastOccurrenceAt: occurrenceAt });
    try {
      const result = await this._startTask(record, occurrenceAt);
      const once = record.trigger.kind === "once";
      await this._store.update(record.id, {
        lastTaskId: result?.taskId ?? null,
        lastError: null,
        consecutiveFailures: 0,
        ...(once ? { enabled: false, disabledReason: "completed" } : {}),
      });
      this._emit({ type: "started", scheduleId: record.id, occurrenceAt, taskId: result?.taskId ?? null });
    } catch (error) {
      if (error?.code === "host_closed") return;
      const failures = record.consecutiveFailures + 1;
      const ownerGone = OWNER_GONE_CODES.has(error?.code);
      const disable = ownerGone || record.trigger.kind === "once" || failures >= this._maxFailures;
      await this._store.update(record.id, {
        lastError: shortMessage(error),
        consecutiveFailures: failures,
        ...(disable ? { enabled: false, disabledReason: ownerGone ? "owner_unavailable" : record.trigger.kind === "once" ? "failed" : "too_many_failures" } : {}),
      });
      this._emit({ type: "run_failed", scheduleId: record.id, occurrenceAt, message: shortMessage(error) });
    }
  }

  async _arm() {
    if (!this._running) return;
    let records;
    try { records = await this._store.list(); }
    catch { this._armAt(this._retryMs); return; }
    const nowMs = this._now();
    let earliest = null;
    for (const record of records) {
      if (!record.enabled) continue;
      const next = evaluate(record, nowMs).nextRunAtMs;
      if (next !== null && (earliest === null || next < earliest)) earliest = next;
    }
    if (earliest === null) this._disarm();
    else this._armAt(earliest - nowMs);
  }
}

module.exports = { AgentScheduleStore, AgentScheduler, AgentScheduleError, MAX_SCHEDULE_PLANNER_CALLS, APPROVAL_CHOICES };
