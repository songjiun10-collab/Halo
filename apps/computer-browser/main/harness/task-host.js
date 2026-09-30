"use strict";

const crypto = require("node:crypto");

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

const path = require("node:path");
const { importClaudeUsage, importCodexUsage } = require("./usage-import");
const { fetchClaudeSubscription } = require("./subscription-usage");
const { TaskStore } = require("./task-store");
const { TaskController, TaskControllerError } = require("./task-controller");
const { TaskQueue, TaskQueueError } = require("./task-queue");
const { ResourceAdmission } = require("./resource-admission");
const { CoordinatorCore } = require("./coordinator-core");
const { RoutineStore } = require("./routine-store");
const { RoutineRunner } = require("./routine-runner");
const { ChildAgentCoordinator } = require("./child-agent-coordinator");
const { Scheduler } = require("./scheduler");
const { ScheduleStore } = require("./schedule-store");
const { WorkGoalStore } = require("./work-goal-store");
const { WorkGoalOrchestrator } = require("./work-goal-orchestrator");
const { isPlainObject, validateGoalTrigger, normalizeGoalSpec, DEFAULT_LIMITS } = require("../../shared/harness-contracts");
const { selectHarnessProfile, maxActionsPerProposal } = require("../../shared/harness-profile");
const { resolveTaskProfile } = require("../../shared/task-profile-router");
const { clearSessionCookies, clearDisallowedSessionCookies } = require("./profile-import/session-injector");

const TASK_PROFILE_SELECTOR_FIELDS = Object.freeze(["requestedDurationProfile", "requestedCapabilityProfile", "standalone", "useImportedSessions"]);
const WORK_GOAL_BLOCKER_PHASE = Object.freeze({
  planner_unavailable: "planner", planner_error: "planner", observation_error: "browser_observation",
  context_error: "context_build", no_progress: "action_progress", budget_exhausted: "budget",
  child_plan_failed: "child_plan", message_ack_failed: "message_ack",
  send_message_failed: "message_delivery", routine_step_failed: "routine_step",
});

// Two complete Electron task surfaces (visible + fixed hidden renderer) were
// measured at a 590,888,960-byte increment with 50ms polling; reserve the
// rounded-up per-task half plus margin. Planner subtree reserve is added
// dynamically from the measured live worker high-water mark below.

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
    usageLedger,
    usageSources,
    subscriptionFetch,
    credentialVault,
    profileImporter,
    getTaskSession,
    workGoalStore,
    workGoalOrchestrator,
    routineReadOnlyBatching = true,
    scheduler: schedulerOptions = {},
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
    this._usageLedger = usageLedger || null;
    this._usageSources = usageSources || {};
    this._subscriptionFetch = subscriptionFetch; // undefined -> global fetch
    this._credentialVault = credentialVault || null;
    this._profileImporter = profileImporter || null;
    this._getTaskSession = typeof getTaskSession === "function" ? getTaskSession : null;
    this._workGoalStore = workGoalStore || new WorkGoalStore({ storageRoot, now });
    this._workGoalOrchestrator = workGoalOrchestrator || new WorkGoalOrchestrator({
      storageRoot,
      store: this._workGoalStore,
      taskStoreClass: TaskStore,
      getOpenTaskStore: (taskId) => this._active.get(taskId)?.store || null,
    });
    this._workGoalReady = null;
    // Serialize the short cross-store transaction that reserves a Goal slot,
    // creates/binds its Task journal, and records the continuation with Goal
    // lifecycle changes. Do not hold this gate while a Task is running.
    this._workGoalAdmissionChain = Promise.resolve();
    this._routineStore = new RoutineStore({ storageRoot });
    if (executionMode !== "sequential" && executionMode !== "parallel") throw new TaskHostError("invalid_config", "executionMode must be sequential or parallel");
    this._executionMode = executionMode;
    if (!Number.isInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > 8) throw new TaskHostError("invalid_config", "maxParallelTasks must be an integer from 1 to 8");
    this._maxParallelTasks = maxParallelTasks;
    this._parallelTaskReserveBytes = parallelTaskReserveBytes;
    this._queue = new TaskQueue({ storageRoot });
    this._queueReady = null;
    this._queueTransition = Promise.resolve();
    this._listeners = new Set();
    // taskId -> {store, controller, browser, planner}
    this._active = new Map();
    this._sessionAccessChain = Promise.resolve();
    this._pendingAttachments = new Set();
    this._storeGate = Promise.resolve();
    this._triggeredRuns = new Map();
    this._schedulerOptions = schedulerOptions;
    this._scheduleStore = null;
    this._scheduler = null;
    this._schedulerStarting = null;
    this._closePromise = null;
    // All top-level reservations use the same ledger as child agents. Built
    // lazily (see
    // _ensureResourceAdmission) so a memoryMonitor fake supplied only for
    // TaskController's own pressure check (no canAdmitTask) never trips
    // ResourceAdmission's stricter constructor requirements.
    this._resourceAdmission = null;
    this._runMemoryPolicies = new Map();
    // Admission (parallel cap, memory reserve, lease ledger) lives behind the
    // coordinator seam; a lease is required before a task builds resources.
    this._coordinator = new CoordinatorCore({
      queue: this._queue,
      ensureQueue: () => this._ensureQueue(),
      getResourceAdmission: () => this._ensureResourceAdmission(),
      getRunMemoryPolicy: (taskId) => this._getRunMemoryPolicy(taskId),
      getExternalProcessHighWaterBytes: (kind) => this._memoryMonitor?.getExternalProcessHighWaterBytes?.(kind),
      executionMode: this._executionMode,
      maxParallelTasks: this._maxParallelTasks,
      parallelTaskReserveBytes: this._parallelTaskReserveBytes,
    });
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

  _attach(store, routine = null) {
    if (this._ensureResourceAdmission() && !this._coordinator.hasLease(store.taskId)) {
      throw new TaskHostError("memory_lease_required", "top-level task requires a memory lease before creating resources");
    }
    const taskProfile = store.taskProfile ?? null;
    if (taskProfile?.capability.id === "routine" && !routine) {
      throw new TaskHostError("profile_routine_pin_missing", "profile-selected Routine task has no validated pinned definition");
    }
    if (taskProfile && (taskProfile.capability.id === "routine") !== !!routine) {
      throw new TaskHostError("profile_capability_mismatch", "task profile capability does not match its pinned execution source");
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
    // Profile selection is a host operation (design doc "Profile selection"):
    // TaskHost is the sole authority that decides harnessProfile, and passes
    // it in rather than letting the controller (or the task's own text)
    // infer it independently. The resolved durable task profile is canonical;
    // legacy tasks without one retain the deterministic routine default.
    const harnessProfile = taskProfile?.duration.id || selectHarnessProfile({ isRoutine: !!routine });
    const controller = new TaskController({
      store,
      planner,
      browser,
      harnessProfile,
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
      ...(taskProfile?.workGoalBinding ? {
        readWorkGoalContext: (binding) => {
          const persisted = taskProfile.workGoalBinding;
          if (binding.goalId !== persisted.goalId || binding.goalVersion !== persisted.goalVersion ||
              binding.reservationId !== persisted.reservationId || binding.taskId !== store.taskId) {
            throw new TaskHostError("invalid_work_goal_binding", "planner context request differs from the Task's durable Work Goal binding");
          }
          return this._workGoalOrchestrator.getTaskContext({
            ...persisted,
            taskId: store.taskId,
            workGoalBinding: persisted,
          });
        },
      } : {}),
      ...(routine ? { routineRunner: routine.runner, routineRun: routine.run } : {}),
    });
    const entry = { store, controller, browser, planner, routinePinned: !!routine, snapshot: controller.getSnapshot() };
    this._active.set(store.taskId, entry);
    entry.unsubscribeController = controller.onChange((snapshot) => {
      entry.snapshot = snapshot;
      this._emit(store.taskId, snapshot, { goal: controller.getGoal(), browser: browser.getBrowserSnapshot?.() });
      const binding = store.taskProfile?.workGoalBinding;
      const phase = WORK_GOAL_BLOCKER_PHASE[snapshot.pauseReason];
      if (binding && snapshot.state === "paused") {
        // Controller pause transitions checkpoint before notifying listeners.
        // Blocker accounting is durable but best-effort: it never interferes
        // with pausing the actual Task.
        const operation = phase
          ? () => this._workGoalOrchestrator.observeBlocker(binding.goalId, binding.goalVersion, {
            taskId: store.taskId, reasonCode: snapshot.pauseReason, phase, taskStore: store,
          })
          : () => this._workGoalOrchestrator.resolveContinuation(binding.goalId, binding.goalVersion, {
            taskId: store.taskId, taskStore: store, taskState: "paused",
          });
        this._withWorkGoalAdmission(operation).catch(() => {});
      }
      if (snapshot.state === "completed" || snapshot.state === "stopped") {
        // The task's session is discarded with it; stop tracking it for purges.
        this._profileImporter?.releaseTask?.(store.taskId);
        this._recordTerminal(store.taskId, snapshot.state);
      }
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

  // Injects the user's imported sessions into the task's own session partition
  // before its browser is built, so the first navigation is already signed in.
  // Only tasks that opted in (durably, at creation) are touched. A failure
  // never blocks the task; the audit note records counts and domains only.
  async _attachPrepared(store, routine = null) {
    if (!this._profileImporter || !this._getTaskSession) return this._attach(store, routine);
    let optedIn = false;
    try { optedIn = await this._profileImporter.hasTaskOptIn(store.taskId); }
    catch { return this._attach(store, routine); }
    if (!optedIn) return this._attach(store, routine);

    return this._withSessionAccess(async () => {
      let summary = null;
      let injectionErrorCode = null;
      const session = this._getTaskSession(store.taskId);
      try { summary = await this._profileImporter.prepareTask(store.taskId, session); }
      catch (error) {
        // Still non-blocking, but recorded: a value-free code distinguishes a
        // failed injection from a task that never opted in.
        summary = null;
        injectionErrorCode = /^[A-Za-z0-9_.-]{1,64}$/.test(String(error?.code)) ? String(error.code) : "unknown";
      }
      const entry = this._attach(store, routine);
      entry.importedSession = session;
      if (injectionErrorCode) {
        entry.controller.recordHostNote({ kind: "imported_sessions_injection_failed", errorCode: injectionErrorCode }).catch(() => {});
      }
      if (summary) {
        entry.controller.recordHostNote({ kind: "imported_sessions_injected", injected: summary.injected, failed: summary.failed, domains: summary.domains }).catch(() => {});
      }
      return entry;
    });
  }

  async _clearActiveSessionCookies(domains, { disallowed = false } = {}) {
    const entries = [...this._active.values()].filter((entry) => entry.importedSession);
    const results = await Promise.allSettled(entries.map((entry) => (
      disallowed
        ? clearDisallowedSessionCookies(entry.importedSession, domains)
        : clearSessionCookies(entry.importedSession, domains)
    )));
    const failed = results.reduce((count, result) => count + (result.status === "rejected" ? 1 : result.value.failed), 0);
    if (failed > 0) {
      const affected = results.flatMap((result, index) => (
        result.status === "rejected" || result.value.failed > 0 ? [entries[index]] : []
      ));
      // A failed revocation is not just a settings error: the task may still
      // hold a usable login. Remove its automation and page runtime even when
      // Electron cannot confirm that every cookie left the partition.
      await Promise.allSettled(affected.map(async (entry) => {
        try {
          // Child agents share the parent's partition, so stopping only the
          // parent would leave another live renderer able to use the same
          // session. cancelPlan() is a no-op error when no child plan exists.
          try {
            await this._childCoordinator.cancelPlan(entry.store.taskId, "session_revocation_failed", { parentStore: entry.store });
          } catch {
            // Continue to stop and tear down the parent even if child-plan
            // cancellation could not be durably recorded.
          }
          const state = entry.controller?.getSnapshot?.().state;
          if (!state || !["stopped", "completed"].includes(state)) await entry.controller?.stop?.();
        } finally {
          await entry.browser?.dispose?.();
        }
      }));
      throw new TaskHostError("session_revoke_failed", "one or more active task sessions could not be cleared; affected tasks were stopped");
    }
  }

  _requireSessions() {
    this._assertOpen();
    if (!this._profileImporter) throw new TaskHostError("sessions_unavailable", "imported browser sessions are unavailable");
    return this._profileImporter;
  }

  async importSessions(input) { return this._withSessionAccess(() => this._requireSessions().import(input)); }
  async listImportedSessions() { return this._requireSessions().list(); }
  async removeImportedSession(domain) {
    return this._withSessionAccess(async () => {
      const removed = await this._requireSessions().remove(domain);
      await this._clearActiveSessionCookies([domain]);
      return removed;
    });
  }
  async getSessionAllowlist() { return this._requireSessions().getAllowlist(); }
  async setSessionAllowlist(domains) {
    return this._withSessionAccess(async () => {
      const allowlist = await this._requireSessions().setAllowlist(domains);
      await this._clearActiveSessionCookies(allowlist, { disallowed: true });
      return allowlist;
    });
  }
  async importBrowserSettings(input) { return this._requireSessions().importSettings(input); }
  async getImportedSettings() { return this._requireSessions().getSettings(); }

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

  createTask(goalInput, selectors = {}) {
    return this._createTaskWithProfile(goalInput, selectors);
  }

  async _ensureWorkGoalReady() {
    if (this._workGoalReady) return this._workGoalReady;
    this._workGoalReady = (async () => {
      await this._workGoalStore.load();
      await this._workGoalOrchestrator.reconcileAll?.();
    })();
    try { await this._workGoalReady; }
    catch (error) { this._workGoalReady = null; throw error; }
  }

  _withWorkGoalAdmission(operation) {
    const result = this._workGoalAdmissionChain.then(operation);
    this._workGoalAdmissionChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async startWorkGoal(input) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.startWorkGoal(input));
  }

  async getActiveWorkGoal() {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._workGoalOrchestrator.getActiveWorkGoal();
  }

  async listWorkGoalHistory(options) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._workGoalOrchestrator.listWorkGoalHistory(options);
  }

  async amendWorkGoal(expectedVersion, nextSpec) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.amendWorkGoal(expectedVersion, nextSpec));
  }

  async pauseWorkGoal(goalId, expectedVersion) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.pauseWorkGoal(goalId, expectedVersion));
  }

  async resumeWorkGoal(goalId, expectedVersion) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.resumeWorkGoal(goalId, expectedVersion));
  }

  async completeWorkGoal(goalId, expectedVersion) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.completeWorkGoal(goalId, expectedVersion));
  }

  async archiveWorkGoal(goalId, expectedVersion) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.archiveWorkGoal(goalId, expectedVersion));
  }

  async recordWorkGoalProgress(goalId, expectedVersion, evidenceRefs) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._workGoalOrchestrator.recordWorkGoalProgress(goalId, expectedVersion, evidenceRefs);
  }

  async verifyWorkGoalCriterion(goalId, expectedVersion, criterionId) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._workGoalOrchestrator.verifyWorkGoalCriterion(goalId, expectedVersion, criterionId);
  }

  async getWorkGoalRecoveryStatus(goalId, expectedVersion) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.getWorkGoalRecoveryStatus(goalId, expectedVersion));
  }

  async repairWorkGoalReservation(goalId, expectedVersion, reservationId) {
    this._assertOpen();
    await this._ensureWorkGoalReady();
    return this._withWorkGoalAdmission(() => this._workGoalOrchestrator.repairMissingTaskReservation(goalId, expectedVersion, reservationId));
  }

  _createTaskWithProfile(goalInput, selectors = {}) {
    this._assertOpen();
    if (!isPlainObject(selectors) || Object.keys(selectors).some((key) => !TASK_PROFILE_SELECTOR_FIELDS.includes(key)) ||
        (Object.hasOwn(selectors, "standalone") && typeof selectors.standalone !== "boolean") ||
        (Object.hasOwn(selectors, "useImportedSessions") && typeof selectors.useImportedSessions !== "boolean")) {
      return Promise.reject(new TaskHostError("invalid_selector", "task profile selectors contain unknown fields"));
    }
    if (selectors.useImportedSessions === true && !(this._profileImporter && this._getTaskSession)) {
      return Promise.reject(new TaskHostError("sessions_unavailable", "imported browser sessions are unavailable"));
    }
    let stableGoalInput;
    try { stableGoalInput = structuredClone(goalInput); }
    catch (error) { return Promise.reject(new TaskHostError("invalid_goal", `goalInput cannot be snapshotted: ${error.message}`)); }
    let resolvedProfile;
    try {
      resolvedProfile = resolveTaskProfile({
        goalInput: stableGoalInput,
        requestedDurationProfile: Object.hasOwn(selectors, "requestedDurationProfile") ? selectors.requestedDurationProfile : "auto",
        requestedCapabilityProfile: Object.hasOwn(selectors, "requestedCapabilityProfile") ? selectors.requestedCapabilityProfile : null,
      });
    } catch (error) {
      return Promise.reject(new TaskHostError(error.code || "profile_resolution_failed", error.message));
    }
    return this._createNewTask(stableGoalInput, null, null, resolvedProfile, selectors.standalone === true, selectors.useImportedSessions === true);
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
    const result = await this._routineStore.delete(routineId);
    await this.getScheduleStore().disableForRoutine(routineId, "routine_deleted");
    return result;
  }

  getScheduleStore() {
    if (!this._scheduleStore) {
      this._scheduleStore = new ScheduleStore({ storageRoot: this._storageRoot, now: this._schedulerOptions.now });
    }
    return this._scheduleStore;
  }

  // Starts the routine scheduler over this host's storage root. The scheduler
  // only calls runRoutine/listTasks/stopTask, so scheduled runs go through the
  // same queue, admission and approval path as manual ones.
  async startScheduler() {
    this._assertOpen();
    if (!this._schedulerStarting) {
      this._schedulerStarting = (async () => {
        await this._ensureQueue();
        const scheduler = new Scheduler({ ...this._schedulerOptions, host: this, store: this.getScheduleStore() });
        this._scheduler = scheduler;
        await scheduler.start();
        return scheduler;
      })();
      this._schedulerStarting.catch(() => { this._schedulerStarting = null; this._scheduler = null; });
    }
    return this._schedulerStarting;
  }

  async runRoutine(routineId, revision, options = {}) {
    this._assertOpen();
    if (!isPlainObject(options) || Object.keys(options).some((key) => !["trigger", "requestedDurationProfile"].includes(key))) {
      throw new TaskHostError("invalid_selector", "routine options contain unknown fields");
    }
    const { trigger, requestedDurationProfile = "auto" } = options;
    if (!Number.isInteger(revision) || revision < 1) {
      throw new TaskHostError("invalid_revision", "runRoutine requires an exact positive revision");
    }
    if (trigger === undefined) return this._runRoutineNow(routineId, revision, undefined, requestedDurationProfile);
    validateGoalTrigger(trigger, "trigger");
    // Idempotent per occurrence: a repeat of the same scheduled occurrence
    // returns the task it already produced instead of creating a second one.
    const key = `${trigger.scheduleId}@${trigger.occurrenceAt}`;
    const inflight = this._triggeredRuns.get(key);
    if (inflight) return inflight;
    const run = (async () => {
      await this._ensureQueue();
      const existing = (await this._listTaskSummaries()).find((task) => task.routinePinned && task.trigger
        && task.trigger.scheduleId === trigger.scheduleId && task.trigger.occurrenceAt === trigger.occurrenceAt);
      if (existing) return { taskId: existing.taskId, snapshot: { state: existing.state, pauseReason: existing.pauseReason }, existing: true };
      return this._runRoutineNow(routineId, revision, trigger, requestedDurationProfile);
    })().finally(() => this._triggeredRuns.delete(key));
    this._triggeredRuns.set(key, run);
    return run;
  }

  async _runRoutineNow(routineId, revision, trigger, requestedDurationProfile = "auto") {
    // The current-index read enforces the tombstone: an explicit get of an
    // old revision is allowed for recovery, but deletion forbids new runs.
    await this._routineStore.get(routineId);
    const definition = await this._routineStore.get(routineId, revision);
    const goal = {
      originalRequest: `Run saved routine: ${definition.name}`,
      criteria: [{ id: "routine-complete", text: "Confirm the saved routine completed", required: true, verification: "user" }],
      ...(trigger ? { trigger } : {}),
    };
    const run = {
      routineId: definition.routineId,
      revision: definition.revision,
      digest: definition.digest,
      cursor: 0,
    };
    let resolvedProfile;
    try {
      resolvedProfile = resolveTaskProfile({
        goalInput: goal,
        requestedDurationProfile,
        routineMetadata: {
          routineId: definition.routineId,
          revision: definition.revision,
          digest: definition.digest,
          stepCount: definition.steps.length,
        },
      });
    } catch (error) {
      throw new TaskHostError(error.code || "profile_resolution_failed", error.message);
    }
    return this._createNewTask(goal, run, definition, resolvedProfile);
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
      runner = this._makeRoutineRunner({
        definition,
        cursor,
        durationProfile: store.taskProfile?.duration?.id || "short",
      });
    } catch {
      throw new TaskHostError("routine_cursor_mismatch", "routine cursor is out of range");
    }
    return { runner, run: { ...pin, cursor } };
  }

  // The runner's proposal cap follows the independently selected duration
  // profile, both for a new routine and for recovery from its pinned store.
  _makeRoutineRunner({ definition, cursor, durationProfile = "short" }) {
    return new RoutineRunner({
      definition,
      cursor,
      batchReadOnlySteps: this._routineBatchReadOnlySteps,
      maxBatchActions: maxActionsPerProposal(durationProfile),
    });
  }

  _createNewTask(goalInput, routineRun = null, pinnedRoutineDefinition = null, resolvedProfile = null, standalone = false, useImportedSessions = false) {
    this._assertOpen();
    if (!resolvedProfile) throw new TaskHostError("profile_required", "new tasks must have a host-resolved profile before storage or admission");
    return this._trackAttachment(async () => {
      await this._ensureQueue();
      await this._ensureWorkGoalReady();
      const selected = this._settingsStore
        ? await this._settingsStore.getMemoryPolicySelection()
        : { mode: "budgeted", auditEventId: null, actor: null, at: null };
      let taskId;
      try { taskId = crypto.randomUUID(); }
      catch (error) { throw new TaskHostError("task_id_unavailable", error.message); }
      // The task ID is host-generated before any storage exists, so the opt-in
      // is made durable FIRST. A failed write rejects createTask with no task
      // or Work Goal reservation left behind, and a crash after this point can
      // never leave a recoverable task that silently lost its opt-in.
      if (useImportedSessions) await this._profileImporter.markTaskOptIn(taskId);
      let created;
      try {
        created = await this._withWorkGoalAdmission(async () => {
        let binding = null;
        let taskGoalInput = structuredClone(goalInput);
        const activeGoal = standalone ? null : await this._workGoalOrchestrator.getActiveWorkGoal();
        let reservation = null;
        if (activeGoal) {
          if (activeGoal.status !== "active") {
            throw new TaskHostError("work_goal_not_active", "resume or archive the current Work Goal, or explicitly create a standalone Task");
          }
          const currentContext = await this._workGoalOrchestrator.getContext(activeGoal.goalId, activeGoal.spec.version);
          let normalized;
          try { normalized = normalizeGoalSpec(taskGoalInput, { taskId, goalVersion: 1, createdAt: new Date().toISOString() }); }
          catch (error) { throw new TaskHostError(error.code || "invalid_goal", error.message); }
          const effectiveLimits = {};
          for (const axis of Object.keys(DEFAULT_LIMITS)) {
            const aggregate = currentContext.remainingBudget[axis];
            effectiveLimits[axis] = Math.min(normalized.limits[axis], aggregate === undefined ? normalized.limits[axis] : aggregate);
            if (!Number.isSafeInteger(effectiveLimits[axis]) || effectiveLimits[axis] <= 0) {
              throw new TaskHostError("goal_budget_exhausted", `Work Goal has no remaining ${axis} allowance`);
            }
          }
          taskGoalInput.limits = effectiveLimits;
          reservation = {
            taskId,
            limits: { maxTasks: 1, ...effectiveLimits },
            reservationId: crypto.randomUUID(),
          };
          binding = {
            goalId: activeGoal.goalId,
            goalVersion: activeGoal.spec.version,
            reservationId: reservation.reservationId,
          };
        }
        const taskStore = await TaskStore.create(taskGoalInput, {
          storageRoot: this._storageRoot,
          taskId,
          resolvedProfile,
          ...(binding ? { workGoalBinding: binding } : {}),
        });
        try {
          if (reservation && binding) {
            // Create the immutable Task profile before consuming project
            // budget. If TaskStore.create fails before it can produce a
            // recoverable journal, no reservation is left stranded.
            await this._workGoalOrchestrator.reserveTask(binding.goalId, binding.goalVersion, reservation);
            await this._workGoalOrchestrator.linkTask(binding.goalId, binding.goalVersion, {
              reservationId: reservation.reservationId, taskId,
            });
          }
          if (routineRun) await taskStore.checkpoint({ task: { state: "idle", pauseReason: null }, routineRun });
          await taskStore.append({ type: "note", payload: {
            kind: "memory_policy_selected",
            mode: selected.mode,
            auditEventId: selected.auditEventId,
            actor: selected.actor,
            selectedAt: selected.at,
          } });
          if (this._closePromise) throw new TaskHostError("host_closed", "task host is closing or closed");
          if (binding) {
            await this._workGoalOrchestrator.recordContinuation(binding.goalId, binding.goalVersion, {
              taskId, origin: goalInput?.trigger ? "scheduler" : routineRun ? "routine" : "user",
            });
          }
        } catch (error) {
          await taskStore.close();
          throw error;
        }
        return { store: taskStore, workGoalBinding: binding };
        });
      } catch (error) {
        if (useImportedSessions) await this._profileImporter.unmarkTaskOptIn(taskId).catch(() => {});
        throw error;
      }
      const { store, workGoalBinding } = created;
      this._runMemoryPolicies.set(store.taskId, { mode: selected.mode, auditEventId: selected.auditEventId });
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
            runner: this._makeRoutineRunner({
              definition: pinnedRoutineDefinition,
              cursor: routineRun.cursor,
              durationProfile: resolvedProfile.duration.id,
            }),
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
      const { controller } = await this._attachPrepared(store, routine);
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
      await this._ensureWorkGoalReady();
      await this._queue.load();
      const summaries = await this._listTaskSummaries();
      await this._queue.reconcile(summaries);
      this._coordinator.recoveredBlocked = this._queue.pendingIds().length > 0;
    })();
    try { await this._queueReady; } catch (error) { this._queueReady = null; throw error; }
  }

  _admitNext(options = {}) {
    return this._coordinator.admitNext(options);
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
        const binding = entry.store.taskProfile?.workGoalBinding;
        if (binding) {
          await this._withWorkGoalAdmission(() => this._workGoalOrchestrator.resolveContinuation(
            binding.goalId, binding.goalVersion, { taskId, taskStore: entry.store, taskState: state },
          )).catch((error) => {
            this._emit(taskId, entry.snapshot, { error: error.code || "work_goal_continuation_resolution_failed" });
          });
          await this._workGoalOrchestrator.reconcileTask(taskId, { taskStore: entry.store }).catch((error) => {
            this._emit(taskId, entry.snapshot, { error: error.code || "work_goal_reconciliation_failed" });
          });
        }
        this._unsubscribe(entry);
        this._active.delete(taskId);
        this._childCoordinator.unregisterStore(taskId);
        const cleanup = await Promise.allSettled([entry.planner.close?.(), entry.browser.dispose?.(), entry.store.close()]);
        if (cleanup.every((result) => result.status === "fulfilled")) await this._coordinator.releaseLease(taskId);
        else this._emit(taskId, entry.snapshot, { error: "resource_teardown_failed" });
      } else {
        await this._coordinator.releaseLease(taskId);
      }
      this._runMemoryPolicies.delete(taskId);
      if (this._closePromise) return;
      const nextId = await this._admitNext();
      if (nextId) this._startQueued(nextId).catch((error) => this._emit(nextId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
    });
    this._queueTransition = transition.catch(() => {});
  }

  // listTasks() peeks stores under their writer lock. In-process peeks and the
  // load that attaches a queued task go through one gate so they can never
  // collide on that lock (a collision left an admitted task queued forever).
  _withStoreGate(fn) {
    const run = this._storeGate.then(fn);
    this._storeGate = run.then(() => {}, () => {});
    return run;
  }

  async _startQueued(taskId) {
    return this._trackAttachment(async () => {
      const store = await this._withStoreGate(() => TaskStore.load(taskId, { storageRoot: this._storageRoot }));
      if (this._closePromise) { await store.close(); return; }
      try {
        const routine = await this._resolveRoutineForStore(store);
        const { controller } = await this._attachPrepared(store, routine);
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
          trigger: active.controller.getGoal().trigger ?? null,
          routinePinned: active.routinePinned === true,
        });
        continue;
      }
      // Not currently attached -- peek the store without starting a
      // controller/browser/planner for every saved task on every listTasks()
      // call (that would spawn a WebContentsView/worker per saved task just
      // to list them).
      const peeked = await this._withStoreGate(async () => {
        let store;
        try {
          store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
        } catch (error) {
          return { error };
        }
        try {
          // Same fix as task-controller.js's constructor (2026-09-27 follow-up):
          // a task that already reached completed/stopped was checkpointed
          // synchronously the instant it got there, so that checkpoint is
          // authoritative over recoveryReason -- otherwise a finished task is
          // peeked as plain "paused"/"recovered", indistinguishable from one
          // merely interrupted mid-flight.
          const checkpointedTask = store.lastCheckpoint && store.lastCheckpoint.payload && store.lastCheckpoint.payload.task;
          const isTerminal = checkpointedTask && (checkpointedTask.state === "completed" || checkpointedTask.state === "stopped");
          return {
            summary: {
              taskId,
              originalRequest: store.getGoal().originalRequest,
              createdAt: store.getGoal().createdAt,
              state: isTerminal ? checkpointedTask.state : store.recoveryReason === "execution_uncertain" ? "paused" : store.recoveryReason === "recovered" ? "paused" : "idle",
              pauseReason: isTerminal ? (checkpointedTask.pauseReason ?? null) : store.recoveryReason === "created" ? null : store.recoveryReason,
              active: false,
              trigger: store.getGoal().trigger ?? null,
              routinePinned: !!store.lastCheckpoint?.payload?.routineRun,
            },
          };
        } finally {
          await store.close();
        }
      });
      if (peeked.error) {
        const error = peeked.error;
        // A profile-required store can be left with only goal_created if the
        // second durable append failed during creation. It is intentionally
        // non-runnable, but it must not make unrelated valid tasks invisible
        // or prevent TaskHost queue recovery after restart.
        if (error?.code === "profile_incomplete") continue;
        // An in-flight or just-finished attachment (a queued task being
        // started) holds the store's writer lock; wait for it, then report the
        // attached task.
        if (error?.code !== "writer_conflict") throw error;
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
          trigger: attached.controller.getGoal().trigger ?? null,
          routinePinned: attached.routinePinned === true,
        });
        continue;
      }
      summaries.push(peeked.summary);
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
    if (this._coordinator.recoveredBlocked) {
      if (this._queue.pendingIds()[0] !== taskId) throw new TaskHostError("queued_behind_other_task", "resume the oldest queued task first");
      const admitted = await this._admitNext({ recoveredHead: true });
      if (admitted !== taskId) throw new TaskHostError("memory_admission_denied", "the queued task is waiting for a measured memory lease");
      this._coordinator.recoveredBlocked = false;
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
        const attachedEntry = await this._attachPrepared(store, routine);
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
      return {
        taskId,
        goal: active.controller.getGoal(),
        snapshot: active.controller.getSnapshot(),
        active: true,
        harnessProfile: active.controller.getHarnessProfile(),
        taskProfile: active.store.taskProfile ?? null,
      };
    }
    const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
    const harnessProfile = store.taskProfile?.duration.id || store.lastCheckpoint?.payload?.harnessProfile || selectHarnessProfile({ isRoutine: !!store.lastCheckpoint?.payload?.routineRun });
    const detail = { taskId, goal: store.getGoal(), recoveryReason: store.recoveryReason, active: false, harnessProfile, taskProfile: store.taskProfile ?? null };
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

  async getUsage(taskId) {
    this._assertOpen();
    if (!this._usageLedger) throw new TaskHostError("usage_unavailable", "usage ledger is unavailable");
    return this._usageLedger.summary(typeof taskId === "string" ? { taskId } : {});
  }

  // Pulls the totals the local Claude/Codex CLIs recorded themselves. A source
  // that is not configured or holds no records is reported, not faked.
  async syncUsage() {
    this._assertOpen();
    if (!this._usageLedger) throw new TaskHostError("usage_unavailable", "usage ledger is unavailable");
    const importers = { claude: importClaudeUsage, codex: importCodexUsage };
    const results = {};
    for (const provider of Object.keys(importers)) {
      const root = this._usageSources[provider];
      if (!root) { results[provider] = { status: "not_configured" }; continue; }
      try {
        const imported = await importers[provider]({ root });
        if (imported.sessions === 0) { results[provider] = { status: "no_records" }; continue; }
        const { subscription, ...totals } = imported;
        this._usageLedger.setImported(provider, totals);
        if (subscription) this._usageLedger.setSubscription(provider, subscription);
        results[provider] = { status: "synced", sessions: imported.sessions };
      } catch {
        results[provider] = { status: "failed" };
      }
    }
    // Claude's plan quota comes from the account, not from local files.
    const claudeConfigDir = this._usageSources.claude ? path.dirname(this._usageSources.claude) : null;
    const subscription = await fetchClaudeSubscription({ configDir: claudeConfigDir, fetchFn: this._subscriptionFetch });
    if (subscription.snapshot) this._usageLedger.setSubscription("claude", subscription.snapshot);
    results.claudeSubscription = { status: subscription.status };
    return { results, usage: this._usageLedger.summary() };
  }

  async setUsageLimit(provider, patch) {
    this._assertOpen();
    if (!this._usageLedger) throw new TaskHostError("usage_unavailable", "usage ledger is unavailable");
    try {
      this._usageLedger.setLimit(provider, patch);
    } catch (error) {
      throw new TaskHostError(error.code || "invalid_limit", error.message);
    }
    return this._usageLedger.summary();
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
      // Stop scheduling first so no new occurrence is launched during shutdown.
      // This never stops or cancels tasks; they are paused below like any other.
      await this._scheduler?.stop();
      // A create/load that started before close() must either attach before
      // this snapshot (so it gets cleaned up below) or observe the closed
      // state after its await, close its store, and reject. Never let a late
      // attachment escape this shutdown pass.
      await Promise.allSettled([...this._pendingAttachments]);
      await this._sessionAccessChain;
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
          try { await this._coordinator.releaseLease(entry.store.taskId); } catch (error) { errors.push(error); }
        }
      }));
      this._active.clear();
      this._listeners.clear();
      await Promise.resolve(this._workGoalStore.close?.()).catch((error) => errors.push(error));
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

  _withSessionAccess(operation) {
    const pending = this._sessionAccessChain.then(() => {
      this._assertOpen();
      return operation();
    });
    this._sessionAccessChain = pending.catch(() => {});
    return pending;
  }
}

module.exports = { TaskHost, TaskHostError, TaskControllerError };
