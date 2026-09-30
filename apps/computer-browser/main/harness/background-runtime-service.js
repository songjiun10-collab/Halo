"use strict";

// Background-runtime plan Task 5: the service-owned runtime lifecycle. This
// is the object a per-user LaunchAgent keeps alive -- it owns a real
// TaskHost/ChildAgentCoordinator/MemoryMonitor/approver resource set (built
// by whoever constructs this in main/index.js's --halo-background-service
// mode) and exposes a small, explicit method allowlist to any number of
// UI-process clients over the RuntimeIpcServer transport
// (background-runtime-ipc.js).
//
// The one property every test in test/background-runtime-service.test.js
// exists to prove: attachClient()/detachClient() are pure bookkeeping for
// "is a UI currently watching this service" -- neither one ever calls into
// the TaskHost. A hidden/closed UI window is a client detach, never task
// cancellation (design doc / plan Global Constraints); only an explicit
// stopTask()/stopService() call touches real work.

const crypto = require("node:crypto");
const { RuntimeIpcServer } = require("./background-runtime-ipc");

class BackgroundRuntimeServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackgroundRuntimeServiceError";
    this.code = code;
  }
}

// Dispatched directly on the service instance. Deliberately small: every
// other capability a UI needs (creating/amending/approving tasks, credential
// and memory management, etc.) lives on TASK_HOST_METHODS below, gated on
// having called attachClient() first.
const SERVICE_METHODS = new Set([
  "attachClient",
  "detachClient",
  "getSnapshot",
  "stopTask",
  "stopService",
  "setMemoryPolicy",
  "listChildren",
]);

// The existing TaskHost method surface (main/ipc.js's HARNESS_METHODS
// values) that a UI client may invoke once attached. No method here accepts
// a raw filesystem path, shell string, or partition name from the client --
// every argument still flows through that method's own existing validation,
// exactly as it does for today's single-process ipcMain channel.
const TASK_HOST_METHODS = new Set([
  "createTask",
  "listTasks",
  "resumeSavedTask",
  "amendTask",
  "confirmCriterion",
  "getTaskDetail",
  "approveTask",
  "denyTask",
  "pauseTask",
  "takeOverTask",
  "getTaskEvents",
  "getTaskBrowser",
  "taskBrowserAction",
  "setTaskViewport",
  "getHostSettings",
  "updateHostSettings",
  "listCredentials",
  "saveCredential",
  "removeCredential",
  "listMemories",
  "saveMemory",
  "removeMemory",
  "fillCredential",
]);

class BackgroundRuntimeService {
  constructor({ socketPath, socketRoot, taskHost, now, randomBytes } = {}) {
    if (typeof socketPath !== "string" || !socketPath) {
      throw new BackgroundRuntimeServiceError("invalid_config", "socketPath is required");
    }
    if (!taskHost || typeof taskHost.onEvent !== "function") {
      throw new BackgroundRuntimeServiceError("invalid_config", "taskHost (with onEvent) is required");
    }
    this._socketPath = socketPath;
    this._socketRoot = socketRoot;
    this._taskHost = taskHost;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._randomBytes = typeof randomBytes === "function" ? randomBytes : (n) => crypto.randomBytes(n);
    this._clients = new Set();
    this._server = null;
    this._capability = null;
    this._startedAt = null;
    this._stopped = false;
    this._serverCloseScheduled = false;
    this._listeners = new Set();
    this._unsubscribeTaskHost = null;
  }

  async start() {
    if (this._server) {
      throw new BackgroundRuntimeServiceError("already_started", "this service has already been started");
    }
    this._capability = this._randomBytes(32).toString("hex");
    this._server = new RuntimeIpcServer({
      socketPath: this._socketPath,
      socketRoot: this._socketRoot,
      capability: this._capability,
      onCall: (method, params, clientId) => this._dispatch(method, params, clientId),
    });
    await this._server.listen();
    this._startedAt = this._now();
    this._unsubscribeTaskHost = this._taskHost.onEvent((taskId, snapshot, detail) => {
      const payload = { taskId, snapshot, ...detail };
      this._emit("taskEvent", payload);
      this._server.broadcast("taskEvent", payload);
    });
    return { socketPath: this._socketPath, capability: this._capability };
  }

  async _dispatch(method, params, clientId) {
    if (this._stopped) {
      throw new BackgroundRuntimeServiceError("service_stopped", "the background service has stopped");
    }
    const args = Array.isArray(params) ? params : [params];
    if (SERVICE_METHODS.has(method)) {
      return this[method](...args);
    }
    if (TASK_HOST_METHODS.has(method)) {
      if (!this._clients.has(clientId)) {
        throw new BackgroundRuntimeServiceError("not_attached", "call attachClient() before using this method");
      }
      return this._taskHost[method](...args);
    }
    throw new BackgroundRuntimeServiceError("unknown_method", `unknown runtime method: ${method}`);
  }

  // Idempotent: attaching an already-attached clientId is a no-op beyond
  // returning the current client list. Never touches the TaskHost -- a
  // caller that also wants the current task list calls getSnapshot() itself
  // as a separate, explicit step.
  attachClient(clientId) {
    if (typeof clientId !== "string" || !clientId) {
      throw new BackgroundRuntimeServiceError("invalid_field", "clientId is required");
    }
    this._clients.add(clientId);
    return { clients: [...this._clients] };
  }

  // Never touches the TaskHost -- a UI window closing (which calls this, not
  // stopTask/stopService) must never be indistinguishable from an explicit
  // stop.
  detachClient(clientId) {
    this._clients.delete(clientId);
    return null;
  }

  async stopTask(taskId, reason) {
    this._emit("serviceNotice", { kind: "task_stop_requested", taskId, reason: reason ?? null });
    return this._taskHost.stopTask(taskId);
  }

  async setMemoryPolicy(choice) {
    return this._taskHost.updateHostSettings({ memoryPolicy: choice });
  }

  async listChildren(parentTaskId) {
    return this._taskHost.listChildren(parentTaskId);
  }

  async getSnapshot() {
    const tasks = await this._taskHost.listTasks();
    return {
      startedAt: this._startedAt,
      stopped: this._stopped,
      clients: [...this._clients],
      tasks,
    };
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("onEvent requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(event, payload) {
    for (const listener of this._listeners) {
      try {
        listener(event, payload);
      } catch {
        // A misbehaving observer must never interfere with service/task state.
      }
    }
  }

  // Idempotent -- a second stopService() call (e.g. a racing Quit and an
  // already-in-flight explicit stop) never drains the TaskHost twice.
  async stopService(reason) {
    if (this._stopped) return;
    this._stopped = true;
    this._emit("serviceNotice", { kind: "service_stopping", reason: reason ?? null });
    this._server?.broadcast("serviceStopping", { reason: reason ?? null });
    this._unsubscribeTaskHost?.();
    await this._taskHost.close();
    // If this was invoked over the runtime socket, closing it before the
    // dispatcher writes its response turns a successful explicit stop into
    // a client-side connection_closed error. Return the durable drain result
    // first, then close the listener/connections on the next macrotask.
    // The app's local serviceStopped listener is emitted only after teardown.
    if (!this._serverCloseScheduled) {
      this._serverCloseScheduled = true;
      setImmediate(async () => {
        await this._server?.close();
        this._emit("serviceStopped", { reason: reason ?? null });
      });
    }
  }
}

module.exports = { BackgroundRuntimeService, BackgroundRuntimeServiceError, SERVICE_METHODS, TASK_HOST_METHODS };
