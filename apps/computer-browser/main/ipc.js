"use strict";

const { ipcMain } = require("electron");

// Exactly the method surface preload exposes as window.haloBrowser. No
// channel here accepts a raw path/eval/shell string -- every argument is
// whatever ControlApi's own method signature validates.
const METHODS = [
  "getSnapshot", "navigate", "startTask", "pauseTask", "resumeTask", "stopTask",
  "goBack", "goForward", "reload", "newTab", "approve", "deny", "setBrowserBounds",
];

module.exports = function registerIpc(win, controlApi) {
  const handlers = [];
  for (const method of METHODS) {
    const channel = `halo:${method}`;
    const handler = (_event, ...args) => controlApi[method](...args);
    ipcMain.handle(channel, handler);
    handlers.push(channel);
  }

  const unsubscribe = controlApi.onChange((snapshot) => {
    if (!win.isDestroyed()) win.webContents.send("halo:event", { snapshot });
  });

  win.on("closed", () => {
    unsubscribe();
    for (const channel of handlers) ipcMain.removeHandler(channel);
  });
};
