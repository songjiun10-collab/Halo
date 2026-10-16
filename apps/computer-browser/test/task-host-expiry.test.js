"use strict";

// An expired (or unreadable) beta build starts no tasks and attaches no saved ones.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { parseExpiry } = require("../main/harness/build-expiry");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

async function makeHost(options = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-expiry-"));
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }),
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...options,
  });
  hosts.add(host);
  return { host, storageRoot };
}

const day = parseExpiry("2027-02-28");

test("a development build (no build info) runs tasks", async () => {
  const { host } = await makeHost();
  const { taskId } = await host.createTask({ originalRequest: "look at the weather" });
  assert.ok(taskId);
});

test("a live beta build runs tasks, an expired one refuses before storing anything", async () => {
  const live = await makeHost({ buildInfo: { expiresAt: day, invalid: false }, wallClock: () => day - 1000 });
  assert.ok((await live.host.createTask({ originalRequest: "look at the weather" })).taskId);

  const dead = await makeHost({ buildInfo: { expiresAt: day, invalid: false }, wallClock: () => day + 1000 });
  await assert.rejects(() => Promise.resolve().then(() => dead.host.createTask({ originalRequest: "look at the weather" })), { code: "build_expired", message: /expired/ });
  assert.deepEqual(await dead.host.listTasks(), [], "no task record is left behind");
});

test("an unreadable expiry fails closed with its own message", async () => {
  const { host } = await makeHost({ buildInfo: { expiresAt: null, invalid: true } });
  await assert.rejects(() => Promise.resolve().then(() => host.createTask({ originalRequest: "look at the weather" })), { code: "build_expired", message: /unreadable/ });
});

test("the clock is read each time: a build that expires while running refuses the next task", async () => {
  let now = day - 1000;
  const { host } = await makeHost({ buildInfo: { expiresAt: day, invalid: false }, wallClock: () => now });
  assert.ok((await host.createTask({ originalRequest: "first" })).taskId);
  now = day + 1;
  await assert.rejects(() => Promise.resolve().then(() => host.createTask({ originalRequest: "second" })), { code: "build_expired" });
});

test("settings carry a read-only build expiry notice only for a beta build", async () => {
  const dev = await makeHost({ settingsStore: { load: async () => ({ version: 1 }) } });
  assert.equal((await dev.host.getHostSettings()).buildExpiry, undefined);

  const beta = await makeHost({ settingsStore: { load: async () => ({ version: 1 }) }, buildInfo: { expiresAt: day, invalid: false }, wallClock: () => day - 3 * 86_400_000 + 1000 });
  const settings = await beta.host.getHostSettings();
  assert.deepEqual(settings.buildExpiry, { expired: false, daysLeft: 3, expiresAt: day });
});

test("an update result carries the same read-only build expiry as a load, and a development build is unchanged", async () => {
  const store = { load: async () => ({ version: 1, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", plannerEffortMode: "auto", mcpProviders: [] }), update: async (patch) => ({ version: 1, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", plannerEffortMode: "auto", mcpProviders: [], ...patch }) };
  const beta = await makeHost({ settingsStore: store, buildInfo: { expiresAt: day, invalid: false }, wallClock: () => day - 3 * 86_400_000 + 1000 });
  const updated = await beta.host.updateHostSettings({ permissionMode: "interact" });
  assert.equal(updated.permissionMode, "interact");
  assert.deepEqual(updated.buildExpiry, { expired: false, daysLeft: 3, expiresAt: day });

  const dev = await makeHost({ settingsStore: store });
  assert.equal("buildExpiry" in (await dev.host.updateHostSettings({ permissionMode: "interact" })), false);
});
