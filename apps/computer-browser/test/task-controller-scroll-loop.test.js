"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const makeStore = async () => TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-scroll-")) });

function setup(actionFor) {
  let turn = 0;
  const seen = [];
  const planner = { next: async (context) => {
    seen.push(context.progress.scrollStreak);
    const action = actionFor(turn);
    turn += 1;
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [], kind: "actions", actions: [action] };
  } };
  let n = 0;
  const browser = {
    supportsAction: () => true,
    // The visible text changes with every scroll, like a long listing page.
    observe: async () => { n += 1; return { id: `obs${n}`, url: "https://page.test/list", text: `chunk ${n}`, elements: [{ elementId: "1", tag: "a" }] }; },
    execute: async () => ({ status: "ok" }),
  };
  return { planner, browser, seen };
}

const make = async (planner, browser) => new TaskController({ store: await makeStore(), planner, browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1 });

test("endless scrolling of one page pauses as no_progress and the planner is warned first", async () => {
  const { planner, browser, seen } = setup(() => ({ type: "scroll", direction: "down", amount: 600 }));
  const snapshot = await (await make(planner, browser)).start();
  assert.equal(snapshot.pauseReason, "no_progress");
  assert.ok(seen.includes(3), `planner never saw a scrollStreak warning: ${JSON.stringify(seen)}`);
  assert.equal(seen.length, 6);
});

test("a non-scroll action between scrolls resets the streak", async () => {
  const { planner, browser, seen } = setup((turn) => (turn % 3 === 2 ? { type: "observe" } : { type: "scroll", direction: "down", amount: 600 }));
  const controller = await make(planner, browser);
  await controller.start();
  // The scroll streak never reached the warning threshold (the separate
  // same-page guard is what eventually stops this stationary loop).
  assert.ok(seen.every((value) => value === undefined), `scrollStreak leaked: ${JSON.stringify(seen)}`);
  await controller.stop().catch(() => {});
});

test("a malformed planner proposal is retried once, a second one pauses as planner_error", async () => {
  const slip = () => Object.assign(new Error("planner failed (invalid_proposal)"), { plannerCode: "invalid_proposal" });
  const browser = { supportsAction: () => true, observe: async () => ({ id: "o1", url: "https://page.test/", text: "x", elements: [] }), execute: async () => ({ status: "ok" }) };
  let calls = 0;
  const once = { next: async (context) => {
    calls += 1;
    if (calls === 1) throw slip();
    if (calls === 2) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "scroll", direction: "down", amount: 100 }] };
    throw new Error("stop here");
  } };
  const recovered = await (await make(once, browser)).start();
  assert.equal(calls, 3, "first slip was retried and the loop carried on");
  assert.equal(recovered.pauseReason, "planner_error");

  let always = 0;
  const failing = { next: async () => { always += 1; throw slip(); } };
  const paused = await (await make(failing, browser)).start();
  assert.equal(always, 2);
  assert.equal(paused.pauseReason, "planner_error");
});

test("most recent turns staying on one page pause as no_progress even when the actions differ", async () => {
  const types = [{ type: "observe" }, { type: "scroll", direction: "down", amount: 300 }, { type: "observe" }, { type: "scroll", direction: "up", amount: 300 }];
  const { planner, browser } = setup((turn) => types[turn % types.length]);
  const snapshot = await (await make(planner, browser)).start();
  assert.equal(snapshot.pauseReason, "no_progress");
});

test("a hub page revisited between different pages does not trip the page-loop guard", async () => {
  let turn = 0, n = 0;
  const pages = ["https://hub.test/list", "https://hub.test/item1", "https://hub.test/list", "https://hub.test/item2"];
  const planner = { next: async (context) => {
    turn += 1;
    if (turn > 20) return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "scroll", direction: "down", amount: 1 }] };
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "observe" }] };
  } };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: pages[n % pages.length], text: `t${n}`, elements: [] }; }, execute: async () => ({ status: "ok" }) };
  const snapshot = await (await make(planner, browser)).start();
  assert.ok(turn > 12, `guard fired early after ${turn} turns (${snapshot.pauseReason})`);
});

test("bouncing between two pages for a whole window pauses as no_progress", async () => {
  let n = 0;
  const pages = ["https://a.test/x", "https://a.test/search"];
  const planner = { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "observe" }] }) };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: pages[n % 2], text: `t${n}`, elements: [] }; }, execute: async () => ({ status: "ok" }) };
  const snapshot = await (await make(planner, browser)).start();
  assert.equal(snapshot.pauseReason, "no_progress");
});

test("addresses that answered with an HTTP error are listed for the planner", async () => {
  let n = 0;
  const seenErrors = [];
  const planner = { next: async (context) => {
    seenErrors.push(context.progress.errorUrls);
    if (seenErrors.length > 3) throw new Error("stop");
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "observe" }] };
  } };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: `https://a.test/p${n}`, httpStatus: n === 1 ? 404 : undefined, text: "x", elements: [] }; }, execute: async () => ({ status: "ok" }) };
  await (await make(planner, browser)).start();
  assert.deepEqual(seenErrors[1], ["https://a.test/p1"]);
});
