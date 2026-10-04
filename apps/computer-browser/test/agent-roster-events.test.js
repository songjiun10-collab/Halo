"use strict";

// Agent roster change notices reach the UI without a poll: TaskHost emits a
// content-free {kind, id, change} notice, main/ipc.js forwards it on
// halo:agentRosterEvent, and the background runtime broadcasts it. The UI
// re-reads getAgentRoster(); no profile text travels in the notice.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskHost } = require("../main/harness/task-host");
const { AGENT_SHAPES, AGENT_COLORS } = require("../main/harness/agent-store");
const registerIpc = require("../main/ipc");
const { BackgroundRuntimeService } = require("../main/harness/background-runtime-service");
const { RuntimeIpcClient } = require("../main/harness/background-runtime-ipc");

const avatar = { shape: AGENT_SHAPES[0], color: AGENT_COLORS[0] };
const agentInput = { name: "A", title: "", description: "", avatar, instructions: "비밀스러운 지시", capabilityId: "browser" };

test("TaskHost emits a content-free notice for every roster change", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-roster-events-"));
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: () => ({ next: async (c) => ({ taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] }) }),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  const notices = [];
  const unsubscribe = host.onAgentRosterEvent((notice) => notices.push(notice));
  try {
    const agent = await host.saveAgent(agentInput);
    const copy = await host.duplicateAgent(agent.id);
    await host.setAgentPinned({ kind: "agent", id: copy.id, pinned: true });
    const team = await host.saveTeam({ name: "T", title: "", description: "", avatar, memberAgentIds: [agent.id] });
    await host.startAgentTask({ agentId: agent.id, request: "x" });
    await host.markAgentConversationsRead({ agentId: agent.id });
    await host.archiveTeam(team.id);
    await host.archiveAgent(copy.id);
    // A failed mutation emits nothing.
    await assert.rejects(host.saveAgent({ ...agentInput, name: "" }));
    assert.deepEqual(notices, [
      { kind: "agent", id: agent.id, change: "saved" },
      { kind: "agent", id: copy.id, change: "saved" },
      { kind: "agent", id: copy.id, change: "pinned" },
      { kind: "team", id: team.id, change: "saved" },
      { kind: "agent", id: agent.id, change: "conversation_started" },
      { kind: "agent", id: agent.id, change: "read" },
      { kind: "team", id: team.id, change: "archived" },
      { kind: "agent", id: copy.id, change: "archived" },
    ]);
    assert.ok(!JSON.stringify(notices).includes("비밀"));
    unsubscribe();
    await host.saveAgent(agentInput);
    assert.equal(notices.length, 8);
  } finally {
    await host.close();
  }
});

test("main/ipc.js forwards roster notices to the window on halo:agentRosterEvent", () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const sent = [];
  let closed;
  const win = { isDestroyed: () => false, webContents: { mainFrame: { url: "file:///app/renderer/index.html" }, send: (channel, payload) => sent.push({ channel, payload }) }, on: (event, fn) => { if (event === "closed") closed = fn; } };
  let rosterListener = null;
  const taskHost = { onEvent: () => () => {}, onAgentRosterEvent: (fn) => { rosterListener = fn; return () => { rosterListener = null; }; } };
  const controlApi = { getSnapshot: async () => ({}), navigate: async () => ({}), takeOverTask: async () => ({}), onChange: () => () => {} };
  registerIpc(win, controlApi, { ipcMain, taskHost });
  rosterListener({ kind: "agent", id: "a", change: "saved" });
  assert.deepEqual(sent, [{ channel: "halo:agentRosterEvent", payload: { kind: "agent", id: "a", change: "saved" } }]);
  closed();
  assert.equal(rosterListener, null);
});

test("the background runtime broadcasts roster notices to attached clients", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-roster-runtime-"));
  let rosterListener = null;
  const taskHost = {
    onEvent: () => () => {},
    onAgentRosterEvent: (fn) => { rosterListener = fn; return () => { rosterListener = null; }; },
    close: async () => {},
  };
  const service = new BackgroundRuntimeService({ socketPath: path.join(root, "runtime.sock"), taskHost });
  const { capability } = await service.start();
  const client = new RuntimeIpcClient({ socketPath: path.join(root, "runtime.sock"), capability, clientId: "ui-1" });
  await client.connect();
  await client.call("attachClient", "ui-1");
  const received = [];
  client.on("agentRosterEvent", (payload) => received.push(payload));
  rosterListener({ kind: "team", id: "t", change: "archived" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(received, [{ kind: "team", id: "t", change: "archived" }]);
  await client.close();
  await service.stopService("test done");
  assert.equal(rosterListener, null);
});
