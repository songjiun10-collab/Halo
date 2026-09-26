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

// Independently reproduced and reported by Codex: the fix above only guards
// the window *before* execute() runs (waiting on the approver). It missed
// stopTask() landing *while an already-approved* execute() is still in
// flight (e.g. a real navigate() awaiting loadURL()) -- in that case the
// decision was legitimately "allow" and execute() genuinely ran, but every
// caller that turns "allow" into `_task.state = "completed"` was still doing
// so unconditionally, silently overwriting the "stopped" state stopTask()
// had already set. Fixed by threading the captured epoch into
// _applyDecision() and re-checking it after execute() resolves, and by
// capturing one epoch at the top of startTask() and re-checking it at every
// subsequent await (including the previously-unchecked _findFirstOutboundLink
// await and its "no link found" branch, which is exactly what this repro
// hits).

test("performGatedAction reports a stale allow (but still runs execute()) if stopTask() lands mid-execute", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });
  let executed = false;

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
      executed = true;
    },
  );

  // Let performGatedAction actually reach the awaited execute() call before
  // stopping -- otherwise stopTask()'s synchronous epoch bump (it has no
  // internal await) would land before performGatedAction's very first
  // continuation ever runs, catching it at the pre-execute check instead of
  // the one this test targets.
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();

  const outcome = await pending;
  assert.equal(outcome, "cancelled", "the caller must not be told this was a clean allow once stop happened mid-flight");
  assert.equal(executed, true, "execute() already genuinely ran; this guard is about not misreporting the outcome afterwards");
  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("startTask leaves the task stopped, not completed, if stopTask() lands while step 1's navigate is still running", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let resolveNavigate;
  const navigatePromise = new Promise((res) => {
    resolveNavigate = res;
  });
  api.navigate = async () => {
    await navigatePromise;
  };
  api._findFirstOutboundLink = async () => null;

  const pending = api.startTask("https://example.com");
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveNavigate();
  await pending;

  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("resumeTask leaves the task stopped, not completed, if stopTask() lands while the held decision's execute() is still running", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });
  await pending; // now "paused" with the decision held, execute() not yet called

  const resumePending = api.resumeTask();
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();
  await resumePending;

  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("approve leaves the task stopped, not completed, if stopTask() lands while the approved item's execute() is still running", async () => {
  const api = makeApi(async () => ({ decision: "review", reasons: ["needs a human"] }));
  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });

  await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
    },
  );
  assert.equal(api.getSnapshot().approvalQueue.length, 1);

  const approvePending = api.approve("r1");
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();
  await approvePending;

  assert.equal(api.getSnapshot().task.state, "stopped");
  assert.equal(api.getSnapshot().approvalQueue.length, 0);
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
