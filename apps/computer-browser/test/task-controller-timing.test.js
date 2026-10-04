"use strict";

// P0 measurement (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md):
// the context packet is built inside TaskController, so a benchmark cannot
// time it or size it from outside. An optional onTiming callback, with the
// same shape and closed vocabulary idea as TaskStore's, reports it. It is
// telemetry only: it never changes what runs, and its failure is ignored.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function makeStore() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-controller-timing-"));
  return TaskStore.create({ originalRequest: "goal" }, { storageRoot });
}

function finishingPlanner(seen) {
  return {
    next: async (context) => {
      seen.push(Buffer.byteLength(JSON.stringify(context), "utf8"));
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
    },
  };
}

const browser = { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
const approve = async () => ({ decision: "allow", reasons: [] });

test("onTiming reports each context build with its duration and exact packet bytes", async () => {
  const store = await makeStore();
  const timings = [];
  const seen = [];
  const controller = new TaskController({ store, planner: finishingPlanner(seen), browser, approve, hostVerifier: () => true, onTiming: (t) => timings.push(t) });
  await controller.start();
  const builds = timings.filter((t) => t.operation === "context_build");
  assert.equal(builds.length, seen.length);
  assert.ok(builds.length >= 1);
  for (const [i, t] of builds.entries()) {
    assert.deepEqual(Object.keys(t).sort(), ["bytes", "elapsedMs", "operation"]);
    assert.ok(Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0);
    assert.equal(t.bytes, seen[i], "bytes are the packet the planner received");
  }
  await store.close();
});

test("a throwing onTiming never changes the run", async () => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner: finishingPlanner([]), browser, approve, hostVerifier: () => true, onTiming: () => { throw new Error("telemetry down"); } });
  await controller.start();
  assert.notEqual(controller.getSnapshot().pauseReason, "context_error");
  assert.ok(["awaiting_verification", "completed"].includes(controller.getSnapshot().state));
  await store.close();
});

test("onTiming must be a function when given", async () => {
  const store = await makeStore();
  assert.throws(
    () => new TaskController({ store, planner: finishingPlanner([]), browser, approve, hostVerifier: () => true, onTiming: "yes" }),
    (error) => error instanceof TaskControllerError && error.code === "invalid_config",
  );
  await store.close();
});
