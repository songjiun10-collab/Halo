"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskQueue } = require("../main/harness/task-queue");

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

async function withQueue(run) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-task-queue-"));
  try {
    const queue = new TaskQueue({ storageRoot });
    await queue.load();
    await run(queue, storageRoot);
  } finally {
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
}

test("sequential mode admits one FIFO task and advances only after an explicit terminal state", async () => {
  await withQueue(async (queue) => {
    await queue.enqueue(ids[0]);
    await queue.enqueue(ids[1]);
    assert.equal(await queue.admitNext({ maxActive: 1 }), ids[0]);
    assert.equal(await queue.admitNext({ maxActive: 1 }), null);
    await assert.rejects(queue.complete(ids[0], "paused"), { code: "invalid_terminal_state" });
    await queue.complete(ids[0], "completed");
    assert.equal(await queue.admitNext({ maxActive: 1 }), ids[1]);
  });
});

test("parallel mode admits FIFO work up to the bounded active count and reuses a freed slot", async () => {
  await withQueue(async (queue) => {
    for (const id of ids) await queue.enqueue(id);
    assert.equal(await queue.admitNext({ maxActive: 2 }), ids[0]);
    assert.equal(await queue.admitNext({ maxActive: 2 }), ids[1]);
    assert.equal(await queue.admitNext({ maxActive: 2 }), null);
    await queue.complete(ids[0], "stopped");
    assert.equal(await queue.admitNext({ maxActive: 2 }), ids[2]);
    assert.deepEqual(queue.activeIds(), [ids[1], ids[2]]);
  });
});

test("concurrent scheduler calls cannot admit the same queue item twice", async () => {
  await withQueue(async (queue) => {
    await queue.enqueue(ids[0]);
    const results = await Promise.all([
      queue.admitNext({ maxActive: 1 }),
      queue.admitNext({ maxActive: 1 }),
    ]);
    assert.deepEqual(results.sort(), [null, ids[0]].sort());
    assert.deepEqual(queue.activeIds(), [ids[0]]);
  });
});

test("skip is trusted-host-only, durable, and distinct from completion", async () => {
  await withQueue(async (queue, root) => {
    await queue.enqueue(ids[0]);
    await queue.enqueue(ids[1]);
    await assert.rejects(queue.skip(ids[0], { reason: "blocked" }), { code: "untrusted_skip" });
    assert.deepEqual(queue.pendingIds(), ids.slice(0, 2));
    await queue.skip(ids[0], { reason: "user skipped", actor: "trusted_host" });
    const reloaded = new TaskQueue({ storageRoot: root });
    await reloaded.load();
    assert.deepEqual(reloaded.pendingIds(), [ids[1]]);
    assert.equal(reloaded.history().at(-1).type, "skip");
  });
});

test("reconciliation fails closed for missing references and prunes checkpointed terminal tasks", async () => {
  await withQueue(async (queue) => {
    await queue.enqueue(ids[0]);
    await queue.enqueue(ids[1]);
    await assert.rejects(queue.reconcile([{ taskId: ids[1], state: "paused" }]), { code: "queue_reference_missing" });
    await queue.reconcile([
      { taskId: ids[0], state: "completed" },
      { taskId: ids[1], state: "paused", pauseReason: "recovered" },
    ]);
    assert.deepEqual(queue.pendingIds(), [ids[1]]);
  });
});
