"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HUMAN_REASONS, HumanHandoffQueue, handoffLabel, needsHuman } = require("../main/harness/human-handoff");

test("only the human-needed pause reasons open a handoff", () => {
  for (const reason of HUMAN_REASONS) assert.equal(needsHuman(reason), true, reason);
  for (const reason of ["planner_error", "no_progress", "memory_pressure", "recovered", "queue_start_failed", "", null, undefined, 42]) {
    assert.equal(needsHuman(reason), false, String(reason));
  }
});

test("a wait opens once per reason and notifies once", () => {
  const notifications = [];
  let clock = 1000;
  const queue = new HumanHandoffQueue({ now: () => clock, notify: (handoff) => notifications.push(handoff) });
  assert.equal(queue.open({ taskId: "", reason: "captcha" }), null);
  assert.equal(queue.open({ taskId: "t1", reason: "planner_error" }), null);
  assert.deepEqual(queue.list(), []);

  const first = queue.open({ taskId: "t1", reason: "captcha", detail: "x".repeat(900) });
  assert.equal(first.created, true);
  assert.equal(first.record.reason, "captcha");
  assert.equal(first.record.since, 1000);
  assert.equal(first.record.detail.length, 500, "detail is bounded");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].taskId, "t1");

  clock = 2000;
  const again = queue.open({ taskId: "t1", reason: "captcha" });
  assert.equal(again.created, false);
  assert.equal(again.record.since, 1000, "an idempotent pause keeps the original wait start");
  assert.equal(notifications.length, 1, "the person is not notified twice for one wait");

  clock = 3000;
  const changed = queue.open({ taskId: "t1", reason: "need_user", detail: null });
  assert.equal(changed.created, true);
  assert.equal(changed.record.since, 3000);
  assert.equal(notifications.length, 2, "a new reason restarts the wait and notifies again");
  assert.equal(queue.size, 1);
});

test("resolving a wait clears it once and returns the outcome", () => {
  const queue = new HumanHandoffQueue({ now: () => 500 });
  assert.equal(queue.resolve("missing"), null);
  queue.open({ taskId: "t1", reason: "need_user" });
  const resolved = queue.resolve("t1", { outcome: "stopped" });
  assert.equal(resolved.reason, "need_user");
  assert.equal(resolved.outcome, "stopped");
  assert.equal(resolved.resolvedAt, 500);
  assert.equal(queue.resolve("t1"), null);
  assert.equal(queue.has("t1"), false);
});

test("returned records are copies, and a throwing notifier cannot break the queue", () => {
  const queue = new HumanHandoffQueue({ notify: () => { throw new Error("nope"); } });
  const opened = queue.open({ taskId: "t1", reason: "captcha" });
  assert.equal(opened.created, true, "a throwing notifier does not fail the open");
  const listed = queue.list();
  listed[0].reason = "tampered";
  const gotten = queue.get("t1");
  gotten.reason = "tampered";
  assert.equal(queue.get("t1").reason, "captcha");
  assert.match(handoffLabel("captcha"), /human check/);
  assert.equal(typeof handoffLabel("something_new"), "string");
});
