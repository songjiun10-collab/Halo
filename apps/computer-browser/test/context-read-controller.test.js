"use strict";

// P1 wiring: with contextRefs enabled, pages the task has already left stay
// reachable as text-only snapshots through the packet's contextManifest and a
// context_read action. The read is host-only: no browser dispatch, no approval,
// one unit of the existing action budget. Off by default, so the packet and
// every existing planner contract are unchanged unless a host opts in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function makeStore(limits) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-context-read-"));
  return TaskStore.create({ originalRequest: "read the page", ...(limits ? { limits } : {}) }, { storageRoot });
}

// Every executed action lands on a new page, so the task makes progress and
// each turn leaves a page behind.
function makeBrowser() {
  const executed = [];
  let n = 0;
  let page = 0;
  return {
    executed,
    observe: async () => ({ id: `obs-${n++}`, url: `http://127.0.0.1/page/${page}`, title: `Page ${page}`, documentEpoch: page + 1, text: `text of page ${page}`,
      elements: [{ role: "link", name: "Next", href: `http://127.0.0.1/page/${page + 1}`, elementId: `next-${page}` }] }),
    execute: async (action) => { executed.push(action.type); page += 1; return { status: "ok" }; },
  };
}

const approve = async () => ({ decision: "allow", reasons: [] });

// Scrolls (each scroll moves to a new page here), letting `onRefs` act first.
function scriptedPlanner({ seen, onRefs }) {
  let scrolls = 0;
  return {
    next: async (context) => {
      seen.push(context);
      const envelope = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [] };
      const refs = context.contextManifest?.refs ?? [];
      const decided = onRefs(context, refs, envelope);
      if (decided) return decided;
      if (scrolls < 8) { scrolls += 1; return { ...envelope, kind: "actions", actions: [{ type: "scroll", direction: "down", amount: 100 }] }; }
      return { ...envelope, kind: "finish", evidenceIds: [] };
    },
  };
}

test("off by default: the packet carries no manifest and context_read is not special", async () => {
  const store = await makeStore();
  const seen = [];
  const controller = new TaskController({ store, planner: scriptedPlanner({ seen, onRefs: () => null }), browser: makeBrowser(), approve, hostVerifier: () => true });
  await controller.start();
  assert.ok(seen.length > 0);
  assert.ok(seen.every((context) => !Object.hasOwn(context, "contextManifest")));
  await store.close();
});

test("contextRefs must be a boolean", async () => {
  const store = await makeStore();
  assert.throws(() => new TaskController({ store, planner: { next: async () => null }, browser: makeBrowser(), approve, hostVerifier: () => true, contextRefs: "yes" }),
    (error) => error instanceof TaskControllerError && error.code === "invalid_config");
  await store.close();
});

test("pages already left are offered by reference and read back without touching the browser", async () => {
  const store = await makeStore();
  const seen = [];
  const browser = makeBrowser();
  let readSent = false;
  let readAt = -1;
  const planner = scriptedPlanner({
    seen,
    onRefs: (context, refs, envelope) => {
      if (!readSent && refs.length >= 2) {
        readSent = true;
        readAt = seen.length;
        return { ...envelope, kind: "actions", actions: [{ type: "context_read", refIds: [refs[0].refId] }] };
      }
      return null;
    },
  });
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true, contextRefs: true });
  await controller.start();

  assert.ok(readSent, "the manifest offered earlier pages once the task moved on");
  assert.equal(seen[0].contextManifest.refs.length, 0, "nothing is offered before any page is left");
  const ref = seen[readAt - 1].contextManifest.refs[0];
  assert.equal(ref.kind, "observation");
  assert.equal(ref.authority, "untrusted_page_derived");
  assert.equal(ref.summary, "Earlier page: http://127.0.0.1/page/0");
  assert.equal(JSON.stringify(seen[readAt - 1].contextManifest).includes("text of page 0"), false, "the body is not in the packet");

  const after = seen[readAt];
  assert.ok(after, "the planner was called again after the read");
  const read = after.observation.contextRead;
  assert.equal(read.authority, "context_read");
  assert.equal(read.results[0].outcome, "ok");
  assert.equal(read.results[0].authority, "untrusted_page_derived");
  assert.deepEqual(JSON.parse(read.results[0].body), { url: "http://127.0.0.1/page/0", title: "Page 0", text: "text of page 0" }, "text only: no element ids to act on");
  assert.equal(Object.hasOwn(seen[readAt + 1]?.observation ?? {}, "contextRead"), false, "a read result is shown once");
  assert.ok(!browser.executed.includes("context_read"), "context_read never reaches the browser");
  assert.ok(Buffer.byteLength(JSON.stringify(after), "utf8") <= 64 * 1024);
  await store.close();
});

test("a context_read mixed with other actions, or malformed, is not executed", async () => {
  const store = await makeStore();
  const seen = [];
  const browser = makeBrowser();
  let sent = 0;
  const planner = scriptedPlanner({
    seen,
    onRefs: (context, refs, envelope) => {
      if (sent === 0) { sent += 1; return { ...envelope, kind: "actions", actions: [{ type: "context_read", refIds: ["ref_aaaaaaaaaaaa"] }, { type: "scroll", direction: "down", amount: 1 }] }; }
      if (sent === 1) { sent += 1; return { ...envelope, kind: "actions", actions: [{ type: "context_read", refIds: ["../etc/passwd"], extra: 1 }] }; }
      return null;
    },
  });
  const controller = new TaskController({ store, planner, browser, approve, hostVerifier: () => true, contextRefs: true });
  await controller.start();
  assert.ok(!browser.executed.includes("context_read"));
  assert.equal(seen[1].observation.contextRead?.results?.length ?? 0, 0, "nothing was read for the mixed proposal");
  await store.close();
});

test("an unknown ref is answered as unavailable, and each read spends one action", async () => {
  const store = await makeStore();
  const seen = [];
  let sent = false;
  const planner = scriptedPlanner({
    seen,
    onRefs: (context, refs, envelope) => {
      if (!sent) { sent = true; return { ...envelope, kind: "actions", actions: [{ type: "context_read", refIds: ["ref_doesnotexist0"] }] }; }
      return null;
    },
  });
  const controller = new TaskController({ store, planner, browser: makeBrowser(), approve, hostVerifier: () => true, contextRefs: true });
  await controller.start();
  assert.deepEqual(seen[1].observation.contextRead.results, [{ refId: "ref_doesnotexist0", outcome: "error", code: "context_ref_unavailable" }]);
  assert.equal(seen[1].progress.budgets.actionsUsed, 1);
  await store.close();
});

test("a read with no action budget left pauses instead of running", async () => {
  const store = await makeStore({ maxActions: 1, maxPlannerCalls: 10, maxActiveMs: 60000 });
  const seen = [];
  let sent = 0;
  const planner = scriptedPlanner({
    seen,
    onRefs: (context, refs, envelope) => {
      sent += 1;
      return { ...envelope, kind: "actions", actions: [{ type: "context_read", refIds: ["ref_doesnotexist0"] }] };
    },
  });
  const controller = new TaskController({ store, planner, browser: makeBrowser(), approve, hostVerifier: () => true, contextRefs: true });
  await controller.start();
  assert.equal(controller.getSnapshot().pauseReason, "budget_exhausted");
  await store.close();
});
