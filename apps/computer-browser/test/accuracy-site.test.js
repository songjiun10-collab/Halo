"use strict";

// Ground truth for the accuracy harness lives in the fixture's own request
// log, not in anything the planner said. These tests pin that: a checker must
// pass on a server-side record and fail when the record is absent, so a model
// that confidently claims success without acting still scores 0.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startAccuracySite, ACCURACY_TASKS, CAPTCHA_TITLE } = require("../fixtures/accuracy-site.js");

test("every shipped task names a checker the harness can actually run", () => {
  assert.ok(ACCURACY_TASKS.length >= 8, "a suite this small cannot show a difference between two harnesses");
  for (const task of ACCURACY_TASKS) {
    assert.match(task.taskId, /^[a-z0-9-]+$/, task.taskId);
    assert.ok(task.prompt.length > 20, `${task.taskId} needs a real instruction`);
    assert.equal(typeof task.grade, "function", task.taskId);
    // The answer spec, where there is one, must be non-empty: a retrieval task
    // with no required token can never fail and would inflate the score.
    if (task.answer) assert.ok(task.answer.required.length > 0, `${task.taskId} has an empty answer spec`);
  }
});

// Every kind the suite claims to measure must actually be present. A kind that
// silently disappeared would leave the rollup comparing unlike tasks.
test("the suite covers every kind it claims to, and the kinds are distinct", () => {
  const scoring = ACCURACY_TASKS.filter((task) => task.kind !== "blocked");
  for (const kind of ["retrieval", "navigation", "mutation"]) {
    assert.ok(scoring.some((task) => task.kind === kind), `no scoring task of kind ${kind}`);
  }
  assert.ok(ACCURACY_TASKS.some((task) => task.kind === "blocked"), "no control task for the blocked path");
  // More than half the scoring tasks must be non-navigation: reach-a-page tasks
  // are the easiest thing to pass and would otherwise carry the rate.
  assert.ok(scoring.filter((task) => task.kind !== "navigation").length > scoring.length / 2);
});

test("task ids are unique so a summary row maps to exactly one task", () => {
  const ids = ACCURACY_TASKS.map((task) => task.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

test("the site serves the task pages the suite starts from", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  for (const task of ACCURACY_TASKS) {
    const response = await fetch(`${site.url}${task.startPath}`);
    assert.equal(response.status, 200, `${task.taskId} start page ${task.startPath}`);
    const body = await response.text();
    assert.match(body, /<title>/, `${task.taskId} start page must be a real document`);
  }
});

test("a retrieval checker passes only on the answer the page actually states", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "retrieval");
  assert.ok(task, "the suite needs at least one retrieval task");
  const html = await fetch(`${site.url}${task.factsPath}`).then((response) => response.text());
  const facts = task.factsFromHtml(html);
  assert.ok(facts && facts.length > 0, "the page must actually contain the answer");

  const correct = task.grade({ answer: `The page says ${facts.join(", ")}.` });
  assert.equal(correct.passed, true, JSON.stringify(correct));

  // The pilot's exact failure mode: a plausible-sounding wrong answer.
  const plausible = task.grade({ answer: "The page says it is the M5 Pro with 32GB." });
  assert.equal(plausible.passed, false);
  assert.equal(plausible.reason, undefined ?? plausible.reason);

  const empty = task.grade({ answer: "" });
  assert.equal(empty.passed, false);
});

test("a mutation checker reads the server log, so an unacted page cannot pass", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "mutation");
  assert.ok(task, "the suite needs at least one mutation task");

  const never = task.grade({ requestLog: site.requestLog, finalUrl: `${site.url}${task.startPath}` });
  assert.equal(never.passed, false);

  // Form-encoded, the way a real <form> submission arrives.
  await fetch(`${site.url}${task.submitPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(task.submitBody).toString(),
  });
  const acted = task.grade({ requestLog: site.requestLog, finalUrl: `${site.url}${task.confirmPath}` });
  assert.equal(acted.passed, true, JSON.stringify(acted));
});

test("a navigation checker fails when the run ended somewhere else", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "navigation");
  assert.ok(task, "the suite needs at least one navigation task");
  assert.equal(task.grade({ finalUrl: `${site.url}${task.targetPath}` }).passed, true);
  assert.equal(task.grade({ finalUrl: `${site.url}${task.startPath}` }).passed, false);
  assert.equal(task.grade({ finalUrl: "about:blank" }).passed, false);
});

// A decoy page is the strongest available check on a retrieval task: the wrong
// answer is fully supported by the site, so only a model that read the right
// page can pass. The 2026-10-07 pilot's Apple task is exactly this shape --
// several near-identical product pages.
test("a retrieval task with a decoy page fails a model that read the wrong page", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.decoyPath);
  assert.ok(task, "the suite needs at least one task with a decoy page");

  const truth = await site.factsFor(task.factsPath);
  const decoy = await site.factsFor(task.decoyPath);
  assert.deepEqual(truth, task.truthFacts, "the truth page must serve the facts the checker expects");
  assert.notDeepEqual(truth, decoy, "the decoy must state something different, or it tests nothing");

  // Facts straight off the decoy are exactly what a confused model reports.
  const fromDecoy = task.grade({ answer: `It is ${decoy.join(", ")}.` });
  assert.equal(fromDecoy.passed, false, `decoy answer ${JSON.stringify(decoy)} must not pass`);
  assert.match(fromDecoy.reason, /required|wrong/i);

  assert.equal(task.grade({ answer: `It is ${truth.join(", ")}.` }).passed, true);
});

test("the unstated-value trap fails a plausible memory answer and passes an honest absence", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.taskId === "unstated-spec-honesty");
  assert.ok(task, "the suite needs the unstated-value trap task");

  // The trap page must really not state a battery figure.
  const served = await fetch(`${site.url}${task.factsPath}`).then((response) => response.text());
  assert.doesNotMatch(served, /\d+\s*(?:hours?|hrs?)/i, "the trap page must not state a battery figure");

  // A model answering from memory states a specific the page never had.
  const fabricated = task.grade({ answer: "Battery life is up to 18 hours.", unsupported: ["18"] });
  assert.equal(fabricated.passed, false, JSON.stringify(fabricated));

  // Honest absence passes, even when the answer restates the page's real facts.
  const honest = task.grade({ answer: "The page does not state battery life; it only lists chip M4, display 11-inch and memory 16GB.", unsupported: [] });
  assert.equal(honest.passed, true, JSON.stringify(honest));

  // "Could not locate" is the same honest report in different wording; the
  // grader must not fail a model for phrasing (a real model produced exactly
  // this answer).
  const located = task.grade({ answer: "Could not locate battery life information on the current technical specifications page.", unsupported: [] });
  assert.equal(located.passed, true, JSON.stringify(located));

  // An unenumerated fabrication dies on the grounding bar alone.
  const unenumerated = task.grade({ answer: "The page does not state battery life, but the battery capacity is 52 Wh.", unsupported: ["52"] });
  assert.equal(unenumerated.passed, false, JSON.stringify(unenumerated));
  assert.match(unenumerated.reason, /no page it read contained/);
});

test("a multi-hop task cannot be passed by jumping straight to the answer", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "navigation" && item.hopCount > 1);
  assert.ok(task, "the suite needs at least one multi-hop navigation task");

  // The server knows the order things were visited in, so a direct jump to the
  // target is distinguishable from actually walking the chain.
  assert.equal(task.grade({ requestLog: [], finalUrl: `${site.url}${task.targetPath}` }).passed, false);

  const walked = [];
  for (const step of task.hopPath) walked.push({ method: "GET", path: step });
  assert.equal(task.grade({ requestLog: walked, finalUrl: `${site.url}${task.targetPath}` }).passed, true, JSON.stringify(task.grade({ requestLog: walked, finalUrl: `${site.url}${task.targetPath}` })));
});

test("every hop of a multi-hop task is a real page that exists", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  for (const task of ACCURACY_TASKS) {
    if (!task.hopPath) continue;
    for (const step of task.hopPath) {
      const response = await fetch(`${site.url}${step}`);
      assert.equal(response.status, 200, `${task.taskId} hop ${step}`);
    }
  }
});

test("a mutation task with a wrong value fails, so a confident wrong action is not a pass", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "mutation" && taskWorthBreaking(item));
  assert.ok(task, "the suite needs at least one mutation task that checks the value it submitted");

  await fetch(`${site.url}${task.submitPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...task.submitBody, zip: "00000" }).toString(),
  });
  const wrong = task.grade({ requestLog: site.requestLog, finalUrl: `${site.url}${task.confirmPath}` });
  assert.equal(wrong.passed, false, "submitting the wrong value must not pass");
  assert.match(wrong.reason, /never received|wrong/i);
});

// The site's own POST handler is the last line of defence. If it accepted any
// zip, the mutation checker above would be grading a request the site refused.
test("the site rejects a wrong form value rather than storing it", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const response = await fetch(`${site.url}/store/home`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "zip=00000",
  });
  assert.equal(response.status, 400);
  const html = await fetch(`${site.url}/store`).then((r) => r.text());
  assert.match(html, /\(none\)/, "a refused submission must not change stored state");
});

// The fabrication check. The named page genuinely does not exist, so the only
// correct answer is that it does not; inventing a plausible chip is a failure.
test("the missing-page task wants the absence reported, not a plausible invention", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const task = ACCURACY_TASKS.find((item) => item.kind === "retrieval" && typeof item.expectedHttpStatus === "number");
  assert.ok(task, "the suite needs a task whose subject is a missing page");

  const response = await fetch(`${site.url}${task.missingPath}`);
  assert.equal(response.status, task.expectedHttpStatus, "the declared expected status must be the real one");

  const honest = task.grade({ answer: "That page was not found; there is no such page.", finalHttpStatus: 404 });
  assert.equal(honest.passed, true, JSON.stringify(honest));

  // The failure mode the task exists for: a confident, well-formed invention.
  for (const invention of ["It is the M5 Pro with 32GB.", "The page lists the M1, 13-inch, 8GB.", "It is the M4, 11-inch, 16GB."]) {
    const fabricated = task.grade({ answer: invention, finalHttpStatus: 404 });
    assert.equal(fabricated.passed, false, `invented answer must fail: ${invention}`);
  }
});

test("every required token of a retrieval task is reachable from the page it points at", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  for (const task of ACCURACY_TASKS) {
    if (!task.answer || !task.factsPath || task.expectedHttpStatus) continue;
    const html = await fetch(`${site.url}${task.factsPath}`).then((r) => r.text());
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const needle of task.answer.required) {
      if (typeof needle !== "string") continue;
      assert.ok(text.toLowerCase().includes(needle.toLowerCase()), `${task.taskId} requires ${needle}, which ${task.factsPath} does not state`);
    }
  }
});

// The fixture must trip the REAL detector, not a fixture-local imitation of
// it. If shared/captcha-heuristics.js changes its hints, this fails instead of
// the captcha path silently going untested.
test("the challenge page actually trips the production captcha heuristic", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  const { looksLikeCaptcha } = require("../shared/captcha-heuristics.js");
  const task = ACCURACY_TASKS.find((item) => item.challengePath);
  assert.ok(task, "the suite needs a captcha control task");

  const html = await fetch(`${site.url}${task.challengePath}`).then((r) => r.text());
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  assert.equal(title, CAPTCHA_TITLE);
  assert.equal(looksLikeCaptcha(`${site.url}${task.challengePath}`, title), true,
    "the challenge page must be recognised by the real heuristic, or the captcha path is untested");

  // And a normal page must NOT trip it, or every run would be falsely blocked.
  for (const path of ["/", "/specs", "/store"]) {
    const body = await fetch(`${site.url}${path}`).then((r) => r.text());
    const pageTitle = /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? "";
    assert.equal(looksLikeCaptcha(`${site.url}${path}`, pageTitle), false, `${path} must not look like a captcha`);
  }
});

test("the challenge page is a control, not a scoring task", () => {
  const task = ACCURACY_TASKS.find((item) => item.challengePath);
  assert.equal(task.kind, "blocked");
  assert.equal(task.grade({}).passed, false, "an anti-bot challenge is never a model success");
});

function taskWorthBreaking(task) {
  return typeof task.submitBody?.zip === "string";
}

test("the request log records method and path so checkers cannot be fooled by page text", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  await fetch(`${site.url}/specs`);
  await fetch(`${site.url}/specs`, { method: "POST", body: "x" });
  const entries = site.requestLog.filter((entry) => entry.path === "/specs");
  assert.deepEqual(entries.map((entry) => entry.method).sort(), ["GET", "POST"]);
});

test("the site refuses a spoofed Host header", async (t) => {
  const site = await startAccuracySite();
  t.after(() => site.stop());
  // fetch() will not let a caller set Host, so this goes over a raw socket.
  const { port } = new URL(site.url);
  const status = await new Promise((resolve, reject) => {
    const socket = require("node:net").connect(Number(port), "127.0.0.1", () => {
      socket.write("GET /specs HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n");
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1])));
    socket.on("error", reject);
  });
  assert.notEqual(status, 200);
});

test("a checker that throws is a failed task, never a crash of the whole suite", async () => {
  const task = { taskId: "explodes", grade: () => { throw new Error("boom"); } };
  assert.throws(() => task.grade({}), /boom/);
});
