"use strict";

// Background-runtime plan Task 5: the UI-process side of the split. Wraps a
// RuntimeIpcClient (background-runtime-ipc.js) behind the SAME method
// surface main/ipc.js's HARNESS_METHODS already expects from a plain
// TaskHost instance (createTask, listTasks, ...), so main/index.js can hand
// registerIpc() either a real in-process TaskHost (today's single-process
// mode) or this client (talking to a separate --halo-background-service
// process) without main/ipc.js itself needing to know which.
//
// connect() performs both the wire-level capability handshake
// (RuntimeIpcClient.connect()) and the service-level attachClient() call in
// one step; detach() is the "UI window closed" path -- it tells the service
// this client is gone and closes the socket, but (by construction, since
// detachClient() on the service side never touches the TaskHost) never
// stops or cancels any task.

const { RuntimeIpcClient } = require("./background-runtime-ipc");
const { TASK_HOST_METHODS } = require("./background-runtime-service");

class BackgroundRuntimeClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackgroundRuntimeClientError";
    this.code = code;
  }
}

class BackgroundRuntimeClient {
  constructor({ socketPath, capability, clientId, RuntimeIpcClientClass } = {}) {
    if (typeof clientId !== "string" || !clientId) {
      throw new BackgroundRuntimeClientError("invalid_config", "clientId is required");
    }
    const Client = RuntimeIpcClientClass || RuntimeIpcClient;
    this._clientId = clientId;
    this._ipc = new Client({ socketPath, capability, clientId });
    this._connected = false;

    // Every TaskHost method a UI may call once attached, proxied 1:1 so
    // registerIpc()'s existing `taskHost[method](...args)` calls work
    // unchanged against this object.
    for (const method of TASK_HOST_METHODS) {
      this[method] = (...args) => this._ipc.call(method, args);
    }
  }

  async connect() {
    await this._ipc.connect();
    await this._ipc.call("attachClient", this._clientId);
    this._connected = true;
  }

  // The UI-window-close path: bookkeeping only, on both ends -- never stops
  // or pauses any task.
  async detach() {
    if (!this._connected) return;
    this._connected = false;
    await this._ipc.call("detachClient", this._clientId).catch(() => {});
    await this._ipc.close();
  }

  onEvent(listener) {
    return this._ipc.on("taskEvent", (payload) => listener(payload.taskId, payload.snapshot, payload));
  }

  onServiceNotice(listener) {
    return this._ipc.on("serviceNotice", listener);
  }

  onServiceStopping(listener) {
    return this._ipc.on("serviceStopping", listener);
  }

  async getSnapshot() {
    return this._ipc.call("getSnapshot");
  }

  async stopTask(taskId, reason) {
    return this._ipc.call("stopTask", [taskId, reason]);
  }

  async setMemoryPolicy(choice) {
    return this._ipc.call("setMemoryPolicy", choice);
  }

  async listChildren(parentTaskId) {
    return this._ipc.call("listChildren", parentTaskId);
  }

  // Explicit full shutdown of the background service itself -- distinct
  // from detach(), and only ever invoked from a trusted, explicit user
  // action (plan Task 5 step 7's Quit "detach vs stop" choice).
  async stopService(reason) {
    return this._ipc.call("stopService", reason);
  }
}

module.exports = { BackgroundRuntimeClient, BackgroundRuntimeClientError };
