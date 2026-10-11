"use strict";

// Runs the accuracy suite against a real browser and a real planner, and
// reports a pass rate computed from ground truth.
//
// Why this exists: the 2026-10-07 Online-Mind2Web pilot produced no usable
// number. All five runs were written with `graded:false, success:null`, grading
// was a human reading `manual-review.md`, and that manual pass found 2 of the 3
// recorded non-successes had actually been answered correctly. Two of the
// remaining failures were a Cloudflare interstitial and an HTTP 403 --
// conditions no harness work can fix, but which were charged to the model.
//
// This module fixes the accounting, and only the accounting:
//   - ground truth comes from the fixture server, never from the planner
//   - a `need_user` pause carries the planner's answer, and is graded as one
//   - captcha and 4xx/5xx land in `blocked`, out of the denominator
//   - timeouts and crashes land in `inconclusive`, and make the suite
//     `reportable: false` so a rate cannot be quoted off a broken run
//
// Determinism and safety: loopback fixture only, one task at a time, a fresh
// private store per task, an explicit allow-only approver, and no model
// credentials handled here -- the planner is injected by the caller.
//
//   node --test test/accuracy-harness.test.js   # scripted planner, no model
//
// A real planner is deliberately not defaulted in: injecting one lets the
// measurement plumbing be exercised without a model, and keeps the model
// choice a caller decision rather than a value baked into a benchmark.

// CommonJS with JSDoc types, like integration/online-mind2web-pilot.ts. An
// ESM `export` here would make Node load this .ts as an ES module, where
// `require` is not defined and the file fails at load time.
//
// The harness modules it drives are untyped CommonJS, so they are required
// lazily. That keeps this file out of any emitted build cohort and out of the
// typecheck projects, which only cover runtime-src/.
//
// @typedef {{ next: (context: any, options?: any) => Promise<any>,
//             close?: () => any, warm?: () => Promise<any> }} Planner
// @typedef {{ taskId: string, kind: string, prompt: string, startPath: string,
//             grade: (evidence: any) => { passed: boolean, reason?: string } }} Task
// @typedef {{ taskId: string, verdict: string, reason?: string }} ResultRow

const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const HARNESS_ID = "halo-accuracy";
const DEFAULT_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 800 };

// Chromium on this machine needs 5-30s for the first CDP handshake and for
// Page.enable, and longer still when a regression suite is loading the box
// alongside it. The 30s default in cdp-web-contents.js is a production
// deadline, not a benchmark one: raising it here costs nothing at runtime and
// keeps a loaded machine from being misreported as a task failure. The task
// timeout above is untouched and still bounds the run itself.
const CDP_COMMAND_TIMEOUT_MS = 120_000;
const CDP_STARTUP_TIMEOUT_MS = 120_000;

// A scripted planner names a site-relative path as `__SITE__/specs`; the port
// is ephemeral, so the prefix is rewritten to the fixture's real loopback URL
// before dispatch. A full replacement, not a suffix match: leaving the label in
// place produced "SPECShttp://127.0.0.1:..." and a run that silently never
// left the start page.
const SITE_PREFIX = "__SITE__";

/**
 * @typedef {object} SuiteOptions
 * @property {string[]} [taskIds]
 * @property {(task: any, site: { url: string }) => any} plannerFactory
 * @property {(descriptor: any) => Promise<any>} approve
 * @property {number} [timeoutMs]
 * @property {readonly any[]} [resumeFrom]
 * @property {boolean} [includeControl]
 * @property {boolean} [headless]
 * @property {number} [groundingCorrections] how many times a run whose answer
 *   contained an unsupported value is sent back to the planner before it is
 *   graded as-is. Defaults to 1; 0 measures the raw, uncorrected rate.
 * @property {any} [browser] an already-running browser to reuse; launching
 *   Chromium costs tens of seconds, so a caller running several suites should
 *   launch once. The suite still closes only the page targets it opened.
 */

// The correction is delivered as a goal amendment, which is the only channel
// that puts text in front of the planner mid-run; the pilot used the same
// channel for "no user is available". The amendment contract stamps
// authority: "user", so a production build should send this over a distinct
// host channel instead of borrowing the user's voice. Recorded here so the
// seam is not forgotten.
const DEFAULT_GROUNDING_CORRECTIONS = 1;
const MAX_UNSUPPORTED_NAMED = 8;
const MAX_CORRECTION_CHARS = 900;

function correctionText(unsupported: string[]): string {
  const named = unsupported.slice(0, MAX_UNSUPPORTED_NAMED).join(", ");
  const more = unsupported.length > MAX_UNSUPPORTED_NAMED ? ` (and ${unsupported.length - MAX_UNSUPPORTED_NAMED} more)` : "";
  return (
    `Correction: your answer stated ${named}${more} -- value(s) that appeared on no page you actually read. ` +
    `Only state a value a page you observed showed you. Either go and find that value on a page, ` +
    `or give the answer without it. Do not guess.`
  ).slice(0, MAX_CORRECTION_CHARS);
}

// A previous run's rows are trusted only when this harness wrote them. A
// foreign or truncated file must not be able to mark a task as already done.
function resumeRows(rows: readonly any[] | null | undefined): any[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row === "object" && row.schemaVersion === SCHEMA_VERSION && row.harness === HARNESS_ID && typeof row.taskId === "string");
}

function selectTasks(taskIds: readonly string[] | undefined, includeControl: boolean): any[] {
  const { ACCURACY_TASKS } = require("../../fixtures/accuracy-site.js");
  const byId = new Map<string, any>(ACCURACY_TASKS.map((task: any) => [task.taskId, task]));
  if (!taskIds || taskIds.length === 0) {
    return includeControl ? [...ACCURACY_TASKS] : ACCURACY_TASKS.filter((task: any) => task.kind !== "blocked");
  }
  return taskIds.map((id: string) => {
    const task = byId.get(id);
    // Refusing beats defaulting: a typo must never silently run some other task.
    if (!task) throw new Error(`unknown_task ${id}`);
    if (task.kind === "blocked" && !includeControl) throw new Error(`unknown_task ${id} (control task; pass includeControl)`);
    return task;
  });
}

function resolveAction(action: any, siteUrl: string): any {
  if (!action || typeof action !== "object") return action;
  if (action.type === "navigate" && typeof action.url === "string" && action.url.startsWith(SITE_PREFIX)) {
    return { ...action, url: siteUrl + action.url.slice(SITE_PREFIX.length) };
  }
  return action;
}

// Runs an optional cleanup method and swallows whatever it does -- including
// returning nothing, which an optional call like `obj.close?.()` does when the
// method is a plain sync function. Without this, a clean teardown throws
// "cannot read .catch of undefined" and the run's real verdict is lost.
async function quietly(target: any, method: string): Promise<void> {
  try {
    await Promise.resolve(target?.[method]?.());
  } catch { /* teardown never changes the outcome of a completed run */ }
}

function resolveProposal(proposal: any, siteUrl: string): any {
  if (!proposal || typeof proposal !== "object" || !Array.isArray(proposal.actions)) return proposal;
  return { ...proposal, actions: proposal.actions.map((action: any) => resolveAction(action, siteUrl)) };
}

async function runOne({ task, site, options, storageRoot, launched }: any): Promise<any> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const requestsBefore = site.requestLog.length;

  let view: any;
  let browser: any;
  let store: any;
  let controller: any;
  /** @type {any} */
  let inner = null;
  let plannerCalls = 0;
  let lastUrl = null;
  let lastText = "";
  let lastHttpStatus = null;
  let timedOut = false;
  let snapshot: any = {};
  const maxCorrections = Number.isInteger(options.groundingCorrections) && options.groundingCorrections >= 0
    ? options.groundingCorrections
    : DEFAULT_GROUNDING_CORRECTIONS;
  let corrections = 0;
  let correctionError = null;
  // The first answer and its grounding, kept separately from the final ones so
  // a corrected run still reports the hallucination it started with. That is
  // the number a correction arm is supposed to move, and dropping it would
  // make the two arms impossible to compare.
  let firstAnswer: string | null = null;
  let firstUnsupported: string[] | null = null;
  // Everything the planner was shown, as canonical text. This is the corpus a
  // claim has to be grounded in; the answer itself is never added to it.
  const observed: string[] = [];
  let observedBytes = 0;
  const MAX_OBSERVED_BYTES = 512 * 1024;
  const recordObserved = (value: any) => {
    if (typeof value !== "string" || !value) return;
    if (observedBytes >= MAX_OBSERVED_BYTES) return;
    observed.push(value);
    observedBytes += Buffer.byteLength(value, "utf8");
  };
  // The task's own prompt is ground truth the planner was GIVEN, not shown: a
  // value copied from the request (e.g. the zip code to set) is not a
  // hallucination. The correction text is still never added here -- that is the
  // laundering guard the correction tests pin.
  recordObserved((task && task.prompt) || "");

  const { TaskStore } = require("../../main/harness/task-store.js");
  const { TaskController } = require("../../main/harness/task-controller.js");
  const { BrowserAdapter } = require("../../main/harness/browser-adapter.js");
  const { openCdpView } = require("../../main/harness/cdp-web-contents.js");
  const { answerFrom, grade } = require("./verdict.js");
  const { groundingReport } = require("./grounding.js");

  try {
    if (typeof options.createBrowser === "function") {
      browser = await options.createBrowser({ task, siteUrl: site.url, viewport: VIEWPORT });
    } else {
      view = await openCdpView(launched.wsUrl, { ...VIEWPORT, commandTimeoutMs: CDP_COMMAND_TIMEOUT_MS });
      browser = new BrowserAdapter({ view, navigationTimeoutMs: 20_000 });
    }

    // The host owns observation capture. Recording what the planner was
    // actually shown is what lets a reviewer trust a fail.
    const observe = browser.observe.bind(browser);
    browser.observe = async (...args: any[]) => {
      const observation = await observe(...args);
      if (observation && typeof observation === "object") {
        if (typeof observation.url === "string") lastUrl = observation.url;
        if (typeof observation.text === "string") lastText = observation.text;
        if (typeof observation.httpStatus === "number") lastHttpStatus = observation.httpStatus;
        // What the planner saw: page text, the URL it was on, and every element
        // name. A claim is grounded only if it appears among these.
        recordObserved(observation.text);
        recordObserved(observation.url);
        if (Array.isArray(observation.elements)) {
          for (const element of observation.elements) recordObserved(element?.name);
        }
      }
      return observation;
    };
    const execute = browser.execute.bind(browser);
    browser.execute = async (action: any, execOptions: any) => execute(resolveAction(action, site.url), execOptions);

    // Bootstrap: open the task's own start page. This is harness setup, not a
    // planner action -- the pilot recorded it separately as bootstrapActions for
    // the same reason. Charging the model for it would make the first turn a
    // freebie it did not ask for.
    await browser.execute({ type: "navigate", url: `${site.url}${task.startPath}` });

    store = await TaskStore.create({
      originalRequest: task.prompt,
      criteria: [{ id: "done", text: task.prompt, required: true, verification: "user" }],
      // The timeout, not the budget, is the limit. Budget exhaustion is graded
      // as a real failure; hiding it behind a timeout would launder a failure.
      limits: { maxActions: 60, maxPlannerCalls: 40, maxActiveMs: timeoutMs },
    }, { storageRoot });

    const worker = options.plannerFactory(task, { url: site.url });
    inner = worker;
    const planner = {
      warm: worker.warm ? () => worker.warm() : undefined,
      close: async () => { await worker.close?.(); },
      next: async (context: any, nextOptions: any) => {
        plannerCalls += 1;
        return resolveProposal(await worker.next(context, nextOptions), site.url);
      },
    };

    controller = new TaskController({
      store,
      planner,
      browser,
      approve: options.approve,
      // The suite grades from the fixture's request log and served pages, not
      // from the controller's own completion bookkeeping.
      hostVerifier: () => false,
      permissionMode: "full",
      harnessProfile: "middle",
      // The harness owns its own correction arm (and its 0-correction
      // baseline), so the controller's production grounding device stays off
      // here; the two layers must not correct each other's runs.
      groundingCorrections: 0,
    });

    const timer = setTimeout(() => { timedOut = true; controller.stop().catch(() => {}); }, timeoutMs);
    try {
      // start() resolves at a policy wait or a terminal state. There is no
      // human here: a need_user pause already carries the planner's answer for
      // an information task, so the run ends there and is graded.
      snapshot = await controller.start();

      // Correction turns. A need_user pause for an information task is the
      // planner's ANSWER, so an answer built on values no observed page
      // supported is sent back once with the offending values named. Nothing
      // is added to `observed` here: the correction text is harness-authored,
      // and letting it ground the next answer would be laundering.
      for (;;) {
        if (timedOut) break;
        if (!snapshot || snapshot.state !== "paused" || snapshot.pauseReason !== "need_user") break;
        const candidate = answerFrom({ needUserReason: snapshot.needUserReason ?? null });
        const report = groundingReport(candidate, observed);
        if (firstAnswer === null) {
          firstAnswer = candidate;
          firstUnsupported = report.unsupported;
        }
        if (!report.hallucinated) break;
        if (corrections >= maxCorrections) break;
        corrections += 1;
        try {
          await controller.amend({
            text: correctionText(report.unsupported),
            supersedesConstraintIds: [],
            newConstraints: [],
            newCriteria: [],
          });
          snapshot = await controller.resume();
        } catch (error) {
          // A failed correction is not the run's fault. Keep whatever answer
          // we already have and grade it rather than turning this into a
          // harness error that hides the real result.
          correctionError = (error as any)?.code ?? (error as any)?.message ?? "correction_failed";
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!snapshot || typeof snapshot !== "object") snapshot = controller.getSnapshot();
  } finally {
    // Teardown must tolerate any of these being absent, already closed, or
    // returning nothing. A cleanup throw here would be reported as a harness
    // error and hide the run's actual verdict.
    await quietly(inner, "close");
    await quietly(controller, "stop");
    await quietly(browser, "dispose");
    // Closes the page target only. The shared browser is owned by the caller.
    try {
      view?.closeConnection?.();
    } catch { /* the page is already gone */ }
    await quietly(store, "close");
  }

  const ending = String(snapshot?.state || "unknown");
  const pauseReason = snapshot?.pauseReason ?? null;
  const needUserReason = snapshot?.needUserReason ?? null;

  const answer = answerFrom({ needUserReason });
  // An HTTP status the planner saw counts as observed: an honest "the page
  // returned 404" must not be flagged as inventing the number 404.
  if (typeof lastHttpStatus === "number") recordObserved(String(lastHttpStatus));
  const grounding = groundingReport(answer, observed);
  // If a correction was made, the first answer's grounding is what the arm is
  // measured against; otherwise the first answer IS the final one.
  const firstUnsupportedResolved = firstUnsupported === null ? grounding.unsupported : firstUnsupported;
  const evidence = {
    ending,
    pauseReason,
    needUserReason,
    timedOut,
    errorCode: null,
    finalUrl: lastUrl,
    finalHttpStatus: lastHttpStatus,
    // A task whose subject IS a missing page names the status that is its
    // answer, so that one status (and only that one) does not count as blocked.
    expectedHttpStatus: task.expectedHttpStatus,
    answer,
    unsupported: grounding.unsupported,
    pageText: lastText,
    requestLog: site.requestLog.slice(requestsBefore),
    budgets: snapshot?.budgets ?? null,
  };

  const verdict = grade(evidence, { grade: (input: any) => task.grade(input) });
  return {
    schemaVersion: SCHEMA_VERSION,
    harness: HARNESS_ID,
    taskId: task.taskId,
    kind: task.kind,
    verdict: verdict.verdict,
    reason: verdict.reason,
    // The machine-readable cause, present only when the run was taken out of
    // the graded set. This is what makes a captcha rate readable instead of
    // leaving it buried in prose inside a lumped "blocked" count.
    ...(verdict.verdict === "blocked" || verdict.verdict === "inconclusive" ? { blockReason: verdict.code } : {}),
    ending,
    pauseReason,
    answer,
    // Recorded independently of the verdict: a run that is graded `fail` for a
    // missing fact can still have invented a value, and that count is the
    // number being driven down.
    hallucinated: grounding.hallucinated,
    unsupported: grounding.unsupported,
    // Correction-arm accounting. `hallucinatedFirstAnswer` is the uncorrected
    // rate, so switching the arm on never hides the raw number.
    corrections,
    hallucinatedFirstAnswer: firstUnsupportedResolved.length > 0,
    ...(correctionError ? { correctionError } : {}),
    finalUrl: lastUrl,
    plannerCalls,
    actionsUsed: Number(snapshot?.budgets?.actionsUsed ?? 0),
    pageRequests: evidence.requestLog.filter((entry: any) => entry.method === "GET").length,
    wallMs: Date.now() - startedAt,
  };
}

/**
 * Runs the suite. Returns one row per task plus a suite-level rollup.
 *
 * Every row carries that same rollup on purpose: a single row read on its own
 * would otherwise be readable as a rate.
 */
async function runAccuracySuite(options: any) {
  if (!options || typeof options.plannerFactory !== "function") throw new Error("plannerFactory is required");
  if (typeof options.approve !== "function") throw new Error("approve is required");
  const tasks = selectTasks(options.taskIds, options.includeControl === true);
  for (const task of tasks) if (typeof task.grade !== "function") throw new Error(`no_checker ${task.taskId}`);

  const { startAccuracySite } = require("../../fixtures/accuracy-site.js");
  const { acquireCdpBrowser } = require("../../main/harness/cdp-browser-host.js");
  const { aggregate } = require("./verdict.js");

  const resumed = resumeRows(options.resumeFrom ?? []);
  const site = await startAccuracySite();
  const pending = tasks.filter((task) => !resumed.some((row) => row.taskId === task.taskId));
  const rows = [];
  // Nothing to run: no browser is launched at all, so a fully resumed suite
  // costs one fixture start.
  const borrowed = Boolean(options.browser || options.createBrowser);
  let launched: any = options.browser ?? null;
  if (pending.length > 0 && !launched && typeof options.createBrowser !== "function") {
    launched = await acquireCdpBrowser({ headless: options.headless !== false, startupTimeoutMs: CDP_STARTUP_TIMEOUT_MS });
  }
  try {
    for (const task of tasks) {
      const prior = resumed.find((row) => row.taskId === task.taskId);
      if (prior) {
        // Keep the recorded verdict; the rollup below refreshes it.
        rows.push({ ...prior });
        continue;
      }
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `halo-accuracy-${task.taskId}-`));
      try {
        rows.push(await runOne({ task, site, options, storageRoot: root, launched }));
      } catch (error) {
        // A harness-level crash is inconclusive by definition. It must never be
        // allowed to look like a task failure.
        rows.push({
          schemaVersion: SCHEMA_VERSION,
          harness: HARNESS_ID,
          taskId: task.taskId,
          kind: task.kind,
          verdict: "inconclusive",
          reason: `harness error: ${(error as any)?.message ?? error}`,
          ending: "harness_error",
          pauseReason: null,
          answer: "",
          hallucinated: false,
          unsupported: [],
          corrections: 0,
          hallucinatedFirstAnswer: false,
          finalUrl: null,
          plannerCalls: 0,
          actionsUsed: 0,
          pageRequests: 0,
          wallMs: 0,
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    // A borrowed browser belongs to the caller; closing it here would tear down
    // the page targets of whatever else is still using it.
    if (!borrowed) await quietly(launched, "close");
    await quietly(site, "stop");
  }
  // One rollup across everything recorded, so every row carries the same
  // suite-level denominators and no row can be read in isolation as a rate.
  const summary = aggregate(rows);
  return { rows: rows.map((row) => ({ ...row, summary })), summary };
}

module.exports = { runAccuracySuite, resumeRows };
