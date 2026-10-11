"use strict";

// Same-site navigation pacing: the politeness gap between page loads on one
// site. The floor (navIntervalMs) is never shortened; jitter is bounded and
// drawn fresh for each navigation so the gap is not a perfectly uniform
// signature. These tests pin the jitter source, so they are deterministic --
// the pacing stamp is taken just before execute(), so slop never shortens a gap.

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
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-pace-")) });
  openStores.add(store);
  return store;
};
const make = async (planner, browser, extra = {}) => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner, browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1, ...extra });
  return { controller, store };
};
const actions = (context, action) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [], kind: "actions", actions: [action] });

// Navigates the same origin `count` times, records the real wall-clock instant of
// each execute(), then pauses. Returns the gaps between consecutive loads.
// The observer increments n before returning, so the planner sees n = k on
// turn k and one execute happens per planner call below the threshold; the
// need_user threshold is therefore count + 1.
const runSameSiteNavigations = async (count, extra = {}) => {
  const stamps = [];
  let n = 0;
  const planner = { next: async (context) => (n >= count + 1
    ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }
    : actions(context, { type: "navigate", url: `https://page.test/p${n}` })) };
  const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: `https://page.test/p${n}`, text: `t${n}`, elements: [] }; }, execute: async () => { stamps.push(Date.now()); return { status: "ok" }; } };
  const { controller } = await make(planner, browser, extra);
  await controller.start();
  assert.ok(stamps.length >= 2, `expected at least two loads, got ${stamps.length}`);
  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) gaps.push(stamps[i] - stamps[i - 1]);
  return gaps;
};

test("injected jitter is applied on top of the floor, never instead of it", async () => {
  // First load is never paced (nothing to be spaced from); the second waits
  // the 50ms floor plus the pinned 500ms jitter. Asserting >= 500 leaves 50ms
  // of event-loop slop; slop only ever lengthens a gap.
  const gaps = await runSameSiteNavigations(2, { navIntervalMs: 50, navJitter: () => 500 });
  assert.ok(gaps[gaps.length - 1] >= 500, `gap ${gaps[gaps.length - 1]}ms must include the 500ms jitter`);
});

test("jitter is drawn fresh for each navigation, not fixed per origin", async () => {
  // A per-origin constant offset would space every load by the same amount
  // and read as uniform again. A fresh draw per navigation alternates the
  // gap: 50ms floor alone, then floor plus 400ms.
  const draws = [0, 400, 0, 400, 0];
  const gaps = await runSameSiteNavigations(4, { navIntervalMs: 50, navJitter: () => draws.shift() ?? 0 });
  assert.ok(gaps.length >= 3);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert.ok(spread > 200, `gaps ${JSON.stringify(gaps)} must vary, spread ${spread}ms`);
});

test("the configured floor is never shortened, with or without jitter", async () => {
  // Default randomness: the effective interval is floor + jitter >= floor.
  const gaps = await runSameSiteNavigations(3, { navIntervalMs: 200 });
  for (const gap of gaps) assert.ok(gap >= 190, `gap ${gap}ms must not fall below the 200ms floor`);
  // A negative or non-finite option is jitter off, never a negative interval.
  const clamped = await runSameSiteNavigations(2, { navIntervalMs: 50, navJitterMaxMs: -5 });
  for (const gap of clamped) assert.ok(gap >= 40, `gap ${gap}ms must not fall below the 50ms floor`);
});

test("navIntervalMs 0 disables pacing entirely, jitter or not", async () => {
  const gaps = await runSameSiteNavigations(2, { navIntervalMs: 0, navJitter: () => 500 });
  for (const gap of gaps) assert.ok(gap < 500, `gap ${gap}ms must not be paced when the interval is 0`);
});

test("controllers sharing a ledger keep one same-site gap between them", async () => {
  const ledger = new Map();
  const stamps = [];
  const mk = async () => {
    let n = 0;
    const planner = { next: async (context) => (n >= 2
      ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "done" }
      : actions(context, { type: "navigate", url: "https://page.test/shared" })) };
    const browser = { supportsAction: () => true, observe: async () => { n += 1; return { id: `o${n}`, url: "https://page.test/shared", text: `t${n}`, elements: [] }; }, execute: async () => { stamps.push(Date.now()); return { status: "ok" }; } };
    return (await make(planner, browser, { navIntervalMs: 300, navJitterMaxMs: 0, navLedger: ledger })).controller;
  };
  const [a, b] = [await mk(), await mk()];
  await Promise.all([a.start(), b.start()]);
  stamps.sort((x, y) => x - y);
  assert.ok(stamps.length >= 2, `expected loads from both tasks, got ${stamps.length}`);
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] - stamps[i - 1] >= 280, `loads ${stamps[i] - stamps[i - 1]}ms apart across tasks must keep the 300ms floor`);
});
