"use strict";

// How a run ENDED, kept strictly separate from whether the TASK was done.
// CommonJS with JSDoc types, matching integration/online-mind2web-pilot.ts:
// a .ts file that Node loads directly under type stripping.
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
// Nothing in this file talks to a browser, a model or a network.

export type Verdict = "pass" | "fail" | "blocked" | "inconclusive";

// The environment refused the run, so the planner never got a fair shot.
// Excluded from the denominator and counted separately -- charging the model
// for a Cloudflare interstitial measures the internet, not the harness.
export const BLOCKING_PAUSE_REASONS: ReadonlySet<string> = new Set(["captcha"]);

// The harness itself lost the thread. Also excluded, but reported, because a
// suite full of these means the measurement is broken rather than the model
// being wrong.
export const INCONCLUSIVE_PAUSE_REASONS: ReadonlySet<string> = new Set([
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

export const INCONCLUSIVE_ERROR_CODES: ReadonlySet<string> = new Set([
  "pilot_error",
  "observation_failed",
  "stale_document",
  "browser_unavailable",
  "disposed",
]);

export type EndingEvidence = {
  ending: string;
  pauseReason: string | null;
  needUserReason?: string | null;
  timedOut?: boolean;
  errorCode?: string | null;
  finalHttpStatus?: number | null;
  [key: string]: unknown;
};

export type ClassifiedEnding = { verdict: "graded" | Verdict; reason: string };

export type AnswerSpec = {
  required: readonly (string | RegExp)[];
  forbidden?: readonly (string | RegExp)[];
};

export type CheckedAnswer = {
  passed: boolean;
  missing: (string | RegExp)[];
  forbidden: (string | RegExp)[];
};

export type GradedVerdict = { verdict: Verdict; reason: string };

// Decides only whether the run is scoreable. Deliberately says nothing about
// whether the task was accomplished.
export function classifyEnding(evidence: EndingEvidence): ClassifiedEnding {
  if (evidence.timedOut) return { verdict: "inconclusive", reason: "run hit the time limit" };
  if (typeof evidence.errorCode === "string" && INCONCLUSIVE_ERROR_CODES.has(evidence.errorCode)) {
    return { verdict: "inconclusive", reason: `error code ${evidence.errorCode}` };
  }
  if (evidence.pauseReason && INCONCLUSIVE_PAUSE_REASONS.has(evidence.pauseReason)) {
    return { verdict: "inconclusive", reason: `paused on ${evidence.pauseReason}` };
  }
  // An access-denied answer is a blocked site, not a wrong answer. The reason
  // text a planner writes when it hits a 403 usually quotes the status, so the
  // status wins over any optimism in the prose.
  if (typeof evidence.finalHttpStatus === "number" && evidence.finalHttpStatus >= 400) {
    return { verdict: "blocked", reason: `final page returned HTTP ${evidence.finalHttpStatus}` };
  }
  if (evidence.pauseReason && BLOCKING_PAUSE_REASONS.has(evidence.pauseReason)) {
    return { verdict: "blocked", reason: `site required human verification (${evidence.pauseReason})` };
  }
  return { verdict: "graded", reason: "run is scoreable" };
}

// The planner's answer, from whichever channel carried it. A `need_user`
// reason is the answer for an information task, not a request for help: the
// harness has no human to answer, and the pilot's 2-of-5 real successes both
// arrived here.
export function answerFrom(evidence: EndingEvidence): string {
  const reason = evidence.needUserReason;
  return typeof reason === "string" ? reason : "";
}

// Runs of whitespace and the space between words are how a model's phrasing
// drifts from the fixture's; case and spacing are not content. Everything
// else is left alone so a wrong model name still fails.
const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, " ");

function matches(needle: string | RegExp, haystack: string): boolean {
  if (typeof needle === "string") return squash(haystack).includes(squash(needle));
  // A caller-supplied global regexp keeps lastIndex between calls; reset it so
  // repeated grading of the same answer stays deterministic.
  needle.lastIndex = 0;
  return needle.test(haystack);
}

export function checkAnswer(answer: string, spec: AnswerSpec): CheckedAnswer {
  const text = typeof answer === "string" ? answer : "";
  const required = Array.isArray(spec?.required) ? spec.required : [];
  const forbidden = Array.isArray(spec?.forbidden) ? spec.forbidden : [];
  const missing = required.filter((needle) => !matches(needle, text));
  const tripped = forbidden.filter((needle) => matches(needle, text));
  return { passed: missing.length === 0 && tripped.length === 0, missing, forbidden: tripped };
}

export type GradedTask = { grade: (evidence: EndingEvidence) => { passed: boolean; reason?: string } };

// Combines "is this scoreable" with "did the ground truth say yes". Any
// missing or throwing checker is a fail, never a pass: a benchmark that
// cannot check a task must not reward it.
export function grade(evidence: EndingEvidence, task: GradedTask): GradedVerdict {
  const ending = classifyEnding(evidence);
  if (ending.verdict !== "graded") return { verdict: ending.verdict, reason: ending.reason };
  if (!task || typeof task.grade !== "function") return { verdict: "fail", reason: "task has no ground-truth checker" };
  let result;
  try {
    result = task.grade(evidence);
  } catch (error) {
    return { verdict: "fail", reason: `ground-truth checker failed: ${(error as Error)?.message ?? error}` };
  }
  if (!result || typeof result.passed !== "boolean") return { verdict: "fail", reason: "ground-truth checker returned no verdict" };
  return result.passed
    ? { verdict: "pass", reason: typeof result.reason === "string" ? result.reason : "ground truth confirmed" }
    : { verdict: "fail", reason: typeof result.reason === "string" ? result.reason : "ground truth rejected the run" };
}

export type ResultRow = { taskId: string; verdict: string; reason?: string };

export type Summary = {
  total: number;
  graded: number;
  passed: number;
  failed: number;
  blocked: number;
  inconclusive: number;
  unclassified: number;
  passRate: number | null;
  // A suite with a dropped or unclassified run must not be quoted as a rate.
  reportable: boolean;
  caveat: string;
};

const COUNTS: Record<Verdict, number> = { pass: 0, fail: 0, blocked: 0, inconclusive: 0 };

export function aggregate(results: readonly ResultRow[]): Summary {
  const rows = Array.isArray(results) ? results : [];
  const counts = { ...COUNTS };
  let unclassified = 0;
  for (const row of rows) {
    if (row && Object.hasOwn(counts, row.verdict)) counts[row.verdict as Verdict] += 1;
    else unclassified += 1;
  }
  const graded = counts.pass + counts.fail;
  const passRate = graded > 0 ? counts.pass / graded : null;
  const notes: string[] = [];
  if (unclassified > 0) notes.push(`${unclassified} unclassified row(s) were excluded`);
  if (counts.inconclusive > 0) notes.push(`${counts.inconclusive} inconclusive run(s) mean the measurement, not only the model, is in question`);
  const reportable = unclassified === 0 && counts.inconclusive === 0 && graded > 0;
  return {
    total: rows.length,
    graded,
    passed: counts.pass,
    failed: counts.fail,
    blocked: counts.blocked,
    inconclusive: counts.inconclusive,
    unclassified,
    passRate,
    reportable,
    caveat: notes.length ? `${notes.join("; ")}` : "every run was graded",
  };
}
