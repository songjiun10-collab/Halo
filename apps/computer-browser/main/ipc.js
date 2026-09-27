"use strict";

const { isTrustedSender } = require("./harness/trusted-sender");

// Exactly the method surface preload exposes as window.haloBrowser. No
// channel here accepts a raw path/eval/shell string -- every argument is
// whatever ControlApi's own method signature validates. Unchanged since
// before the long-horizon harness: no taskId, no trusted-sender gate (this
// predates that requirement and governs only the single legacy demo task).
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
  "halo:taskPause": "pauseTask",
  "halo:taskStop": "stopTask",
  "halo:taskTakeOver": "takeOverTask",
};

// win, controlApi: unchanged from before. Options:
//   ipcMain: injectable for tests (real Electron's ipcMain resolves to a
//     path STRING outside an actual Electron process, so this module must
//     never hardcode `require("electron").ipcMain` at call time if it is to
//     be unit-testable at all -- production callers pass the real one).
//   taskHost: main/harness/task-host.js instance. Omitted entirely in the
//     legacy-only demo mode -- no harness channel is registered at all in
//     that case, rather than registering handlers that would throw.
module.exports = function registerIpc(win, controlApi, { ipcMain, taskHost } = {}) {
  const ipc = ipcMain || require("electron").ipcMain;
  const handlers = [];

  for (const method of LEGACY_METHODS) {
    const channel = `halo:${method}`;
    const handler = (_event, ...args) => controlApi[method](...args);
    ipc.handle(channel, handler);
    handlers.push(channel);
  }

  if (taskHost) {
    for (const [channel, method] of Object.entries(HARNESS_METHODS)) {
      // Design doc section 7: "goal amendment, approval, verification은 이
      // trusted UI API에서만 가능하다. remote WebContents에는 preload/Node/
      // 이 IPC를 노출하지 않는다." Applied to every harness channel, not
      // just the three named there -- a remote/subframe sender has no
      // legitimate reason to reach any long-horizon task state at all.
      const handler = (event, ...args) => {
        if (!isTrustedSender(event, win)) {
          return Promise.reject(new Error(`${channel}: rejected untrusted sender`));
        }
        return taskHost[method](...args);
      };
      ipc.handle(channel, handler);
      handlers.push(channel);
    }
  }

  const unsubscribe = controlApi.onChange((snapshot) => {
    if (!win.isDestroyed()) win.webContents.send("halo:event", { snapshot });
  });

  win.on("closed", () => {
    unsubscribe();
    for (const channel of handlers) ipc.removeHandler(channel);
  });
};
