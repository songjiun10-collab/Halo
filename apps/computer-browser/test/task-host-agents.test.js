"use strict";

// TaskHost wiring for the Agent roster (docs/superpowers/specs/
// 2026-10-01-agent-roster-and-teams-design.md): the methods exist on the host,
// stay closed after close(), and an Agent start becomes an ordinary task whose
// goal carries the role constraints.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { TaskStore } = require("../main/harness/task-store");
const { AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

async function makeHost({ makeBrowser, makePlanner, maxParallelTasks } = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-agents-"));
  const host = new TaskHost({
    storageRoot,
    makeBrowser: makeBrowser || (() => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) })),
    makePlanner: makePlanner || (() => ({
      next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }),
    })),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...(maxParallelTasks ? { maxParallelTasks } : {}),
  });
  hosts.add(host);
  return { host, storageRoot };
}

const agentInput = {
  name: "Mail Assistant", title: "", description: "", avatar: { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] },
  instructions: "중요한 메일만 요약한다", capabilityId: "browser",
};

test("agent and team CRUD is exposed on the host and stored under its storage root", async () => {
  const { host, storageRoot } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  assert.deepEqual((await host.listAgents()).map((agent) => agent.id), [saved.id]);
  await fs.access(path.join(storageRoot, "agents", "agents.json"));
  const team = await host.saveTeam({ name: "T", title: "", description: "", avatar: agentInput.avatar, memberAgentIds: [saved.id] });
  assert.deepEqual((await host.listTeams()).map((item) => item.id), [team.id]);
  assert.equal((await host.archiveTeam(team.id)).archived, true);
  assert.equal((await host.archiveAgent(saved.id)).archived, true);
});

test("startAgentTask creates a normal task carrying the role and lists it as a conversation", async () => {
  const { host } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  const { taskId } = await host.startAgentTask({ agentId: saved.id, request: "받은 메일 정리" });
  const detail = await host.getTaskDetail(taskId);
  assert.equal(detail.goal.originalRequest, "받은 메일 정리");
  assert.deepEqual(detail.goal.constraints.map((constraint) => constraint.text), ["중요한 메일만 요약한다"]);
  const conversations = await host.listAgentConversations({ agentId: saved.id });
  assert.deepEqual(conversations.map((item) => item.taskId), [taskId]);
  assert.equal(conversations[0].task.taskId, taskId);
});

test("only an opted-in direct Agent start records its owner before browser construction", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-host-agent-profile-"));
  let observedProfileAtBrowserConstruction = null;
  const host = new TaskHost({
    storageRoot,
    makeBrowser: async (taskId) => {
      const raw = await fs.readFile(path.join(storageRoot, "tasks", taskId, "events.jsonl"), "utf8");
      const selected = raw.trim().split("\n").map(JSON.parse).find((event) => event.type === "task_profile_selected");
      observedProfileAtBrowserConstruction = selected?.payload?.agentBrowserProfile ?? null;
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) };
    },
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }) }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  hosts.add(host);
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const { taskId } = await host.startAgentTask({ agentId: saved.id, request: "use the saved Agent session" });
  assert.deepEqual(observedProfileAtBrowserConstruction, { agentId: saved.id });
  assert.deepEqual((await host.getTaskDetail(taskId)).taskProfile.agentBrowserProfile, { agentId: saved.id });

  const ordinary = await host.saveAgent({ ...agentInput, name: "Ephemeral" });
  const ephemeralTask = await host.startAgentTask({ agentId: ordinary.id, request: "use a temporary session" });
  assert.equal((await host.getTaskDetail(ephemeralTask.taskId)).taskProfile.agentBrowserProfile, undefined);
});

test("the roster, pin, duplicate, and read marker work through the host", async () => {
  const { host } = await makeHost();
  const saved = await host.saveAgent(agentInput);
  const copy = await host.duplicateAgent(saved.id);
  await host.setAgentPinned({ kind: "agent", id: copy.id, pinned: true });
  await host.startAgentTask({ agentId: saved.id, request: "받은 메일 정리" });
  const roster = await host.getAgentRoster();
  assert.deepEqual(roster.agents.map((item) => item.id), [copy.id, saved.id]);
  assert.ok(roster.agents[1].status.lastConversation);
  const { marked } = await host.markAgentConversationsRead({ agentId: saved.id });
  assert.equal(marked, 1);
});

test("agent methods fail closed after close()", async () => {
  const { host } = await makeHost();
  await host.close();
  await assert.rejects(host.listAgents());
  await assert.rejects(host.startAgentTask({ agentId: "x", request: "y" }));
});

test("public createTask selectors cannot spoof a persistent Agent profile owner", async () => {
  const { host } = await makeHost();
  await assert.rejects(
    host.createTask({ originalRequest: "spoof owner" }, { agentId: "11111111-1111-4111-8111-111111111111" }),
    { code: "invalid_selector" },
  );
});

test("turning off an Agent profile stops active bound tasks and keeps the Agent data", async () => {
  let disposed = 0;
  const { host, storageRoot } = await makeHost({
    maxParallelTasks: 1,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => { disposed += 1; } }),
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold for revocation" }) }),
  });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const task = await host.startAgentTask({ agentId: saved.id, request: "wait for revocation" });
  for (let i = 0; i < 200 && (await host.getTaskDetail(task.taskId)).snapshot?.state !== "paused"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  const disabled = await host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false });
  assert.equal(disabled.persistentBrowser, false);
  assert.equal((await host.listAgents()).find((agent) => agent.id === saved.id).name, saved.name, "the Agent record is retained");
  assert.equal(disposed, 1, "the active task browser is disposed before revocation returns");
  assert.equal((await host.listTasks()).find((item) => item.taskId === task.taskId).state, "stopped");
  const ephemeral = await host.startAgentTask({ agentId: saved.id, request: "do not use persistent profile" });
  assert.equal((await host.getTaskDetail(ephemeral.taskId)).taskProfile.agentBrowserProfile, undefined, "the Agent can still run in an isolated temporary session");
});

test("failed stop keeps a profile unavailable and does not report successful revocation", async () => {
  const { host } = await makeHost({ makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold" }) }) });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const task = await host.startAgentTask({ agentId: saved.id, request: "stop failure probe" });
  for (let i = 0; i < 200 && (await host.getTaskDetail(task.taskId)).snapshot?.state !== "paused"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  host._active.get(task.taskId).controller.stop = async () => { throw Object.assign(new Error("injected stop failure"), { code: "injected_stop_failure" }); };

  await assert.rejects(host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false }), { code: "agent_profile_revocation_failed" });
  assert.equal((await host.listAgents()).find((agent) => agent.id === saved.id).persistentBrowser, false);
  const ephemeral = await host.startAgentTask({ agentId: saved.id, request: "must remain isolated" });
  assert.equal((await host.getTaskDetail(ephemeral.taskId)).taskProfile.agentBrowserProfile, undefined, "a failed revocation never opts later tasks into the profile");
});

test("failed browser teardown keeps an Agent profile revocation unconfirmed and retryable", async () => {
  let disposeFailures = 1;
  let browsersBuilt = 0;
  const { host } = await makeHost({
    maxParallelTasks: 1,
    makeBrowser: () => {
      browsersBuilt += 1;
      return {
        observe: async () => ({ id: "obs" }),
        execute: async () => ({ status: "ok" }),
        dispose: async () => {
          if (disposeFailures-- > 0) throw new Error("injected browser dispose failure");
        },
      };
    },
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold for teardown failure" }) }),
  });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const task = await host.startAgentTask({ agentId: saved.id, request: "profile teardown failure probe" });
  for (let i = 0; i < 200 && (await host.getTaskDetail(task.taskId)).snapshot?.state !== "paused"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const queued = await host.createTask({ originalRequest: "must wait for the shared browser owner to close" });
  assert.equal(host._active.has(queued.taskId), false, "the second task remains queued behind the Agent browser");

  await assert.rejects(host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false }), { code: "agent_profile_revocation_failed" });
  assert.equal((await host.listAgents()).find((agent) => agent.id === saved.id).persistentBrowser, false);
  assert.equal(host._active.has(task.taskId), true, "the host retains the resource owner so teardown can be retried");
  assert.equal(host._active.has(queued.taskId), false, "a teardown failure cannot free the slot for another task");
  assert.equal(browsersBuilt, 1, "no second browser is built while the previous browser may still be alive");
  assert.equal(disposeFailures, 0);

  await host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false });
  assert.equal(host._active.has(task.taskId), false, "a repeated revocation retries failed cleanup and releases ownership only after success");
  for (let i = 0; i < 200 && !host._active.has(queued.taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host._active.has(queued.taskId), true, "the queued task is admitted after cleanup succeeds");
});

test("profile disable serializes behind an in-flight Agent task start", async () => {
  let releasePlanner;
  const plannerGate = new Promise((resolve) => { releasePlanner = resolve; });
  const { host } = await makeHost({ makePlanner: () => ({ next: async (context) => {
    await plannerGate;
    return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold" };
  } }) });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const start = host.startAgentTask({ agentId: saved.id, request: "start during revocation" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let disabledDone = false;
  const disable = host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false }).then((result) => { disabledDone = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disabledDone, false, "revocation waits for an admitted Agent start to settle");
  releasePlanner();
  const task = await start;
  const disabled = await disable;
  assert.equal(disabled.persistentBrowser, false);
  assert.equal((await host.listTasks()).find((item) => item.taskId === task.taskId).state, "stopped");
});

test("a queued profile task is skipped instead of attaching after its Agent opts out", async () => {
  let disposed = 0;
  const { host } = await makeHost({
    maxParallelTasks: 1,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => { disposed += 1; } }),
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold" }) }),
  });
  const blocker = await host.createTask({ originalRequest: "hold the only slot" });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const queued = await host.startAgentTask({ agentId: saved.id, request: "wait for a slot" });
  assert.equal(queued.snapshot.state, "queued");
  await host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false });
  assert.equal(host._queue.pendingIds().includes(queued.taskId), false, "revocation removes its pending FIFO entry immediately");
  assert.equal((await host.listTasks()).find((item) => item.taskId === queued.taskId).state, "stopped", "revocation durably stops the queued task before returning");
  await host.stopTask(blocker.taskId);
  for (let i = 0; i < 200 && (host._queue.pendingIds().length || host._queue.activeIds().length); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host._active.has(queued.taskId), false, "disabled profile task never attaches a browser");
  assert.equal(host._queue.pendingIds().includes(queued.taskId), false);
  assert.equal(host._queue.activeIds().includes(queued.taskId), false);
  assert.equal((await host.listTasks()).find((item) => item.taskId === queued.taskId).state, "stopped", "the skipped task is terminal across restart reconciliation");
  assert.ok(disposed >= 1, "only the blocker browser is created and disposed");
});

test("profile revocation retains a temporary TaskStore when close fails and host shutdown retries it", async () => {
  const { host } = await makeHost({ maxParallelTasks: 1 });
  const blocker = await host.createTask({ originalRequest: "hold the only slot" });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const queued = await host.startAgentTask({ agentId: saved.id, request: "queued profile cleanup" });
  assert.equal(queued.snapshot.state, "queued");

  const originalLoad = TaskStore.load;
  let closeFailureInjected = false;
  let revokedStore;
  TaskStore.load = async (...args) => {
    const store = await originalLoad.apply(TaskStore, args);
    if (store.taskId === queued.taskId) {
      revokedStore = store;
      const close = store.close.bind(store);
      store.close = async () => {
        if (!closeFailureInjected) {
          closeFailureInjected = true;
          throw new Error("injected profile-revocation store close failure");
        }
        return close();
      };
    }
    return store;
  };

  try {
    await assert.rejects(host.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false }), { code: "agent_profile_revocation_failed" });
    assert.equal(host._unattachedStoreClosures.get(queued.taskId)?.store, revokedStore, "the failed temporary close remains host-owned");
    assert.equal(host._queue.pendingIds().includes(queued.taskId), false, "the task stop remains durable even when close needs retry");
    await host.close();
    assert.equal(host._unattachedStoreClosures.has(queued.taskId), false);
    const reopened = await TaskStore.load(queued.taskId, { storageRoot: host._storageRoot });
    assert.equal(reopened.lastCheckpoint.payload.task.state, "stopped");
    await reopened.close();
  } finally {
    TaskStore.load = originalLoad;
  }
  await host.stopTask(blocker.taskId).catch(() => {});
});

test("profile revocation stops a queue-admitted task already waiting on the Agent lock", async () => {
  const persistentBrowserTasks = [];
  const { host, storageRoot } = await makeHost({
    maxParallelTasks: 1,
    makeBrowser: async (taskId) => {
      const raw = await fs.readFile(path.join(storageRoot, "tasks", taskId, "events.jsonl"), "utf8");
      const selected = raw.trim().split("\n").map(JSON.parse).find((event) => event.type === "task_profile_selected");
      if (selected?.payload?.agentBrowserProfile) persistentBrowserTasks.push(taskId);
      return { observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }), dispose: async () => {} };
    },
    makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold" }) }),
  });
  const blocker = await host.createTask({ originalRequest: "hold the only slot" });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const queued = await host.startAgentTask({ agentId: saved.id, request: "wait for the queue slot" });
  assert.equal(queued.snapshot.state, "queued");

  let releaseProfileLock;
  let announceProfileLock;
  const profileLockHeld = new Promise((resolve) => { announceProfileLock = resolve; });
  const heldProfileLock = host._withAgentProfileLock(saved.id, () => new Promise((resolve) => {
    releaseProfileLock = resolve;
    announceProfileLock();
  }));
  await profileLockHeld;
  try {
    await host.stopTask(blocker.taskId);
    for (let i = 0; i < 500 && !host._queue.activeIds().includes(queued.taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(host._queue.activeIds().includes(queued.taskId), "the released slot admits the waiting profile task");
    for (let i = 0; i < 500 && !host._queuedStores.has(queued.taskId); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(host._queuedStores.has(queued.taskId), "the task store is open while queued execution waits on the profile lock");

    // This is the store mutation performed inside saveAgent(), while the held
    // profile lock is the same serialization boundary used by the public path.
    const disabled = await host._agentStore.saveAgent({ ...agentInput, id: saved.id, persistentBrowser: false });
    await host._revokeAgentBrowserTasks(disabled.id);
    assert.equal(host._queue.activeIds().includes(queued.taskId), false);
    assert.equal(host._queue.pendingIds().includes(queued.taskId), false);
    assert.equal((await host.listTasks()).find((item) => item.taskId === queued.taskId).state, "stopped");
    assert.equal((await host.getTaskDetail(queued.taskId)).snapshot.state, "stopped");
  } finally {
    releaseProfileLock();
    await heldProfileLock;
  }
  for (let i = 0; i < 500 && host._queuedStartPromises.has(queued.taskId); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host._active.has(queued.taskId), false);
  assert.equal(persistentBrowserTasks.includes(queued.taskId), false, "revoked queue work never constructs a browser surface");
});

test("a queued-store readiness waiter is released when host shutdown rejects the queued start", async () => {
  const { host } = await makeHost();
  const taskId = "00000000-0000-4000-8000-000000000001";
  const started = host._startQueued(taskId);
  const ready = host._queuedStoreReady.get(taskId);
  await host.close();
  await assert.rejects(started, { code: "host_closed" });
  assert.equal(await ready, null);
});

test("archiving an opted-in Agent also stops its active profile tasks", async () => {
  const { host } = await makeHost({ makePlanner: () => ({ next: async (context) => ({ taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "need_user", reason: "hold" }) }) });
  const saved = await host.saveAgent({ ...agentInput, persistentBrowser: true });
  const task = await host.startAgentTask({ agentId: saved.id, request: "archive probe" });
  for (let i = 0; i < 200 && (await host.getTaskDetail(task.taskId)).snapshot?.state !== "paused"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await host.archiveAgent(saved.id)).archived, true);
  assert.equal((await host.listTasks()).find((item) => item.taskId === task.taskId).state, "stopped");
});
