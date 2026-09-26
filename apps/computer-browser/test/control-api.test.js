"use strict";

// Regression tests for the stopTask()/pauseTask() race found while
// coordinating with Codex on apps/computer-browser: an approver round-trip
// already in flight when stopTask()/pauseTask() ran used to ignore the new
// state entirely once it resolved -- a late "allow" executed anyway, and a
// late "review" re-populated the queue stopTask() had just cleared. These
// tests exercise ControlApi directly (no Electron, no real socket) via the
// requestDecision injection seam in the constructor, so they can control
// exactly when the decision resolves relative to stop/pause.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ControlApi } = require("../main/control-api");

function deferredDecision() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeApi(requestDecisionStub) {
  const api = new ControlApi({ window: {}, socketPath: "/tmp/fake.sock", requestDecision: requestDecisionStub });
  api._task = { id: "t1", state: "running" };
  return api;
}

test("performGatedAction executes immediately on allow (baseline, no stop/pause)", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let executed = false;
  const outcome = await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );
  assert.equal(outcome, "allow");
  assert.equal(executed, true);
});

test("performGatedAction queues review (baseline, no stop/pause)", async () => {
  const api = makeApi(async () => ({ decision: "review", reasons: ["why"] }));
  const outcome = await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );
  assert.equal(outcome, "review");
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 1);
  assert.equal(snapshot.task.state, "awaiting_approval");
});

test("stopTask discards a late allow instead of executing it", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.stopTask();
  resolve({ decision: "allow", reasons: [] });

  const outcome = await pending;
  assert.equal(outcome, "cancelled");
  assert.equal(executed, false, "a decision that arrives after stop must never execute");
  assert.equal(api.getSnapshot().task.state, "stopped", "the late decision must not overwrite the stopped state");
});

test("stopTask discards a late review without resurrecting the approval queue", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );

  await api.stopTask();
  resolve({ decision: "review", reasons: ["needs a human"] });

  const outcome = await pending;
  assert.equal(outcome, "cancelled");
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 0, "stop must not be silently undone by a late review");
  assert.equal(snapshot.task.state, "stopped");
});

test("pauseTask holds a late allow instead of executing it; resumeTask applies it", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });

  const outcome = await pending;
  assert.equal(outcome, "paused");
  assert.equal(executed, false, "a decision that arrives while paused must not execute immediately");
  assert.equal(api.getSnapshot().task.state, "paused");

  await api.resumeTask();
  assert.equal(executed, true, "resumeTask must apply the held decision");
  assert.equal(api.getSnapshot().task.state, "completed");
});

test("pauseTask holds a late review; resumeTask queues it for approval", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );

  await api.pauseTask();
  resolve({ decision: "review", reasons: ["needs a human"] });

  const outcome = await pending;
  assert.equal(outcome, "paused");
  assert.equal(api.getSnapshot().approvalQueue.length, 0, "must not queue while still paused");

  await api.resumeTask();
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 1);
  assert.equal(snapshot.task.state, "awaiting_approval");
});

test("stopTask after pause discards the held decision too", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });
  await pending; // now "paused" with a deferred decision held

  await api.stopTask();
  await api.resumeTask(); // must be a no-op: task is "stopped", not "paused"

  assert.equal(executed, false);
  assert.equal(api.getSnapshot().task.state, "stopped");
});
