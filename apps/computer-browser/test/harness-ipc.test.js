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
  let listener = null;
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
    getTaskEvents: record("getTaskEvents"),
    getTaskBrowser: record("getTaskBrowser"),
    taskBrowserAction: record("taskBrowserAction"),
    setTaskViewport: record("setTaskViewport"),
    listRoutines: record("listRoutines"),
    getRoutine: record("getRoutine"),
    saveRoutine: record("saveRoutine"),
    deleteRoutine: record("deleteRoutine"),
    runRoutine: record("runRoutine"),
    startWorkGoal: record("startWorkGoal"),
    getActiveWorkGoal: record("getActiveWorkGoal"),
    listWorkGoalHistory: record("listWorkGoalHistory"),
    amendWorkGoal: record("amendWorkGoal"),
    pauseWorkGoal: record("pauseWorkGoal"),
    resumeWorkGoal: record("resumeWorkGoal"),
    completeWorkGoal: record("completeWorkGoal"),
    archiveWorkGoal: record("archiveWorkGoal"),
    recordWorkGoalProgress: record("recordWorkGoalProgress"),
    verifyWorkGoalCriterion: record("verifyWorkGoalCriterion"),
    getWorkGoalRecoveryStatus: record("getWorkGoalRecoveryStatus"),
    repairWorkGoalReservation: record("repairWorkGoalReservation"),
    importSessions: record("importSessions"),
    listImportedSessions: record("listImportedSessions"),
    removeImportedSession: record("removeImportedSession"),
    getSessionAllowlist: record("getSessionAllowlist"),
    setSessionAllowlist: record("setSessionAllowlist"),
    importBrowserSettings: record("importBrowserSettings"),
    getImportedSettings: record("getImportedSettings"),
    onEvent: (callback) => { listener = callback; return () => { listener = null; }; },
    _emit: (...args) => listener?.(...args),
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

test("newWindow opens only through the trusted shell UI bridge", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  let opened = 0;
  registerIpc(win, makeFakeControlApi(), { ipcMain, onNewWindow: async () => { opened += 1; return { opened: true }; } });

  assert.deepEqual(await ipcMain._invoke("halo:newWindow", trustedEvent(win)), { opened: true });
  assert.equal(opened, 1);
  await assert.rejects(ipcMain._invoke("halo:newWindow", untrustedEvent()), /rejected untrusted sender/);
  assert.equal(opened, 1, "untrusted content cannot ask the main process to create windows");
});

test("one process-global IPC handler routes multiple Halo windows to their own browser hosts", async () => {
  const ipcMain = makeFakeIpcMain();
  const firstWindow = makeFakeWin();
  const secondWindow = makeFakeWin();
  let closeFirst;
  let closeSecond;
  firstWindow.on = (_event, handler) => { closeFirst = handler; };
  secondWindow.on = (_event, handler) => { closeSecond = handler; };
  let firstOpens = 0;
  let secondOpens = 0;
  const firstApi = { ...makeFakeControlApi(), navigate: async (url) => ({ window: "first", url }) };
  const secondApi = { ...makeFakeControlApi(), navigate: async (url) => ({ window: "second", url }) };
  registerIpc(firstWindow, firstApi, { ipcMain, onNewWindow: async () => { firstOpens += 1; return { opened: "first" }; } });
  registerIpc(secondWindow, secondApi, { ipcMain, onNewWindow: async () => { secondOpens += 1; return { opened: "second" }; } });

  assert.deepEqual(await ipcMain._invoke("halo:navigate", trustedEvent(secondWindow), "https://example.com"), { window: "second", url: "https://example.com" });
  assert.deepEqual(await ipcMain._invoke("halo:newWindow", trustedEvent(firstWindow)), { opened: "first" });
  closeFirst();
  assert.ok(ipcMain._has("halo:navigate"), "closing one window must not unregister handlers used by another");
  assert.deepEqual(await ipcMain._invoke("halo:newWindow", trustedEvent(secondWindow)), { opened: "second" });
  assert.equal(firstOpens, 1);
  assert.equal(secondOpens, 1);
  closeSecond();
  assert.equal(ipcMain._has("halo:navigate"), false, "closing the final window releases process-global handlers");
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
  await ipcMain._invoke("halo:getTaskEvents", trustedEvent(win), "task-1", { since: 3 });
  await ipcMain._invoke("halo:getTaskBrowser", trustedEvent(win), "task-1");
  await ipcMain._invoke("halo:taskBrowserAction", trustedEvent(win), "task-1", { type: "back" });
  await ipcMain._invoke("halo:setTaskViewport", trustedEvent(win), "task-1", { x: 1, y: 94, width: 10, height: 10, visible: true });

  assert.deepEqual(
    taskHost.calls.map((c) => c[0]),
    ["createTask", "amendTask", "confirmCriterion", "approveTask", "denyTask", "pauseTask", "stopTask", "takeOverTask", "resumeSavedTask", "getTaskDetail", "listTasks", "getTaskEvents", "getTaskBrowser", "taskBrowserAction", "setTaskViewport"],
  );
});

test("trusted createTask IPC forwards the optional host profile selectors unchanged", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  const goal = { originalRequest: "quickly inspect this page" };
  const selectors = { requestedDurationProfile: "long", requestedCapabilityProfile: "browser" };
  const result = await ipcMain._invoke("halo:createTask", trustedEvent(win), goal, selectors);
  assert.deepEqual(result, { ok: "createTask", args: [goal, selectors] });
});

test("Work Goal lifecycle IPC maps only to trusted host methods", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });
  const calls = [
    ["halo:startWorkGoal", [{ objective: "x" }], "startWorkGoal"],
    ["halo:getActiveWorkGoal", [], "getActiveWorkGoal"],
    ["halo:listWorkGoalHistory", [{ limit: 25, cursor: "00000000-0000-4000-8000-000000000001" }], "listWorkGoalHistory"],
    ["halo:amendWorkGoal", [1, { objective: "y" }], "amendWorkGoal"],
    ["halo:pauseWorkGoal", ["goal-id", 1], "pauseWorkGoal"],
    ["halo:resumeWorkGoal", ["goal-id", 1], "resumeWorkGoal"],
    ["halo:completeWorkGoal", ["goal-id", 1], "completeWorkGoal"],
    ["halo:archiveWorkGoal", ["goal-id", 1], "archiveWorkGoal"],
    ["halo:recordWorkGoalProgress", ["goal-id", 1, []], "recordWorkGoalProgress"],
    ["halo:verifyWorkGoalCriterion", ["goal-id", 1, "criterion"], "verifyWorkGoalCriterion"],
    ["halo:getWorkGoalRecoveryStatus", ["goal-id", 1], "getWorkGoalRecoveryStatus"],
    ["halo:repairWorkGoalReservation", ["goal-id", 1, "reservation-id"], "repairWorkGoalReservation"],
    ["halo:importSessions", [{ browser: "chrome", profile: "Default" }], "importSessions"],
    ["halo:listImportedSessions", [], "listImportedSessions"],
    ["halo:removeImportedSession", ["claude.ai"], "removeImportedSession"],
    ["halo:getSessionAllowlist", [], "getSessionAllowlist"],
    ["halo:setSessionAllowlist", [["claude.ai"]], "setSessionAllowlist"],
    ["halo:importBrowserSettings", [{ browser: "chrome" }], "importBrowserSettings"],
    ["halo:getImportedSettings", [], "getImportedSettings"],
  ];
  for (const [channel, methodArgs, method] of calls) {
    assert.deepEqual(await ipcMain._invoke(channel, trustedEvent(win), ...methodArgs), { ok: method, args: methodArgs });
  }
});

test("routine channels dispatch exactly five trusted host operations and reject untrusted senders", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });
  const calls = [
    ["listRoutines", []], ["getRoutine", ["routine-1", 2]],
    ["saveRoutine", [{ name: "Routine" }]], ["deleteRoutine", ["routine-1"]],
    ["runRoutine", ["routine-1", 2]],
  ];
  for (const [method, args] of calls) {
    assert.deepEqual(await ipcMain._invoke(`halo:${method}`, trustedEvent(win), ...args), { ok: method, args });
    await assert.rejects(() => Promise.resolve(ipcMain._invoke(`halo:${method}`, untrustedEvent(), ...args)), /untrusted sender/);
  }
  assert.deepEqual(taskHost.calls.map((call) => call[0]), calls.map(([method]) => method));
});

test("taskHost events are forwarded on the task-specific channel and unsubscribed on close", () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  let closeHandler;
  win.on = (event, callback) => { if (event === "closed") closeHandler = callback; };
  const taskHost = makeFakeTaskHost();
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  const snapshot = { state: "paused", approvalQueue: [] };
  taskHost._emit("task-1", snapshot, { goal: { originalRequest: "goal" } });
  assert.deepEqual(win._sent.at(-1), {
    channel: "halo:taskEvent",
    payload: { taskId: "task-1", snapshot, goal: { originalRequest: "goal" } },
  });
  closeHandler();
  const sentCount = win._sent.length;
  taskHost._emit("task-1", snapshot);
  assert.equal(win._sent.length, sentCount);
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
    ["halo:getTaskEvents", ["task-1", { since: 3 }]],
    ["halo:getTaskBrowser", ["task-1"]],
    ["halo:taskBrowserAction", ["task-1", { type: "back" }]],
    ["halo:setTaskViewport", ["task-1", { x: 1, y: 94, width: 10, height: 10, visible: true }]],
    ["halo:startWorkGoal", [{ objective: "hi" }]],
    ["halo:getActiveWorkGoal", []],
    ["halo:listWorkGoalHistory", [{ limit: 7, cursor: null }]],
    ["halo:amendWorkGoal", [1, { objective: "new" }]],
    ["halo:pauseWorkGoal", ["goal-1", 1]],
    ["halo:resumeWorkGoal", ["goal-1", 1]],
    ["halo:completeWorkGoal", ["goal-1", 1]],
    ["halo:archiveWorkGoal", ["goal-1", 1]],
    ["halo:recordWorkGoalProgress", ["goal-1", 1, []]],
    ["halo:verifyWorkGoalCriterion", ["goal-1", 1, "c1"]],
    ["halo:getWorkGoalRecoveryStatus", ["goal-1", 1]],
    ["halo:repairWorkGoalReservation", ["goal-1", 1, "reservation-1"]],
    ["halo:importSessions", [{ browser: "chrome" }]],
    ["halo:listImportedSessions", []],
    ["halo:removeImportedSession", ["claude.ai"]],
    ["halo:getSessionAllowlist", []],
    ["halo:setSessionAllowlist", [["claude.ai"]]],
    ["halo:importBrowserSettings", [{ browser: "chrome" }]],
    ["halo:getImportedSettings", []],
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

test("agent roster channels carry the host error code across IPC in the message", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  taskHost.saveAgent = async () => { throw Object.assign(new Error("agent limit reached"), { code: "limit_reached" }); };
  taskHost.archiveTeam = () => { throw Object.assign(new Error("team is archived"), { code: "archived" }); };
  taskHost.listAgents = async () => { throw new Error("plain failure"); };
  taskHost.createTask = async () => { throw Object.assign(new Error("bad task"), { code: "invalid_task" }); };
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  await assert.rejects(ipcMain._invoke("halo:saveAgent", trustedEvent(win), {}), (error) => {
    assert.equal(error.message, "[limit_reached] agent limit reached");
    assert.equal(error.code, "limit_reached");
    return true;
  });
  await assert.rejects(ipcMain._invoke("halo:archiveTeam", trustedEvent(win), "t1"), { message: "[archived] team is archived" });
  await assert.rejects(ipcMain._invoke("halo:listAgents", trustedEvent(win)), { message: "plain failure" });
  // Channels outside the agent roster keep their existing messages.
  await assert.rejects(ipcMain._invoke("halo:createTask", trustedEvent(win), {}), { message: "bad task" });
});

test("room channels dispatch to the TaskHost and room events reach the window", async () => {
  const ipcMain = makeFakeIpcMain();
  const win = makeFakeWin();
  const taskHost = makeFakeTaskHost();
  let roomListener = null;
  taskHost.postRoomMessage = async (input) => ({ posted: input });
  taskHost.getRoom = async (teamId) => ({ roomId: teamId });
  taskHost.listRooms = async () => [];
  taskHost.stopRoomRound = async () => { throw Object.assign(new Error("no such room"), { code: "invalid_room" }); };
  taskHost.onRoomEvent = (listener) => { roomListener = listener; return () => { roomListener = null; }; };
  registerIpc(win, makeFakeControlApi(), { ipcMain, taskHost });

  assert.deepEqual(await ipcMain._invoke("halo:postRoomMessage", trustedEvent(win), { teamId: "t", text: "hi" }), { posted: { teamId: "t", text: "hi" } });
  assert.deepEqual(await ipcMain._invoke("halo:getRoom", trustedEvent(win), "t"), { roomId: "t" });
  assert.deepEqual(await ipcMain._invoke("halo:listRooms", trustedEvent(win)), []);
  await assert.rejects(ipcMain._invoke("halo:stopRoomRound", trustedEvent(win), "t"), { message: "[invalid_room] no such room" });
  await assert.rejects(() => Promise.resolve(ipcMain._invoke("halo:postRoomMessage", untrustedEvent(), {})), /untrusted sender/);
  roomListener({ roomId: "t", message: { text: "hi" } });
  assert.deepEqual(win._sent.at(-1), { channel: "halo:roomEvent", payload: { roomId: "t", message: { text: "hi" } } });
});
