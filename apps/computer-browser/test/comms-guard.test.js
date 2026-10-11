"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CommsGuard, CommsGuardError } = require("../main/harness/comms-guard");

const code = (c) => (e) => e instanceof CommsGuardError && e.code === c;

test("a question creates a wait edge that an answer removes", () => {
  const g = new CommsGuard();
  g.noteQuestion({ id: "q1", from: "a", to: "b" });
  assert.deepEqual(g.waitingOn("a"), ["b"]);
  g.noteAnswer("q1");
  assert.deepEqual(g.waitingOn("a"), []);
});

test("a question that would close a wait cycle is refused as deadlock", () => {
  const g = new CommsGuard();
  g.noteQuestion({ id: "q1", from: "a", to: "b" });
  g.noteQuestion({ id: "q2", from: "b", to: "c" });
  assert.throws(() => g.noteQuestion({ id: "q3", from: "c", to: "a" }), code("deadlock"));
  assert.throws(() => g.noteQuestion({ id: "q4", from: "a", to: "a" }), code("deadlock"));
  assert.deepEqual(g.waitingOn("c"), [], "the refused edge is not recorded");
});

test("a sender may have only maxOpenQuestions outstanding", () => {
  const g = new CommsGuard({ maxOpenQuestions: 2 });
  g.noteQuestion({ id: "q1", from: "a", to: "b" });
  g.noteQuestion({ id: "q2", from: "a", to: "c" });
  assert.throws(() => g.noteQuestion({ id: "q3", from: "a", to: "d" }), code("wait_limit"));
});

test("unanswered questions time out and free the wait edge", () => {
  let t = 1000;
  const g = new CommsGuard({ questionTimeoutMs: 500, now: () => t });
  g.noteQuestion({ id: "q1", from: "a", to: "b" });
  t = 1400;
  assert.deepEqual(g.expireQuestions(), []);
  t = 1500;
  assert.deepEqual(g.expireQuestions().map((q) => q.id), ["q1"]);
  assert.deepEqual(g.waitingOn("a"), []);
});

test("sends are rate limited per sender within a window", () => {
  let t = 0;
  const g = new CommsGuard({ maxSends: 2, sendWindowMs: 1000, now: () => t });
  g.checkSend("a"); g.checkSend("a");
  assert.throws(() => g.checkSend("a"), code("send_limit"));
  g.checkSend("b");
  t = 1000;
  g.checkSend("a");
});

test("broadcast targets are the teammates except the sender", () => {
  const g = new CommsGuard();
  assert.deepEqual(g.broadcastTargets("a", ["a", "b", "c"]), ["b", "c"]);
});
