"use strict";

// The runtime hallucination device: a need_user answer whose specific claims
// never appeared in anything the task observed is sent back to the planner once
// (host-owned groundingFeedback, never the user's voice or an amendment); if it
// survives the correction budget, the pause carries the unsupported list and the
// journal records it. Detection must never change an honest answer's path.

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

const make = async (planner, browser, extra = {}) => {
  const store = await TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-ground-")) });
  openStores.add(store);
  const controller = new TaskController({ store, planner, browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1, ...extra });
  return { controller, store };
};

const observedPage = { id: "o1", url: "https://store.test/macbook", title: "MacBook Air", text: "MacBook Air chip M4 display 11-inch memory 16GB price $1099", elements: [] };
const needUser = (context, reason) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason });
const browserFor = (page) => ({ supportsAction: () => true, observe: async () => page, execute: async () => ({ status: "ok" }) });

test("a fabricated answer is sent back once for revision, and the person sees the grounded answer", async () => {
  const seen = [];
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    seen.push(context.progress?.groundingFeedback ?? null);
    if (calls === 1) return needUser(context, "Chip M4, display 11-inch, memory 16GB, cache 24GB.");
    return needUser(context, "Chip M4, display 11-inch, memory 16GB.");
  } };
  const { controller, store } = await make(planner, browserFor(observedPage));
  const snapshot = await controller.start();
  assert.equal(calls, 2, "one host correction turn before the pause");
  const feedback = seen.find((entry) => entry !== null);
  assert.equal(feedback.authority, "host_grounding_not_permission");
  assert.deepEqual(feedback.unsupported, ["24gb"]);
  assert.deepEqual(feedback.observedUrls, ["https://store.test/macbook"], "the feedback names a page the planner can revisit instead of guessing");
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(snapshot.needUserReason, "Chip M4, display 11-inch, memory 16GB.");
  assert.equal(snapshot.grounding, undefined, "the revised answer no longer carries unsupported specifics");
  const events = await store.getEvents();
  const notes = events.filter((event) => event.type === "note" && event.payload?.kind === "grounding");
  assert.deepEqual(notes.map((note) => note.payload.outcome), ["correction_requested"]);
});

test("an answer that ignores the correction is kept and surfaced to the person", async () => {
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return needUser(context, "Chip M4, display 11-inch, memory 16GB, cache 24GB."); } };
  const { controller, store } = await make(planner, browserFor(observedPage));
  const snapshot = await controller.start();
  assert.equal(calls, 2, "groundingCorrections defaults to one revision");
  assert.equal(snapshot.pauseReason, "need_user");
  assert.deepEqual(snapshot.grounding, { unsupported: ["24gb"] });
  const events = await store.getEvents();
  const notes = events.filter((event) => event.type === "note" && event.payload?.kind === "grounding");
  assert.deepEqual(notes.map((note) => note.payload.outcome), ["correction_requested", "unsupported_kept"]);
});

test("groundingCorrections: 0 measures without correcting", async () => {
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return needUser(context, "The chip is M4, memory 16GB, cache 24GB."); } };
  const { controller } = await make(planner, browserFor(observedPage), { groundingCorrections: 0 });
  const snapshot = await controller.start();
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.grounding, { unsupported: ["24gb"] });
});

test("an honest answer takes exactly the path it took before the device existed", async () => {
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return needUser(context, "Chip M4, display 11-inch, memory 16GB."); } };
  const { controller, store } = await make(planner, browserFor(observedPage));
  const snapshot = await controller.start();
  assert.equal(calls, 1);
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(snapshot.grounding, undefined);
  const events = await store.getEvents();
  assert.equal(events.some((event) => event.type === "note" && event.payload?.kind === "grounding"), false);
});

test("a value the task actually read earlier stays grounded after navigating away", async () => {
  let pageIndex = 0;
  const pages = [
    { id: "o1", url: "https://store.test/macbook", title: "MacBook Air", text: "chip M4 display 11-inch memory 16GB price $1099", elements: [] },
    { id: "o2", url: "https://store.test/compare", title: "Compare", text: "all models compared", elements: [] },
  ];
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    if (pageIndex === 0) {
      pageIndex = 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [{ type: "navigate", url: "https://store.test/compare" }] };
    }
    return needUser(context, "Chip M4, memory 16GB.");
  } };
  const browser = { supportsAction: () => true, observe: async () => pages[pageIndex], execute: async () => ({ status: "ok" }) };
  const { controller } = await make(planner, browser);
  const snapshot = await controller.start();
  assert.equal(calls, 2);
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(snapshot.grounding, undefined, "16GB was on a page this task read");
  assert.equal(snapshot.needUserReason, "Chip M4, memory 16GB.");
});

test("a value the user's own request carried is grounded, not a hallucination", async () => {
  // The false positive a real model produced: it restated the zip code from the
  // task's request while confirming the store mutation. The request is ground
  // truth the planner was given, so the answer must not be corrected or flagged.
  const store = await TaskStore.create({ originalRequest: "Set zip 90028 as the home store." }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-ground-")) });
  openStores.add(store);
  let calls = 0;
  const planner = { next: async (context) => { calls += 1; return needUser(context, "Please confirm that zip code 90028 has been set as your home store."); } };
  const controller = new TaskController({ store, planner, browser: browserFor(observedPage), approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1 });
  const snapshot = await controller.start();
  assert.equal(calls, 1, "the request's own value must not trigger a grounding correction");
  assert.equal(snapshot.pauseReason, "need_user");
  assert.equal(snapshot.grounding, undefined);
  const events = await store.getEvents();
  assert.equal(events.some((event) => event.type === "note" && event.payload?.kind === "grounding"), false);
});
