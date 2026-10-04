"use strict";

// The Agent roster methods are reachable through the same three allowlists as
// every other TaskHost method: main/ipc.js (trusted-sender gated), the preload
// bridge, and the background runtime's TASK_HOST_METHODS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const registerIpc = require("../main/ipc");
const { TASK_HOST_METHODS } = require("../main/harness/background-runtime-service");

const AGENT_METHODS = [
  "listAgents", "saveAgent", "archiveAgent", "listTeams", "saveTeam", "archiveTeam",
  "startAgentTask", "listAgentConversations",
  "getAgentRoster", "setAgentPinned", "duplicateAgent", "markAgentConversationsRead",
  "listAgentSchedules", "saveAgentSchedule", "deleteAgentSchedule",
];

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, event, ...args) => handlers.get(channel)(event, ...args),
  };
}

test("agent channels dispatch to the host only for the trusted main frame", async () => {
  const ipcMain = fakeIpcMain();
  const mainFrame = { url: "file:///app/renderer/index.html" };
  const win = { isDestroyed: () => false, webContents: { mainFrame, send: () => {} }, on: () => {} };
  const calls = [];
  const taskHost = { onEvent: () => () => {} };
  for (const method of AGENT_METHODS) taskHost[method] = async (...args) => { calls.push(method); return { method, args }; };
  const controlApi = { getSnapshot: async () => ({}), navigate: async () => ({}), takeOverTask: async () => ({}), onChange: () => () => {} };
  registerIpc(win, controlApi, { ipcMain, taskHost });

  for (const method of AGENT_METHODS) {
    assert.deepEqual(await ipcMain.invoke(`halo:${method}`, { senderFrame: mainFrame }, { x: 1 }), { method, args: [{ x: 1 }] });
    await assert.rejects(() => Promise.resolve(ipcMain.invoke(`halo:${method}`, { senderFrame: { url: "https://attacker.example/" } })), /untrusted sender/);
  }
  assert.deepEqual(calls, AGENT_METHODS);
});

test("agent methods are on the background runtime and preload allowlists", () => {
  for (const method of AGENT_METHODS) assert.ok(TASK_HOST_METHODS.has(method), method);
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload", "index.js"), "utf8");
  for (const method of AGENT_METHODS) assert.match(preload, new RegExp(`"${method}"`), method);
});
