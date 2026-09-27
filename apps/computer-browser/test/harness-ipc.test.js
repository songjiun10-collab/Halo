"use strict";

// Tests for main/ipc.js's harness wiring (Task 5): the new task-scoped
// channels (createTask/listTasks/resumeSavedTask/amendTask/confirmCriterion/
// getTaskDetail/taskApprove/taskDeny/taskPause/taskStop) must be gated by
// isTrustedSender(event, win) -- a subframe/remote sender must never reach
// taskHost. The legacy channels (getSnapshot/navigate/startTask/... ,
// unchanged names/signatures) must keep working exactly as before.
//
// main/ipc.js requires "electron" at module load for ipcMain -- that
// resolves to a path STRING outside a real Electron process (confirmed:
// requiring "electron" under plain node returns the binary path, not an
// object), so registerIpc must accept an injectable ipcMain to be testable
// at all here. This is the same injection-seam pattern already used
// throughout this codebase (control-api.js's requestDecision, etc.).

const test = require("node:test");
const assert = require("node:assert/strict");
const registerIpc = require("../main/ipc");

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    _invoke: (channel, event, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for ${channel}`);
      return fn(event, ...args);
    },
    _has: (channel) => handlers.has(channel),
  };
}

function makeFakeWin({ destroyed = false, mainFrameUrl = "file:///app/renderer/index.html" } = {}) {
  const mainFrame = { url: mainFrameUrl };
  const sent = [];
  return {
    isDestroyed: () => destroyed,
    webContents: { mainFrame, send: (channel, payload) => sent.push({ channel, payload }) },
    on: () => {},
    _mainFrame: mainFrame,
    _sent: sent,
  };
}

function trustedEvent(win) {
  return { senderFrame: win._mainFrame };
}

function untrustedEvent() {
  return { senderFrame: { url: "https://attacker.example/" } };
}

function makeFakeControlApi() {
  return {
    getSnapshot: async () => ({ page: {}, task: {}, approvalQueue: [], timeline: [] }),
    navigate: async (url) => ({ navigated: url }),
    takeOverTask: async () => ({ task: { state: "paused", pauseReason: "user_takeover" } }),
    onChange: () => () => {},
  };
}

function makeFakeTaskHost() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return { ok: name, args };
  };
  return {
    calls,
    createTask: record("createTask"),
    listTasks: record("listTasks"),
    resumeSavedTask: record("resumeSavedTask"),
    amendTask: record("amendTask"),
    confirmCriterion: record("confirmCriterion"),
    getTaskDetail: record("getTaskDetail"),
    approveTask: record("approveTask"),
    denyTask: record("denyTask"),
    pauseTask: record("pauseTask"),
    stopTask: record("stopTask"),
    takeOverTask: record("takeOverTask"),
  };
}

test("legacy channels still register and dispatch to controlApi unchanged", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const controlApi = makeFakeControlApi();

  registerIpc(win, controlApi, { ipcMain });

  assert.ok(ipcMain._has("halo:getSnapshot"));
  assert.ok(ipcMain._has("halo:navigate"));
  assert.ok(ipcMain._has("halo:takeOverTask"));
  const result = await ipcMain._invoke("halo:navigate", trustedEvent(win), "https://example.com");
  assert.deepEqual(result, { navigated: "https://example.com" });
  assert.deepEqual(await ipcMain._invoke("halo:takeOverTask", trustedEvent(win)), {
    task: { state: "paused", pauseReason: "user_takeover" },
  });
});

test("legacy channels work even from an untrusted sender (unchanged behavior -- not newly gated)", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const controlApi = makeFakeControlApi();

  registerIpc(win, controlApi, { ipcMain });

  const result = await ipcMain._invoke("halo:navigate", untrustedEvent(), "https://example.com");
  assert.deepEqual(result, { navigated: "https://example.com" });
});

test("registerIpc without a taskHost does not register any harness channel", () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  registerIpc(win, makeFakeControlApi(), { ipcMain });

  assert.equal(ipcMain._has("halo:createTask"), false);
});

test("harness channels dispatch to taskHost for a trusted sender", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  const result = await ipcMain._invoke("halo:createTask", trustedEvent(win), { originalRequest: "hi" });
  assert.deepEqual(result, { ok: "createTask", args: [{ originalRequest: "hi" }] });

  await ipcMain._invoke("halo:amendTask", trustedEvent(win), "task-1", { text: "x" });
  await ipcMain._invoke("halo:confirmCriterion", trustedEvent(win), "task-1", { criterionId: "c1" });
  await ipcMain._invoke("halo:taskApprove", trustedEvent(win), "task-1", "req-1");
  await ipcMain._invoke("halo:taskDeny", trustedEvent(win), "task-1", "req-1");
  await ipcMain._invoke("halo:taskPause", trustedEvent(win), "task-1");
  await ipcMain._invoke("halo:taskStop", trustedEvent(win), "task-1");
  await ipcMain._invoke("halo:taskTakeOver", trustedEvent(win), "task-1", "user_takeover");
  await ipcMain._invoke("halo:resumeSavedTask", trustedEvent(win), "task-1");
  await ipcMain._invoke("halo:getTaskDetail", trustedEvent(win), "task-1");
  await ipcMain._invoke("halo:listTasks", trustedEvent(win));

  assert.deepEqual(
    taskHost.calls.map((c) => c[0]),
    ["createTask", "amendTask", "confirmCriterion", "approveTask", "denyTask", "pauseTask", "stopTask", "takeOverTask", "resumeSavedTask", "getTaskDetail", "listTasks"],
  );
});

test("every harness channel rejects a request from an untrusted (non-main-frame) sender without calling taskHost", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  const channels = [
    ["halo:createTask", [{ originalRequest: "hi" }]],
    ["halo:listTasks", []],
    ["halo:resumeSavedTask", ["task-1"]],
    ["halo:amendTask", ["task-1", { text: "x" }]],
    ["halo:confirmCriterion", ["task-1", { criterionId: "c1" }]],
    ["halo:getTaskDetail", ["task-1"]],
    ["halo:taskApprove", ["task-1", "req-1"]],
    ["halo:taskDeny", ["task-1", "req-1"]],
    ["halo:taskPause", ["task-1"]],
    ["halo:taskStop", ["task-1"]],
    ["halo:taskTakeOver", ["task-1", "user_takeover"]],
  ];

  for (const [channel, args] of channels) {
    await assert.rejects(
      () => Promise.resolve(ipcMain._invoke(channel, untrustedEvent(), ...args)),
      /untrusted|trusted sender/i,
      `${channel} must reject an untrusted sender`,
    );
  }
  assert.equal(taskHost.calls.length, 0, "taskHost must never be called for any untrusted-sender request");
});

test("removeHandler is called for every registered channel (legacy + harness) on window close", () => {
  const ipcMain = makeFakeIpcMain();
  let closeHandler = null;
  const win = makeFakeWin();
  win.on = (event, fn) => {
    if (event === "closed") closeHandler = fn;
  };
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  assert.ok(ipcMain._has("halo:createTask"));
  closeHandler();
  assert.equal(ipcMain._has("halo:createTask"), false);
  assert.equal(ipcMain._has("halo:navigate"), false);
});
