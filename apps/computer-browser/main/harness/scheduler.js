"use strict";

// Runs saved routines at scheduled times by calling host.runRoutine. It owns
// no executor and never touches running tasks. Task creation is idempotent
// per occurrence key (`scheduleId@occurrenceAt`), which is written into the
// task goal as `trigger`. See
// docs/superpowers/specs/2026-09-29-routine-scheduler-design.md.

const contracts = require("../../shared/schedule-contracts");

const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_RETRY_MS = 30_000;
// A task in one of these states no longer counts as "still running" for overlap.
const SETTLED_STATES = new Set(["completed", "stopped", "awaiting_verification", "failed", "cancelled"]);
const DELETED_CODES = new Set(["routine_deleted", "not_found"]);

function iso(ms) {
  return new Date(ms).toISOString();
}

function shortMessage(error) {
  const text = String(error?.message ?? error ?? "unknown error");
  return text.length > contracts.MAX_ERROR_CHARS ? text.slice(0, contracts.MAX_ERROR_CHARS) : text;
}

class Scheduler {
  constructor({ host, store, now, setTimer, clearTimer, onEvent, maxConsecutiveFailures, retryMs } = {}) {
    if (!host || typeof host.runRoutine !== "function" || typeof host.listTasks !== "function" || typeof host.stopTask !== "function") {
      throw new TypeError("Scheduler requires a host with runRoutine, listTasks and stopTask");
    }
    if (!store || typeof store.list !== "function" || typeof store.update !== "function") {
      throw new TypeError("Scheduler requires a schedule store");
    }
    this._host = host;
    this._store = store;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._setTimer = typeof setTimer === "function" ? setTimer : (fn, ms) => setTimeout(fn, ms);
    this._clearTimer = typeof clearTimer === "function" ? clearTimer : (handle) => clearTimeout(handle);
    this._onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._maxFailures = Number.isInteger(maxConsecutiveFailures) && maxConsecutiveFailures >= 1 ? maxConsecutiveFailures : DEFAULT_MAX_FAILURES;
    this._retryMs = Number.isInteger(retryMs) && retryMs > 0 ? retryMs : DEFAULT_RETRY_MS;
    this._running = false;
    this._timer = null;
    this._tickChain = Promise.resolve();
    this._launches = new Set();
    this._inflightKeys = new Set();
  }

  async start() {
    this._running = true;
    await this.tick();
  }

  async stop() {
    this._running = false;
    this._disarm();
  }

  tick() {
    const run = this._tickChain.then(() => this._tick());
    this._tickChain = run.catch(() => {});
    return run;
  }

  async settleTicks() {
    await this._tickChain;
  }

  async whenSettled() {
    for (;;) {
      const chain = this._tickChain;
      await chain;
      if (this._launches.size === 0 && chain === this._tickChain) return;
      await Promise.allSettled([...this._launches]);
    }
  }

  _emit(event) {
    try {
      this._onEvent(event);
    } catch {
      // observers must not break scheduling
    }
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
      this._onTimer();
    }, Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
  }

  _onTimer() {
    if (!this._running) return;
    this.tick().catch((error) => {
      this._emit({ type: "tick_error", message: shortMessage(error) });
      this._armAt(this._retryMs);
    });
  }

  async _arm() {
    if (!this._running) return;
    let records;
    try {
      records = await this._store.list();
    } catch {
      this._armAt(this._retryMs);
      return;
    }
    const nowMs = this._now();
    let earliest = null;
    for (const record of records) {
      if (!record.enabled) continue;
      const next = contracts.evaluateSchedule(record, nowMs).nextRunAtMs;
      if (next !== null && (earliest === null || next < earliest)) earliest = next;
    }
    if (earliest === null) this._disarm();
    else this._armAt(earliest - nowMs);
  }

  async _tick() {
    const nowMs = this._now();
    const records = await this._store.list();
    const due = [];
    for (const record of records) {
      if (!record.enabled) continue;
      const decision = contracts.evaluateSchedule(record, nowMs);
      if (decision.action === "none") continue;
      due.push({ record, decision });
    }
    if (due.length > 0) {
      const tasks = await this._host.listTasks();
      await this._stopOrphans(tasks);
      due.sort((a, b) => (a.decision.occurrenceAtMs ?? 0) - (b.decision.occurrenceAtMs ?? 0));
      for (const { record, decision } of due) {
        await this._handle(record, decision, tasks);
      }
    }
    await this._arm();
  }

  async _stopOrphans(tasks) {
    for (const task of tasks) {
      if (!task.trigger || task.routinePinned !== false || SETTLED_STATES.has(task.state)) continue;
      const key = contracts.occurrenceKey(task.trigger.scheduleId, task.trigger.occurrenceAt);
      if (this._inflightKeys.has(key)) continue;
      await this._host.stopTask(task.taskId);
      task.state = "stopped";
      this._emit({ type: "orphan_stopped", taskId: task.taskId, key });
    }
  }

  async _handle(record, decision, tasks) {
    const { scheduleId } = record;
    if (decision.action === "finished") {
      await this._store.update(scheduleId, { enabled: false, disabledReason: "completed", nextRunAt: null });
      return;
    }
    if (decision.action === "missed") {
      await this._store.update(scheduleId, { enabled: false, disabledReason: "missed", nextRunAt: null });
      this._emit({ type: "missed", scheduleId, occurrenceAt: iso(decision.occurrenceAtMs) });
      return;
    }

    const occurrenceAt = iso(decision.occurrenceAtMs);
    const key = contracts.occurrenceKey(scheduleId, occurrenceAt);
    if (this._inflightKeys.has(key)) return;

    const existing = tasks.find((task) => task.routinePinned === true && task.trigger
      && contracts.occurrenceKey(task.trigger.scheduleId, task.trigger.occurrenceAt) === key);
    if (existing) {
      await this._record(record, decision, occurrenceAt, { taskId: existing.taskId, ok: true });
      this._emit({ type: "adopted", scheduleId, occurrenceAt, taskId: existing.taskId });
      return;
    }

    if (record.overlap === "skip") {
      const live = tasks.some((task) => task.trigger && task.trigger.scheduleId === scheduleId
        && task.routinePinned === true && !SETTLED_STATES.has(task.state));
      if (live || this._hasInflight(scheduleId)) {
        await this._store.update(scheduleId, {
          lastOccurrenceAt: this._later(record.lastOccurrenceAt, occurrenceAt),
          skippedCount: record.skippedCount + 1,
          nextRunAt: decision.nextRunAtMs === null ? null : iso(decision.nextRunAtMs),
        });
        this._emit({ type: "skipped", scheduleId, occurrenceAt });
        return;
      }
    }

    this._launch(record, decision, occurrenceAt, key);
  }

  _hasInflight(scheduleId) {
    for (const key of this._inflightKeys) {
      if (key.startsWith(`${scheduleId}@`)) return true;
    }
    return false;
  }

  _launch(record, decision, occurrenceAt, key) {
    this._inflightKeys.add(key);
    const promise = (async () => {
      let outcome;
      try {
        const result = await this._host.runRoutine(record.routineId, record.revision, {
          trigger: { scheduleId: record.scheduleId, occurrenceAt },
        });
        outcome = { ok: true, taskId: result?.taskId ?? null };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        await this._record(record, decision, occurrenceAt, outcome);
      } catch (error) {
        this._emit({ type: "record_error", scheduleId: record.scheduleId, occurrenceAt, message: shortMessage(error) });
      }
    })().finally(() => {
      this._inflightKeys.delete(key);
      this._launches.delete(promise);
      this._arm().catch(() => {});
    });
    this._launches.add(promise);
  }

  _later(current, candidate) {
    return current !== null && current > candidate ? current : candidate;
  }

  async _record(staleRecord, decision, occurrenceAt, outcome) {
    if (!outcome.ok && outcome.error?.code === "host_closed") {
      // Shutdown, not a routine fault: leave the record so the occurrence is retried or adopted on restart.
      this._emit({ type: "host_closed", scheduleId: staleRecord.scheduleId, occurrenceAt });
      return;
    }
    // Re-read: a skip may have advanced the record while a slow run was in flight.
    let record;
    try {
      record = await this._store.get(staleRecord.scheduleId);
    } catch {
      record = staleRecord;
    }
    const patch = {
      lastOccurrenceAt: this._later(record.lastOccurrenceAt, occurrenceAt),
      nextRunAt: decision.nextRunAtMs === null ? null : iso(decision.nextRunAtMs),
    };
    const once = record.trigger.kind === "once";
    if (outcome.ok) {
      if (outcome.taskId !== null) patch.lastTaskId = outcome.taskId;
      patch.consecutiveFailures = 0;
      patch.lastError = null;
      if (once) {
        patch.enabled = false;
        patch.disabledReason = "completed";
        patch.nextRunAt = null;
      }
    } else {
      const failures = record.consecutiveFailures + 1;
      patch.consecutiveFailures = failures;
      patch.lastError = shortMessage(outcome.error);
      const deleted = DELETED_CODES.has(outcome.error?.code);
      if (deleted || once || failures >= this._maxFailures) {
        patch.enabled = false;
        patch.disabledReason = deleted ? "routine_deleted" : once ? "failed" : "too_many_failures";
        patch.nextRunAt = null;
      }
      this._emit({ type: "run_failed", scheduleId: record.scheduleId, occurrenceAt, message: patch.lastError });
    }
    await this._store.update(record.scheduleId, patch);
  }
}

module.exports = { Scheduler };
