"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const makeStore = async () => TaskStore.create({ originalRequest: "goal" }, { storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-obsretry-")) });
const finisher = () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [], kind: "finish", evidenceIds: [] }) });
const stale = () => Object.assign(new Error("page navigated during observation"), { code: "stale_document" });

function browserFailing(errors) {
  let calls = 0;
  return {
    get observeCalls() { return calls; },
    supportsAction: () => true,
    observe: async () => {
      const failure = errors[calls];
      calls += 1;
      if (failure) throw failure;
      return { id: "obs", url: "https://page.test/", elements: [] };
    },
    execute: async () => ({ status: "ok" }),
  };
}

const make = async (browser) => new TaskController({ store: await makeStore(), planner: finisher(), browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, observeRetryDelayMs: 1 });

test("a page that was still navigating is observed again instead of pausing the task", async () => {
  const browser = browserFailing([stale(), stale()]);
  const snapshot = await (await make(browser)).start();
  assert.notEqual(snapshot.pauseReason, "observation_error");
  assert.equal(browser.observeCalls, 3);
});

test("a page that never settles still fails closed with observation_error", async () => {
  const browser = browserFailing([stale(), stale(), stale(), stale(), stale()]);
  const snapshot = await (await make(browser)).start();
  assert.equal(snapshot.pauseReason, "observation_error");
  assert.equal(browser.observeCalls, 3);
});

test("only stale_document is retried; any other observation failure pauses at once", async () => {
  const browser = browserFailing([Object.assign(new Error("observe() failed"), { code: "observe_failed" })]);
  const snapshot = await (await make(browser)).start();
  assert.equal(snapshot.pauseReason, "observation_error");
  assert.equal(browser.observeCalls, 1);
});
