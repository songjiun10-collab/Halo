"use strict";

// Regression tests for the accuracy harness's outcome layer. The bug these
// lock down is visible in the 2026-10-07 Online-Mind2Web pilot: 5 tasks, 3
// recorded as non-successes, and 2 of those 3 (Apple, FlightAware) were runs
// whose planner had actually answered correctly inside a need_user pause. The
// harness counted the delivery channel, not the task.
//
// The invariant under test: task STATE never grants a pass. Only ground truth
// does. A state can only subtract (blocked / inconclusive).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyEnding,
  answerFrom,
  checkAnswer,
  grade,
  aggregate,
  BLOCKING_PAUSE_REASONS,
  INCONCLUSIVE_PAUSE_REASONS,
  INCONCLUSIVE_ERROR_CODES,
} = require("../integration/accuracy/verdict.js");

const base = { ending: "completed", pauseReason: null, needUserReason: null, timedOut: false, errorCode: null };

test("a planner answer delivered through need_user is a gradeable answer, not a dead end", () => {
  const evidence = { ...base, ending: "paused", pauseReason: "need_user", needUserReason: "The current MacBook Air is the M4 model." };
  assert.equal(classifyEnding(evidence).verdict, "graded");
  assert.equal(answerFrom(evidence), "The current MacBook Air is the M4 model.");
});

test("captcha and access denial are blocked, not model failures", () => {
  for (const pauseReason of BLOCKING_PAUSE_REASONS) {
    const verdict = classifyEnding({ ...base, ending: "paused", pauseReason });
    assert.equal(verdict.verdict, "blocked", `${pauseReason} must be blocked`);
  }
  const denied = classifyEnding({ ...base, ending: "paused", pauseReason: "need_user", finalHttpStatus: 403 });
  assert.equal(denied.verdict, "blocked");
  assert.match(denied.reason, /403/);
});

// Why a captcha is worth its own number: it is a property of the SITE, not of
// the model or the harness. Lumping it into a generic "blocked" bucket with
// HTTP errors makes the one rate you would take to a site owner unreadable.
test("the blocked cause is machine-readable, not only prose", () => {
  assert.equal(classifyEnding({ ...base, ending: "paused", pauseReason: "captcha" }).code, "captcha");
  assert.equal(classifyEnding({ ...base, finalHttpStatus: 403 }).code, "http_403");
  assert.equal(classifyEnding({ ...base, finalHttpStatus: 503 }).code, "http_503");
  assert.equal(classifyEnding({ ...base }).code, "graded");
  assert.equal(classifyEnding({ ...base, timedOut: true }).code, "timeout");
  assert.equal(classifyEnding({ ...base, ending: "paused", pauseReason: "planner_error" }).code, "pause:planner_error");
});

test("aggregation breaks the blocked bucket down by cause and reports a captcha rate", () => {
  const summary = aggregate([
    { taskId: "a", verdict: "pass" },
    { taskId: "b", verdict: "blocked", blockReason: "captcha" },
    { taskId: "c", verdict: "blocked", blockReason: "http_403" },
    { taskId: "d", verdict: "blocked", blockReason: "http_403" },
    { taskId: "e", verdict: "blocked", blockReason: "captcha" },
  ]);
  assert.equal(summary.blocked, 4);
  assert.deepEqual(summary.blockedBy, { captcha: 2, http_403: 2 });
  // The captcha rate is per ATTEMPT, not per graded run: an interrupted run is
  // an interruption whether or not anything was gradeable.
  assert.equal(summary.captchaBlocked, 2);
  assert.equal(summary.captchaRate, 2 / 5);
  // And it stays out of the pass rate.
  assert.equal(summary.graded, 1);
  assert.equal(summary.passRate, 1);
});

test("a blocked row with no recorded cause is still counted, just not attributed", () => {
  const summary = aggregate([{ taskId: "a", verdict: "blocked" }, { taskId: "b", verdict: "blocked", blockReason: "captcha" }]);
  assert.equal(summary.blocked, 2);
  assert.deepEqual(summary.blockedBy, { captcha: 1, unrecorded: 1 });
  assert.equal(summary.captchaRate, 1 / 2);
});

test("a suite that never touched a captcha reports a zero rate, not a missing one", () => {
  const summary = aggregate([{ taskId: "a", verdict: "pass" }, { taskId: "b", verdict: "fail" }]);
  assert.equal(summary.captchaRate, 0);
  assert.deepEqual(summary.blockedBy, {});
});

// A task can be ABOUT a missing page -- "find the next-generation specs" where
// there are none. Then the 404 is the answer, not an obstruction, and the run
// has to stay in the graded set. Without this the harness would drop an honest
// "that page does not exist" from the denominator and score it BELOW a model
// that fabricated a chip name.
test("an HTTP error a task is asking about stays graded instead of being blocked", () => {
  const aboutMissing = { ...base, ending: "paused", pauseReason: "need_user", finalHttpStatus: 404, expectedHttpStatus: 404 };
  assert.equal(classifyEnding(aboutMissing).verdict, "graded");
  // The status stays visible to the checker either way.
  const task = { grade: (evidence) => ({ passed: evidence.finalHttpStatus === 404, reason: "reported the page is missing" }) };
  assert.equal(grade(aboutMissing, task).verdict, "pass");
  // Default behaviour is unchanged for every other task.
  assert.equal(classifyEnding({ ...base, finalHttpStatus: 404 }).verdict, "blocked");
});

test("declaring an expected status exempts exactly that status and nothing else", () => {
  // The opt-out names ONE status. A 403 denial encountered while doing the
  // missing-page task is a different obstacle and must still block the run --
  // otherwise a task could exempt itself from every HTTP error at once.
  const denied = { ...base, ending: "paused", pauseReason: "need_user", finalHttpStatus: 403, expectedHttpStatus: 404 };
  assert.equal(classifyEnding(denied).verdict, "blocked");
  assert.match(classifyEnding(denied).reason, /403/);
  // And it cannot launder a crash or any other inconclusive ending into a score.
  const crashed = { ...base, ending: "paused", pauseReason: "need_user", timedOut: true, expectedHttpStatus: 404 };
  assert.equal(classifyEnding(crashed).verdict, "inconclusive");
  const plannerDown = { ...base, ending: "paused", pauseReason: "planner_error", finalHttpStatus: 404, expectedHttpStatus: 404 };
  assert.equal(classifyEnding(plannerDown).verdict, "inconclusive");
});

test("a timeout or a planner crash is inconclusive rather than a silent fail", () => {
  assert.equal(classifyEnding({ ...base, timedOut: true }).verdict, "inconclusive");
  for (const errorCode of INCONCLUSIVE_ERROR_CODES) {
    assert.equal(classifyEnding({ ...base, errorCode }).verdict, "inconclusive", errorCode);
  }
  for (const pauseReason of INCONCLUSIVE_PAUSE_REASONS) {
    assert.equal(classifyEnding({ ...base, ending: "paused", pauseReason }).verdict, "inconclusive", pauseReason);
  }
});

test("giving up and exhausting the budget stay graded so they are judged, not excused", () => {
  for (const pauseReason of ["goal_not_reached", "budget_exhausted", "no_progress"]) {
    assert.equal(classifyEnding({ ...base, ending: "paused", pauseReason }).verdict, "graded", pauseReason);
  }
});

test("answer matching needs every required token and trips on a forbidden one", () => {
  const spec = { required: ["M4", "11-inch"], forbidden: [/\bpro\b/i] };
  assert.equal(checkAnswer("The M4 11-inch MacBook Air.", spec).passed, true);
  const partial = checkAnswer("It is the M4.", spec);
  assert.equal(partial.passed, false);
  assert.deepEqual(partial.missing, ["11-inch"]);
  const wrongModel = checkAnswer("The M4 11-inch MacBook Pro.", spec);
  assert.equal(wrongModel.passed, false);
  assert.deepEqual(wrongModel.forbidden, [/\bpro\b/i]);
});

test("answer matching ignores case and whitespace but not content", () => {
  const spec = { required: ["m4  chip"] };
  assert.equal(checkAnswer("M4   Chip", spec).passed, true);
  assert.equal(checkAnswer("M5 chip", spec).passed, false);
});

test("the model claiming it finished never overrides ground truth", () => {
  const task = { grade: () => ({ passed: false, reason: "server recorded no submit" }) };
  const claimed = grade({ ...base, ending: "completed" }, task);
  assert.equal(claimed.verdict, "fail");
  assert.match(claimed.reason, /no submit/);
});

test("awaiting_verification is not a pass by itself", () => {
  const task = { grade: () => ({ passed: false, reason: "field still empty" }) };
  const verdict = grade({ ...base, ending: "awaiting_verification" }, task);
  assert.equal(verdict.verdict, "fail");
});

test("grading fails closed when the task has no checker or the evidence is unusable", () => {
  assert.equal(grade({ ...base, ending: "paused", pauseReason: "need_user", needUserReason: "42" }, {}).verdict, "fail");
  assert.equal(grade({ ...base, ending: "paused", pauseReason: "need_user", needUserReason: "42" }, { grade: null }).verdict, "fail");
  const throwing = grade({ ...base }, { grade: () => { throw new Error("checker exploded"); } });
  assert.equal(throwing.verdict, "fail");
  assert.match(throwing.reason, /checker exploded/);
});

test("a ground-truth pass is reported as a pass with its reason attached", () => {
  const task = { grade: (evidence) => ({ passed: evidence.serverLog.some((e) => e.path === "/confirm"), reason: "submitted" }) };
  const verdict = grade({ ...base, ending: "paused", pauseReason: "need_user", serverLog: [{ path: "/confirm" }] }, task);
  assert.deepEqual([verdict.verdict, verdict.reason], ["pass", "submitted"]);
});

test("aggregation scores the graded denominator and never hides dropped runs", () => {
  const results = [
    { taskId: "a", verdict: "pass" },
    { taskId: "b", verdict: "pass" },
    { taskId: "c", verdict: "fail", reason: "wrong model" },
    { taskId: "d", verdict: "blocked", reason: "captcha" },
    { taskId: "e", verdict: "inconclusive", reason: "timeout" },
  ];
  const summary = aggregate(results);
  assert.deepEqual(
    [summary.total, summary.graded, summary.passed, summary.failed, summary.blocked, summary.inconclusive],
    [5, 3, 2, 1, 1, 1],
  );
  assert.equal(summary.passRate, 2 / 3);
  // 2/5 would silently charge the model for the captcha and the timeout.
  assert.notEqual(summary.passRate, 2 / 5);
});

test("aggregation reports no rate at all when nothing was gradeable", () => {
  const summary = aggregate([{ taskId: "a", verdict: "blocked" }]);
  assert.equal(summary.passRate, null);
  assert.equal(summary.reportable, false);
});

test("a run with inconclusive outcomes is labelled unreportable so it cannot be quoted as a rate", () => {
  const clean = aggregate([{ taskId: "a", verdict: "pass" }, { taskId: "b", verdict: "fail" }]);
  assert.equal(clean.reportable, true);
  const dirty = aggregate([{ taskId: "a", verdict: "pass" }, { taskId: "b", verdict: "inconclusive" }]);
  assert.equal(dirty.reportable, false);
  assert.match(dirty.caveat, /inconclusive/);
  // The number is still present for debugging, it just is not quotable.
  assert.equal(dirty.passRate, 1);
});

test("aggregation counts hallucinated runs separately from the pass rate", () => {
  const summary = aggregate([
    { taskId: "a", verdict: "pass", hallucinated: false },
    { taskId: "b", verdict: "fail", hallucinated: true },
    { taskId: "c", verdict: "fail", hallucinated: false },
    { taskId: "d", verdict: "pass", hallucinated: true },
  ]);
  assert.equal(summary.fabricated, 2);
  assert.equal(summary.hallucinationRate, 2 / 4);
  assert.equal(summary.passed, 2);
  // A hallucinating pass is still a pass for the task, and still counted as a
  // fabrication -- the two numbers answer different questions.
  assert.equal(summary.passRate, 2 / 4);
});

test("a suite with nothing graded reports no hallucination rate either", () => {
  const summary = aggregate([{ taskId: "a", verdict: "blocked", hallucinated: false }]);
  assert.equal(summary.hallucinationRate, null);
  assert.equal(summary.fabricated, 0);
});

test("aggregation refuses rows it cannot classify instead of guessing", () => {
  const summary = aggregate([{ taskId: "a", verdict: "wat" }]);
  assert.equal(summary.reportable, false);
  assert.match(summary.caveat, /unclassified/);
});
