"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskController } = require("../main/harness/task-controller");
const { adaptiveEffort } = require("../main/harness/planner-effort-policy");

const easy = { lastActionType: "navigate", lastActionOk: true, revisit: false, pendingMessages: false, easyStreak: 1 };

test("adaptiveEffort drops one level after an easy hop and two after a second one", () => {
  assert.equal(adaptiveEffort({ base: "high", ...easy }), "medium");
  assert.equal(adaptiveEffort({ base: "high", ...easy, easyStreak: 2 }), "low");
  assert.equal(adaptiveEffort({ base: "xhigh", ...easy, easyStreak: 3 }), "medium");
  for (const type of ["navigate", "follow_link"]) assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionType: type }), "medium");
  assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionType: "scroll" }), "high");
});

test("adaptiveEffort keeps the configured effort whenever the turn looks hard", () => {
  assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionType: undefined, lastActionOk: false }), "high");
  assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionType: "click" }), "high");
  assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionType: "type" }), "high");
  assert.equal(adaptiveEffort({ base: "high", ...easy, lastActionOk: false }), "high");
  assert.equal(adaptiveEffort({ base: "high", ...easy, revisit: true }), "high");
  assert.equal(adaptiveEffort({ base: "high", ...easy, pendingMessages: true }), "high");
});

test("adaptiveEffort never goes below low or above the configured effort", () => {
  assert.equal(adaptiveEffort({ base: "low", ...easy, easyStreak: 5 }), "low");
  assert.equal(adaptiveEffort({ base: "medium", ...easy, easyStreak: 5 }), "low");
});

const controller = (over) => Object.assign(Object.create(TaskController.prototype), {
  _plannerEffort: "high", _adaptiveEffort: true, _seenUrls: new Set(), _lastActionType: "navigate", _lastActionStatus: "ok", _easyStreak: 1,
}, over);

test("the controller adapts only in auto mode and treats a revisited page as hard", () => {
  assert.equal(controller()._effectivePlannerEffort([], "https://a.test/"), "medium");
  assert.equal(controller()._effectivePlannerEffort([], "https://a.test/"), "medium");
  const c = controller();
  c._effectivePlannerEffort([], "https://a.test/");
  assert.equal(c._effectivePlannerEffort([], "https://a.test/"), "high");
  assert.equal(controller({ _adaptiveEffort: false })._effectivePlannerEffort([], "https://b.test/"), "high");
});

test("fast shares short's structural speedups", () => {
  const { isQuickProfile, maxActionsPerProposal } = require("../shared/harness-profile");
  const { routeForProfile } = require("../main/harness/planner-effort-policy");
  assert.ok(isQuickProfile("fast") && isQuickProfile("short") && !isQuickProfile("middle"));
  assert.equal(maxActionsPerProposal("fast"), maxActionsPerProposal("short"));
  assert.equal(routeForProfile({ duration: { id: "fast" } }), "fast");
});
