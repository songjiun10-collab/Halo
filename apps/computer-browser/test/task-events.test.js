"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { TaskHost } = require("../main/harness/task-host");
const { validateJournalEvent, MAX_EVENT_BYTES } = require("../shared/harness-contracts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-task-events-"));
  const store = await TaskStore.create({ originalRequest: "event test" }, { storageRoot });
  t.after(() => store.close());
  const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({
    store,
    browser,
    planner: { next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "waiting on you" }) },
    approve: async () => ({ decision: "allow" }),
    hostVerifier: () => true,
    ...overrides,
  });
  return { storageRoot, store, controller, browser };
}

test("journal pages use an exclusive cursor without losing events at the bound", async (t) => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 204 }, (_, n) => store.append({ type: "note", payload: { n } })));
  const page = await store.getEvents();
  assert.equal(page.length, 200);
  assert.equal(page[0].seq, 1);
  assert.equal(page[199].seq, 200);
  const next = await store.getEvents({ since: 200 });
  assert.deepEqual(next.map((event) => event.seq), [201, 202, 203, 204, 205]);
  for (const event of [...page, ...next]) assert.equal(validateJournalEvent(event), event);
  assert.deepEqual(await store.getEvents({ since: 205 }), []);
});

test("journal queries reject unsafe cursors and unknown options", async (t) => {
  const { store } = await fixture(t);
  for (const options of [null, [], { since: -1 }, { since: 1.5 }, { since: "1" }, { since: Infinity }, { since: Number.MAX_SAFE_INTEGER + 1 }, { path: "/tmp/other" }]) {
    await assert.rejects(() => store.getEvents(options), { code: "invalid_field" });
  }
});

test("saved journal reads are read-only even while a writer owns the task", async (t) => {
  const { storageRoot, store } = await fixture(t);
  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");
  await fs.appendFile(journalPath, '{"unfinished":');
  const before = await fs.readFile(journalPath, "utf8");
  const events = await TaskStore.readEvents(store.taskId, { storageRoot });
  assert.deepEqual(events.map((event) => event.type), ["goal_created"]);
  assert.equal(await fs.readFile(journalPath, "utf8"), before, "a timeline read never repairs or truncates the journal");
  await assert.rejects(() => TaskStore.load(store.taskId, { storageRoot }), { code: "writer_conflict" });
});

test("journal reads reject malformed, oversized, cross-task and symlinked data", async (t) => {
  const { storageRoot, store } = await fixture(t);
  const journalPath = path.join(storageRoot, "tasks", store.taskId, "events.jsonl");
  const original = await fs.readFile(journalPath, "utf8");
  const foreign = JSON.parse(original);
  foreign.taskId = "11111111-1111-1111-1111-111111111111";
  for (const contents of ["not json\n", "x".repeat(MAX_EVENT_BYTES + 1), `${JSON.stringify(foreign)}\n`]) {
    await fs.writeFile(journalPath, contents);
    await assert.rejects(() => TaskStore.readEvents(store.taskId, { storageRoot }), { code: "storage_corrupt" });
  }
  await fs.writeFile(journalPath, original);
  await store.close();
  const target = path.join(storageRoot, "foreign.jsonl");
  await fs.rename(journalPath, target);
  await fs.symlink(target, journalPath);
  await assert.rejects(() => TaskStore.readEvents(store.taskId, { storageRoot }));
});

test("controller publishes running, loop progress and durable pause without duplicate snapshots", async (t) => {
  const { controller, store } = await fixture(t);
  const snapshots = [];
  const unsubscribe = controller.onChange((snapshot) => snapshots.push(snapshot));
  await controller.start();
  assert.deepEqual(snapshots.map((snapshot) => [snapshot.state, snapshot.budgets.plannerCallsUsed]), [
    ["running", 0], ["running", 1], ["paused", 1],
  ]);
  assert.equal(snapshots.at(-1).pauseReason, "need_user");
  assert.equal(store.lastCheckpoint.payload.task.state, "paused");
  await controller.pause();
  assert.equal(snapshots.length, 3, "no-op pause must not publish again");
  await assert.rejects(() => controller.start(), { code: "invalid_state" });
  assert.equal(snapshots.length, 3, "rejected public operations must not publish");
  unsubscribe();
  await controller.stop();
  assert.equal(snapshots.length, 3);
});

test("subscribers cannot corrupt state or interrupt a transition", async (t) => {
  const { controller } = await fixture(t);
  controller.onChange((snapshot) => { snapshot.budgets.actionsUsed = 900; throw new Error("subscriber failed"); });
  const seen = [];
  controller.onChange((snapshot) => seen.push(snapshot));
  await controller.stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].budgets.actionsUsed, 0);
  assert.equal(controller.getSnapshot().budgets.actionsUsed, 0);
});

test("takeover notification waits for checkpoint and failure publishes nothing", async (t) => {
  const { controller, store } = await fixture(t);
  const snapshots = [];
  controller.onChange((snapshot) => snapshots.push(snapshot));
  const gate = deferred();
  const reached = deferred();
  const checkpoint = store.checkpoint.bind(store);
  store.checkpoint = async (payload) => { reached.resolve(); await gate.promise; return checkpoint(payload); };
  const stopped = controller.stop();
  await reached.promise;
  assert.equal(snapshots.length, 0);
  gate.resolve();
  await stopped;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].state, "stopped");
  store.checkpoint = async () => { throw new Error("checkpoint failed"); };
  await assert.rejects(() => controller.stop(), /checkpoint failed/);
  assert.equal(snapshots.length, 1);
});

test("action evidence and approval queue transitions publish their complete snapshots", async (t) => {
  let calls = 0;
  const { controller } = await fixture(t, {
    planner: {
      next: async (context) => {
        const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: ["C1"] };
        return ++calls === 1
          ? { ...base, kind: "actions", actions: [{ type: "observe" }] }
          : { ...base, kind: "finish", evidenceIds: [] };
      },
    },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok", evidenceCandidate: { kind: "host_check" } }) },
    approve: async () => ({ decision: "review" }),
  });
  const snapshots = [];
  controller.onChange((snapshot) => snapshots.push(snapshot));
  await controller.start();
  const queued = snapshots.at(-1);
  assert.equal(queued.state, "awaiting_approval");
  assert.equal(queued.approvalQueue.length, 1);
  await controller.approve(queued.approvalQueue[0].id);
  assert.ok(snapshots.some((snapshot) => snapshot.budgets.actionsUsed === 1 && snapshot.criteriaStatus[0]?.status === "pending"));
  assert.equal(snapshots.at(-1).state, "awaiting_verification");
  const evidence = snapshots.at(-1).criteriaStatus[0];
  await controller.confirmCriterion({ criterionId: evidence.criterionId, goalVersion: 1, evidenceId: evidence.evidenceId, outcome: "verified" });
  assert.equal(snapshots.at(-1).state, "completed");
});

test("browser navigation excludes resume and waits for prior ownership transitions", async (t) => {
  const navigate = deferred();
  const reached = deferred();
  const { controller } = await fixture(t, {
    browser: {
      observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }),
      userNavigate: async () => { reached.resolve(); await navigate.promise; return { tabs: [{ id: "page", url: "https://example.com/" }], activeTabId: "page" }; },
    },
  });
  await controller.start();
  assert.equal(controller.isUserControlled(), true);
  const pending = controller.userNavigate({ type: "navigate", url: "https://example.com/" });
  await reached.promise;
  assert.equal(controller.isUserControlled(), false);
  await assert.rejects(() => controller.resume(), { code: "admission_closed" });
  const stopping = controller.stop();
  navigate.resolve();
  assert.equal((await pending).tabs[0].url, "https://example.com/");
  await stopping;
  assert.equal(controller.getSnapshot().state, "stopped");
  assert.equal(controller.isUserControlled(), true);
});

async function hostFixture(t, overrides = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-task-push-"));
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user" }) }),
    approve: async () => ({ decision: "allow" }), hostVerifier: () => true,
    ...overrides,
  });
  t.after(() => host.close());
  return { host, storageRoot };
}

test("host publishes identity before create resolves and releases subscriptions on close", async (t) => {
  const plan = deferred();
  const reached = deferred();
  let browserListener;
  let browserUnsubscribed = false;
  const browserSnapshot = { tabs: [{ id: "page", url: "https://example.com/", title: "Page", canGoBack: false, canGoForward: false }], activeTabId: "page", documentEpoch: 0 };
  const { host } = await hostFixture(t, {
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), getBrowserSnapshot: () => browserSnapshot, onChange: (listener) => { browserListener = listener; return () => { browserUnsubscribed = true; }; } }),
    makePlanner: () => ({ next: async (context) => { reached.resolve(); await plan.promise; return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user" }; } }),
  });
  const events = [];
  const unsubscribe = host.onEvent((taskId, snapshot, detail) => events.push({ taskId, snapshot, ...detail }));
  const creating = host.createTask({ originalRequest: "early identity" });
  await reached.promise;
  assert.equal(events[0].goal.originalRequest, "early identity");
  const taskId = events[0].taskId;
  assert.ok(events.some((event) => event.snapshot.state === "running"));
  assert.equal(host.canUseTaskBrowser(taskId), false);
  await assert.rejects(() => host.taskBrowserAction(taskId, { type: "back" }), { code: "invalid_state" });
  browserListener(browserSnapshot);
  assert.equal(events.at(-1).browser.tabs[0].url, "https://example.com/");
  plan.resolve();
  await creating;
  assert.equal(host.canUseTaskBrowser(taskId), true);
  unsubscribe();
  const count = events.length;
  await host.stopTask(taskId);
  assert.equal(events.length, count);
  await host.close();
  assert.equal(browserUnsubscribed, true);
});

test("host reads detached events without constructing a browser or acquiring the writer lock", async (t) => {
  let browsers = 0;
  const { host, storageRoot } = await hostFixture(t, { makeBrowser: () => { browsers += 1; throw new Error("unexpected browser"); } });
  const store = await TaskStore.create({ originalRequest: "saved only" }, { storageRoot });
  t.after(() => store.close());
  const events = await host.getTaskEvents(store.taskId);
  assert.equal(events[0].type, "goal_created");
  assert.equal(browsers, 0);
  assert.equal(host.canUseTaskBrowser(store.taskId), false);
});

test("viewport updates validate bounds and never attach an unknown task", async (t) => {
  const viewports = [];
  const { host } = await hostFixture(t, { setViewport: (taskId, bounds) => viewports.push({ taskId, bounds }) });
  const { taskId } = await host.createTask({ originalRequest: "viewport" });
  const bounds = { x: 10, y: 20, width: 300, height: 200, visible: true };
  await host.setTaskViewport(taskId, bounds);
  assert.deepEqual(viewports, [{ taskId, bounds }]);
  await assert.rejects(() => host.setTaskViewport("missing", bounds), { code: "not_active" });
  await assert.rejects(() => host.setTaskViewport(taskId, { ...bounds, width: Infinity }), { code: "invalid_field" });
  await host.setTaskViewport(null, { ...bounds, visible: false });
  assert.equal(viewports.at(-1).taskId, null);
});
