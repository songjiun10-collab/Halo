"use strict";

// TaskHost (Task 5): the multi-task coordinator behind the new IPC surface
// (createTask/listTasks/resumeSavedTask/amendTask/confirmCriterion/
// getTaskDetail/approveTask/denyTask). Each long-horizon task gets its own
// TaskStore + TaskController + BrowserAdapter; this module owns the map
// from taskId to the currently-active controller (if any) and the lazy
// construction of that trio, so main/ipc.js only ever calls a plain
// method-per-taskId surface.
//
// browser/planner are built lazily via injected factories (makeBrowser/
// makePlanner) rather than eagerly at TaskHost construction time, because
// each task needs its OWN BrowserAdapter (its own WebContentsView) and its
// own planner connection -- these are real Electron/child-process resources
// in production and cheap fakes in tests.
//
// Design doc section 4: a task recovered from disk (paused: recovered /
// execution_uncertain) never auto-starts -- resumeSavedTask() is the
// explicit human action that re-attaches it and calls controller.resume().
// createTask() is the only path that auto-starts a BRAND NEW task.

const { TaskStore } = require("./task-store");
const { TaskController, TaskControllerError } = require("./task-controller");

class TaskHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskHostError";
    this.code = code;
  }
}

class TaskHost {
  constructor({
    storageRoot,
    makeBrowser,
    makePlanner,
    hostVerifier,
    approve,
    memoryMonitor,
    now,
    segmentRotationCalls,
    noProgressThreshold,
  } = {}) {
    if (!storageRoot) throw new TaskHostError("invalid_config", "storageRoot is required");
    if (typeof makeBrowser !== "function") throw new TaskHostError("invalid_config", "makeBrowser is required");
    if (typeof makePlanner !== "function") throw new TaskHostError("invalid_config", "makePlanner is required");
    if (typeof hostVerifier !== "function") throw new TaskHostError("invalid_config", "hostVerifier is required");
    if (typeof approve !== "function") throw new TaskHostError("invalid_config", "approve is required");

    this._storageRoot = storageRoot;
    this._makeBrowser = makeBrowser;
    this._makePlanner = makePlanner;
    this._hostVerifier = hostVerifier;
    this._approve = approve;
    this._memoryMonitor = memoryMonitor;
    this._now = now;
    this._segmentRotationCalls = segmentRotationCalls;
    this._noProgressThreshold = noProgressThreshold;
    // taskId -> {store, controller, browser, planner}
    this._active = new Map();
  }

  _attach(store) {
    const browser = this._makeBrowser(store.taskId);
    const planner = this._makePlanner(store.taskId);
    const controller = new TaskController({
      store,
      planner,
      browser,
      approve: (descriptor) => this._approve(store.taskId, descriptor),
      hostVerifier: this._hostVerifier,
      memoryMonitor: this._memoryMonitor,
      now: this._now,
      segmentRotationCalls: this._segmentRotationCalls,
      noProgressThreshold: this._noProgressThreshold,
    });
    const entry = { store, controller, browser, planner };
    this._active.set(store.taskId, entry);
    return entry;
  }

  _require(taskId) {
    const entry = this._active.get(taskId);
    if (!entry) throw new TaskHostError("not_active", `task ${taskId} is not currently attached -- call resumeSavedTask() first`);
    return entry;
  }

  async createTask(goalInput) {
    const store = await TaskStore.create(goalInput, { storageRoot: this._storageRoot });
    const { controller } = this._attach(store);
    await controller.start();
    return { taskId: store.taskId, snapshot: controller.getSnapshot(), goal: controller.getGoal() };
  }

  async listTasks() {
    const ids = await TaskStore.listTaskIds({ storageRoot: this._storageRoot });
    const summaries = [];
    for (const taskId of ids) {
      const active = this._active.get(taskId);
      if (active) {
        summaries.push({
          taskId,
          originalRequest: active.controller.getGoal().originalRequest,
          state: active.controller.getSnapshot().state,
          pauseReason: active.controller.getSnapshot().pauseReason,
          active: true,
        });
        continue;
      }
      // Not currently attached -- peek the store without starting a
      // controller/browser/planner for every saved task on every listTasks()
      // call (that would spawn a WebContentsView/worker per saved task just
      // to list them).
      const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
      summaries.push({
        taskId,
        originalRequest: store.getGoal().originalRequest,
        state: store.recoveryReason === "execution_uncertain" ? "paused" : store.recoveryReason === "recovered" ? "paused" : "idle",
        pauseReason: store.recoveryReason === "created" ? null : store.recoveryReason,
        active: false,
      });
      await store.close();
    }
    return summaries;
  }

  async resumeSavedTask(taskId, opts = {}) {
    let entry = this._active.get(taskId);
    // A memory_emergency-paused controller already disposed its own
    // browser/planner (task-controller.js's teardown) and now refuses
    // resume() outright -- the only way forward is a fresh re-attachment
    // (new browser/planner instances), exactly like recovering from a
    // process restart. Evict the stale entry and fall through to the
    // "never attached" path below.
    if (entry && entry.controller.getSnapshot().pauseReason === "memory_emergency") {
      this._active.delete(taskId);
      entry = null;
    }
    if (!entry) {
      const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
      entry = this._attach(store);
    }
    if (entry.controller.getSnapshot().state === "paused") {
      await entry.controller.resume(opts);
    }
    return entry.controller.getSnapshot();
  }

  async amendTask(taskId, amendmentInput) {
    const { controller } = this._require(taskId);
    await controller.amend(amendmentInput);
    return controller.getSnapshot();
  }

  async confirmCriterion(taskId, args) {
    const { controller } = this._require(taskId);
    return controller.confirmCriterion(args);
  }

  async approveTask(taskId, requestId) {
    const { controller } = this._require(taskId);
    return controller.approve(requestId);
  }

  async denyTask(taskId, requestId) {
    const { controller } = this._require(taskId);
    return controller.deny(requestId);
  }

  async pauseTask(taskId, reason) {
    const { controller } = this._require(taskId);
    return controller.pause(reason);
  }

  async stopTask(taskId) {
    const { controller } = this._require(taskId);
    return controller.stop();
  }

  async getTaskDetail(taskId) {
    const active = this._active.get(taskId);
    if (active) {
      return { taskId, goal: active.controller.getGoal(), snapshot: active.controller.getSnapshot(), active: true };
    }
    const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
    const detail = { taskId, goal: store.getGoal(), recoveryReason: store.recoveryReason, active: false };
    await store.close();
    return detail;
  }
}

module.exports = { TaskHost, TaskHostError, TaskControllerError };
