"use strict";

// Route-based planner effort through TaskHost: the effort a planner sees is
// derived from the task's persisted profile and the host settings mode, and a
// settings change re-derives it per task instead of flattening every task to
// one value.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { HostSettingsStore } = require("../main/harness/host-settings");
const { ChildAgentCoordinator } = require("../main/harness/child-agent-coordinator");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

async function makeHost(options = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-effort-"));
  const seen = [];
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({
      next: async (context) => {
        seen.push({ taskId: context.taskId, effort: context.progress.plannerEffort });
        return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
      },
    }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...options,
  });
  hosts.add(host);
  return { host, seen, storageRoot };
}

async function effortSeenFor(host, seen, duration) {
  const { taskId } = await host.createTask({ originalRequest: `task ${duration}` }, { requestedDurationProfile: duration });
  for (let i = 0; i < 200 && !seen.some((item) => item.taskId === taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  return seen.find((item) => item.taskId === taskId)?.effort;
}

test("auto mode gives short tasks low effort and keeps the user's effort elsewhere", async () => {
  // A finished task holds its slot (awaiting_verification), so each route
  // gets its own host.
  for (const [duration, expected] of [["short", "low"], ["middle", "high"], ["long", "high"]]) {
    const { host, seen } = await makeHost({ plannerEffort: "high", plannerEffortMode: "auto" });
    assert.equal(await effortSeenFor(host, seen, duration), expected, duration);
  }
});

test("fixed mode (the constructor default) keeps one effort for every route", async () => {
  const { host, seen } = await makeHost({ plannerEffort: "high" });
  assert.equal(await effortSeenFor(host, seen, "short"), "high");
});

test("a settings change re-derives effort per active task", async () => {
  const { host, storageRoot } = await makeHost({ plannerEffort: "medium", plannerEffortMode: "fixed", settingsStore: undefined });
  host._settingsStore = new HostSettingsStore({ storageRoot: path.join(storageRoot, "settings") });
  const applied = [];
  const fakeEntry = (duration) => ({
    store: { taskProfile: { duration: { id: duration } } },
    controller: { setPolicySettings: (settings) => applied.push([duration, settings.plannerEffort]) },
  });
  host._active.set("short-task", fakeEntry("short"));
  host._active.set("middle-task", fakeEntry("middle"));
  await host.updateHostSettings({ plannerEffort: "xhigh", plannerEffortMode: "auto" });
  assert.deepEqual(applied, [["short", "low"], ["middle", "xhigh"]]);
  host._active.clear();
});

test("child planners get the child route effort, resolved when each child starts", () => {
  let mode = "auto";
  const coordinator = new ChildAgentCoordinator({ storageRoot: os.tmpdir(), plannerEffort: () => (mode === "auto" ? "low" : "high") });
  assert.equal(coordinator._childPlannerEffort(), "low");
  mode = "fixed";
  assert.equal(coordinator._childPlannerEffort(), "high");
  assert.equal(new ChildAgentCoordinator({ storageRoot: os.tmpdir(), plannerEffort: "max" })._childPlannerEffort(), "max");
});
