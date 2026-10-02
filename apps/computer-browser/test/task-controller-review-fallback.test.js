"use strict";

// reviewFallback "deny" is the unattended-run choice: an action that would
// wait for a human is denied (and journaled) instead, and the loop goes on.
// The default "queue" keeps today's awaiting_approval behaviour.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function makeStore() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-review-fallback-"));
  return TaskStore.create({ originalRequest: "goal" }, { storageRoot });
}

function plannerFor(actions) {
  let calls = 0;
  return {
    get calls() { return calls; },
    next: async (context) => {
      calls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [] };
      return calls === 1 ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    },
  };
}

const browser = () => {
  const executed = [];
  return { executed, observe: async () => ({ id: "obs" }), execute: async (action) => { executed.push(action.type); return { status: "ok" }; } };
};
const review = async () => ({ decision: "review", reasons: ["needs a human look"] });

for (const [label, actions] of [["a single action", [{ type: "observe" }]], ["a read-only batch", [{ type: "observe" }, { type: "observe" }]]]) {
  test(`reviewFallback deny skips ${label} instead of waiting`, async () => {
    const store = await makeStore();
    const planner = plannerFor(actions);
    const fake = browser();
    const controller = new TaskController({ store, planner, browser: fake, approve: review, hostVerifier: () => true, reviewFallback: "deny" });
    await controller.start();
    const snapshot = controller.getSnapshot();
    assert.notEqual(snapshot.state, "awaiting_approval");
    assert.deepEqual(snapshot.approvalQueue, []);
    assert.deepEqual(fake.executed, []);
    assert.equal(planner.calls, 2);
    const notes = (await store.getEvents()).filter((event) => event.type === "note" && event.payload?.kind === "review_auto_denied");
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].payload.reasons, ["needs a human look"]);
    await store.close();
  });

  test(`default reviewFallback still queues ${label} for a human`, async () => {
    const store = await makeStore();
    const controller = new TaskController({ store, planner: plannerFor(actions), browser: browser(), approve: review, hostVerifier: () => true });
    await controller.start();
    assert.equal(controller.getSnapshot().state, "awaiting_approval");
    await store.close();
  });
}

test("reviewFallback rejects unknown values", async () => {
  const store = await makeStore();
  assert.throws(
    () => new TaskController({ store, planner: plannerFor([]), browser: browser(), approve: review, hostVerifier: () => true, reviewFallback: "allow" }),
    (error) => error instanceof TaskControllerError && error.code === "invalid_config",
  );
  await store.close();
});
