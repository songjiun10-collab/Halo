"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");

function makeHost(storageRoot) {
  let calls = 0;
  return new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => {
        calls += 1;
        const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [] };
        return calls % 2 === 1 ? { ...base, kind: "actions", actions: [{ type: "observe" }] } : { ...base, kind: "finish", evidenceIds: [] };
      },
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "review", reasons: ["needs a human look"] }),
  });
}

async function settle(host, taskId) {
  for (let i = 0; i < 100; i += 1) {
    const detail = await host.getTaskDetail(taskId);
    if (detail.snapshot && !["idle", "running", "queued"].includes(detail.snapshot.state)) return detail.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not settle");
}

test("createTask rejects an unknown reviewFallback", async () => {
  const host = makeHost(await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-fallback-")));
  try {
    await assert.rejects(host.createTask({ originalRequest: "x" }, { reviewFallback: "allow" }), { code: "invalid_selector" });
  } finally {
    await host.close();
  }
});

test("reviewFallback deny is journaled and keeps an unattended task moving", async () => {
  const host = makeHost(await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-fallback-")));
  try {
    const { taskId } = await host.createTask({ originalRequest: "x" }, { reviewFallback: "deny" });
    const snapshot = await settle(host, taskId);
    assert.notEqual(snapshot.state, "awaiting_approval");
    const events = await host.getTaskEvents(taskId);
    const items = Array.isArray(events) ? events : events.events;
    assert.ok(items.some((event) => event.payload?.kind === "review_fallback_selected" && event.payload.mode === "deny"));
    assert.ok(items.some((event) => event.payload?.kind === "review_auto_denied"));
  } finally {
    await host.close();
  }
  const waiting = makeHost(await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-fallback-")));
  try {
    const { taskId } = await waiting.createTask({ originalRequest: "x" });
    assert.equal((await settle(waiting, taskId)).state, "awaiting_approval");
  } finally {
    await waiting.close();
  }
});
