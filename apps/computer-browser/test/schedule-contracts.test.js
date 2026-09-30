"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ScheduleContractError,
  MIN_INTERVAL_MS,
  ONCE_GRACE_MS,
  validateScheduleInput,
  validateScheduleRecord,
  evaluateSchedule,
  occurrenceKey,
} = require("../shared/schedule-contracts");

const ROUTINE = "11111111-1111-4111-8111-111111111111";
const SCHEDULE = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    scheduleId: SCHEDULE,
    routineId: ROUTINE,
    revision: 1,
    enabled: true,
    disabledReason: null,
    trigger: { kind: "interval", everyMs: 60_000, anchor: iso(T0) },
    overlap: "skip",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    lastOccurrenceAt: null,
    lastTaskId: null,
    lastError: null,
    consecutiveFailures: 0,
    skippedCount: 0,
    nextRunAt: iso(T0),
    ...overrides,
  };
}

test("validateScheduleInput accepts once and interval and defaults overlap to skip", () => {
  const once = validateScheduleInput({ routineId: ROUTINE, revision: 2, trigger: { kind: "once", at: iso(T0) } });
  assert.equal(once.overlap, "skip");
  assert.equal(once.enabled, true);
  const interval = validateScheduleInput({
    routineId: ROUTINE, revision: 1, overlap: "queue",
    trigger: { kind: "interval", everyMs: MIN_INTERVAL_MS, anchor: iso(T0) },
  });
  assert.equal(interval.overlap, "queue");
});

test("validateScheduleInput rejects bad shapes, short intervals, non-exact revisions and unknown fields", () => {
  const ok = { routineId: ROUTINE, revision: 1, trigger: { kind: "once", at: iso(T0) } };
  assert.throws(() => validateScheduleInput(null), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, extra: 1 }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, routineId: "nope" }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, revision: 0 }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, revision: undefined }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, overlap: "parallel" }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, trigger: { kind: "cron", expr: "* * * * *" } }), ScheduleContractError);
  assert.throws(() => validateScheduleInput({ ...ok, trigger: { kind: "once", at: "tomorrow" } }), ScheduleContractError);
  assert.throws(
    () => validateScheduleInput({ ...ok, trigger: { kind: "interval", everyMs: MIN_INTERVAL_MS - 1, anchor: iso(T0) } }),
    (error) => error.code === "interval_too_short",
  );
  assert.throws(
    () => validateScheduleInput({ ...ok, trigger: { kind: "interval", everyMs: 1.5 * 60_000 + 0.5, anchor: iso(T0) } }),
    ScheduleContractError,
  );
});

test("validateScheduleRecord round-trips a record and rejects tampered ones", () => {
  assert.deepEqual(validateScheduleRecord(record()), record());
  assert.throws(() => validateScheduleRecord({ ...record(), schemaVersion: 2 }), ScheduleContractError);
  assert.throws(() => validateScheduleRecord({ ...record(), consecutiveFailures: -1 }), ScheduleContractError);
  assert.throws(() => validateScheduleRecord({ ...record(), extra: true }), ScheduleContractError);
  const { nextRunAt, ...missing } = record();
  void nextRunAt;
  assert.throws(() => validateScheduleRecord(missing), ScheduleContractError);
});

test("occurrenceKey is scheduleId@occurrenceAt", () => {
  assert.equal(occurrenceKey(SCHEDULE, iso(T0)), `${SCHEDULE}@${iso(T0)}`);
});

test("interval: not due before the anchor, due exactly at it, then anchored without drift", () => {
  const rec = record();
  assert.deepEqual(evaluateSchedule(rec, T0 - 1), { action: "none", nextRunAtMs: T0 });
  assert.deepEqual(evaluateSchedule(rec, T0), { action: "run", occurrenceAtMs: T0, nextRunAtMs: T0 + 60_000 });
  const done = record({ lastOccurrenceAt: iso(T0) });
  assert.deepEqual(evaluateSchedule(done, T0 + 30_000), { action: "none", nextRunAtMs: T0 + 60_000 });
  // A late tick (5 s after the boundary) still reports the anchored occurrence, not now.
  assert.deepEqual(evaluateSchedule(done, T0 + 65_000), { action: "run", occurrenceAtMs: T0 + 60_000, nextRunAtMs: T0 + 120_000 });
});

test("interval: three missed occurrences coalesce into one run at the latest occurrence", () => {
  const done = record({ lastOccurrenceAt: iso(T0) });
  const result = evaluateSchedule(done, T0 + 3 * 60_000 + 10_000);
  assert.deepEqual(result, { action: "run", occurrenceAtMs: T0 + 3 * 60_000, nextRunAtMs: T0 + 4 * 60_000 });
});

test("interval: occurrences before createdAt never run", () => {
  const rec = record({
    trigger: { kind: "interval", everyMs: 60_000, anchor: iso(T0) },
    createdAt: iso(T0 + 10 * 60_000 + 20_000),
    nextRunAt: iso(T0 + 11 * 60_000),
  });
  const now = T0 + 10 * 60_000 + 30_000;
  assert.deepEqual(evaluateSchedule(rec, now), { action: "none", nextRunAtMs: T0 + 11 * 60_000 });
  assert.equal(evaluateSchedule(rec, T0 + 11 * 60_000).action, "run");
});

test("once: runs when due, is missed when more than the grace period late, and is finished afterwards", () => {
  const at = T0 + 10_000;
  const rec = record({ trigger: { kind: "once", at: iso(at) }, nextRunAt: iso(at) });
  assert.deepEqual(evaluateSchedule(rec, at - 1), { action: "none", nextRunAtMs: at });
  assert.deepEqual(evaluateSchedule(rec, at), { action: "run", occurrenceAtMs: at, nextRunAtMs: null });
  assert.deepEqual(evaluateSchedule(rec, at + ONCE_GRACE_MS), { action: "run", occurrenceAtMs: at, nextRunAtMs: null });
  assert.deepEqual(evaluateSchedule(rec, at + ONCE_GRACE_MS + 1), { action: "missed", occurrenceAtMs: at, nextRunAtMs: null });
  const done = record({ trigger: { kind: "once", at: iso(at) }, lastOccurrenceAt: iso(at) });
  assert.deepEqual(evaluateSchedule(done, at + 5), { action: "finished", nextRunAtMs: null });
});
