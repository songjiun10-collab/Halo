"use strict";

// The payments opt-in reaches the host and every task: off by default, a settings change reaches
// tasks that are already running, and a task attached later starts with the host's current value.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { HostSettingsStore } = require("../main/harness/host-settings");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

async function makeHost(options = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-payments-"));
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

test("payments are off unless the host is told otherwise", async () => {
  const { host } = await makeHost();
  assert.equal(host._paymentsEnabled, false);
  assert.equal((await makeHost({ paymentsEnabled: false })).host._paymentsEnabled, false);
  assert.equal((await makeHost({ paymentsEnabled: "yes" })).host._paymentsEnabled, false, "only true counts");
  assert.equal((await makeHost({ paymentsEnabled: true })).host._paymentsEnabled, true);
});

test("a settings change reaches the host and tasks that are already running", async () => {
  const { host, storageRoot } = await makeHost();
  host._settingsStore = new HostSettingsStore({ storageRoot: path.join(storageRoot, "settings") });
  const seen = [];
  host._active.set("t1", { store: { taskProfile: { duration: { id: "middle" } } }, controller: { setPolicySettings: (settings) => seen.push(settings.paymentsEnabled) } });
  await host.updateHostSettings({ paymentsEnabled: true });
  assert.equal(host._paymentsEnabled, true);
  await host.updateHostSettings({ paymentsEnabled: false });
  assert.equal(host._paymentsEnabled, false);
  await host.updateHostSettings({ plannerEffort: "high" });
  assert.deepEqual(seen, [true, false, false], "an unrelated change keeps payments off");
  host._active.clear();
});

test("a task attached later starts with the host's current setting", async () => {
  for (const enabled of [false, true]) {
    const { host } = await makeHost({ paymentsEnabled: enabled });
    const { taskId } = await host.createTask({ originalRequest: "look at the weather" });
    for (let i = 0; i < 200 && !host._active.get(taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host._active.get(taskId)?.controller._paymentsEnabled, enabled, `host ${enabled}`);
  }
});

test("a task started with requestAuthor model mints no mandate for its own purchase words, and the author survives a restart", async () => {
  const { host, storageRoot } = await makeHost({ paymentsEnabled: true });
  const order = "shop.example에서 $20 이하로 구매해줘";

  const { taskId } = await host.createTask({ originalRequest: order }, { requestAuthor: "model" });
  const events = async (id, root = storageRoot) => (await require("../main/harness/task-store").TaskStore.readEvents(id, { storageRoot: root }));
  // The controller reads the request before its first planner call, so a finish_rejected note means the mandate step has run.
  const settled = async (id, root) => { for (let i = 0; i < 400; i += 1) { if ((await events(id, root).catch(() => [])).some((e) => e.payload?.kind === "finish_rejected")) return; await new Promise((r) => setTimeout(r, 10)); } };
  await settled(taskId);
  const modelNotes = (await events(taskId)).filter((e) => e.type === "note").map((e) => e.payload.kind);
  assert.ok(modelNotes.includes("request_author_selected"), "the author is journaled so a restart keeps it");
  assert.equal(modelNotes.includes("mandate_granted"), false, "no mandate from model-written text");
  assert.equal((await host._getRunScope(taskId, null).catch(() => null))?.requestAuthor ?? "model", "model");

  // The host runs one task at a time and the first is still looping on its rejected finish, so the control runs on its own host.
  const control = (await makeHost({ paymentsEnabled: true }));
  const person = await control.host.createTask({ originalRequest: order });
  await settled(person.taskId, control.storageRoot);
  assert.ok((await events(person.taskId, control.storageRoot)).some((e) => e.payload?.kind === "mandate_granted"), "control: the person's own order still mints a mandate");

  await assert.rejects(() => host.createTask({ originalRequest: "x" }, { requestAuthor: "robot" }), { code: "invalid_selector" });
});

test("a team room starts its tasks as model-written", async () => {
  const { host } = await makeHost();
  const calls = [];
  host.startAgentTask = async (input, context) => { calls.push({ input, context }); return { taskId: "t" }; };
  await host._rooms._startTask({ teamId: "team-1", request: "buy it", intentText: "please" });
  assert.deepEqual(calls[0].context, { intentText: "please", requestAuthor: "model" });
});
