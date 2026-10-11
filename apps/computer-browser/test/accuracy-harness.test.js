"use strict";

// The harness itself: it must drive a real planner over a real browser and
// grade the result against the fixture, and it must survive the planner
// answering correctly through need_user -- the channel the 2026-10-07 pilot
// scored as failure in 2 of 5 tasks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { runAccuracySuite, resumeRows } = require("../integration/accuracy/run-suite.ts");


// A planner that reaches the goal by a scripted route, so the harness's own
// plumbing is what is under test. Model quality is measured separately, with a
// real planner; this proves the measurement does not invent failures.
// `text` is the observation's free-text channel PLUS every element name. Both
// are needed: browser-adapter.js deliberately leaves a leaf's copy out of
// `observation.text` when its accessible name already carries it, so a planner
// matching only on `observation.text` sees an empty page.
function scriptedPlanner(script) {
  return {
    close() {},
    async next(context) {
      const observation = context.observation || {};
      const text = [observation.text || "", ...(observation.elements || []).map((item) => item.name || "")].join("\n");
      const base = {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: observation.id || "fixture-observation",
        criterionIds: (context.goal?.criteria || []).map((criterion) => criterion.id),
      };
      const step = script({ observation, text, context });
      if (!step) return { ...base, kind: "need_user", reason: "no scripted step applies" };
      return { ...base, ...step };
    },
  };
}

const READ_ONLY = { decision: "allow", reasons: ["accuracy_fixture_scope"] };

// Chromium startup dominates the runtime here, so every suite in this file
// borrows one browser. The suite closes only the page targets it opens.
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host.js");
let sharedBrowser = null;
async function browser() {
  // Same reason as CDP_STARTUP_TIMEOUT_MS in the harness: a loaded machine
  // must not be reported as a task failure.
  if (!sharedBrowser) sharedBrowser = await acquireCdpBrowser({ headless: true, startupTimeoutMs: 120_000 });
  return sharedBrowser;
}
test.after(async () => { await sharedBrowser?.close?.().catch(() => {}); sharedBrowser = null; });

test("the harness scores a retrieval task correct when the answer arrives via need_user", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => scriptedPlanner(({ observation, text }) => {
      if (/11-inch/.test(text)) return { kind: "need_user", reason: "The chip is M4, the display is 11-inch and memory is 16GB." };
      const specs = (observation.elements || []).find((item) => /specifications/i.test(item.name || ""));
      return specs ? { kind: "actions", actions: [{ type: "follow_link", elementId: specs.elementId }] }
        : { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
    }),
    approve: async () => READ_ONLY,
  });

  const row = run.rows.find((item) => item.taskId === "specs-retrieval");
  assert.equal(row.verdict, "pass", JSON.stringify(row));
  assert.equal(row.summary.reportable, true);
  assert.equal(row.summary.passRate, 1);
});

test("the harness scores a confident but wrong answer as a fail, not a pass", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => scriptedPlanner(({ text }) => {
      if (/11-inch/.test(text)) return { kind: "need_user", reason: "It is an M5 Pro with 32GB." };
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows.find((item) => item.taskId === "specs-retrieval");
  assert.equal(row.verdict, "fail", JSON.stringify(row));
  // A wrong answer is the most useful thing the run produced: it is what a
  // reviewer reads to decide whether the model was wrong or the checker was.
  assert.match(row.answer, /M5/, "the wrong answer must still be preserved as evidence");
  assert.equal(row.pauseReason, "need_user");
});

test("the harness reads the server log, so a planner that only claims to have submitted fails", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["store-mutation"],
    plannerFactory: () => scriptedPlanner(({ observation, text }) => {
      if (/Home store set/.test(text)) return { kind: "finish", evidenceIds: [] };
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/store" }] };
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows.find((item) => item.taskId === "store-mutation");
  assert.equal(row.verdict, "fail");
  assert.match(row.reason, /never received/);
});

test("a value copied from the task's own prompt is not a hallucination", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["store-mutation"],
    plannerFactory: () => scriptedPlanner(({ observation, text }) => {
      if (/Home store set/.test(text)) return { kind: "need_user", reason: "Please confirm that zip code 90028 has been set as your home store." };
      if (/Home store/.test(text)) {
        const submit = (observation.elements || []).find((item) => /set home store|submit/i.test(item.name || ""));
        return submit ? { kind: "actions", actions: [{ type: "submit_form", elementId: submit.elementId }] } : { kind: "actions", actions: [{ type: "observe" }] };
      }
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/store" }] };
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows.find((item) => item.taskId === "store-mutation");
  assert.equal(row.hallucinated, false, JSON.stringify(row.unsupported));
  assert.equal(row.hallucinatedFirstAnswer, false);
  assert.equal(row.corrections, 0);
  assert.equal(row.verdict, "pass", row.reason);
});

test("the harness records a real 403 as blocked instead of a model failure", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["denied-page"],
    includeControl: true,
    plannerFactory: () => scriptedPlanner(({ text }) => {
      if (/Access Denied/.test(text)) return { kind: "need_user", reason: "The page says Access Denied." };
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/denied" }] };
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows.find((item) => item.taskId === "denied-page");
  assert.equal(row.verdict, "blocked");
  assert.match(row.reason, /403/);
  // Blocked runs leave the denominator entirely.
  assert.equal(row.summary.graded, 0);
  assert.equal(row.summary.passRate, null);
  assert.equal(row.summary.reportable, false);
});

test("a planner crash is inconclusive and makes the suite unreportable", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => ({
      close() {},
      async next() { throw Object.assign(new Error("provider refused"), { code: "planner_unavailable" }); },
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows.find((item) => item.taskId === "specs-retrieval");
  assert.equal(row.verdict, "inconclusive");
  assert.equal(row.summary.reportable, false);
  assert.match(row.summary.caveat, /inconclusive/);
});

test("an unknown task id is refused before any browser is launched", async () => {
  await assert.rejects(
    runAccuracySuite({ taskIds: ["no-such-task"], plannerFactory: () => { throw new Error("must not be called"); }, approve: async () => READ_ONLY }),
    /unknown_task/,
  );
});

test("a suite is refused outright when a task carries no checker", async () => {
  // Simulates the mistake this guards: adding a task and forgetting the
  // ground truth. It must fail loudly here, not score as a free pass later.
  const tasks = require("../fixtures/accuracy-site.js").ACCURACY_TASKS;
  const uncheckable = tasks.find((task) => typeof task.grade !== "function");
  assert.equal(uncheckable, undefined, "every shipped task must have a checker");
  await assert.rejects(
    runAccuracySuite({ taskIds: ["denied-page"], plannerFactory: () => scriptedPlanner(() => null), approve: async () => READ_ONLY }),
    /unknown_task/,
    "the blocked control task must not be runnable as a scoring task",
  );
});

// The two checks that need a real browser and a real 404: a decoy page the
// model must NOT read, and a page that does not exist at all. Both are the
// shapes the pilot could not measure -- near-identical product pages, and a
// site that refused us.
test("the harness passes a planner that reads the right page and reports an absent one honestly", async (t) => {
  const honest = (task) => scriptedPlanner(({ text, observation }) => {
    // The two tasks need different routes; the planner is told which it is on.
    if (task.taskId === "missing-page-honesty") {
      if (/next-generation/.test(observation.url || "")) return { kind: "need_user", reason: "That page does not exist; I could not find it." };
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs/next-generation" }] };
    }
    if (/11-inch/.test(text)) return { kind: "need_user", reason: "The chip is M4, the display is 11-inch, memory is 16GB." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval", "missing-page-honesty"],
    plannerFactory: honest,
    approve: async () => READ_ONLY,
  });
  const byId = new Map(run.rows.map((row) => [row.taskId, row]));
  assert.equal(byId.get("specs-retrieval").verdict, "pass", JSON.stringify(byId.get("specs-retrieval")));
  const missing = byId.get("missing-page-honesty");
  assert.equal(missing.verdict, "pass", JSON.stringify(missing));
  // The 404 must be gradeable, not swept into the blocked bucket.
  assert.equal(run.summary.blocked, 0, JSON.stringify(run.summary));
  assert.equal(run.summary.reportable, true);
});

test("the harness fails a planner that reads the decoy and invents a value for a missing page", async (t) => {
  const careless = (task) => scriptedPlanner(({ text, observation }) => {
    if (task.taskId === "missing-page-honesty") {
      if (/next-generation/.test(observation.url || "")) return { kind: "need_user", reason: "The chip is M5, display 13-inch, memory 32GB." };
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs/next-generation" }] };
    }
    // The archived page states M1 / 13-inch / 8GB -- real values from the site.
    if (/13-inch/.test(text)) return { kind: "need_user", reason: "The chip is M1, display 13-inch, memory 8GB." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs/archive" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval", "missing-page-honesty"],
    plannerFactory: careless,
    approve: async () => READ_ONLY,
  });
  const byId = new Map(run.rows.map((row) => [row.taskId, row]));
  assert.equal(byId.get("specs-retrieval").verdict, "fail", "reading the archive must not pass the current-spec task");
  assert.equal(byId.get("missing-page-honesty").verdict, "fail", "inventing a chip must not pass the missing-page task");
  assert.equal(run.summary.passRate, 0);
});

// The hallucination check, end to end. The answer names every required fact
// correctly and trips no forbidden entry: only grounding can catch it. This is
// the case the pilot could not see, and the reason the harness now keeps a
// corpus of what the planner was shown.
test("an answer that is right but invents an extra value is a fail, not a pass", async (t) => {
  const overclaiming = scriptedPlanner(({ observation }) => {
    if (/specs/.test(observation.url || "")) {
      // Required facts present; forbidden list untouched; "24GB" is on no page.
      return { kind: "need_user", reason: "The chip is M4, display 11-inch, memory 16GB, and the cache is 24GB." };
    }
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => overclaiming,
    approve: async () => READ_ONLY,
  });
  const row = run.rows[0];
  assert.equal(row.verdict, "fail", JSON.stringify(row));
  assert.match(row.reason, /no page it read contained/);
  assert.equal(row.hallucinated, true);
  assert.deepEqual(row.unsupported, ["24gb"]);
  // The suite-level hallucination number is reported next to the pass rate.
  assert.equal(run.summary.fabricated, 1);
  assert.equal(run.summary.hallucinationRate, 1);
  assert.equal(run.summary.passRate, 0);
});

test("a claim copied from a page the planner actually read is not a hallucination", async (t) => {
  const faithful = scriptedPlanner(({ text, observation }) => {
    if (/specs/.test(observation.url || "")) return { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB." };
    void text;
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => faithful,
    approve: async () => READ_ONLY,
  });
  assert.equal(run.rows[0].verdict, "pass", JSON.stringify(run.rows[0]));
  assert.equal(run.summary.fabricated, 0);
  assert.equal(run.summary.hallucinationRate, 0);
});

test("an honest abstention on the missing page is neither a pass nor a hallucination", async (t) => {
  const honest = scriptedPlanner(({ observation }) => {
    if (/next-generation/.test(observation.url || "")) return { kind: "need_user", reason: "That page was not found, so there is nothing to report." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs/next-generation" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["missing-page-honesty"],
    plannerFactory: () => honest,
    approve: async () => READ_ONLY,
  });
  assert.equal(run.rows[0].verdict, "pass", JSON.stringify(run.rows[0]));
  assert.equal(run.rows[0].hallucinated, false);
  assert.equal(run.summary.fabricated, 0);
});

// The correction turn: detector says "you stated a value no page you read
// supported", harness sends it back, planner tries again. This is the only
// place the harness changes the run's trajectory rather than just grading it,
// so the tests pin both what it fixes and what it must not launder.
test("a fabricated value can be corrected within the turn budget", async (t) => {
  let correctionText = null;
  const correctable = scriptedPlanner(({ observation, context }) => {
    const amendments = context.goal?.amendments || [];
    if (amendments.length > 0) correctionText = amendments.map((item) => item.text).join("\n");
    if (/specs/.test(observation.url || "")) {
      return amendments.length > 0
        ? { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB." }
        : { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB, cache 24GB." };
    }
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => correctable,
    approve: async () => READ_ONLY,
  });
  const row = run.rows[0];
  assert.equal(row.verdict, "pass", JSON.stringify(row));
  assert.equal(row.corrections, 1);
  // The hallucination was real and then fixed -- both numbers survive.
  assert.equal(row.hallucinatedFirstAnswer, true);
  assert.equal(row.hallucinated, false);
  assert.deepEqual(row.unsupported, []);
  assert.match(correctionText, /24gb/i, "the planner must be told which value was unsupported");
  assert.equal(run.summary.fabricated, 0);
  assert.equal(run.summary.fabricatedFirstAnswer, 1);
});

// The laundering check. The correction message names the fabricated value, so
// if that message entered the grounding corpus the planner could cite the
// harness's own words back and be scored as grounded. It must not, and a
// planner that ignores the correction must still fail on the same value.
test("the correction message is not evidence, so repeating the fabrication still fails", async (t) => {
  let correctionText = null;
  const stubborn = scriptedPlanner(({ observation, context }) => {
    const amendments = context.goal?.amendments || [];
    if (amendments.length > 0) correctionText = amendments.map((item) => item.text).join("\n");
    if (/specs/.test(observation.url || "")) return { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB, cache 24GB." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => stubborn,
    approve: async () => READ_ONLY,
  });
  const row = run.rows[0];
  assert.equal(row.verdict, "fail", JSON.stringify(row));
  assert.equal(row.corrections, 1, "the budget is one correction by default");
  assert.equal(row.hallucinated, true);
  assert.deepEqual(row.unsupported, ["24gb"], "the correction text must not have grounded the value it named");
  assert.match(correctionText, /24gb/i);
  assert.equal(run.summary.fabricated, 1);
});

test("with the correction arm switched off the first answer is simply graded", async (t) => {
  const overclaiming = scriptedPlanner(({ observation }) => {
    if (/specs/.test(observation.url || "")) return { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB, cache 24GB." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => overclaiming,
    approve: async () => READ_ONLY,
    groundingCorrections: 0,
  });
  const row = run.rows[0];
  assert.equal(row.corrections, 0);
  assert.equal(row.verdict, "fail");
  assert.equal(row.hallucinatedFirstAnswer, true);
  assert.equal(run.summary.fabricatedFirstAnswer, 1);
  assert.equal(run.summary.fabricated, 1);
});

test("a correction is only sent when there is something to correct", async (t) => {
  let amendmentsSeen = 0;
  const faithful = scriptedPlanner(({ observation, context }) => {
    amendmentsSeen = (context.goal?.amendments || []).length;
    if (/specs/.test(observation.url || "")) return { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB." };
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => faithful,
    approve: async () => READ_ONLY,
  });
  assert.equal(run.rows[0].verdict, "pass");
  assert.equal(run.rows[0].corrections, 0);
  assert.equal(amendmentsSeen, 0, "a grounded answer must not trigger a goal amendment");
});

// Captcha end to end. The pauseReason a real controller produces has to become
// a readable number, and it must not be charged to the model as a failure.
test("a real anti-bot challenge is blocked with a captcha cause and its own rate", async (t) => {
  const challenged = scriptedPlanner(({ observation }) => {
    if (/\/challenge/.test(observation.url || "")) {
      // The controller gives one chance per origin to leave; on a single-origin
      // fixture the only remaining move keeps it on that origin, which is what
      // hands the task to the person.
      return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] };
    }
    return { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/challenge" }] };
  });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["captcha-page"],
    includeControl: true,
    plannerFactory: () => challenged,
    approve: async () => READ_ONLY,
  });
  const row = run.rows[0];
  assert.equal(row.verdict, "blocked", JSON.stringify(row));
  assert.equal(row.blockReason, "captcha", "the cause must be readable, not buried in prose");
  assert.match(row.reason, /human verification/i);
  // Blocked is not failed: the model never got a fair shot.
  assert.equal(run.summary.failed, 0);
  assert.equal(run.summary.blocked, 1);
  assert.deepEqual(run.summary.blockedBy, { captcha: 1 });
  assert.equal(run.summary.captchaBlocked, 1);
  assert.equal(run.summary.captchaRate, 1);
});

// The counterpart: a site that never challenges anyone must report a zero
// captcha rate rather than leaving the field out.
test("a run that meets no challenge reports a zero captcha rate", async (t) => {
  const clean = scriptedPlanner(({ text }) =>
    /11-inch/.test(text)
      ? { kind: "need_user", reason: "Chip M4, display 11-inch, memory 16GB." }
      : { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] });
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => clean,
    approve: async () => READ_ONLY,
  });
  assert.equal(run.summary.captchaRate, 0);
  assert.equal(run.summary.captchaBlocked, 0);
  assert.deepEqual(run.summary.blockedBy, {});
});

test("resuming skips tasks already recorded and keeps their verdicts", async () => {
  const first = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval"],
    plannerFactory: () => scriptedPlanner(({ text }) =>
      /11-inch/.test(text)
        ? { kind: "need_user", reason: "M4, 11-inch, 16GB." }
        : { kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] }),
    approve: async () => READ_ONLY,
  });
  assert.equal(first.rows[0].verdict, "pass");

  let launched = 0;
  const second = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["specs-retrieval", "walkthrough-navigation"],
    resumeFrom: first.rows,
    plannerFactory: () => { launched += 1; return scriptedPlanner(({ observation }) => ({ kind: "actions", actions: [{ type: "navigate", url: "__SITE__/specs" }] })); },
    approve: async () => READ_ONLY,
  });
  assert.equal(launched, 1, "the already-recorded task must not be re-run");
  assert.deepEqual(second.rows.map((row) => row.taskId).sort(), ["specs-retrieval", "walkthrough-navigation"]);
  assert.equal(second.rows.find((row) => row.taskId === "specs-retrieval").verdict, "pass");
});

test("resumeRows keeps only rows this harness wrote, so a foreign file cannot fake a resume", () => {
  const rows = resumeRows([
    { schemaVersion: 1, harness: "halo-accuracy", taskId: "a", verdict: "pass" },
    { schemaVersion: 1, harness: "something-else", taskId: "b", verdict: "pass" },
    { taskId: "c", verdict: "pass" },
    "not an object",
    null,
  ]);
  assert.deepEqual(rows.map((row) => row.taskId), ["a"]);
});

test("the suite reports per-task planner calls and page requests, not just a rate", async (t) => {
  const run = await runAccuracySuite({
    browser: await browser(),
    taskIds: ["walkthrough-navigation"],
    plannerFactory: () => scriptedPlanner(({ observation }) => {
      const next = (observation.elements || []).find((item) => item.role === "link" && /Chapter 2/.test(item.name || ""));
      if (next) return { kind: "actions", actions: [{ type: "follow_link", elementId: next.elementId }] };
      if (/\/walkthrough\/2/.test(observation.url || "")) return { kind: "finish", evidenceIds: [] };
      return { kind: "need_user", reason: "stuck" };
    }),
    approve: async () => READ_ONLY,
  });
  const row = run.rows[0];
  assert.equal(row.verdict, "pass", JSON.stringify(row));
  assert.ok(row.plannerCalls >= 2, `expected several planner turns, got ${row.plannerCalls}`);
  assert.ok(row.pageRequests >= 2, `expected the chain to be walked, got ${row.pageRequests}`);
});
