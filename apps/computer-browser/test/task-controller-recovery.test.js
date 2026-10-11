"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const openStores = new Set();
afterEach(async () => {
  const stores = [...openStores];
  openStores.clear();
  await Promise.all(stores.map((store) => store.close()));
});

const makeStore = async () => {
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-recover-")) });
  openStores.add(store);
  return store;
};
const make = async (planner, browser, extra = {}) => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner, browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1, ...extra });
  return { controller, store };
};
const actions = (context, action) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [], kind: "actions", actions: [action] });
const page = (n) => ({ id: `o${n}`, url: "https://page.test/list", text: `t${n}`, elements: [] });
test("a planner failure is retried automatically and the task carries on", async () => {
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    if (calls <= 2) throw new Error("transport hiccup");
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done here" };
  } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(calls, 3);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("need_user answer keeps the full validated 2000-character reason for the person", async () => {
  const reason = "A".repeat(1800);
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion,
    basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason }) };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(snapshot.needUserReason, reason);
});

test("recovery is bounded: a planner that always fails still pauses as planner_error", async () => {
  let calls = 0;
  const planner = { next: async () => { calls += 1; throw new Error("down"); } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 3, "first call plus two recoveries");
});

test("maxRecoveries: 0 turns recovery off", async () => {
  let calls = 0;
  const planner = { next: async () => { calls += 1; throw new Error("down"); } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) }, { maxRecoveries: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 1);
});

test("an observation failure is re-observed once before pausing", async () => {
  let n = 0;
  const browser = { supportsAction: () => true, observe: async () => { n += 1; if (n === 1) throw Object.assign(new Error("boom"), { code: "observe_failed" }); return page(n); }, execute: async () => ({ status: "ok" }) };
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "ask" }) };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(n, 2);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("a page loop is warned about and given another chance before pausing", async () => {
  const warnings = [];
  let n = 0;
  const planner = { next: async (context) => { warnings.push(context.progress.loopWarning === true); return actions(context, { type: "observe" }); } };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return page(n); }, execute: async () => ({ status: "ok" }) };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "no_progress");
  assert.ok(warnings.includes(true), "planner never saw loopWarning");
  assert.ok(warnings.length > 12, `paused without recovering after ${warnings.length} turns`);
});

test("need_user is never auto-recovered", async () => {
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "hi" }; } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(calls, 1);
  assert.equal(snapshot.pauseReason, "need_user");
});

test("recovery policy caps per reason and overall", () => {
  const { createRecoveryPolicy } = require("../main/harness/recovery-policy");
  const policy = createRecoveryPolicy(3);
  assert.deepEqual(policy.tryConsume("a"), { attempt: 1, total: 1 });
  assert.deepEqual(policy.tryConsume("a"), { attempt: 2, total: 2 });
  assert.equal(policy.tryConsume("a"), null, "per-reason cap of two");
  assert.deepEqual(policy.tryConsume("b"), { attempt: 1, total: 3 });
  assert.equal(policy.tryConsume("c"), null, "overall cap");
  assert.equal(createRecoveryPolicy(0).tryConsume("a"), null);
});

test("recovery feedback includes a bounded diagnosis, attempt counts, and a concrete next step", () => {
  const { createRecoveryPolicy, buildRecoveryFeedback } = require("../main/harness/recovery-policy");
  const policy = createRecoveryPolicy(5, 2, { now: () => 1000, lifetime: 30 });
  policy.tryConsume("planner_error");
  const feedback = buildRecoveryFeedback(policy.snapshot());
  assert.equal(feedback.authority, "host_diagnostic_not_permission");
  assert.equal(feedback.reason, "planner_error");
  assert.equal(feedback.attempt, 1);
  assert.equal(feedback.attemptsInWindow, 1);
  assert.equal(feedback.nextAction, "retry_planner_from_current_state");
  assert.equal(feedback.guidance.includes("Do not repeat uncertain actions"), true);
});

test("a host-observed page effect starts a fresh recovery window without resetting lifetime usage", async () => {
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    if (calls === 1 || calls === 3) throw new Error("temporary planner transport error");
    if (calls === 2) return actions(context, { type: "scroll", direction: "down", amount: 100 });
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" };
  } };
  const browser = {
    supportsAction: () => true,
    observe: async () => page(1),
    execute: async () => ({ status: "ok", effect: { observed: true } }),
  };
  const { controller, store } = await make(planner, browser);
  const snapshot = await controller.start();
  const events = await store.getEvents();
  const recoveries = events.filter((event) => event.type === "note" && event.payload?.kind === "recovery");
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(recoveries.length, 2);
  assert.deepEqual(recoveries.map((event) => event.payload.attempt), [1, 1], "observed progress resets the rolling retry window");
  assert.deepEqual(recoveries.map((event) => event.payload.total), [1, 1]);
  assert.equal(recoveries[1].payload.recoveryBudget.spent, 2, "progress never resets the lifetime safety cap");
  assert.equal(recoveries[0].payload.nextAction, "retry_planner_from_current_state");
});

test("recoveries expire after the window, so isolated failures hours apart each get their own retries", () => {
  const { createRecoveryPolicy } = require("../main/harness/recovery-policy");
  let clock = 0;
  const policy = createRecoveryPolicy(5, 2, { now: () => clock, windowMs: 600_000, lifetime: 30 });
  assert.ok(policy.tryConsume("planner_error"));
  assert.ok(policy.tryConsume("planner_error"));
  assert.equal(policy.tryConsume("planner_error"), null, "a tight failure loop is still bounded");
  clock += 600_000;
  assert.deepEqual(policy.tryConsume("planner_error"), { attempt: 1, total: 1 }, "an hour later the same failure is retried again");
});

test("a failure slow enough to outlast the window is still bounded by the lifetime cap", () => {
  const { createRecoveryPolicy } = require("../main/harness/recovery-policy");
  let clock = 0;
  const policy = createRecoveryPolicy(5, 2, { now: () => clock, windowMs: 600_000, lifetime: 4 });
  const grants = [];
  for (let i = 0; i < 10; i += 1) { grants.push(policy.tryConsume("planner_error")); clock += 700_000; }
  assert.equal(grants.filter(Boolean).length, 4);
});

test("reaching new pages refills the recovery budget, so scattered failures never stop a task that keeps progressing", async () => {
  let calls = 0;
  let observed = 0;
  const planner = { next: async (context) => {
    calls += 1;
    if (calls % 2 === 1 && calls < 14) throw new Error("transport hiccup"); // seven isolated failures
    if (calls >= 14) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" };
    return actions(context, { type: "scroll", direction: "down" });
  } };
  const browser = {
    supportsAction: () => true,
    observe: async () => { observed += 1; return { id: `o${observed}`, url: `https://page.test/list?p=${observed}`, text: `t${observed}`, elements: [] }; },
    execute: async () => ({ status: "ok" }),
  };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "need_user", "progress between failures keeps the budget alive");
});

test("looping on pages already seen does not refill the budget", async () => {
  let calls = 0;
  const planner = { next: async () => { calls += 1; throw new Error("down"); } };
  const { controller } = await make(planner, { supportsAction: () => true, observe: async () => page(1), execute: async () => ({ status: "ok" }) });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "planner_error");
  assert.equal(calls, 3);
});

test("a CAPTCHA page never gets a click: the task pauses for the person and resumes once it is gone", async () => {
  let solved = false;
  const executed = [];
  const planner = { next: async (context) => (solved
    ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "answer" }
    : actions(context, { type: "click", elementId: "e1" })) };
  const browser = {
    supportsAction: () => true,
    observe: async () => (solved ? page(2) : { id: "o1", url: "https://site.test/x", title: "Just a moment...", text: "verify", elements: [] }),
    execute: async (action) => { executed.push(action.type); return { status: "ok" }; },
  };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const first = await controller.start();
  assert.equal(first.pauseReason, "captcha");
  assert.deepEqual(executed, []);
  solved = true;
  const second = await controller.resume();
  assert.equal(second.pauseReason, "need_user");
});

test("page loads on the same site are spaced by the navigation interval", async () => {
  // navJitter pinned to 0: this test is about the floor exactly. Jitter on
  // top of it is covered by test/task-controller-pacing.test.js.
  const stamps = [];
  let n = 0;
  const planner = { next: async (context) => (n >= 3
    ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }
    : actions(context, { type: "navigate", url: `https://page.test/p${n}` })) };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: `https://page.test/p${n}`, text: `t${n}`, elements: [] }; }, execute: async () => { stamps.push(Date.now()); return { status: "ok" }; } };
  const { controller } = await make(planner, browser, { navIntervalMs: 120, navJitter: () => 0 });
  await controller.start();
  assert.ok(stamps.length >= 2);
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] - stamps[i - 1] >= 100, `gap ${stamps[i] - stamps[i - 1]}ms`);
});

test("a CAPTCHA site is left for another source once, and clicking on the challenge hands over to the person", async () => {
  const seen = [];
  const notices = [];
  let url = "https://a.test/x";
  const planner = { next: async (context) => {
    seen.push(context.progress?.errorUrls ?? null);
    notices.push(context.progress?.captchaReroute ?? null);
    if (url.startsWith("https://b.test")) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "answer from b" };
    return actions(context, { type: "navigate", url: "https://b.test/y" });
  } };
  const browser = { supportsAction: () => true, observe: async () => (url.startsWith("https://a.test") ? { id: "o1", url, title: "Just a moment...", text: "", elements: [] } : { id: "o2", url, title: "b", text: "ok", elements: [] }), execute: async (action) => { if (action.type === "navigate") url = action.url; return { status: "ok" }; } };
  const { controller, store } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "need_user");
  assert.ok(seen.some((urls) => Array.isArray(urls) && urls.some((entry) => entry.startsWith("https://a.test"))), "the challenged URL is surfaced as an error so the planner picks another source");
  const notice = notices.find((entry) => entry !== null);
  assert.equal(notice?.reason, "human_check");
  assert.equal(notice?.origin, "https://a.test");
  assert.match(notice?.guidance ?? "", /different source/, "the reroute notice names the alternative-source rule");
  const events = await store.getEvents();
  assert.ok(events.some((event) => event.type === "note" && event.payload?.kind === "captcha_reroute" && event.payload?.origin === "https://a.test"), "the reroute is durably journaled");

  const clicker = { next: async (context) => actions(context, { type: "click", elementId: "e1" }) };
  const blocked = { supportsAction: () => true, observe: async () => ({ id: "o1", url: "https://c.test/x", title: "Verify you are human", text: "", elements: [] }), execute: async () => ({ status: "ok" }) };
  const second = await (await make(clicker, blocked, { navIntervalMs: 0 })).controller.start();
  assert.equal(second.pauseReason, "captcha");
});

test("after a human check, navigating back into the challenged site hands the task over", async () => {
  const executed = [];
  const planner = { next: async (context) => actions(context, { type: "navigate", url: "https://a.test/other" }) };
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: "o1", url: "https://a.test/x", title: "Just a moment...", text: "", elements: [] }),
    execute: async (action) => { executed.push(action.type); return { status: "ok" }; },
  };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "captcha");
  assert.deepEqual(executed, [], "the challenged origin is never navigated into again");
});

test("the task is routed around at most two challenged sites, then pauses", async () => {
  const executed = [];
  let url = "https://a.test/x";
  const planner = { next: async (context) => actions(context, { type: "navigate", url: url.startsWith("https://a.test") ? "https://b.test/y" : "https://c.test/z" }) };
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: `o-${url}`, url, title: "Just a moment...", text: "", elements: [] }),
    execute: async (action) => { executed.push(action.url); url = action.url; return { status: "ok" }; },
  };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "captcha");
  assert.deepEqual(executed, ["https://b.test/y", "https://c.test/z"], "two challenged sites are routed around, the third hands over");
});

test("a site that showed a human check is remembered for later tasks sharing the ledger", async () => {
  const ledger = new Map();
  const blocked = { supportsAction: () => true, observe: async () => ({ id: "o1", url: "https://a.test/x", title: "Just a moment...", text: "", elements: [] }), execute: async () => ({ status: "ok" }) };
  await (await make({ next: async (context) => actions(context, { type: "observe" }) }, blocked, { navIntervalMs: 0, frictionLedger: ledger })).controller.start();
  assert.ok(ledger.has("https://a.test"), "the challenged origin is recorded");

  const hints = [];
  const clean = { supportsAction: () => true, observe: async () => ({ id: "o2", url: "https://b.test/y", title: "b", text: "ok", elements: [] }), execute: async () => ({ status: "ok" }) };
  const planner = { next: async (context) => { hints.push(context.progress?.recentHumanChecks ?? null); return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }; } };
  await (await make(planner, clean, { navIntervalMs: 0, frictionLedger: ledger })).controller.start();
  assert.deepEqual(hints.find((entry) => entry !== null), ["https://a.test"], "a later task is told which site recently challenged");

  const alone = [];
  const planner2 = { next: async (context) => { alone.push(context.progress?.recentHumanChecks ?? null); return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }; } };
  await (await make(planner2, clean, { navIntervalMs: 0 })).controller.start();
  assert.ok(alone.every((entry) => entry === null), "tasks without a shared ledger see no remembered sites");
});
