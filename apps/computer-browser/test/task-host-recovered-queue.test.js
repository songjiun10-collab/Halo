"use strict";

// After a restart, unfinished tasks are recovered to the queue head and wait
// for a person to resume them. A task the user starts in the new session
// must not queue behind them forever: the recovered entries are skipped
// (never run, still saved as paused), and resuming one later re-enters the
// FIFO so it is admitted like any other task.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");

const hosts = new Set();
test.afterEach(async () => { await Promise.all([...hosts].map((host) => host.close())); hosts.clear(); });

function plannerOf(kind) {
  return {
    next: async (context) => (kind === "pause"
      ? { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "need_user", reason: "hold" }
      : { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }),
  };
}

function makeHost(storageRoot, kind, created = []) {
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: (taskId) => { created.push(taskId); return plannerOf(kind); },
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  hosts.add(host);
  return host;
}

async function restartedWithRecovered() {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-recovered-queue-"));
  const before = makeHost(storageRoot, "pause");
  const first = await before.createTask({ originalRequest: "unfinished before restart" });
  const second = await before.createTask({ originalRequest: "queued before restart" });
  assert.equal(second.snapshot.state, "queued");
  await before.close();
  hosts.delete(before);
  return { storageRoot, first, second };
}

test("a new task starts instead of queueing behind tasks recovered from the last session", async () => {
  const { storageRoot, first, second } = await restartedWithRecovered();
  const planners = [];
  const host = makeHost(storageRoot, "finish", planners);
  const fresh = await host.createTask({ originalRequest: "new work" });
  assert.notEqual(fresh.snapshot.state, "queued");
  assert.ok(planners.includes(fresh.taskId), "the new task attached a planner");
  assert.ok(!planners.includes(first.taskId) && !planners.includes(second.taskId), "recovered tasks never run on their own");
  const listed = await host.listTasks();
  for (const id of [first.taskId, second.taskId]) {
    const summary = listed.find((item) => item.taskId === id);
    assert.ok(summary, "recovered tasks stay saved");
    assert.equal(summary.queuePosition, undefined);
    assert.notEqual(summary.state, "completed");
  }
  const skips = host._queue.history().filter((event) => event.type === "skip");
  assert.deepEqual(skips.map((event) => event.taskId), [first.taskId, second.taskId]);
});

test("resuming a skipped recovered task puts it back through FIFO admission", async () => {
  const { storageRoot, first } = await restartedWithRecovered();
  const planners = [];
  const host = makeHost(storageRoot, "pause", planners);
  const fresh = await host.createTask({ originalRequest: "new work" });
  // The new task holds the single sequential slot, so the resumed one waits.
  const waiting = await host.resumeSavedTask(first.taskId);
  assert.equal(waiting.state, "queued");
  assert.ok(host._queue.pendingIds().includes(first.taskId));
  await host.stopTask(fresh.taskId);
  for (let i = 0; i < 200 && !planners.includes(first.taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(planners.includes(first.taskId), "the resumed task was admitted once the slot freed");
});

test("listing tasks while one is resumed never collides on its writer lock", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-recovered-gate-"));
  const before = makeHost(storageRoot, "pause");
  const only = await before.createTask({ originalRequest: "resume me" });
  await before.close();
  hosts.delete(before);
  const host = makeHost(storageRoot, "pause");
  const results = await Promise.allSettled([host.listTasks(), host.resumeSavedTask(only.taskId), host.listTasks(), host.listTasks()]);
  const conflicts = results.filter((r) => r.status === "rejected" && r.reason?.code === "writer_conflict");
  assert.deepEqual(conflicts, []);
});
