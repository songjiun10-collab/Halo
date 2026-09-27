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
const { isPlainObject } = require("../../shared/harness-contracts");

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
    setViewport,
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
    this._setViewport = setViewport;
    this._listeners = new Set();
    // taskId -> {store, controller, browser, planner}
    this._active = new Map();
    this._pendingAttachments = new Set();
    this._closePromise = null;
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
    const entry = { store, controller, browser, planner, snapshot: controller.getSnapshot() };
    this._active.set(store.taskId, entry);
    entry.unsubscribeController = controller.onChange((snapshot) => {
      entry.snapshot = snapshot;
      this._emit(store.taskId, snapshot, { goal: controller.getGoal(), browser: browser.getBrowserSnapshot?.() });
    });
    entry.unsubscribeBrowser = browser.onChange?.((snapshot) => {
      this._emit(store.taskId, entry.snapshot, { browser: snapshot });
    });
    // createTask()/resumeSavedTask() retain their existing wait-for-loop
    // return values; this early event makes the attached task usable while
    // its first planner response is still pending.
    this._emit(store.taskId, entry.snapshot, { goal: controller.getGoal(), browser: browser.getBrowserSnapshot?.() });
    return entry;
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("onEvent requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(taskId, snapshot, detail = {}) {
    for (const listener of this._listeners) {
      try {
        Promise.resolve(listener(taskId, structuredClone(snapshot), structuredClone(detail))).catch(() => {});
      } catch {
        // UI observers must not interfere with task execution or shutdown.
      }
    }
  }

  _unsubscribe(entry) {
    entry.unsubscribeController?.();
    entry.unsubscribeBrowser?.();
  }

  _require(taskId) {
    this._assertOpen();
    const entry = this._active.get(taskId);
    if (!entry) throw new TaskHostError("not_active", `task ${taskId} is not currently attached -- call resumeSavedTask() first`);
    return entry;
  }

  createTask(goalInput) {
    this._assertOpen();
    return this._trackAttachment(async () => {
      const store = await TaskStore.create(goalInput, { storageRoot: this._storageRoot });
      if (this._closePromise) {
        await store.close();
        throw new TaskHostError("host_closed", "task host is closing or closed");
      }
      const { controller } = this._attach(store);
      // Start synchronously before releasing the attachment barrier, but do
      // not keep shutdown waiting for the whole long-running task. close()
      // must see this running controller and take it over itself.
      const started = controller.start();
      return { store, controller, started };
    }).then(async ({ store, controller, started }) => {
      await started;
      return { taskId: store.taskId, snapshot: controller.getSnapshot(), goal: controller.getGoal() };
    });
  }

  async listTasks() {
    this._assertOpen();
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
      // Same fix as task-controller.js's constructor (2026-09-27 follow-up):
      // a task that already reached completed/stopped was checkpointed
      // synchronously the instant it got there, so that checkpoint is
      // authoritative over recoveryReason -- otherwise a finished task is
      // peeked as plain "paused"/"recovered", indistinguishable from one
      // merely interrupted mid-flight.
      const checkpointedTask = store.lastCheckpoint && store.lastCheckpoint.payload && store.lastCheckpoint.payload.task;
      const isTerminal = checkpointedTask && (checkpointedTask.state === "completed" || checkpointedTask.state === "stopped");
      summaries.push({
        taskId,
        originalRequest: store.getGoal().originalRequest,
        state: isTerminal ? checkpointedTask.state : store.recoveryReason === "execution_uncertain" ? "paused" : store.recoveryReason === "recovered" ? "paused" : "idle",
        pauseReason: isTerminal ? (checkpointedTask.pauseReason ?? null) : store.recoveryReason === "created" ? null : store.recoveryReason,
        active: false,
      });
      await store.close();
    }
    return summaries;
  }

  async resumeSavedTask(taskId, opts = {}) {
    this._assertOpen();
    let entry = this._active.get(taskId);
    // A memory_emergency-paused controller already disposed its own
    // browser/planner (task-controller.js's teardown) and now refuses
    // resume() outright -- the only way forward is a fresh re-attachment
    // (new browser/planner instances), exactly like recovering from a
    // process restart. Evict the stale entry and fall through to the
    // "never attached" path below.
    if (entry && entry.controller.getSnapshot().pauseReason === "memory_emergency") {
      this._unsubscribe(entry);
      this._active.delete(taskId);
      entry = null;
    }
    if (!entry) {
      const attached = await this._trackAttachment(async () => {
        const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
        if (this._closePromise) {
          await store.close();
          throw new TaskHostError("host_closed", "task host is closing or closed");
        }
        const attachedEntry = this._attach(store);
        // Like createTask(), enter the controller synchronously so a
        // concurrent close() sees the active entry and can take it over,
        // without this attachment barrier waiting for the task's run loop.
        const resumed = attachedEntry.controller.getSnapshot().state === "paused"
          ? attachedEntry.controller.resume(opts)
          : Promise.resolve();
        return { entry: attachedEntry, resumed };
      });
      await attached.resumed;
      return attached.entry.controller.getSnapshot();
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

  async takeOverTask(taskId, reason) {
    const { controller } = this._require(taskId);
    return controller.takeOver(reason);
  }

  async getTaskDetail(taskId) {
    this._assertOpen();
    const active = this._active.get(taskId);
    if (active) {
      return { taskId, goal: active.controller.getGoal(), snapshot: active.controller.getSnapshot(), active: true };
    }
    const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
    const detail = { taskId, goal: store.getGoal(), recoveryReason: store.recoveryReason, active: false };
    await store.close();
    return detail;
  }

  async getTaskEvents(taskId, options) {
    this._assertOpen();
    const entry = this._active.get(taskId);
    if (entry) return entry.controller.getEvents(options);
    return TaskStore.readEvents(taskId, { storageRoot: this._storageRoot }, options);
  }

  getTaskBrowser(taskId) {
    const { browser } = this._require(taskId);
    if (typeof browser.getBrowserSnapshot !== "function") {
      throw new TaskHostError("browser_unavailable", "this task browser does not expose a snapshot");
    }
    return browser.getBrowserSnapshot();
  }

  canUseTaskBrowser(taskId) {
    if (this._closePromise) return false;
    return this._active.get(taskId)?.controller.isUserControlled() === true;
  }

  async taskBrowserAction(taskId, action) {
    return this._require(taskId).controller.userNavigate(action);
  }

  async setTaskViewport(taskId, bounds) {
    this._assertOpen();
    const fields = ["x", "y", "width", "height", "visible"];
    if (!isPlainObject(bounds) || Object.keys(bounds).some((key) => !fields.includes(key)) ||
      !["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 100000) ||
      typeof bounds.visible !== "boolean") {
      throw new TaskHostError("invalid_field", "viewport requires finite non-negative bounds and a visible boolean");
    }
    if (taskId !== null) this._require(taskId);
    if (typeof this._setViewport !== "function") {
      throw new TaskHostError("browser_unavailable", "task viewport is unavailable");
    }
    return this._setViewport(taskId, { ...bounds, visible: taskId === null ? false : bounds.visible });
  }

  // Release this host's owned resources at window/app shutdown. Active work
  // is first durably returned to a paused state, so closing the journal can
  // never race an admitted browser action or leave an approval queued only
  // in memory. The same promise is reused by concurrent shutdown paths.
  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = (async () => {
      // A create/load that started before close() must either attach before
      // this snapshot (so it gets cleaned up below) or observe the closed
      // state after its await, close its store, and reject. Never let a late
      // attachment escape this shutdown pass.
      await Promise.allSettled([...this._pendingAttachments]);
      const entries = [...this._active.values()];
      const errors = [];
      await Promise.all(entries.map(async (entry) => {
        const state = entry.controller.getSnapshot().state;
        if (state === "running" || state === "awaiting_approval") {
          try {
            await entry.controller.takeOver("host_shutdown");
          } catch (error) {
            errors.push(error);
          }
        }

        this._unsubscribe(entry);

        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => entry.planner.close?.()),
          Promise.resolve().then(() => entry.browser.dispose?.()),
          Promise.resolve().then(() => entry.store.close()),
        ]);
        for (const result of cleanup) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      }));
      this._active.clear();
      this._listeners.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, "one or more task resources failed to close");
      }
    })();
    return this._closePromise;
  }

  _assertOpen() {
    if (this._closePromise) throw new TaskHostError("host_closed", "task host is closing or closed");
  }

  _trackAttachment(operation) {
    const pending = Promise.resolve().then(() => {
      this._assertOpen();
      return operation();
    });
    this._pendingAttachments.add(pending);
    pending.then(
      () => this._pendingAttachments.delete(pending),
      () => this._pendingAttachments.delete(pending),
    );
    return pending;
  }
}

module.exports = { TaskHost, TaskHostError, TaskControllerError };
