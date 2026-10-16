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
  const stamps = [];
  let n = 0;
  const planner = { next: async (context) => (n >= 3
    ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }
    : actions(context, { type: "navigate", url: `https://page.test/p${n}` })) };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: `https://page.test/p${n}`, text: `t${n}`, elements: [] }; }, execute: async () => { stamps.push(Date.now()); return { status: "ok" }; } };
  const { controller } = await make(planner, browser, { navIntervalMs: 120 });
  await controller.start();
  assert.ok(stamps.length >= 2);
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] - stamps[i - 1] >= 100, `gap ${stamps[i] - stamps[i - 1]}ms`);
});

test("a CAPTCHA site is left for another source once, and clicking on the challenge hands over to the person", async () => {
  const seen = [];
  let url = "https://a.test/x";
  const planner = { next: async (context) => {
    seen.push(context.progress?.errorUrls ?? context.errorUrls ?? null);
    if (url.startsWith("https://b.test")) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "answer from b" };
    return actions(context, { type: "navigate", url: "https://b.test/y" });
  } };
  const browser = { supportsAction: () => true, observe: async () => (url.startsWith("https://a.test") ? { id: "o1", url, title: "Just a moment...", text: "", elements: [] } : { id: "o2", url, title: "b", text: "ok", elements: [] }), execute: async (action) => { if (action.type === "navigate") url = action.url; return { status: "ok" }; } };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "need_user");

  const clicker = { next: async (context) => actions(context, { type: "click", elementId: "e1" }) };
  const blocked = { supportsAction: () => true, observe: async () => ({ id: "o1", url: "https://c.test/x", title: "Verify you are human", text: "", elements: [] }), execute: async () => ({ status: "ok" }) };
  const second = await (await make(clicker, blocked, { navIntervalMs: 0 })).controller.start();
  assert.equal(second.pauseReason, "captcha");
});

test("a planner that clicks on a CAPTCHA page is told once to leave it and the task carries on elsewhere instead of stopping", async () => {
  const executed = [];
  const feedback = [];
  let url = "https://a.test/x";
  const planner = { next: async (context) => {
    feedback.push(context.progress?.proposalFeedback?.code ?? null);
    if (url.startsWith("https://b.test")) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "answer from b" };
    // First tries the challenge, then follows the host's note and leaves.
    return actions(context, feedback.includes("captcha_page") ? { type: "navigate", url: "https://b.test/y" } : { type: "click", elementId: "e1" });
  } };
  const browser = { supportsAction: () => true, observe: async () => (url.startsWith("https://a.test") ? { id: `o${feedback.length}`, url, title: "Just a moment...", text: "", elements: [] } : { id: "ob", url, title: "b", text: "ok", elements: [] }), execute: async (action) => { executed.push(action.type); if (action.type === "navigate") url = action.url; return { status: "ok" }; } };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "need_user", "reached the answer instead of pausing for a CAPTCHA");
  assert.deepEqual(executed, ["navigate"], "the click on the challenge was never sent");
  assert.ok(feedback.includes("captcha_page"));
});

test("a challenge that clears by itself leaves no free pass: challenged again on that site, the task waits for the person", async () => {
  const seen = [];
  const executed = [];
  let at = "https://a.test/x";
  let observed = 0;
  const planner = { next: async (context) => {
    const { url, title } = context.observation;
    seen.push(url);
    if (title === "Just a moment...") return actions(context, url === "https://a.test/x" ? { type: "click", elementId: "e1" } : { type: "navigate", url: "https://b.test/z" });
    if (url === "https://a.test/x") return actions(context, { type: "navigate", url: "https://a.test/y" });
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "answer from b" };
  } };
  const browser = {
    supportsAction: () => true,
    observe: async () => {
      observed += 1;
      const id = `o${observed}`;
      // a.test challenges, the planner is told to leave, the challenge then clears by itself,
      // and the next page on a.test is challenged again.
      if (at === "https://a.test/x") return observed === 1 ? { id, url: at, title: "Just a moment...", text: "", elements: [] } : { id, url: at, title: "A shop", text: "items", elements: [] };
      if (at === "https://a.test/y") return { id, url: at, title: "Just a moment...", text: "", elements: [] };
      return { id, url: at, title: "b", text: "ok", elements: [] };
    },
    execute: async (action) => { executed.push(action.type); if (action.type === "navigate") at = action.url; return { status: "ok" }; },
  };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "captcha", "(the bug) the earlier note to leave was still pending and let the repeat block through");
  assert.deepEqual(executed, ["navigate"]);
  assert.equal(seen.includes("https://a.test/y"), false, "the planner is not asked about the repeat challenge");
});

test("four different CAPTCHA sites in one task are routed around before it waits for the person; a fifth waits", async () => {
  const hosts = ["a", "b", "c", "d", "e"];
  let index = 0;
  const planner = { next: async (context) => actions(context, { type: "navigate", url: `https://${hosts[Math.min(index + 1, 4)]}.test/y` }) };
  const browser = { supportsAction: () => true, observe: async () => ({ id: `o${index}`, url: `https://${hosts[Math.min(index, 4)]}.test/x`, title: "Just a moment...", text: "", elements: [] }), execute: async () => { index += 1; return { status: "ok" }; } };
  const { controller } = await make(planner, browser, { navIntervalMs: 0 });
  const snapshot = await controller.start();
  assert.equal(snapshot.pauseReason, "captcha");
  assert.equal(index, 4, "four sites were left behind before the fifth challenge paused");
});
