"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// A sandboxed preload's require() is Electron's own restricted polyfill --
// it does not resolve arbitrary local relative paths like
// "../shared/layout-constants" (confirmed by actually running this preload
// under sandbox:true: "Error: module not found: ../shared/layout-constants").
// So the single source of truth (apps/computer-browser/shared/
// layout-constants.js) is required normally by the *unsandboxed* main
// process instead, and handed down here as a --halo-layout=<json>
// additionalArguments flag, which process.argv IS readable from inside a
// sandboxed preload.
function readLayoutFromArgv() {
  const prefix = "--halo-layout=";
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) throw new Error("main did not pass --halo-layout; layout constants are unavailable");
  return JSON.parse(arg.slice(prefix.length));
}

// Exactly this method surface, nothing more -- never expose ipcRenderer
// itself, which would hand the renderer every internal channel including
// ones only meant for main<->main coordination.
const METHODS = [
  "getSnapshot", "navigate", "startTask", "pauseTask", "resumeTask", "resumeAfterCaptcha", "stopTask", "takeOverTask",
  "goBack", "goForward", "reload", "newTab", "selectTab", "closeTab", "approve", "deny", "setBrowserBounds", "getMetricsSummary",
];

// Long-horizon harness channels (main/harness/task-host.js via main/ipc.js).
// Additive: the legacy METHODS above are unchanged, and the renderer is free
// to never call any of these. main/ipc.js independently re-validates the
// sender for every one of these (a compromised/relaxed preload alone is not
// the trust boundary), so this list is just "what's reachable", not "what's
// authorized".
const HARNESS_METHODS = [
  "createTask", "listTasks", "resumeSavedTask", "amendTask", "confirmCriterion", "getTaskDetail",
  "taskApprove", "taskDeny", "taskLend", "taskRevokeLease", "taskPause", "taskStop", "taskTakeOver", "getTaskEvents", "getChildPlan", "listMcpProviders",
  "getTaskBrowser", "taskBrowserAction", "setTaskViewport", "getHostSettings", "updateHostSettings", "getUsage", "setUsageLimit", "syncUsage",
  "listCredentials", "saveCredential", "removeCredential",
  "listMemories", "saveMemory", "removeMemory",
  "fillCredential",
  "listRoutines", "getRoutine", "saveRoutine", "deleteRoutine", "runRoutine",
  "listAgents", "saveAgent", "archiveAgent", "listTeams", "saveTeam", "archiveTeam",
  "startAgentTask", "listAgentConversations",
  "getAgentRoster", "setAgentPinned", "duplicateAgent", "markAgentConversationsRead",
  "listAgentSchedules", "saveAgentSchedule", "deleteAgentSchedule",
  "listRooms", "getRoom", "postRoomMessage", "stopRoomRound",
  "startWorkGoal", "getActiveWorkGoal", "listWorkGoalHistory", "amendWorkGoal",
  "pauseWorkGoal", "resumeWorkGoal", "completeWorkGoal", "archiveWorkGoal",
  "recordWorkGoalProgress", "verifyWorkGoalCriterion",
  "getWorkGoalRecoveryStatus", "repairWorkGoalReservation",
  "importSessions", "listImportedSessions", "removeImportedSession",
  "getSessionAllowlist", "setSessionAllowlist",
  "importBrowserSettings", "getImportedSettings",
  "getBackgroundRuntimeSnapshot", "attachBackgroundRuntime", "detachBackgroundRuntime",
  "setMemoryPolicy", "stopBackgroundService", "setBackgroundLaunchAtLogin",
];

const WINDOW_METHODS = ["newWindow", "captureSurface"];

const api = {};
for (const method of METHODS) {
  api[method] = (...args) => ipcRenderer.invoke(`halo:${method}`, ...args);
}
for (const method of HARNESS_METHODS) {
  api[method] = (...args) => ipcRenderer.invoke(`halo:${method}`, ...args);
}
for (const method of WINDOW_METHODS) {
  api[method] = (...args) => ipcRenderer.invoke(`halo:${method}`, ...args);
}

api.onEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:event", listener);
  return () => ipcRenderer.removeListener("halo:event", listener);
};

api.onAgentRosterEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onAgentRosterEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:agentRosterEvent", listener);
  return () => ipcRenderer.removeListener("halo:agentRosterEvent", listener);
};

api.onRoomEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onRoomEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:roomEvent", listener);
  return () => ipcRenderer.removeListener("halo:roomEvent", listener);
};

api.onBackgroundRuntimeEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onBackgroundRuntimeEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:backgroundRuntimeEvent", listener);
  return () => ipcRenderer.removeListener("halo:backgroundRuntimeEvent", listener);
};

api.onTaskEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onTaskEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:taskEvent", listener);
  return () => ipcRenderer.removeListener("halo:taskEvent", listener);
};

// renderer.js reads this to set CSS custom properties, so the reserved
// approval-queue/timeline region the security clamp in control-api.js
// enforces can never silently drift from what the CSS actually reserves.
api.layout = Object.freeze(readLayoutFromArgv());

contextBridge.exposeInMainWorld("haloBrowser", Object.freeze(api));
