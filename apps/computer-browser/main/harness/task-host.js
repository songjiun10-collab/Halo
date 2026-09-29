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
const { TaskQueue, TaskQueueError } = require("./task-queue");
const { ResourceAdmission } = require("./resource-admission");
const { RoutineStore } = require("./routine-store");
const { RoutineRunner } = require("./routine-runner");
const { ChildAgentCoordinator } = require("./child-agent-coordinator");
const { isPlainObject } = require("../../shared/harness-contracts");

// Two complete Electron task surfaces (visible + fixed hidden renderer) were
// measured at a 590,888,960-byte increment with 50ms polling; reserve the
// rounded-up per-task half plus margin. Planner subtree reserve is added
// dynamically from the measured live worker high-water mark below.
const MEASURED_BROWSER_TASK_RESERVE_BYTES = 370_000_000;

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
    makeChildBrowser,
    hostVerifier,
    approve,
    memoryMonitor,
    now,
    segmentRotationCalls,
    noProgressThreshold,
    setViewport,
    executionMode = "sequential",
    parallelTaskReserveBytes,
    maxParallelTasks = 2,
    permissionMode = "browse",
    plannerEffort = "medium",
    memoryStore,
    settingsStore,
    credentialVault,
    routineReadOnlyBatching = true,
  } = {}) {
    if (!storageRoot) throw new TaskHostError("invalid_config", "storageRoot is required");
    if (typeof makeBrowser !== "function") throw new TaskHostError("invalid_config", "makeBrowser is required");
    if (typeof makePlanner !== "function") throw new TaskHostError("invalid_config", "makePlanner is required");
    if (typeof hostVerifier !== "function") throw new TaskHostError("invalid_config", "hostVerifier is required");
    if (typeof approve !== "function") throw new TaskHostError("invalid_config", "approve is required");

    this._storageRoot = storageRoot;
    this._makeBrowser = makeBrowser;
    this._makePlanner = makePlanner;
    this._makeChildBrowser = makeChildBrowser || null;
    this._hostVerifier = hostVerifier;
    this._approve = approve;
    this._memoryMonitor = memoryMonitor;
    this._now = now;
    this._segmentRotationCalls = segmentRotationCalls;
    this._noProgressThreshold = noProgressThreshold;
    this._setViewport = setViewport;
    this._permissionMode = permissionMode;
    this._plannerEffort = plannerEffort;
    this._routineBatchReadOnlySteps = routineReadOnlyBatching !== false;
    this._memoryStore = memoryStore || null;
    this._settingsStore = settingsStore || null;
    this._credentialVault = credentialVault || null;
    this._routineStore = new RoutineStore({ storageRoot });
    if (executionMode !== "sequential" && executionMode !== "parallel") throw new TaskHostError("invalid_config", "executionMode must be sequential or parallel");
    this._executionMode = executionMode;
    if (!Number.isInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > 8) throw new TaskHostError("invalid_config", "maxParallelTasks must be an integer from 1 to 8");
    this._maxParallelTasks = maxParallelTasks;
    this._parallelTaskReserveBytes = parallelTaskReserveBytes;
    this._queue = new TaskQueue({ storageRoot });
    this._queueReady = null;
    this._queueRecoveredBlocked = false;
    this._queueTransition = Promise.resolve();
    this._listeners = new Set();
    // taskId -> {store, controller, browser, planner}
    this._active = new Map();
    this._pendingAttachments = new Set();
    this._closePromise = null;
    // All top-level reservations use the same ledger as child agents. Built
    // lazily (see
    // _ensureResourceAdmission) so a memoryMonitor fake supplied only for
    // TaskController's own pressure check (no canAdmitTask) never trips
    // ResourceAdmission's stricter constructor requirements.
    this._resourceAdmission = null;
    // taskId -> leaseId. A lease is required before a task builds resources.
    this._taskLeases = new Map();
    this._runMemoryPolicies = new Map();
    this._admissionChain = Promise.resolve();
    // Task 3: parent<->child linkage/lifecycle authority, shared across every
    // task this host manages (a child's own coordination never depends on
    // which task happens to be active in this._active).
    this._childCoordinator = new ChildAgentCoordinator({
      storageRoot,
      // Task 4: children lease from the SAME ledger as top-level tasks, via
      // a thunk (never a resolved instance) so both callers always share
      // whichever ResourceAdmission _ensureResourceAdmission() has already
      // built lazily.
      getResourceAdmission: () => this._ensureResourceAdmission(),
      makeChildBrowser: this._makeChildBrowser,
      // Child planners are requested with role:"child"; a makePlanner factory
      // that (like main/index.js's today) ignores extra arguments still works
      // unchanged -- the real role-aware factory is Task 5's responsibility.
      makePlanner: this._makePlanner
        ? (childId) => this._makePlanner(childId, { role: "child" })
        : null,
      approve: this._approve,
      hostVerifier: this._hostVerifier,
      memoryMonitor: this._memoryMonitor,
      memoryStore: this._memoryStore,
      now: this._now,
      segmentRotationCalls: this._segmentRotationCalls,
      noProgressThreshold: this._noProgressThreshold,
      plannerEffort: this._plannerEffort,
    });
  }

  // Task 4: called when a parent's own TaskController proposes a
  // "child_plan" -- uses this parent's captured memoryPolicy (defaulting to
  // "budgeted" when no settingsStore is configured) and hands the proposal
  // to the shared ChildAgentCoordinator, which performs admission, lease
  // acquisition, and the trusted initial navigation before any child planner
  // is ever consulted.
  async _onChildPlan(parentTaskId, parentStore, proposal) {
    const selected = await this._getRunMemoryPolicy(parentTaskId, parentStore);
    return this._childCoordinator.withParentGoalLock(parentTaskId, () => this._childCoordinator.acceptParentPlan(parentTaskId, proposal, {
      parentStore,
      memoryPolicy: selected.mode,
      memoryPolicyAuditEventId: selected.auditEventId,
    }));
  }

  async _getRunMemoryPolicy(taskId, store) {
    const cached = this._runMemoryPolicies.get(taskId);
    if (cached) return cached;
    const events = store ? await store.getEvents() : await TaskStore.readEvents(taskId, { storageRoot: this._storageRoot });
    const saved = events.find((event) => event.type === "note" && event.payload?.kind === "memory_policy_selected");
    const selected = saved
      ? { mode: saved.payload.mode, auditEventId: saved.payload.auditEventId ?? null }
      : { mode: "budgeted", auditEventId: null };
    if (selected.mode !== "budgeted" && selected.mode !== "user_override") {
      throw new TaskHostError("invalid_memory_policy", "saved task memory policy is invalid");
    }
    if (selected.mode === "user_override" && !selected.auditEventId) {
      throw new TaskHostError("audit_missing", "saved memory override has no user audit event");
    }
    this._runMemoryPolicies.set(taskId, selected);
    return selected;
  }

  // Safe summaries of a parent task's children (see
  // ChildAgentCoordinator.listChildren) -- children are never returned by
  // listTasks()/resumeSavedTask() themselves; this is the only supported way
  // to read them back.
  async listChildren(parentTaskId) {
    return this._childCoordinator.listChildren(parentTaskId);
  }

  _ensureResourceAdmission() {
    if (this._resourceAdmission) return this._resourceAdmission;
    if (!this._memoryMonitor || typeof this._memoryMonitor.canAdmitTask !== "function" || typeof this._memoryMonitor.getPressureLevel !== "function") {
      return null;
    }
    this._resourceAdmission = new ResourceAdmission({ memoryMonitor: this._memoryMonitor });
    return this._resourceAdmission;
  }

  async _releaseTaskLease(taskId) {
    const leaseId = this._taskLeases.get(taskId);
    if (!leaseId) return;
    await this._resourceAdmission?.release(leaseId);
    this._taskLeases.delete(taskId);
  }

  _attach(store, routine = null) {
    if (this._ensureResourceAdmission() && !this._taskLeases.has(store.taskId)) {
      throw new TaskHostError("memory_lease_required", "top-level task requires a memory lease before creating resources");
    }
    const runPolicy = this._runMemoryPolicies.get(store.taskId);
    if (!runPolicy) throw new TaskHostError("memory_policy_missing", "top-level task policy must be captured before attachment");
    const controllerMemoryMonitor = runPolicy.mode === "user_override" && this._memoryMonitor
      ? { getPressureLevel: () => "normal" }
      : this._memoryMonitor;
    // Subagent communication protocol Task 4: the shared ChildAgentCoordinator
    // is this store's mailbox authority (it may be either party's own
    // parent-side messaging, or a plain standalone task with no children --
    // in the latter case listPendingMessages()/handleSendMessage() simply
    // find no known relationship). It must be registered before the
    // controller's loop can possibly run.
    this._childCoordinator.registerStore(store.taskId, store);
    const browser = this._makeBrowser(store.taskId);
    const planner = routine ? routine.runner : this._makePlanner(store.taskId);
    const controller = new TaskController({
      store,
      planner,
      browser,
      approve: (descriptor) => this._approve(store.taskId, descriptor),
      hostVerifier: this._hostVerifier,
      memoryMonitor: controllerMemoryMonitor,
      memoryStore: this._memoryStore,
      permissionMode: this._permissionMode,
      plannerEffort: this._plannerEffort,
      now: this._now,
      segmentRotationCalls: this._segmentRotationCalls,
      noProgressThreshold: this._noProgressThreshold,
      // Task 4: only top-level TaskControllers get this hook -- child
      // TaskControllers are never constructed here, so they structurally
      // never receive onChildPlan, which is exactly what prevents nested
      // child agents.
      onChildPlan: (proposal) => this._onChildPlan(store.taskId, store, proposal),
      sendMessage: (validated) => this._childCoordinator.handleSendMessage(store.taskId, validated),
      listPendingMessages: () => this._childCoordinator.listPendingMessages(store.taskId),
      recordMessagesConsumed: (ids, plannerCall) => this._childCoordinator.recordMessagesConsumed(store.taskId, ids, plannerCall),
      ...(routine ? { routineRunner: routine.runner, routineRun: routine.run } : {}),
    });
    const entry = { store, controller, browser, planner, snapshot: controller.getSnapshot() };
    this._active.set(store.taskId, entry);
    entry.unsubscribeController = controller.onChange((snapshot) => {
      entry.snapshot = snapshot;
      this._emit(store.taskId, snapshot, { goal: controller.getGoal(), browser: browser.getBrowserSnapshot?.() });
      if (snapshot.state === "completed" || snapshot.state === "stopped") this._recordTerminal(store.taskId, snapshot.state);
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
    return this._createNewTask(goalInput);
  }

  async listRoutines() {
    this._assertOpen();
    return this._routineStore.list();
  }

  async getRoutine(routineId, revision) {
    this._assertOpen();
    return this._routineStore.get(routineId, revision);
  }

  async saveRoutine(input) {
    this._assertOpen();
    return this._routineStore.save(input);
  }

  async deleteRoutine(routineId) {
    this._assertOpen();
    return this._routineStore.delete(routineId);
  }

  async runRoutine(routineId, revision) {
    this._assertOpen();
    if (!Number.isInteger(revision) || revision < 1) {
      throw new TaskHostError("invalid_revision", "runRoutine requires an exact positive revision");
    }
    // The current-index read enforces the tombstone: an explicit get of an
    // old revision is allowed for recovery, but deletion forbids new runs.
    await this._routineStore.get(routineId);
    const definition = await this._routineStore.get(routineId, revision);
    const goal = {
      originalRequest: `Run saved routine: ${definition.name}`,
      criteria: [{ id: "routine-complete", text: "Confirm the saved routine completed", required: true, verification: "user" }],
    };
    const run = {
      routineId: definition.routineId,
      revision: definition.revision,
      digest: definition.digest,
      cursor: 0,
    };
    return this._createNewTask(goal, run, definition);
  }

  async _resolveRoutineForStore(store) {
    const pin = store.lastCheckpoint?.payload?.routineRun;
    if (!pin) return null;
    const definition = await this._routineStore.get(pin.routineId, pin.revision);
    if (definition.digest !== pin.digest || definition.routineId !== pin.routineId || definition.revision !== pin.revision) {
      throw new TaskHostError("routine_cursor_mismatch", "saved routine pin differs from its immutable revision");
    }
    const recovery = store.routineRecovery;
    if (recovery && (recovery.routineId !== pin.routineId || recovery.revision !== pin.revision || recovery.digest !== pin.digest)) {
      throw new TaskHostError("routine_cursor_mismatch", "routine recovery differs from its pinned revision");
    }
    for (const transition of recovery?.transitions ?? []) {
      let expected;
      try {
        expected = new RoutineRunner({ definition, cursor: transition.stepIndex }).getCurrentStep();
      } catch {
        throw new TaskHostError("routine_cursor_mismatch", "routine transition step is out of range");
      }
      if (!expected || transition.stepDigest !== expected.stepDigest) {
        throw new TaskHostError("routine_cursor_mismatch", "routine transition step digest differs from the pinned definition");
      }
    }
    const cursor = recovery ? recovery.cursor : pin.cursor;
    let runner;
    try {
      runner = new RoutineRunner({ definition, cursor, batchReadOnlySteps: this._routineBatchReadOnlySteps });
    } catch {
      throw new TaskHostError("routine_cursor_mismatch", "routine cursor is out of range");
    }
    return { runner, run: { ...pin, cursor } };
  }

  _createNewTask(goalInput, routineRun = null, pinnedRoutineDefinition = null) {
    this._assertOpen();
    return this._trackAttachment(async () => {
      await this._ensureQueue();
      const selected = this._settingsStore
        ? await this._settingsStore.getMemoryPolicySelection()
        : { mode: "budgeted", auditEventId: null, actor: null, at: null };
      const store = await TaskStore.create(goalInput, { storageRoot: this._storageRoot });
      try {
        if (routineRun) await store.checkpoint({ task: { state: "idle", pauseReason: null }, routineRun });
        await store.append({ type: "note", payload: {
          kind: "memory_policy_selected",
          mode: selected.mode,
          auditEventId: selected.auditEventId,
          actor: selected.actor,
          selectedAt: selected.at,
        } });
      } catch (error) {
        await store.close();
        throw error;
      }
      this._runMemoryPolicies.set(store.taskId, { mode: selected.mode, auditEventId: selected.auditEventId });
      if (this._closePromise) {
        await store.close();
        throw new TaskHostError("host_closed", "task host is closing or closed");
      }
      // Validate the exact pinned revision while the task is still not
      // enqueued/admitted. A malformed or missing routine must never reserve
      // a browser lease and then strand an active queue entry.
      let routine = null;
      try {
        if (routineRun) {
          if (!pinnedRoutineDefinition || pinnedRoutineDefinition.routineId !== routineRun.routineId ||
              pinnedRoutineDefinition.revision !== routineRun.revision || pinnedRoutineDefinition.digest !== routineRun.digest) {
            throw new TaskHostError("routine_cursor_mismatch", "new routine task lost its validated immutable revision");
          }
          routine = {
            runner: new RoutineRunner({ definition: pinnedRoutineDefinition, cursor: routineRun.cursor, batchReadOnlySteps: this._routineBatchReadOnlySteps }),
            run: { ...routineRun },
          };
        }
      } catch (error) {
        this._runMemoryPolicies.delete(store.taskId);
        await store.close();
        throw error;
      }
      await this._queue.enqueue(store.taskId);
      const admitted = await this._admitNext();
      if (admitted !== store.taskId) {
        const goal = store.getGoal();
        await store.close();
        return { taskId: store.taskId, snapshot: { state: "queued", queuePosition: this._queue.pendingIds().indexOf(store.taskId) + 1 }, goal };
      }
      const { controller } = this._attach(store, routine);
      const started = controller.start();
      return { store, controller, started };
    }).then(async (result) => {
      if (!result.controller) return { taskId: result.taskId, snapshot: result.snapshot, goal: result.goal };
      await result.started;
      return { taskId: result.store.taskId, snapshot: result.controller.getSnapshot(), goal: result.controller.getGoal() };
    });
  }

  async _ensureQueue() {
    if (this._queueReady) return this._queueReady;
    this._queueReady = (async () => {
      await this._queue.load();
      const summaries = await this._listTaskSummaries();
      await this._queue.reconcile(summaries);
      this._queueRecoveredBlocked = this._queue.pendingIds().length > 0;
    })();
    try { await this._queueReady; } catch (error) { this._queueReady = null; throw error; }
  }

  async _admitNext(options = {}) {
    const operation = this._admissionChain.then(() => this._admitNextLocked(options));
    this._admissionChain = operation.then(() => {}, () => {});
    return operation;
  }

  async _admitNextLocked({ recoveredHead = false } = {}) {
    await this._ensureQueue();
    if (this._queueRecoveredBlocked && !recoveredHead) return null;
    const candidateId = this._queue.pendingIds()[0];
    if (!candidateId) return null;
    const activeCount = this._queue.activeIds().length;
    const maxActive = this._executionMode === "parallel" ? this._maxParallelTasks : 1;
    if (activeCount >= maxActive) return null;
    const selected = await this._getRunMemoryPolicy(candidateId);
    const resourceAdmission = this._ensureResourceAdmission();
    // Monitor-less injected hosts retain sequential behavior. Production
    // supplies MemoryMonitor and always takes this shared lease path.
    if (!resourceAdmission) return this._queue.admitNext({ maxActive: 1 });
    let reserveBytes = this._parallelTaskReserveBytes;
    if (reserveBytes === undefined) {
      const plannerHighWater = this._memoryMonitor.getExternalProcessHighWaterBytes?.("planner");
      // The first task bootstraps the planner measurement in a single slot.
      // Any additional budgeted task needs the measured planner increment.
      if (activeCount > 0 && selected.mode === "budgeted" && (!Number.isFinite(plannerHighWater) || plannerHighWater <= 0)) return null;
      reserveBytes = MEASURED_BROWSER_TASK_RESERVE_BYTES +
        (Number.isFinite(plannerHighWater) && plannerHighWater > 0 ? Math.ceil(plannerHighWater * 1.25) : 0);
    }
    if (!Number.isFinite(reserveBytes) || reserveBytes <= 0) return null;
    const admission = await resourceAdmission.acquire({
      ownerId: candidateId,
      reserveBytes,
      maxAgeMs: 7500,
      parentPolicy: { mode: selected.mode, parentTaskId: candidateId, requestedAgentCount: 1 },
    });
    if (!admission.admitted) return null;
    try {
      const admittedId = await this._queue.admitNext({ maxActive });
      if (admittedId === candidateId) {
        this._taskLeases.set(candidateId, admission.leaseId);
        return admittedId;
      }
      await resourceAdmission.release(admission.leaseId);
      return null;
    } catch (error) {
      await resourceAdmission.release(admission.leaseId);
      throw error;
    }
  }

  onMemorySample() {
    if (this._closePromise || !this._queueReady || !this._queue.isLoaded() || this._queue.pendingIds().length === 0) return Promise.resolve(null);
    const transition = this._queueTransition.then(async () => {
      await this._queueReady;
      if (this._closePromise) return null;
      const taskId = await this._admitNext();
      if (taskId) this._startQueued(taskId).catch((error) => this._emit(taskId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
      return taskId;
    });
    this._queueTransition = transition.catch(() => {});
    return transition;
  }

  _recordTerminal(taskId, state) {
    const transition = this._queueTransition.then(async () => {
      if (!this._queueReady) return;
      await this._queueReady;
      if (!this._queue.activeIds().includes(taskId)) return;
      await this._queue.complete(taskId, state);
      const entry = this._active.get(taskId);
      if (entry) {
        this._unsubscribe(entry);
        this._active.delete(taskId);
        this._childCoordinator.unregisterStore(taskId);
        const cleanup = await Promise.allSettled([entry.planner.close?.(), entry.browser.dispose?.(), entry.store.close()]);
        if (cleanup.every((result) => result.status === "fulfilled")) await this._releaseTaskLease(taskId);
        else this._emit(taskId, entry.snapshot, { error: "resource_teardown_failed" });
      } else {
        await this._releaseTaskLease(taskId);
      }
      this._runMemoryPolicies.delete(taskId);
      if (this._closePromise) return;
      const nextId = await this._admitNext();
      if (nextId) this._startQueued(nextId).catch((error) => this._emit(nextId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
    });
    this._queueTransition = transition.catch(() => {});
  }

  async _startQueued(taskId) {
    return this._trackAttachment(async () => {
      const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
      if (this._closePromise) { await store.close(); return; }
      try {
        const routine = await this._resolveRoutineForStore(store);
        const { controller } = this._attach(store, routine);
        // A queued task never ran, but a store loaded off disk always attaches
        // as paused/recovered, so it is released with resume(), not start().
        const snapshot = controller.getSnapshot();
        const started = snapshot.state === "paused" && snapshot.pauseReason === "recovered" ? controller.resume() : controller.start();
        return { controller, started };
      } catch (error) {
        await store.close();
        throw error;
      }
    }).then((result) => result?.started);
  }

  async listTasks() {
    this._assertOpen();
    await this._ensureQueue();
    return this._listTaskSummaries();
  }

  async _listTaskSummaries() {
    const ids = await TaskStore.listTaskIds({ storageRoot: this._storageRoot });
    const summaries = [];
    for (const taskId of ids) {
      const active = this._active.get(taskId);
      if (active) {
        summaries.push({
          taskId,
          originalRequest: active.controller.getGoal().originalRequest,
          createdAt: active.controller.getGoal().createdAt,
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
      let store;
      try {
        store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
      } catch (error) {
        // An in-flight attachment (a queued task being started) holds the
        // store's writer lock; wait for it, then report the attached task.
        if (error?.code !== "writer_conflict" || this._pendingAttachments.size === 0) throw error;
        await Promise.allSettled([...this._pendingAttachments]);
        const attached = this._active.get(taskId);
        if (!attached) throw error;
        summaries.push({
          taskId,
          originalRequest: attached.controller.getGoal().originalRequest,
          createdAt: attached.controller.getGoal().createdAt,
          state: attached.controller.getSnapshot().state,
          pauseReason: attached.controller.getSnapshot().pauseReason,
          active: true,
        });
        continue;
      }
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
        createdAt: store.getGoal().createdAt,
        state: isTerminal ? checkpointedTask.state : store.recoveryReason === "execution_uncertain" ? "paused" : store.recoveryReason === "recovered" ? "paused" : "idle",
        pauseReason: isTerminal ? (checkpointedTask.pauseReason ?? null) : store.recoveryReason === "created" ? null : store.recoveryReason,
        active: false,
      });
      await store.close();
    }
    if (this._queue.isLoaded()) {
      const pending = this._queue.pendingIds();
      for (const summary of summaries) {
        const index = pending.indexOf(summary.taskId);
        if (index !== -1) {
          summary.queuePosition = index + 1;
          if (summary.state === "idle") summary.state = "queued";
        }
      }
    }
    return summaries;
  }

  async resumeSavedTask(taskId, opts = {}) {
    this._assertOpen();
    await this._ensureQueue();
    if (!this._active.has(taskId)) {
      const preflight = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
      try { await this._resolveRoutineForStore(preflight); }
      finally { await preflight.close(); }
    }
    if (this._queueRecoveredBlocked) {
      if (this._queue.pendingIds()[0] !== taskId) throw new TaskHostError("queued_behind_other_task", "resume the oldest queued task first");
      const admitted = await this._admitNext({ recoveredHead: true });
      if (admitted !== taskId) throw new TaskHostError("memory_admission_denied", "the queued task is waiting for a measured memory lease");
      this._queueRecoveredBlocked = false;
    }
    if (this._queue.pendingIds().includes(taskId)) {
      throw new TaskHostError("queued_behind_other_task", "a queued task must wait for its FIFO admission");
    }
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
      this._childCoordinator.unregisterStore(taskId);
      entry = null;
    }
    if (!entry) {
      const attached = await this._trackAttachment(async () => {
        const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
        if (this._closePromise) {
          await store.close();
          throw new TaskHostError("host_closed", "task host is closing or closed");
        }
        let routine;
        try {
          routine = await this._resolveRoutineForStore(store);
          await this._getRunMemoryPolicy(taskId, store);
        } catch (error) {
          await store.close();
          throw error;
        }
        const attachedEntry = this._attach(store, routine);
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
    await this._childCoordinator.withParentGoalLock(taskId, () => controller.amend(amendmentInput));
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

  async getHostSettings() {
    this._assertOpen();
    if (!this._settingsStore) throw new TaskHostError("settings_unavailable", "host settings are unavailable");
    return this._settingsStore.load();
  }

  async updateHostSettings(patch) {
    this._assertOpen();
    if (!this._settingsStore) throw new TaskHostError("settings_unavailable", "host settings are unavailable");
    // Only this trusted host method is exposed through the allowlisted UI
    // action. The renderer never supplies or selects an audit actor.
    const settings = await this._settingsStore.update(patch, { actor: "user" });
    this._executionMode = settings.executionMode;
    this._permissionMode = settings.permissionMode;
    this._plannerEffort = settings.plannerEffort;
    for (const entry of this._active.values()) entry.controller.setPolicySettings(settings);
    return settings;
  }

  async listCredentials() {
    this._assertOpen();
    if (!this._credentialVault) throw new TaskHostError("vault_unavailable", "local credential vault is unavailable");
    return this._credentialVault.list();
  }

  async saveCredential(input) {
    this._assertOpen();
    if (!this._credentialVault) throw new TaskHostError("vault_unavailable", "local credential vault is unavailable");
    return this._credentialVault.put(input);
  }

  async removeCredential(id) {
    this._assertOpen();
    if (!this._credentialVault) throw new TaskHostError("vault_unavailable", "local credential vault is unavailable");
    return this._credentialVault.remove(id);
  }

  async fillCredential(taskId, credentialId) {
    const { controller, browser } = this._require(taskId);
    if (!controller.isUserControlled()) throw new TaskHostError("human_control_required", "take over the task before using a saved credential");
    if (!this._credentialVault) throw new TaskHostError("vault_unavailable", "local credential vault is unavailable");
    if (typeof browser.fillCredential !== "function") throw new TaskHostError("browser_unavailable", "this browser surface does not support credential filling");
    const page = browser.getBrowserSnapshot?.();
    const origin = page?.tabs?.find((tab) => tab.id === page.activeTabId)?.url;
    if (typeof origin !== "string") throw new TaskHostError("browser_unavailable", "there is no active web page for credential filling");
    await controller.recordHostNote({ kind: "credential_autofill_requested", credentialId, origin });
    return this._credentialVault.fill({
      credentialId,
      origin,
      approved: true, // invocation is a trusted, explicit human IPC action; never model-dispatchable
      fillCredential: (credentials) => browser.fillCredential({ ...credentials, origin }),
    });
  }

  async listMemories() {
    this._assertOpen();
    if (!this._memoryStore) throw new TaskHostError("memory_unavailable", "local memory store is unavailable");
    return this._memoryStore.list();
  }

  async saveMemory(input) {
    this._assertOpen();
    if (!this._memoryStore) throw new TaskHostError("memory_unavailable", "local memory store is unavailable");
    return this._memoryStore.put(input);
  }

  async removeMemory(id) {
    this._assertOpen();
    if (!this._memoryStore) throw new TaskHostError("memory_unavailable", "local memory store is unavailable");
    return this._memoryStore.remove(id);
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
      await this._queueTransition;
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
        if (cleanup.every((result) => result.status === "fulfilled")) {
          try { await this._releaseTaskLease(entry.store.taskId); } catch (error) { errors.push(error); }
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
