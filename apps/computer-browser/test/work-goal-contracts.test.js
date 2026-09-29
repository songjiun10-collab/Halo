"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateWorkGoalInput,
  validateWorkGoalSpec,
  validateWorkGoalEvent,
  applyWorkGoalEvent,
  replayWorkGoalEvents,
} = require("../shared/work-goal-contracts");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeInput(overrides = {}) {
  return {
    objective: "Ship the verified import workflow",
    successCriteria: [
      { id: "tests", text: "The import passes its regression tests", required: true, verification: "host_evidence" },
      { id: "review", text: "A user reviews the final behavior", required: true, verification: "user" },
    ],
    budget: { maxTasks: 3, maxActions: 40, maxPlannerCalls: 20, maxActiveMs: 60000 },
    ...overrides,
  };
}

function makeSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    goalId: uuid(1),
    version: 1,
    ...makeInput(),
    ...overrides,
  };
}

function event(type, payload, seq, goalVersion = 1, goalId = uuid(1)) {
  return {
    seq,
    eventId: uuid(seq + 100),
    goalId,
    goalVersion,
    type,
    payload,
    at: `2026-09-29T00:00:${String(seq).padStart(2, "0")}.000Z`,
  };
}

function created(spec = makeSpec()) {
  return event("work_goal_created", { spec }, 1, spec.version, spec.goalId);
}

test("WorkGoalInput accepts bounded user fields and refuses host-assigned identity fields", () => {
  const input = makeInput();
  assert.equal(validateWorkGoalInput(input), input);
  assert.throws(() => validateWorkGoalInput({ ...input, goalId: uuid(5) }), { code: "unknown_field" });
  assert.throws(() => validateWorkGoalInput({ ...input, version: 1 }), { code: "unknown_field" });
  assert.throws(() => validateWorkGoalInput({ ...input, objective: "x".repeat(16 * 1024 + 1) }), { code: "field_too_large" });
  assert.throws(() => validateWorkGoalInput({ ...input, unknown: true }), { code: "unknown_field" });
});

test("WorkGoalSpec rejects duplicate criteria and values beyond each host budget cap", () => {
  const duplicate = makeSpec({ successCriteria: [makeInput().successCriteria[0], makeInput().successCriteria[0]] });
  assert.throws(() => validateWorkGoalSpec(duplicate), { code: "duplicate_criterion" });
  assert.throws(() => validateWorkGoalSpec(makeSpec({ budget: { maxTasks: 10001 } })), { code: "limit_exceeded" });
  assert.throws(() => validateWorkGoalSpec(makeSpec({ budget: { maxActiveMs: 31536000001 } })), { code: "limit_exceeded" });
  assert.throws(() => validateWorkGoalSpec(makeSpec({ budget: { maxActions: 0 } })), { code: "invalid_field" });
  assert.throws(() => validateWorkGoalSpec(makeSpec({ untrusted: "extra" })), { code: "unknown_field" });
});

test("WorkGoal journal events use an exact UUID/versioned envelope and closed payload schema", () => {
  const first = created();
  assert.equal(validateWorkGoalEvent(first), first);
  assert.throws(() => validateWorkGoalEvent({ ...first, extra: "ignored?" }), { code: "unknown_field" });
  assert.throws(() => validateWorkGoalEvent({ ...first, goalVersion: 0 }), { code: "invalid_field" });
  assert.throws(() => validateWorkGoalEvent({ ...first, type: "work_goal_future_event" }), { code: "unknown_event" });
  assert.throws(() => validateWorkGoalEvent({ ...first, payload: { spec: first.payload.spec, forged: true } }), { code: "unknown_field" });
});

test("replay accepts a versioned amendment and rejects stale or skipped lifecycle changes", () => {
  const initial = makeSpec({ successCriteria: [{ id: "review", text: "Review the result", required: true, verification: "user" }] });
  const amended = { ...initial, version: 2, objective: "Ship the verified v2 import workflow" };
  const reservationId = uuid(30);
  const taskId = uuid(11);
  const events = [
    created(initial),
    event("work_goal_task_reserved", { reservationId, taskId, taskGoalVersion: 1, limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 } }, 2),
    event("work_goal_task_linked", { reservationId, taskId }, 3),
    event("work_goal_criterion_verified", { criterionId: "review", actor: "user" }, 4),
    event("work_goal_progress_recorded", { evidenceRefs: [{ criterionId: "review", taskId, eventId: uuid(90), evidenceId: "ev-1" }] }, 5),
    event("work_goal_amended", { spec: amended }, 6, 2),
  ];
  const state = replayWorkGoalEvents(events);
  assert.equal(state.status, "active");
  assert.equal(state.spec.version, 2);
  assert.deepEqual(state.verifiedCriteria, []);
  assert.deepEqual(state.verifiedCriteriaByVersion[1], ["review"]);
  assert.equal(state.specsByVersion[1].objective, initial.objective);
  assert.equal(state.progress.length, 1, "amendment keeps the old-version evidence reference as history");
  assert.throws(() => replayWorkGoalEvents([created(initial), event("work_goal_paused", { actor: "user" }, 2, 2)]), { code: "stale_goal_version" });
  assert.throws(() => replayWorkGoalEvents([created(initial), event("work_goal_paused", { actor: "user" }, 3)]), { code: "invalid_sequence" });
});

test("the third consecutive identical host blocker moves the active Work Goal to blocked", () => {
  const tasks = [uuid(11), uuid(12), uuid(13)];
  const events = [created()];
  let seq = 2;
  for (let index = 0; index < tasks.length; index += 1) {
    const taskId = tasks[index];
    const reservationId = uuid(30 + index);
    events.push(event("work_goal_task_reserved", {
      reservationId,
      taskId,
      taskGoalVersion: 1,
      limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 },
    }, seq++));
    events.push(event("work_goal_task_linked", { reservationId, taskId }, seq++));
    events.push(event("work_goal_continuation_attempted", { taskId, origin: "user" }, seq++));
    events.push(event("work_goal_blocker_observed", { taskId, reasonCode: "planner_error", phase: "planner" }, seq++));
  }
  const state = replayWorkGoalEvents(events);
  assert.equal(state.status, "blocked");
  assert.equal(state.blockerStreak.count, 3);
  assert.equal(state.blockerStreak.fingerprint, "planner_error:planner");
});

test("blocker reason and phase are an exact allowlisted pair", () => {
  const events = [
    created(),
    event("work_goal_task_reserved", {
      reservationId: uuid(30), taskId: uuid(11), taskGoalVersion: 1,
      limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 },
    }, 2),
    event("work_goal_task_linked", { reservationId: uuid(30), taskId: uuid(11) }, 3),
    event("work_goal_continuation_attempted", { taskId: uuid(11), origin: "user" }, 4),
    event("work_goal_blocker_observed", { taskId: uuid(11), reasonCode: "planner_error", phase: "budget" }, 5),
  ];
  assert.throws(() => replayWorkGoalEvents(events), { code: "invalid_blocker" });
});

test("only verified current Work Goal criteria can precede completion", () => {
  const review = { id: "review", text: "A user reviews the final behavior", required: true, verification: "user" };
  const first = created(makeSpec({ successCriteria: [review] }));
  const events = [
    first,
    event("work_goal_criterion_verified", { criterionId: "review", actor: "user" }, 2),
    event("work_goal_completed", { criterionIds: ["review"] }, 3),
  ];
  const state = replayWorkGoalEvents(events);
  assert.equal(state.status, "complete");
  assert.deepEqual(state.verifiedCriteria, ["review"]);
  assert.throws(() => replayWorkGoalEvents([first, event("work_goal_completed", { criterionIds: ["tests", "review"] }, 2)]), { code: "criteria_incomplete" });
  assert.throws(() => replayWorkGoalEvents([first, event("work_goal_criterion_verified", { criterionId: "missing", actor: "user" }, 2)]), { code: "unknown_criterion" });
});

test("event sequence and event IDs cannot be reused during replay", () => {
  const first = created();
  assert.throws(() => replayWorkGoalEvents([first, { ...event("work_goal_paused", { actor: "user" }, 2), eventId: first.eventId }]), { code: "duplicate_event" });
  assert.throws(() => replayWorkGoalEvents([first, event("work_goal_paused", { actor: "user" }, 3)]), { code: "invalid_sequence" });
});

test("incremental reducer matches replay while enforcing gapless sequence and unique event IDs", () => {
  const first = created(makeSpec({ successCriteria: [{ id: "review", text: "Review", required: true, verification: "user" }] }));
  const pause = event("work_goal_paused", { actor: "user" }, 2);
  const ids = new Set([first.eventId]);
  const incremental = applyWorkGoalEvent(replayWorkGoalEvents([first]), pause, ids);
  assert.deepEqual(incremental, replayWorkGoalEvents([first, pause]));
  assert.throws(() => applyWorkGoalEvent(incremental, { ...pause, seq: 3 }, ids), { code: "duplicate_event" });
  assert.throws(() => applyWorkGoalEvent(incremental, event("work_goal_resumed", { actor: "user" }, 4), new Set()), { code: "invalid_sequence" });
});

test("incremental reducer rejects overbooking without mutating the last committed state", () => {
  const spec = makeSpec({ successCriteria: [{ id: "review", text: "Review", required: true, verification: "user" }] });
  const state = replayWorkGoalEvents([created(spec)]);
  const before = structuredClone(state);
  const reserve = event("work_goal_task_reserved", {
    reservationId: uuid(30), taskId: uuid(11), taskGoalVersion: 1,
    limits: { maxTasks: 1, maxActions: 41, maxPlannerCalls: 1, maxActiveMs: 1 },
  }, 2);
  assert.throws(() => applyWorkGoalEvent(state, reserve, new Set()), { code: "budget_exhausted" });
  assert.deepEqual(state, before);
});

test("pause, resume, and archive use only legal lifecycle transitions", () => {
  const first = created(makeSpec({ successCriteria: [{ id: "review", text: "Review the result", required: true, verification: "user" }] }));
  const events = [
    first,
    event("work_goal_paused", { actor: "user" }, 2),
    event("work_goal_resumed", { actor: "user" }, 3),
    event("work_goal_paused", { actor: "user" }, 4),
    event("work_goal_archived", { actor: "user" }, 5),
  ];
  assert.equal(replayWorkGoalEvents(events).status, "archived");
  assert.throws(() => replayWorkGoalEvents([first, event("work_goal_archived", { actor: "user" }, 2)]), { code: "invalid_transition" });
});

test("a reservation cannot be reused for a different task or allowance", () => {
  const first = created();
  const reservation = {
    reservationId: uuid(30),
    taskId: uuid(11),
    taskGoalVersion: 1,
    limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 },
  };
  const changedReservation = { ...reservation, taskId: uuid(12) };
  assert.throws(() => replayWorkGoalEvents([
    first,
    event("work_goal_task_reserved", reservation, 2),
    event("work_goal_task_reserved", changedReservation, 3),
  ]), { code: "reservation_conflict" });
});

test("a Task can have only one reservation, and zero terminal usage is valid", () => {
  const first = created(makeSpec({ successCriteria: [{ id: "review", text: "Review", required: true, verification: "user" }] }));
  const reservationId = uuid(30);
  const taskId = uuid(11);
  const reservation = {
    reservationId, taskId, taskGoalVersion: 1,
    limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 },
  };
  assert.throws(() => replayWorkGoalEvents([
    first,
    event("work_goal_task_reserved", reservation, 2),
    event("work_goal_task_reserved", { ...reservation, reservationId: uuid(31) }, 3),
  ]), { code: "reservation_conflict" });

  const zeroUsageEvents = [
    first,
    event("work_goal_task_reserved", reservation, 2),
    event("work_goal_task_linked", { reservationId, taskId }, 3),
    event("work_goal_task_reservation_reconciled", {
      reservationId, taskId, taskState: "stopped",
      usage: { maxActions: 0, maxPlannerCalls: 0, maxActiveMs: 0 },
    }, 4),
    event("work_goal_task_reservation_released", {
      reservationId, taskId, unused: { maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 },
    }, 5),
  ];
  assert.equal(replayWorkGoalEvents(zeroUsageEvents).reservations[reservationId].status, "released");
});

test("an amendment cannot lower aggregate caps beneath consumed usage or outstanding reservations", () => {
  const initial = makeSpec({ successCriteria: [{ id: "review", text: "Review", required: true, verification: "user" }] });
  const reservationId = uuid(30);
  const taskId = uuid(11);
  const amended = { ...initial, version: 2, budget: { maxTasks: 2, maxActions: 4, maxPlannerCalls: 20, maxActiveMs: 60000 } };
  const events = [
    created(initial),
    event("work_goal_task_reserved", { reservationId, taskId, taskGoalVersion: 1, limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 } }, 2),
    event("work_goal_task_linked", { reservationId, taskId }, 3),
    event("work_goal_task_reservation_reconciled", {
      reservationId, taskId, taskState: "stopped",
      usage: { maxActions: 2, maxPlannerCalls: 1, maxActiveMs: 400 },
    }, 4),
    event("work_goal_amended", { spec: amended }, 5, 2),
  ];
  assert.throws(() => replayWorkGoalEvents(events), { code: "budget_overcommitted" });
});

test("reservation release records must equal the validated terminal usage remainder", () => {
  const first = created(makeSpec({ successCriteria: [{ id: "review", text: "Review", required: true, verification: "user" }] }));
  const reservationId = uuid(30);
  const taskId = uuid(11);
  const events = [
    first,
    event("work_goal_task_reserved", { reservationId, taskId, taskGoalVersion: 1, limits: { maxTasks: 1, maxActions: 5, maxPlannerCalls: 2, maxActiveMs: 1000 } }, 2),
    event("work_goal_task_linked", { reservationId, taskId }, 3),
    event("work_goal_task_reservation_reconciled", { reservationId, taskId, taskState: "stopped", usage: { maxActions: 2, maxPlannerCalls: 1, maxActiveMs: 400 } }, 4),
    event("work_goal_task_reservation_released", { reservationId, taskId, unused: {} }, 5),
  ];
  assert.throws(() => replayWorkGoalEvents(events), { code: "budget_corrupt" });
});
