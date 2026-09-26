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
  "getSnapshot", "navigate", "startTask", "pauseTask", "resumeTask", "stopTask",
  "goBack", "goForward", "reload", "newTab", "approve", "deny", "setBrowserBounds",
];

const api = {};
for (const method of METHODS) {
  api[method] = (...args) => ipcRenderer.invoke(`halo:${method}`, ...args);
}

api.onEvent = (callback) => {
  if (typeof callback !== "function") throw new TypeError("onEvent requires a callback function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on("halo:event", listener);
  return () => ipcRenderer.removeListener("halo:event", listener);
};

// renderer.js reads this to set CSS custom properties, so the reserved
// approval-queue/timeline region the security clamp in control-api.js
// enforces can never silently drift from what the CSS actually reserves.
api.layout = Object.freeze(readLayoutFromArgv());

contextBridge.exposeInMainWorld("haloBrowser", Object.freeze(api));
