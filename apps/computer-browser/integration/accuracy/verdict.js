"use strict";

// How a run ENDED, kept strictly separate from whether the TASK was done.
//
// These rules come from the 2026-10-07 Online-Mind2Web pilot, where 3 of 5
// tasks were recorded as non-successes and 2 of those 3 (Apple MacBook Air
// specs, FlightAware AeroAPI tiers) were runs whose planner had in fact
// answered correctly -- inside a `need_user` pause, the only channel this
// harness gives a planner to return an answer. The old runners read the state
// and charged the model for its delivery channel.
//
// One invariant holds the whole module together: a task state never GRANTS a
// pass. A state can only subtract, by taking the run out of the graded set as
// `blocked` (the environment refused us) or `inconclusive` (the harness could
// not tell). A pass comes from one place only: the task's ground-truth
// checker reading the fixture's own server-side record.
//
// Pure logic: no browser, no model, no network, no clock.

/**
 * @typedef {"pass" | "fail" | "blocked" | "inconclusive"} Verdict
 */

// The environment refused the run, so the planner never got a fair shot.
// Excluded from the denominator and counted separately -- charging the model
// for a Cloudflare interstitial measures the internet, not the harness.
const BLOCKING_PAUSE_REASONS = new Set(["captcha"]);

// The harness itself lost the thread. Also excluded, but reported, because a
// suite full of these means the measurement is broken rather than the model
// being wrong.
const INCONCLUSIVE_PAUSE_REASONS = new Set([
  "planner_error",
  "planner_unavailable",
  "observation_error",
  "execution_uncertain",
  "approver_error",
  "memory_pressure",
  "memory_emergency",
  "computer_use_capture_failed",
  "computer_use_unavailable",
]);

const INCONCLUSIVE_ERROR_CODES = new Set([
  "pilot_error",
  "observation_failed",
  "stale_document",
  "browser_unavailable",
  "disposed",
]);

/**
 * Decides only whether a run is scoreable. Deliberately says nothing about
 * whether the task was accomplished.
 *
 * `code` is the machine-readable cause. It exists so a blocked run can be
 * attributed to the SITE (captcha, 403) or to the HARNESS (timeout, crash)
 * without parsing prose -- a captcha rate is a number someone will ask for.
 * @param {any} evidence
 * @returns {{ verdict: "graded" | Verdict, reason: string, code: string }}
 */
function classifyEnding(evidence) {
  if (evidence.timedOut) return { verdict: "inconclusive", reason: "run hit the time limit", code: "timeout" };
  if (typeof evidence.errorCode === "string" && INCONCLUSIVE_ERROR_CODES.has(evidence.errorCode)) {
    return { verdict: "inconclusive", reason: `error code ${evidence.errorCode}`, code: `error:${evidence.errorCode}` };
  }
  if (evidence.pauseReason && INCONCLUSIVE_PAUSE_REASONS.has(evidence.pauseReason)) {
    return { verdict: "inconclusive", reason: `paused on ${evidence.pauseReason}`, code: `pause:${evidence.pauseReason}` };
  }
  // An access-denied answer is a blocked site, not a wrong answer. The prose a
  // planner writes on hitting a 403 is usually optimistic, so the status wins.
  //
  // `expectedHttpStatus` is a task saying "this exact status IS my subject" --
  // a task asking about a page that does not exist needs its 404 graded. It is
  // scoped to that one number on purpose: a blanket exemption would let a task
  // declare itself immune to every HTTP error, and could launder a 403 denial
  // into a score. The inconclusive branches above run first regardless.
  if (typeof evidence.finalHttpStatus === "number" && evidence.finalHttpStatus >= 400
      && evidence.finalHttpStatus !== evidence.expectedHttpStatus) {
    return { verdict: "blocked", reason: `final page returned HTTP ${evidence.finalHttpStatus}`, code: `http_${evidence.finalHttpStatus}` };
  }
  if (evidence.pauseReason && BLOCKING_PAUSE_REASONS.has(evidence.pauseReason)) {
    return { verdict: "blocked", reason: `site required human verification (${evidence.pauseReason})`, code: evidence.pauseReason };
  }
  return { verdict: "graded", reason: "run is scoreable", code: "graded" };
}

/**
 * The planner's answer, from whichever channel carried it. A `need_user`
 * reason is the answer for an information task, not a request for help: the
 * harness has no human to answer, and the pilot's 2-of-5 real successes both
 * arrived here.
 * @param {any} evidence
 * @returns {string}
 */
function answerFrom(evidence) {
  const reason = evidence && evidence.needUserReason;
  return typeof reason === "string" ? reason : "";
}

// Runs of whitespace and the space between words are how a model's phrasing
// drifts from the fixture's; case and spacing are not content. Everything else
// is left alone so a wrong model name still fails.
const squash = (text) => text.toLowerCase().replace(/\s+/g, " ");

function matches(needle, haystack) {
  if (typeof needle === "string") return squash(haystack).includes(squash(needle));
  // A caller-supplied global regexp keeps lastIndex between calls; reset it so
  // repeated grading of the same answer stays deterministic.
  needle.lastIndex = 0;
  return needle.test(haystack);
}

/**
 * @param {string} answer
 * @param {{ required?: readonly (string|RegExp)[], forbidden?: readonly (string|RegExp)[] }} spec
 */
function checkAnswer(answer, spec) {
  const text = typeof answer === "string" ? answer : "";
  const required = Array.isArray(spec && spec.required) ? spec.required : [];
  const forbidden = Array.isArray(spec && spec.forbidden) ? spec.forbidden : [];
  const missing = required.filter((needle) => !matches(needle, text));
  const tripped = forbidden.filter((needle) => matches(needle, text));
  return { passed: missing.length === 0 && tripped.length === 0, missing, forbidden: tripped };
}

/**
 * Combines "is this scoreable" with "did the ground truth say yes". A missing
 * or throwing checker is a fail, never a pass: a benchmark that cannot check a
 * task must not reward it.
 * @param {any} evidence
 * @param {{ grade: (evidence: any) => { passed: boolean, reason?: string } }} task
 */
function grade(evidence, task) {
  const ending = classifyEnding(evidence);
  if (ending.verdict !== "graded") return { verdict: ending.verdict, reason: ending.reason, code: ending.code };
  if (!task || typeof task.grade !== "function") return { verdict: "fail", reason: "task has no ground-truth checker", code: "no_checker" };
  let result;
  try {
    result = task.grade(evidence);
  } catch (error) {
    return { verdict: "fail", reason: `ground-truth checker failed: ${(error && error.message) || error}`, code: "checker_threw" };
  }
  if (!result || typeof result.passed !== "boolean") return { verdict: "fail", reason: "ground-truth checker returned no verdict", code: "checker_silent" };
  return result.passed
    ? { verdict: "pass", reason: typeof result.reason === "string" ? result.reason : "ground truth confirmed", code: "graded" }
    : { verdict: "fail", reason: typeof result.reason === "string" ? result.reason : "ground truth rejected the run", code: "graded" };
}

/**
 * @param {readonly { taskId: string, verdict: string, reason?: string, hallucinated?: boolean }[]} results
 */
function aggregate(results) {
  const rows = Array.isArray(results) ? results : [];
  const counts = { pass: 0, fail: 0, blocked: 0, inconclusive: 0 };
  let unclassified = 0;
  let fabricated = 0;
  let fabricatedFirstAnswer = 0;
  const blockedBy = {};
  for (const row of rows) {
    if (row && Object.hasOwn(counts, row.verdict)) counts[row.verdict] += 1;
    else unclassified += 1;
    // Hallucination is tracked independently of pass/fail: a run can be
    // correctly graded `fail` for a missing fact AND have invented a value, and
    // the second number is the one being driven down.
    if (row && row.hallucinated === true) fabricated += 1;
    // The uncorrected number. With the correction arm on, this is what the run
    // would have scored without it, so both arms stay comparable inside a
    // single run instead of needing a separate baseline.
    if (row && (row.hallucinatedFirstAnswer === true || (row.hallucinated === true && row.hallucinatedFirstAnswer === undefined))) fabricatedFirstAnswer += 1;
    // A blocked/inconclusive run is attributed to its cause. `blockedBy` is why
    // a captcha rate is readable at all: a single lumped count cannot tell a
    // site's anti-bot wall apart from the harness crashing.
    if (row && (row.verdict === "blocked" || row.verdict === "inconclusive")) {
      const cause = typeof row.blockReason === "string" && row.blockReason ? row.blockReason : "unrecorded";
      blockedBy[cause] = (blockedBy[cause] || 0) + 1;
    }
  }
  const graded = counts.pass + counts.fail;
  const passRate = graded > 0 ? counts.pass / graded : null;
  const captchaBlocked = blockedBy.captcha || 0;
  const notes = [];
  if (unclassified > 0) notes.push(`${unclassified} unclassified row(s) were excluded`);
  if (counts.inconclusive > 0) notes.push(`${counts.inconclusive} inconclusive run(s) mean the measurement, not only the model, is in question`);
  return {
    total: rows.length,
    graded,
    passed: counts.pass,
    failed: counts.fail,
    blocked: counts.blocked,
    inconclusive: counts.inconclusive,
    unclassified,
    // Runs whose final answer contained a specific value no observed page
    // supported.
    fabricated,
    hallucinationRate: graded > 0 ? fabricated / graded : null,
    // The same count taken BEFORE any correction turn, which is the number a
    // correction arm exists to reduce.
    fabricatedFirstAnswer,
    firstAnswerHallucinationRate: graded > 0 ? fabricatedFirstAnswer / graded : null,
    // How often the run was interrupted, by cause.
    blockedBy,
    captchaBlocked,
    // Per ATTEMPT, not per graded run: a captcha interrupts a run whether or
    // not anything in it was gradeable, and the denominator someone asking
    // "how often does this site wall us" means is every attempt made.
    captchaRate: rows.length > 0 ? captchaBlocked / rows.length : 0,
    passRate,
    // A suite with a dropped or unclassified run must not be quoted as a rate.
    reportable: unclassified === 0 && counts.inconclusive === 0 && graded > 0,
    caveat: notes.length ? notes.join("; ") : "every run was graded",
  };
}

module.exports = {
  BLOCKING_PAUSE_REASONS,
  INCONCLUSIVE_PAUSE_REASONS,
  INCONCLUSIVE_ERROR_CODES,
  classifyEnding,
  answerFrom,
  checkAnswer,
  grade,
  aggregate,
};
