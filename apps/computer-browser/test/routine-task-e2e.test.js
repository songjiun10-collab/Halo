"use strict";

// End-to-end coverage for the routine execution feature (Task 4 of
// docs/superpowers/plans/2026-09-29-routine-execution.md): unlike
// routine-runner.test.js (RoutineRunner.next() driven by hand-built
// context objects) and task-host.test.js's routine tests (host wiring in
// isolation), these tests drive a saved RoutineDefinition through the real
// TaskHost -> TaskController -> RoutineRunner -> BrowserAdapter loop with a
// stateful fake browser, proving the whole pipeline actually completes,
// recovers across a host restart, and pauses durably on denial.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { TaskStore } = require("../main/harness/task-store");
const { RoutineStore } = require("../main/harness/routine-store");
const { RoutineRunner } = require("../main/harness/routine-runner");

const hostsToClose = new Set();

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-routine-e2e-"));
}

test.afterEach(async () => {
  const hosts = [...hostsToClose];
  hostsToClose.clear();
  await Promise.all(hosts.map((host) => host.close().catch(() => {})));
});

// A minimal but stateful fake browser: tracks the current URL and its
// accessible elements across navigate/follow_link/scroll, exactly like a
// real BrowserAdapter would report them through observe().
function makeFakeBrowser(pages, startUrl = "about:blank") {
  let currentUrl = startUrl;
  let observationCounter = 0;
  return {
    observe: async () => ({
      id: `obs-${observationCounter++}`,
      url: currentUrl,
      elements: pages[currentUrl]?.elements || [],
    }),
    execute: async (action) => {
      if (action.type === "navigate") {
        if (!pages[action.url]) throw new Error(`unmapped fake page: ${action.url}`);
        currentUrl = action.url;
      } else if (action.type === "follow_link") {
        const element = (pages[currentUrl]?.elements || []).find((candidate) => candidate.elementId === action.elementId);
        if (!element) throw new Error(`unknown elementId: ${action.elementId}`);
        currentUrl = element.href;
      } else if (action.type !== "scroll") {
        throw new Error(`fake browser cannot execute: ${action.type}`);
      }
      return { status: "ok" };
    },
  };
}

function makeHost(storageRoot, overrides = {}) {
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => makeFakeBrowser({}),
    makePlanner: () => { throw new Error("a routine task must never build a planner worker"); },
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...overrides,
  });
  hostsToClose.add(host);
  return host;
}

const TWO_STEP_PAGES = {
  "https://example.com/start": {
    elements: [{ role: "link", name: "Inbox", href: "https://example.com/inbox", elementId: "link-inbox" }],
  },
  "https://example.com/inbox": { elements: [] },
};

async function saveTwoStepRoutine(storageRoot) {
  return new RoutineStore({ storageRoot }).save({
    name: "Check inbox",
    origins: ["https://example.com"],
    steps: [
      { kind: "navigate", url: "https://example.com/start" },
      { kind: "follow_link", name: "Inbox", expectedHref: "https://example.com/inbox" },
    ],
  });
}

test("a saved routine runs end-to-end through the real TaskController/BrowserAdapter loop, never building a planner worker", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await saveTwoStepRoutine(storageRoot);
  const host = makeHost(storageRoot, { makeBrowser: () => makeFakeBrowser(TWO_STEP_PAGES) });

  const { taskId, snapshot } = await host.runRoutine(saved.routineId, saved.revision);

  // Both steps executed and only the "confirm completion" user criterion is
  // left -- the routine has no planner, so this is the natural terminal
  // state exactly like a child/finish proposal with no evidence (see
  // child-agent-coordinator.test.js's analogous end-to-end test).
  assert.equal(snapshot.state, "awaiting_verification");

  const events = await host.getTaskEvents(taskId);
  const advanced = events.filter((event) => event.type === "routine_step_advanced");
  assert.equal(advanced.length, 2);
  assert.equal(advanced[0].payload.stepIndex, 0);
  assert.equal(advanced[1].payload.stepIndex, 1);
  assert.equal(advanced[0].payload.routineId, saved.routineId);
  assert.equal(advanced[0].payload.revision, saved.revision);
  assert.notEqual(advanced[0].payload.stepDigest, advanced[1].payload.stepDigest);
  assert.equal(events.some((event) => event.type === "routine_step_denied" || event.type === "routine_step_failed"), false);
});

test("a task whose journal already durably advanced past step 0 resumes on a fresh TaskHost from that cursor, without replaying the completed step", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await saveTwoStepRoutine(storageRoot);

  // Build the exact durable state a real host would have left behind right
  // after step 0's action outcome was accepted and advanced, but before a
  // checkpoint recorded the new cursor -- the precise crash point
  // task-store.js's streamJournalReplay() reconstructs via routineRecovery
  // (see makeRoutineRecovery/assertRoutineEventBinding). This mirrors
  // task-host.test.js's own "routine recovery rejects a wrong step digest"
  // test, but with a VALID digest to prove the happy recovery path.
  const step0 = new RoutineRunner({ definition: saved, cursor: 0 }).getCurrentStep();
  const store = await TaskStore.create({ originalRequest: "Run saved routine" }, { storageRoot });
  const taskId = store.taskId;
  await store.checkpoint({
    task: { state: "idle", pauseReason: null },
    routineRun: { routineId: saved.routineId, revision: saved.revision, digest: saved.digest, cursor: 0 },
  });
  await store.append({ type: "action_started", payload: { actionId: "a1" } });
  await store.append({ type: "action_outcome", payload: { actionId: "a1", status: "ok" } });
  await store.append({ type: "routine_step_advanced", payload: { ...step0, actionId: "a1" } });
  await store.close();

  const executedActions = [];
  // Resume always starts from a completely fresh observation (resume() never
  // replays an already-finished action) -- a real BrowserAdapter would still
  // show whatever page step 0's navigate actually left it on after a process
  // restart, so the reattached fake browser starts there too rather than at
  // "about:blank".
  const trackingBrowser = () => {
    const fake = makeFakeBrowser(TWO_STEP_PAGES, "https://example.com/start");
    return {
      observe: (...args) => fake.observe(...args),
      execute: async (action) => {
        executedActions.push(action);
        return fake.execute(action);
      },
    };
  };
  const host = makeHost(storageRoot, { makeBrowser: trackingBrowser });
  const resumedSnapshot = await host.resumeSavedTask(taskId);

  assert.equal(resumedSnapshot.state, "awaiting_verification");
  assert.equal(executedActions.length, 1, "only the remaining follow_link step is executed, not a replay of the already-advanced navigate step");
  assert.equal(executedActions[0].type, "follow_link");

  const events = await host.getTaskEvents(taskId);
  const advanced = events.filter((event) => event.type === "routine_step_advanced");
  assert.equal(advanced.length, 2, "the pre-existing step-0 advancement plus the newly recorded step-1 advancement");
  assert.equal(advanced[0].payload.stepIndex, 0);
  assert.equal(advanced[1].payload.stepIndex, 1);
});

test("several durable advancements written without any checkpoint recover to the right cursor and only the remaining step runs", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Check inbox then scroll",
    origins: ["https://example.com"],
    steps: [
      { kind: "navigate", url: "https://example.com/start" },
      { kind: "follow_link", name: "Inbox", expectedHref: "https://example.com/inbox" },
      { kind: "scroll", direction: "down", amount: 200 },
    ],
  });

  // The controller no longer checkpoints after every step, so a crash can
  // leave several advancement records past the last checkpoint.
  const store = await TaskStore.create({ originalRequest: "Run saved routine" }, { storageRoot });
  const taskId = store.taskId;
  await store.checkpoint({
    task: { state: "idle", pauseReason: null },
    routineRun: { routineId: saved.routineId, revision: saved.revision, digest: saved.digest, cursor: 0 },
  });
  for (let index = 0; index < 2; index += 1) {
    const step = new RoutineRunner({ definition: saved, cursor: index }).getCurrentStep();
    const actionId = `a${index}`;
    await store.append({ type: "action_started", payload: { actionId } });
    await store.append({ type: "action_outcome", payload: { actionId, status: "ok" } }, { durable: false });
    await store.append({ type: "routine_step_advanced", payload: { ...step, actionId } });
  }
  await store.close();

  const executedActions = [];
  const host = makeHost(storageRoot, { makeBrowser: () => {
    const fake = makeFakeBrowser(TWO_STEP_PAGES, "https://example.com/inbox");
    return {
      observe: (...args) => fake.observe(...args),
      execute: async (action) => { executedActions.push(action); return fake.execute(action); },
    };
  } });
  const resumed = await host.resumeSavedTask(taskId);

  assert.equal(resumed.state, "awaiting_verification");
  assert.deepEqual(executedActions.map((action) => action.type), ["scroll"]);
  const advanced = (await host.getTaskEvents(taskId)).filter((event) => event.type === "routine_step_advanced");
  assert.deepEqual(advanced.map((event) => event.payload.stepIndex), [0, 1, 2]);
});

test("a routine step denied by host approval policy pauses durably with routine_step_denied instead of looping until the planner-call budget is exhausted", async () => {
  const storageRoot = await mkTempRoot();
  const saved = await saveTwoStepRoutine(storageRoot);
  const host = makeHost(storageRoot, {
    makeBrowser: () => makeFakeBrowser(TWO_STEP_PAGES),
    approve: async () => ({ decision: "deny", reasons: ["test_deny"] }),
  });

  const { taskId, snapshot } = await host.runRoutine(saved.routineId, saved.revision);

  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "routine_step_denied");
  // A single planner-call-equivalent turn was spent; the controller must
  // not have kept re-proposing the same denied step.
  assert.equal(snapshot.budgets.plannerCallsUsed, 1);

  const events = await host.getTaskEvents(taskId);
  const denied = events.filter((event) => event.type === "routine_step_denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].payload.stepIndex, 0);
  assert.equal(events.some((event) => event.type === "routine_step_advanced"), false);
});

async function runThreeScrollRoutine(options) {
  const storageRoot = await mkTempRoot();
  const saved = await new RoutineStore({ storageRoot }).save({
    name: "Scroll three times",
    origins: ["https://example.com"],
    steps: [
      { kind: "navigate", url: "https://example.com/start" },
      { kind: "scroll", direction: "down", amount: 100 },
      { kind: "scroll", direction: "down", amount: 200 },
      { kind: "scroll", direction: "down", amount: 300 },
    ],
  });
  let observes = 0;
  const approvals = [];
  const host = makeHost(storageRoot, {
    ...options,
    approve: async (_taskId, descriptor) => { approvals.push(descriptor.action); return { decision: "allow", reasons: [] }; },
    makeBrowser: () => {
      const fake = makeFakeBrowser(TWO_STEP_PAGES);
      return { observe: (...args) => { observes += 1; return fake.observe(...args); }, execute: (action) => fake.execute(action) };
    },
  });
  const { taskId, snapshot } = await host.runRoutine(saved.routineId, saved.revision);
  const events = await host.getTaskEvents(taskId);
  return { snapshot, events, observes, approvals };
}

test("a saved routine batches consecutive scroll steps by default, still recording one advancement per step", async () => {
  const { snapshot, events, observes, approvals } = await runThreeScrollRoutine({});
  assert.equal(snapshot.state, "awaiting_verification");
  assert.deepEqual(events.filter((e) => e.type === "routine_step_advanced").map((e) => e.payload.stepIndex), [0, 1, 2, 3]);
  assert.deepEqual(approvals, ["navigate", "scroll"], "the three scrolls share one approval");
  assert.equal(observes, 3, "observe once before navigate, once before the scroll batch, once after it");
});

test("routineReadOnlyBatching: false keeps one action per routine turn", async () => {
  const { snapshot, events, observes, approvals } = await runThreeScrollRoutine({ routineReadOnlyBatching: false });
  assert.equal(snapshot.state, "awaiting_verification");
  assert.deepEqual(events.filter((e) => e.type === "routine_step_advanced").map((e) => e.payload.stepIndex), [0, 1, 2, 3]);
  assert.deepEqual(approvals, ["navigate", "scroll", "scroll", "scroll"]);
  assert.equal(observes, 5);
});
