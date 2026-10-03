"use strict";

// "Weekdays at 9:00" style schedules: a calendar trigger fires at a local
// wall-clock time on chosen ISO weekdays (1 = Monday ... 7 = Sunday) in an
// IANA time zone, so a schedule keeps its local time across DST changes.

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateTrigger, evaluateSchedule } = require("../shared/schedule-contracts");

const WEEKDAYS = [1, 2, 3, 4, 5];
const seoul = (overrides = {}) => ({ kind: "calendar", days: WEEKDAYS, time: "09:00", timeZone: "Asia/Seoul", ...overrides });
const record = (trigger, createdAt, lastOccurrenceAt = null) => ({ trigger, createdAt, lastOccurrenceAt });
const ms = (iso) => Date.parse(iso);

test("validateTrigger accepts a calendar trigger and rejects malformed ones", () => {
  assert.deepEqual(validateTrigger(seoul()), seoul());
  assert.deepEqual(validateTrigger(seoul({ days: [7, 1] })).days, [1, 7], "days are normalised to ascending order");
  for (const bad of [
    { days: [] },
    { days: [0] },
    { days: [8] },
    { days: [1, 1] },
    { days: [1.5] },
    { days: "1" },
    { time: "9:00" },
    { time: "24:00" },
    { time: "09:60" },
    { time: 900 },
    { timeZone: "Mars/Olympus" },
    { timeZone: "" },
    { timeZone: "x".repeat(65) },
    { extra: 1 },
  ]) {
    assert.throws(() => validateTrigger(seoul(bad)), (error) => typeof error.code === "string", JSON.stringify(bad));
  }
});

test("a weekday 9:00 Seoul schedule runs at 00:00Z on weekdays only", () => {
  // 2026-10-02 is a Friday. 09:00 KST = 00:00Z.
  const created = "2026-10-01T12:00:00.000Z";
  const friday = evaluateSchedule(record(seoul(), created), ms("2026-10-02T00:05:00.000Z"));
  assert.equal(friday.action, "run");
  assert.equal(new Date(friday.occurrenceAtMs).toISOString(), "2026-10-02T00:00:00.000Z");
  // The next one skips the weekend to Monday 2026-10-05.
  assert.equal(new Date(friday.nextRunAtMs).toISOString(), "2026-10-05T00:00:00.000Z");

  const afterRun = evaluateSchedule(record(seoul(), created, "2026-10-02T00:00:00.000Z"), ms("2026-10-03T03:00:00.000Z"));
  assert.equal(afterRun.action, "none");
  assert.equal(new Date(afterRun.nextRunAtMs).toISOString(), "2026-10-05T00:00:00.000Z");
});

test("an occurrence before the schedule was created never runs", () => {
  const created = "2026-10-02T00:30:00.000Z"; // Friday 09:30 KST, after today's slot
  const result = evaluateSchedule(record(seoul(), created), ms("2026-10-02T01:00:00.000Z"));
  assert.equal(result.action, "none");
  assert.equal(new Date(result.nextRunAtMs).toISOString(), "2026-10-05T00:00:00.000Z");
});

test("missed occurrences are coalesced into the latest one", () => {
  const created = "2026-09-28T00:00:00.000Z";
  const result = evaluateSchedule(record(seoul({ days: [1, 2, 3, 4, 5, 6, 7] }), created, "2026-09-28T00:00:00.000Z"), ms("2026-10-01T05:00:00.000Z"));
  assert.equal(result.action, "run");
  assert.equal(new Date(result.occurrenceAtMs).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(new Date(result.nextRunAtMs).toISOString(), "2026-10-02T00:00:00.000Z");
});

test("local time is kept across a DST change", () => {
  // New York leaves DST on 2026-11-01: 09:00 EDT = 13:00Z, 09:00 EST = 14:00Z.
  const daily = { kind: "calendar", days: [1, 2, 3, 4, 5, 6, 7], time: "09:00", timeZone: "America/New_York" };
  const before = evaluateSchedule(record(daily, "2026-10-30T00:00:00.000Z"), ms("2026-10-31T13:30:00.000Z"));
  assert.equal(new Date(before.occurrenceAtMs).toISOString(), "2026-10-31T13:00:00.000Z");
  assert.equal(new Date(before.nextRunAtMs).toISOString(), "2026-11-01T14:00:00.000Z");
});

test("a nonexistent local time runs later, a repeated one runs once at the first", () => {
  const daily = (time) => ({ kind: "calendar", days: [1, 2, 3, 4, 5, 6, 7], time, timeZone: "America/New_York" });
  // 2026-03-08 02:00 EST jumps to 03:00 EDT: 02:30 does not exist -> 03:30 EDT (07:30Z).
  const gap = evaluateSchedule(record(daily("02:30"), "2026-03-07T00:00:00.000Z", "2026-03-07T07:30:00.000Z"), ms("2026-03-08T12:00:00.000Z"));
  assert.equal(new Date(gap.occurrenceAtMs).toISOString(), "2026-03-08T07:30:00.000Z");
  // 2026-11-01 01:30 happens twice (EDT then EST) -> the first, 05:30Z.
  const overlap = evaluateSchedule(record(daily("01:30"), "2026-10-31T00:00:00.000Z", "2026-10-31T05:30:00.000Z"), ms("2026-11-01T12:00:00.000Z"));
  assert.equal(new Date(overlap.occurrenceAtMs).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(overlap.nextRunAtMs).toISOString(), "2026-11-02T06:30:00.000Z");
});

test("an Agent schedule accepts a calendar trigger", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { AgentScheduleStore } = require("../main/harness/agent-schedule");
  const store = new AgentScheduleStore({ storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-calendar-")), now: () => ms("2026-10-01T00:00:00.000Z") });
  const saved = await store.save({
    kind: "agent",
    ownerId: "11111111-1111-4111-8111-111111111111",
    request: "아침 요약",
    trigger: seoul(),
    onApproval: "pause",
    maxPlannerCalls: 40,
  });
  assert.deepEqual(saved.trigger, seoul());
});
