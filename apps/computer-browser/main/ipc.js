"use strict";

const { isTrustedSender } = require("./harness/trusted-sender");
const { BackgroundRuntimeUi } = require("./harness/background-runtime-ui");
const { captureVisibleSurface } = require("./surface-snapshot");
const registries = new WeakMap();

// Exactly the method surface preload exposes as window.haloBrowser. No
// channel here accepts a raw path/eval/shell string -- every argument is
// whatever ControlApi's own method signature validates.
const LEGACY_METHODS = [
  "getSnapshot", "navigate", "startTask", "pauseTask", "resumeTask", "resumeAfterCaptcha", "stopTask", "takeOverTask",
  "goBack", "goForward", "reload", "newTab", "selectTab", "closeTab", "approve", "deny", "setBrowserBounds", "getMetricsSummary",
];

// New long-horizon harness channels (design doc section 8), each mapped to
// the identically-named method on taskHost (main/harness/task-host.js) with
// the exact same argument order preload passes through, EXCEPT taskPause/
// taskStop/taskApprove/taskDeny which are named distinctly from the legacy
// pauseTask/stopTask/approve/deny channels above -- those operate on
// taskHost's method of the same purpose but need a taskId first argument,
// and reusing the legacy channel name for a different signature would be a
// silent, easy-to-miss breaking change for the legacy demo.
const HARNESS_METHODS = {
  "halo:createTask": "createTask",
  "halo:listTasks": "listTasks",
  "halo:resumeSavedTask": "resumeSavedTask",
  "halo:amendTask": "amendTask",
  "halo:confirmCriterion": "confirmCriterion",
  "halo:getTaskDetail": "getTaskDetail",
  "halo:taskApprove": "approveTask",
  "halo:taskDeny": "denyTask",
  "halo:taskLend": "lendTask",
  "halo:taskRevokeLease": "revokeTaskLease",
  "halo:taskPause": "pauseTask",
  "halo:taskStop": "stopTask",
  "halo:taskTakeOver": "takeOverTask",
  "halo:getTaskEvents": "getTaskEvents",
  "halo:getChildPlan": "getChildPlan",
  "halo:listMcpProviders": "listMcpProviders",
  "halo:getTaskBrowser": "getTaskBrowser",
  "halo:taskBrowserAction": "taskBrowserAction",
  "halo:setTaskViewport": "setTaskViewport",
  "halo:getHostSettings": "getHostSettings",
  "halo:getUsage": "getUsage",
  "halo:setUsageLimit": "setUsageLimit",
  "halo:syncUsage": "syncUsage",
  "halo:updateHostSettings": "updateHostSettings",
  "halo:listCredentials": "listCredentials",
  "halo:saveCredential": "saveCredential",
  "halo:removeCredential": "removeCredential",
  "halo:listMemories": "listMemories",
  "halo:saveMemory": "saveMemory",
  "halo:removeMemory": "removeMemory",
  "halo:fillCredential": "fillCredential",
  "halo:listRoutines": "listRoutines",
  "halo:getRoutine": "getRoutine",
  "halo:saveRoutine": "saveRoutine",
  "halo:deleteRoutine": "deleteRoutine",
  "halo:runRoutine": "runRoutine",
  "halo:listAgents": "listAgents",
  "halo:saveAgent": "saveAgent",
  "halo:archiveAgent": "archiveAgent",
  "halo:listTeams": "listTeams",
  "halo:saveTeam": "saveTeam",
  "halo:archiveTeam": "archiveTeam",
  "halo:startAgentTask": "startAgentTask",
  "halo:listAgentConversations": "listAgentConversations",
  "halo:getAgentRoster": "getAgentRoster",
  "halo:setAgentPinned": "setAgentPinned",
  "halo:duplicateAgent": "duplicateAgent",
  "halo:markAgentConversationsRead": "markAgentConversationsRead",
  "halo:listAgentSchedules": "listAgentSchedules",
  "halo:saveAgentSchedule": "saveAgentSchedule",
  "halo:deleteAgentSchedule": "deleteAgentSchedule",
  "halo:listRooms": "listRooms",
  "halo:getRoom": "getRoom",
  "halo:postRoomMessage": "postRoomMessage",
  "halo:stopRoomRound": "stopRoomRound",
  "halo:startWorkGoal": "startWorkGoal",
  "halo:getActiveWorkGoal": "getActiveWorkGoal",
  "halo:listWorkGoalHistory": "listWorkGoalHistory",
  "halo:amendWorkGoal": "amendWorkGoal",
  "halo:pauseWorkGoal": "pauseWorkGoal",
  "halo:resumeWorkGoal": "resumeWorkGoal",
  "halo:completeWorkGoal": "completeWorkGoal",
  "halo:archiveWorkGoal": "archiveWorkGoal",
  "halo:recordWorkGoalProgress": "recordWorkGoalProgress",
  "halo:verifyWorkGoalCriterion": "verifyWorkGoalCriterion",
  "halo:getWorkGoalRecoveryStatus": "getWorkGoalRecoveryStatus",
  "halo:repairWorkGoalReservation": "repairWorkGoalReservation",
  "halo:importSessions": "importSessions",
  "halo:listImportedSessions": "listImportedSessions",
  "halo:removeImportedSession": "removeImportedSession",
  "halo:getSessionAllowlist": "getSessionAllowlist",
  "halo:setSessionAllowlist": "setSessionAllowlist",
  "halo:importBrowserSettings": "importBrowserSettings",
  "halo:getImportedSettings": "getImportedSettings",
};

// Electron's invoke keeps only an error's message, so the agent roster's
// stable codes (limit_reached, archived, ...) ride in it as "[code] message".
// Other channels keep their existing messages.
const CODED_CHANNELS = new Set([
  "halo:listAgents", "halo:saveAgent", "halo:archiveAgent", "halo:duplicateAgent",
  "halo:listTeams", "halo:saveTeam", "halo:archiveTeam", "halo:startAgentTask",
  "halo:listAgentConversations", "halo:markAgentConversationsRead", "halo:getAgentRoster",
  "halo:setAgentPinned", "halo:listAgentSchedules", "halo:saveAgentSchedule",
  "halo:deleteAgentSchedule", "halo:listMcpProviders", "halo:getChildPlan",
  "halo:listRooms", "halo:getRoom", "halo:postRoomMessage", "halo:stopRoomRound",
]);
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function withErrorCode(error) {
  const code = error?.code;
  if (typeof code !== "string" || !ERROR_CODE_RE.test(code)) throw error;
  const coded = new Error(`[${code}] ${error.message}`, { cause: error });
  coded.code = code;
  throw coded;
}

// The renderer's BackgroundRuntimeApi, answered per window.
const RUNTIME_UI_METHODS = {
  "halo:getBackgroundRuntimeSnapshot": "getSnapshot",
  "halo:attachBackgroundRuntime": "attach",
  "halo:detachBackgroundRuntime": "detach",
  "halo:setMemoryPolicy": "setMemoryPolicy",
  "halo:stopBackgroundService": "stopService",
  "halo:setBackgroundLaunchAtLogin": "setLaunchAtLogin",
};
// Runtime changes other windows read too; each re-pushes its own snapshot.
const SHARED_RUNTIME_METHODS = new Set(["setMemoryPolicy", "setLaunchAtLogin"]);

// win, controlApi: unchanged from before. Options:
//   ipcMain: injectable for tests (real Electron's ipcMain resolves to a
//     path STRING outside an actual Electron process, so this module must
//     never hardcode `require("electron").ipcMain` at call time if it is to
//     be unit-testable at all -- production callers pass the real one).
//   taskHost: main/harness/task-host.js instance. Omitted entirely in the
//     legacy-only demo mode -- no harness channel is registered at all in
//     that case, rather than registering handlers that would throw.
//   launchAgentInstalled: optional async () => boolean for the runtime
//     snapshot (main/harness/background-runtime-ui.js).
//   launchAgent: optional {isInstalled, enable, disable} for "start at
//     login" (main/harness/background-launch-agent.js).
module.exports = function registerIpc(win, controlApi, { ipcMain, taskHost, onNewWindow, launchAgentInstalled, launchAgent } = {}) {
  const ipc = ipcMain || require("electron").ipcMain;
  let registry = registries.get(ipc);
  if (!registry) {
    registry = { contexts: new Map(), channels: new Set(), harnessEnabled: false };
    registries.set(ipc, registry);
  }
  if (registry.contexts.has(win)) throw new Error("IPC already registered for this window");
  const context = { win, controlApi, taskHost, onNewWindow, unsubscribe: null, unsubscribeTaskHost: null, unsubscribeRoster: null, runtimeUi: null, unsubscribeRuntime: null };
  registry.contexts.set(win, context);

  // ipcMain is process-global, not window-local. Register each channel once
  // and route it to the BrowserWindow whose trusted main frame invoked it.
  const findContext = (event) => {
    for (const candidate of registry.contexts.values()) {
      if (isTrustedSender(event, candidate.win)) return candidate;
    }
    return null;
  };
  const addHandler = (channel, handler) => {
    if (registry.channels.has(channel)) return;
    ipc.handle(channel, handler);
    registry.channels.add(channel);
  };

  for (const method of LEGACY_METHODS) {
    const channel = `halo:${method}`;
    addHandler(channel, (event, ...args) => {
      const owner = findContext(event);
      if (!owner) return Promise.reject(new Error(`${channel}: no owning HALO window`));
      return owner.controlApi[method](...args);
    });
  }

  addHandler("halo:newWindow", (event) => {
    const owner = findContext(event);
    if (!owner || typeof owner.onNewWindow !== "function") {
      return Promise.reject(new Error("halo:newWindow: rejected untrusted sender or unsupported window"));
    }
    return owner.onNewWindow();
  });

  // A still of the showing page, painted under Halo overlays while the native view is hidden.
  addHandler("halo:captureSurface", (event) => {
    const owner = findContext(event);
    if (!owner) return Promise.reject(new Error("halo:captureSurface: rejected untrusted sender"));
    return captureVisibleSurface(owner.win);
  });

  if (taskHost) registry.harnessEnabled = true;
  if (registry.harnessEnabled) {
    for (const [channel, method] of Object.entries(HARNESS_METHODS)) {
      // A compromised/relaxed preload alone is not the trust boundary.
      addHandler(channel, (event, ...args) => {
        const owner = findContext(event);
        if (!owner?.taskHost) return Promise.reject(new Error(`${channel}: rejected untrusted sender`));
        if (!CODED_CHANNELS.has(channel)) return owner.taskHost[method](...args);
        return Promise.resolve().then(() => owner.taskHost[method](...args)).catch(withErrorCode);
      });
    }
    // This window's background-runtime binding (main/harness/background-runtime-ui.js).
    for (const [channel, method] of Object.entries(RUNTIME_UI_METHODS)) {
      addHandler(channel, (event, ...args) => {
        const owner = findContext(event);
        if (!owner?.runtimeUi) return Promise.reject(new Error(`${channel}: rejected untrusted sender`));
        const result = owner.runtimeUi[method](...args);
        if (!SHARED_RUNTIME_METHODS.has(method)) return result;
        // The policy (host settings) and the LaunchAgent are shared by every
        // window: let each of them re-read and push its own snapshot.
        return result.then((snapshot) => {
          for (const other of registry.contexts.values()) {
            if (other !== owner && other.runtimeUi) void other.runtimeUi.refresh();
          }
          return snapshot;
        });
      });
    }
  }
  if (taskHost && typeof taskHost.getHostSettings === "function" && typeof taskHost.updateHostSettings === "function") {
    context.runtimeUi = new BackgroundRuntimeUi({ host: taskHost, launchAgentInstalled, launchAgent });
    context.unsubscribeRuntime = context.runtimeUi.onChange((snapshot) => {
      if (!win.isDestroyed()) win.webContents.send("halo:backgroundRuntimeEvent", snapshot);
    });
  }

  context.unsubscribe = controlApi.onChange((snapshot) => {
    if (!win.isDestroyed()) win.webContents.send("halo:event", { snapshot });
  });
  context.unsubscribeTaskHost = taskHost?.onEvent((taskId, snapshot, detail = {}) => {
    if (!win.isDestroyed()) win.webContents.send("halo:taskEvent", { taskId, snapshot, ...detail });
  });
  // Content-free {kind, id, change} notices; the renderer re-reads the roster.
  if (typeof taskHost?.onAgentRosterEvent === "function") {
    context.unsubscribeRoster = taskHost.onAgentRosterEvent((notice) => {
      if (!win.isDestroyed()) win.webContents.send("halo:agentRosterEvent", notice);
    });
  }

  // Team room messages and round state, {roomId, message|round}.
  if (typeof taskHost?.onRoomEvent === "function") {
    context.unsubscribeRoom = taskHost.onRoomEvent((event) => {
      if (!win.isDestroyed()) win.webContents.send("halo:roomEvent", event);
    });
  }

  win.on("closed", () => {
    context.unsubscribe?.();
    context.unsubscribeRoom?.();
    context.unsubscribeTaskHost?.();
    context.unsubscribeRoster?.();
    context.unsubscribeRuntime?.();
    registry.contexts.delete(win);
    if (registry.contexts.size > 0) return;
    for (const channel of registry.channels) ipc.removeHandler(channel);
    registry.channels.clear();
    registries.delete(ipc);
  });
};
