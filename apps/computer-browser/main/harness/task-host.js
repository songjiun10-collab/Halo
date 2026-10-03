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
const { AgentStore } = require("./agent-store");
const { AgentService } = require("./agent-service");
const { AgentScheduleStore, AgentScheduler } = require("./agent-schedule");
const { RoomStore } = require("./room-store");
const { RoomOrchestrator, RoomError } = require("./room-orchestrator");
const ROOM_PLANNER_IDLE_MS = 60 * 1000;
const { MCP_PROVIDER_IDS, MCP_PROVIDER_CATALOG } = require("./host-settings");
const { PLANNER_PROVIDERS } = require("./planner-providers");

// The planner provider whose allowlist holds this model id, or null.
const providerForModel = (model) => Object.values(PLANNER_PROVIDERS).find((provider) => provider.isModel(model))?.id ?? null;
const { effortForRoute, routeForProfile } = require("./planner-effort-policy");
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

const TASK_PROFILE_SELECTOR_FIELDS = Object.freeze(["requestedDurationProfile", "requestedCapabilityProfile", "standalone", "useImportedSessions", "mcpProviders", "reviewFallback", "plannerModel"]);
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
    plannerEffortMode = "fixed",
    plannerProvider = "none",
    plannerModel,
    plannerFast,
    mcpProviders = [],
    memoryStore,
    settingsStore,
    usageLedger,
    usageSources,
    subscriptionFetch,
    subscriptionPlatform,
    subscriptionExecFn,
    credentialVault,
    profileImporter,
    getTaskSession,
    workGoalStore,
    workGoalOrchestrator,
    routineReadOnlyBatching = true,
    scheduler: schedulerOptions = {},
    makeMcpBroker,
    agentStore,
  } = {}) {
    if (!storageRoot) throw new TaskHostError("invalid_config", "storageRoot is required");
    if (typeof makeBrowser !== "function") throw new TaskHostError("invalid_config", "makeBrowser is required");
    if (typeof makePlanner !== "function") throw new TaskHostError("invalid_config", "makePlanner is required");
    if (typeof hostVerifier !== "function") throw new TaskHostError("invalid_config", "hostVerifier is required");
    if (typeof approve !== "function") throw new TaskHostError("invalid_config", "approve is required");
    if (makeMcpBroker !== undefined && makeMcpBroker !== null && typeof makeMcpBroker !== "function") {
      throw new TaskHostError("invalid_config", "makeMcpBroker must be a function when provided");
    }

    this._storageRoot = storageRoot;
    this._makeBrowser = makeBrowser;
    this._makePlanner = makePlanner;
    this._makeChildBrowser = makeChildBrowser || null;
    this._hostVerifier = hostVerifier;
    this._approve = approve;
    // Generic MCP is a separate, explicitly host-enabled scope: absent a
    // trusted factory every task's MCP methods fail closed (mcp_disabled).
    this._makeMcpBroker = typeof makeMcpBroker === "function" ? makeMcpBroker : null;
    this._memoryMonitor = memoryMonitor;
    this._now = now;
    this._segmentRotationCalls = segmentRotationCalls;
    this._noProgressThreshold = noProgressThreshold;
    this._setViewport = setViewport;
    this._permissionMode = permissionMode;
    this._plannerEffort = plannerEffort;
    // plannerEffort is the ceiling; "auto" lowers cheap routes (see
    // planner-effort-policy.js). Validated up front so a bad value fails here.
    this._plannerEffortMode = plannerEffortMode;
    effortForRoute({ base: plannerEffort, mode: plannerEffortMode, route: "middle" });
    // Read when each planner is created, so a settings change only affects
    // tasks and children started afterwards.
    this._plannerProvider = plannerProvider;
    this._plannerModel = plannerModel;
    this._plannerFast = plannerFast === true;
    this._mcpProviders = Array.isArray(mcpProviders) ? [...mcpProviders] : [];
    this._routineBatchReadOnlySteps = routineReadOnlyBatching !== false;
    this._memoryStore = memoryStore || null;
    this._settingsStore = settingsStore || null;
    this._usageLedger = usageLedger || null;
    this._usageSources = usageSources || {};
    this._subscriptionFetch = subscriptionFetch; // undefined -> global fetch
    this._subscriptionPlatform = subscriptionPlatform;
    this._subscriptionExecFn = subscriptionExecFn;
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
    // Agent roster: role text reaches a task only as goal constraints through
    // this host's own createTask, so no permission path changes.
    this._agentStore = agentStore || new AgentStore({ storageRoot: path.join(storageRoot, "agents") });
    this._agentProfileLocks = new Map();
    this._queuedStores = new Map();
    this._queuedStartPromises = new Map();
    this._queuedStoreReady = new Map();
    this._agentService = new AgentService({
      store: this._agentStore,
      createTask: (goalInput, selectors, ownerBinding) => ownerBinding
        ? this._createAgentTask(goalInput, selectors, ownerBinding)
        : this.createTask(goalInput, selectors),
      listTasks: () => this.listTasks(),
    });
    // Always-on Agents: schedules live beside agents.json. The scheduler is
    // started explicitly (startAgentScheduler), like the routine scheduler.
    this._agentScheduleStore = new AgentScheduleStore({ storageRoot: path.join(storageRoot, "agents"), now: schedulerOptions.now });
    this._agentScheduler = null;
    // Team chat rooms: one per team, logged beside agents.json. Each turn is
    // one request to that member's own planner worker (child role, so it can
    // never propose a child plan), and a proposed task is an ordinary
    // startAgentTask call.
    this._roomListeners = new Set();
    this._roomStore = new RoomStore({ storageRoot: path.join(storageRoot, "agents") });
    this._rooms = new RoomOrchestrator({
      store: this._roomStore,
      getTeam: (teamId) => this._agentStore.getTeam(teamId),
      getAgent: (agentId) => this._agentStore.getAgent(agentId),
      requestTurn: (turn) => this._requestRoomTurn(turn),
      startTask: ({ teamId, request }) => this.startAgentTask({ teamId, request }),
      getTaskState: async (taskId) => {
        await this._ensureQueue();
        return (await this._listTaskSummaries()).find((task) => task.taskId === taskId)?.state ?? null;
      },
      emit: (event) => this._emitRoomEvent(event),
    });
    // One planner per room, reused across its turns and closed after a
    // minute without one (or at shutdown). A failed turn drops it.
    this._roomPlanners = new Map(); // teamId -> { planner, timer }
    this._roomsRecovered = null;
    if (executionMode !== "sequential" && executionMode !== "parallel") throw new TaskHostError("invalid_config", "executionMode must be sequential or parallel");
    this._executionMode = executionMode;
    if (!Number.isInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > 8) throw new TaskHostError("invalid_config", "maxParallelTasks must be an integer from 1 to 8");
    this._maxParallelTasks = maxParallelTasks;
    this._parallelTaskReserveBytes = parallelTaskReserveBytes;
    this._queue = new TaskQueue({ storageRoot });
    this._queueReady = null;
    this._queueTransition = Promise.resolve();
    this._listeners = new Set();
    this._rosterListeners = new Set();
    // taskId -> {store, controller, browser, planner}
    this._active = new Map();
    // A terminal task remains the owner of any resources that failed to
    // close. Keep only failed cleanup operations so a later stop/revocation
    // or host shutdown can retry them without re-closing successful parts.
    this._terminalTeardownFailures = new Map();
    // Partial attachment has no active TaskController entry to own resources.
    // Keep failed rollback operations separately so shutdown can retry them.
    this._attachmentCleanupFailures = new Map();
    // A TaskStore opened outside _active remains owned until its writer lock
    // closes. Retain handles when close fails so host shutdown can retry.
    this._unattachedStoreClosures = new Map();
    // Queue completion is durable before resource teardown starts. Keep a
    // separate admission barrier until those old resources are actually gone.
    this._terminalTeardowns = new Set();
    this._sessionAccessChain = Promise.resolve();
    this._pendingAttachments = new Set();
    this._storeGate = Promise.resolve();
    this._triggeredRuns = new Map();
    this._schedulerOptions = schedulerOptions;
    this._scheduleStore = null;
    this._scheduler = null;
    this._schedulerStarting = null;
    this._closeRequested = false;
    this._closePromise = null;
    // All top-level reservations use the same ledger as child agents. Built
    // lazily (see
    // _ensureResourceAdmission) so a memoryMonitor fake supplied only for
    // TaskController's own pressure check (no canAdmitTask) never trips
    // ResourceAdmission's stricter constructor requirements.
    this._resourceAdmission = null;
    this._runMemoryPolicies = new Map();
    // taskId -> {mcpProviders: null (inherit host) | narrowing subset,
    // reviewFallback: "queue" | "deny"}, journaled as notes so resume keeps it.
    this._runScopes = new Map();
    // Tasks recovered from the last session that a new task skipped past in
    // the FIFO; resuming one re-enqueues it (see _skipRecoveredForNewTask).
    this._skippedRecovered = new Set();
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
      isAdmissionBlocked: () => this._terminalTeardowns.size > 0,
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
      // Child planners are requested with role:"child" and the provider
      // selected at the moment the child is created.
      makePlanner: this._makePlanner
        ? (childId) => this._makePlanner(childId, this._plannerPin("child"))
        : null,
      approve: this._approve,
      hostVerifier: this._hostVerifier,
      memoryMonitor: this._memoryMonitor,
      memoryStore: this._memoryStore,
      now: this._now,
      segmentRotationCalls: this._segmentRotationCalls,
      noProgressThreshold: this._noProgressThreshold,
      plannerEffort: () => effortForRoute({ base: this._plannerEffort, mode: this._plannerEffortMode, route: "child" }),
      onPlanChange: (parentTaskId) => this._emitChildPlan(parentTaskId),
    });
  }

  _effortForProfile(taskProfile) {
    return effortForRoute({ base: this._plannerEffort, mode: this._plannerEffortMode, route: routeForProfile(taskProfile) });
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

  async _getRunScope(taskId, store) {
    if (this._runScopes.has(taskId)) return this._runScopes.get(taskId);
    const events = await store.getEvents();
    const note = (kind) => events.find((event) => event.type === "note" && event.payload?.kind === kind);
    const scope = { mcpProviders: null, reviewFallback: "queue", plannerModel: null };
    const mcp = note("mcp_scope_selected");
    if (mcp) {
      const providers = mcp.payload.providers;
      if (!Array.isArray(providers) || providers.some((id) => !MCP_PROVIDER_IDS.includes(id))) {
        throw new TaskHostError("invalid_mcp_scope", "saved task MCP scope is invalid");
      }
      scope.mcpProviders = [...providers];
    }
    const fallback = note("review_fallback_selected");
    if (fallback) {
      if (fallback.payload.mode !== "queue" && fallback.payload.mode !== "deny") {
        throw new TaskHostError("invalid_review_fallback", "saved task review fallback is invalid");
      }
      scope.reviewFallback = fallback.payload.mode;
    }
    const model = note("planner_model_selected");
    if (model) {
      if (!providerForModel(model.payload.model)) throw new TaskHostError("invalid_planner_model", "saved task planner model is invalid");
      scope.plannerModel = model.payload.model;
    }
    this._runScopes.set(taskId, scope);
    return scope;
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

  // The Agent tools picker: every known MCP provider and whether the host
  // has it on. An Agent can only narrow to enabled ones (task scope is
  // always intersected with the host set).
  async listMcpProviders() {
    this._assertOpen();
    return MCP_PROVIDER_CATALOG.map(({ id, label }) => ({ id, label, enabled: this._mcpProviders.includes(id) }));
  }

  // The renderer's ChildPlanSummary for a parent task, or null. A corrupt
  // parent-child link has no displayable plan; the parent's own pause/
  // recovery state is what reports it, so selecting the task still works.
  async getChildPlan(parentTaskId) {
    this._assertOpen();
    try {
      return await this._childCoordinator.getPlanSummary(parentTaskId);
    } catch (error) {
      if (error?.code === "corrupt_child_link") return null;
      throw error;
    }
  }

  // Pushes a parent's child plan to UI observers with its current snapshot.
  // Only for an attached parent: an event always carries a real snapshot.
  _emitChildPlan(parentTaskId) {
    const entry = this._active.get(parentTaskId);
    if (!entry || this._closeRequested) return;
    this.getChildPlan(parentTaskId).then((childPlan) => {
      const current = this._active.get(parentTaskId);
      if (!current) return;
      this._emit(parentTaskId, current.snapshot ?? current.controller.getSnapshot(), { childPlan });
    }).catch(() => {
      // Display only; the next selection re-reads the plan.
    });
  }

  _ensureResourceAdmission() {
    if (this._resourceAdmission) return this._resourceAdmission;
    if (!this._memoryMonitor || typeof this._memoryMonitor.canAdmitTask !== "function" || typeof this._memoryMonitor.getPressureLevel !== "function") {
      return null;
    }
    this._resourceAdmission = new ResourceAdmission({ memoryMonitor: this._memoryMonitor });
    return this._resourceAdmission;
  }

  async _attach(store, routine = null) {
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
    let browser = null;
    let planner = null;
    let controller = null;
    let entry = null;
    try {
    browser = this._makeBrowser(store.taskId, taskProfile);
    planner = routine ? routine.runner : this._makePlanner(store.taskId, this._plannerPin("parent", this._runScopes.get(store.taskId)?.plannerModel, { forceFast: taskProfile?.duration.id === "fast" }));
    // Profile selection is a host operation (design doc "Profile selection"):
    // TaskHost is the sole authority that decides harnessProfile, and passes
    // it in rather than letting the controller (or the task's own text)
    // infer it independently. The resolved durable task profile is canonical;
    // legacy tasks without one retain the deterministic routine default.
    const harnessProfile = taskProfile?.duration.id || selectHarnessProfile({ isRoutine: !!routine });
    controller = new TaskController({
      store,
      planner,
      browser,
      harnessProfile,
      approve: (descriptor) => this._approve(store.taskId, descriptor),
      hostVerifier: this._hostVerifier,
      memoryMonitor: controllerMemoryMonitor,
      memoryStore: this._memoryStore,
      permissionMode: this._permissionMode,
      plannerEffort: this._effortForProfile(taskProfile),
      adaptiveEffort: this._plannerEffortMode === "auto",
      reviewFallback: this._runScopes.get(store.taskId)?.reviewFallback ?? "queue",
      now: this._now,
      segmentRotationCalls: this._segmentRotationCalls,
      noProgressThreshold: this._noProgressThreshold,
      // Task 4: only top-level TaskControllers get this hook -- child
      // TaskControllers are never constructed here, so they structurally
      // never receive onChildPlan, which is exactly what prevents nested
      // child agents.
      onChildPlan: (proposal) => this._onChildPlan(store.taskId, store, proposal),
      // Lets the parent's planner know whether a plan already runs, so it is
      // offered a split only when one could be accepted.
      readChildPlan: () => this._childCoordinator.getPlanSummary(store.taskId),
      // MCP providers are pinned when the task attaches, like its planner:
      // a later settings change only affects tasks attached afterwards.
      // Child controllers never receive this hook (child policy is exactly
      // observe+scroll).
      ...(this._makeMcpBroker ? (() => {
        // An Agent/task scope only narrows: never enables a provider the
        // host has turned off.
        const scope = this._runScopes.get(store.taskId)?.mcpProviders ?? null;
        const mcpProviders = this._mcpProviders.filter((id) => scope === null || scope.includes(id));
        return {
          makeMcpBroker: (hooks) => this._makeMcpBroker(store.taskId, hooks, { mcpProviders: [...mcpProviders] }),
          // The planner is offered mcp_* actions only when a provider was pinned.
          mcpEnabled: mcpProviders.includes("codex"),
        };
      })() : {}),
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
    entry = { store, controller, browser, planner, routinePinned: !!routine, snapshot: controller.getSnapshot() };
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
    } catch (error) {
      if (entry?.unsubscribeController) entry.unsubscribeController();
      if (entry?.unsubscribeBrowser) entry.unsubscribeBrowser();
      if (this._active.get(store.taskId) === entry) this._active.delete(store.taskId);
      const operations = [];
      if (controller) operations.push({ key: "mcp", run: () => controller.closeMcp() });
      if (planner && (!routine || planner !== routine.runner)) operations.push({ key: "planner", run: () => planner.close?.() });
      if (browser) operations.push({ key: "browser", run: () => browser.dispose?.() });
      const failed = [];
      for (const operation of operations) {
        try { await operation.run(); }
        catch (cleanupError) { failed.push({ ...operation, error: cleanupError }); }
      }
      if (failed.length) {
        this._attachmentCleanupFailures.set(store.taskId, { store, pending: failed });
        const failure = new AggregateError(
          [error, ...failed.map((item) => item.error)],
          "task attachment failed and partial resources remain owned",
          { cause: error },
        );
        failure.code = "attachment_cleanup_failed";
        throw failure;
      }
      this._childCoordinator.unregisterStore(store.taskId);
      throw error;
    }
  }

  // Injects the user's imported sessions into the task's own session partition
  // before its browser is built, so the first navigation is already signed in.
  // Only tasks that opted in (durably, at creation) are touched. A failure
  // never blocks the task; the audit note records counts and domains only.
  async _attachPrepared(store, routine = null) {
    await this._getRunScope(store.taskId, store);
    if (!this._profileImporter || !this._getTaskSession) return this._attach(store, routine);
    let optedIn = false;
    try { optedIn = await this._profileImporter.hasTaskOptIn(store.taskId); }
    catch { return this._attach(store, routine); }
    if (!optedIn) return this._attach(store, routine);

    // V1 intentionally keeps browser-imported sessions out of persistent
    // Agent profiles. A stale or externally restored opt-in must not copy
    // imported cookies into a cross-task profile or claim they were injected.
    if (store.taskProfile?.agentBrowserProfile) {
      const entry = await this._attach(store, routine);
      entry.controller.recordHostNote({ kind: "imported_sessions_injection_failed", errorCode: "agent_profile_import_conflict" }).catch(() => {});
      return entry;
    }

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
      const entry = await this._attach(store, routine);
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

  async _assertAgentBrowserProfileAvailable(store) {
    const agentId = store.taskProfile?.agentBrowserProfile?.agentId;
    if (!agentId) return;
    let agent;
    try { agent = await this._agentStore.getAgent(agentId); }
    catch { throw new TaskHostError("agent_profile_unavailable", "Agent profile owner is missing"); }
    if (agent.archived || agent.persistentBrowser !== true) {
      throw new TaskHostError("agent_profile_unavailable", "Agent persistent browser profile is unavailable");
    }
  }

  _withAgentProfileLock(agentId, operation) {
    const previous = this._agentProfileLocks.get(agentId) || Promise.resolve();
    let unlock;
    const gate = new Promise((resolve) => { unlock = resolve; });
    this._agentProfileLocks.set(agentId, gate);
    const release = () => {
      unlock();
      if (this._agentProfileLocks.get(agentId) === gate) this._agentProfileLocks.delete(agentId);
    };
    return previous.then(() => operation(release)).finally(release);
  }

  async _revokeAgentBrowserTasks(agentId) {
    await this._ensureQueue();
    const active = [...this._active.values()].filter((entry) => entry.store.taskProfile?.agentBrowserProfile?.agentId === agentId);
    const failures = [];
    for (const entry of active) {
      try {
        if (this._terminalTeardownFailures.has(entry.store.taskId)) await this._retryTerminalTeardown(entry.store.taskId);
        else await entry.controller.stop();
      }
      catch (error) { failures.push(error); }
    }
    // Stop transitions enqueue their durable queue cleanup asynchronously.
    await this._queueTransition;
    if (failures.length || active.some((entry) => this._active.has(entry.store.taskId))) {
      throw new TaskHostError("agent_profile_revocation_failed", "one or more tasks using the Agent browser profile could not be stopped");
    }

    // A task admitted from the FIFO queue may have opened its TaskStore but be
    // waiting for this Agent's profile lock before browser construction. Stop
    // both those admitted-but-unattached tasks and ordinary pending tasks now,
    // rather than letting a disabled profile occupy a queue slot until later.
    const queuedIds = [...new Set([...this._queue.activeIds(), ...this._queue.pendingIds()])];
    for (const taskId of queuedIds) {
      if (this._active.has(taskId)) continue;
      let store = this._queuedStores.get(taskId) || null;
      let ownsStore = false;
      if (!store && this._queue.activeIds().includes(taskId)) {
        // An admission may have committed just before its scheduled
        // _startQueued call begins. Start/observe that loader so revocation
        // waits only until its store is open (not until it can acquire the
        // profile lock that this method intentionally holds).
        this._startQueued(taskId).catch((error) => this._emit(taskId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
        const ready = this._queuedStoreReady.get(taskId);
        if (ready) store = await ready;
      }
      if (!store) {
        try {
          store = await this._withStoreGate(() => TaskStore.load(taskId, { storageRoot: this._storageRoot }));
          ownsStore = true;
        } catch (error) {
          failures.push(error);
          continue;
        }
      }
      try {
        if (store.taskProfile?.agentBrowserProfile?.agentId !== agentId) continue;
        await store.append({ type: "note", payload: { kind: "agent_profile_unavailable", actor: "trusted_host" } });
        const last = store.lastCheckpoint?.payload ?? {};
        await store.checkpoint({ ...last, task: { ...(last.task || {}), state: "stopped", pauseReason: "agent_profile_unavailable" } });
        if (this._queue.activeIds().includes(taskId)) await this._queue.complete(taskId, "stopped");
        else if (this._queue.pendingIds().includes(taskId)) await this._queue.skipPending(taskId, { reason: "agent_profile_unavailable", actor: "trusted_host" });
        else throw new TaskHostError("agent_profile_revocation_failed", "queued task left the queue before its stop was recorded");
        await this._coordinator.releaseLease(taskId);
        this._runMemoryPolicies.delete(taskId);
        this._runScopes.delete(taskId);
        this._emit(taskId, { state: "stopped", pauseReason: "agent_profile_unavailable" });
      } catch (error) {
        failures.push(error);
      } finally {
        if (ownsStore) await this._closeUnattachedTaskStore(store).catch((error) => failures.push(error));
      }
    }
    if (failures.length) throw new TaskHostError("agent_profile_revocation_failed", "one or more queued tasks using the Agent browser profile could not be stopped");
    // A stopped unattached reservation may have freed a parallel slot. Keep
    // the shared FIFO moving for unrelated tasks instead of waiting for an
    // unrelated future scheduler tick.
    while (!this._closeRequested && this._queue.pendingIds().length > 0) {
      let nextId;
      try { nextId = await this._admitNext(); }
      catch (error) { throw new TaskHostError("agent_profile_revocation_failed", `queue admission failed during profile revocation: ${error.message}`); }
      if (!nextId) break;
      this._startQueued(nextId).catch((error) => this._emit(nextId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
    }
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
      const importer = this._requireSessions();
      let removed;
      let removeError;
      try { removed = await importer.remove(domain); } catch (error) { removeError = error; }
      // Always run the host-owned fail-closed path. The importer also purges
      // tracked sessions, but its error must not bypass stopping/disposal of
      // active tasks whose cookies could not be revoked.
      await this._clearActiveSessionCookies([domain]);
      if (removeError) throw removeError;
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
    if (snapshot?.state && this._rooms) {
      void this._recoverRooms();
      this._rooms.onTaskEvent(taskId, snapshot).catch(() => {});
    }
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

  async _createAgentTask(goalInput, selectors, ownerBinding) {
    if (!isPlainObject(ownerBinding) || Object.keys(ownerBinding).length !== 1 ||
        typeof ownerBinding.agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerBinding.agentId)) {
      throw new TaskHostError("invalid_agent_profile", "Agent profile binding is invalid");
    }
    return this._withAgentProfileLock(ownerBinding.agentId, async (release) => {
      let agent;
      try { agent = await this._agentStore.getAgent(ownerBinding.agentId); }
      catch (error) { throw new TaskHostError("agent_profile_unavailable", error.message); }
      if (agent.archived || agent.persistentBrowser !== true) {
        throw new TaskHostError("agent_profile_unavailable", "Agent persistent browser profile is unavailable");
      }
      return this._createTaskWithProfile(goalInput, selectors, {
        agentBrowserProfileBinding: { agentId: agent.id },
        onAgentBrowserProfileAttached: release,
      });
    });
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

  _createTaskWithProfile(goalInput, selectors = {}, { agentBrowserProfileBinding = null, onAgentBrowserProfileAttached = null } = {}) {
    this._assertOpen();
    if (!isPlainObject(selectors) || Object.keys(selectors).some((key) => !TASK_PROFILE_SELECTOR_FIELDS.includes(key)) ||
        (Object.hasOwn(selectors, "standalone") && typeof selectors.standalone !== "boolean") ||
        (Object.hasOwn(selectors, "useImportedSessions") && typeof selectors.useImportedSessions !== "boolean") ||
      (Object.hasOwn(selectors, "mcpProviders") && (!Array.isArray(selectors.mcpProviders) ||
        selectors.mcpProviders.some((id) => !MCP_PROVIDER_IDS.includes(id)) || new Set(selectors.mcpProviders).size !== selectors.mcpProviders.length)) ||
      (Object.hasOwn(selectors, "reviewFallback") && selectors.reviewFallback !== "queue" && selectors.reviewFallback !== "deny") ||
      (Object.hasOwn(selectors, "plannerModel") && !providerForModel(selectors.plannerModel))) {
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
    const runScope = {
      mcpProviders: Object.hasOwn(selectors, "mcpProviders") ? [...selectors.mcpProviders] : null,
      reviewFallback: selectors.reviewFallback ?? "queue",
      plannerModel: selectors.plannerModel ?? null,
    };
    return this._createNewTask(stableGoalInput, null, null, resolvedProfile, selectors.standalone === true, selectors.useImportedSessions === true, runScope, agentBrowserProfileBinding, onAgentBrowserProfileAttached);
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

  async listAgents() { this._assertOpen(); return this._agentStore.listAgents(); }
  async listTeams() { this._assertOpen(); return this._agentStore.listTeams(); }
  async listAgentConversations(input) { this._assertOpen(); return this._agentService.listAgentConversations(input); }
  async getAgentRoster() { this._assertOpen(); return this._agentService.getAgentRoster(); }

  async saveAgent(input) {
    this._assertOpen();
    if (input?.id) {
      return this._withAgentProfileLock(input.id, async () => {
        const saved = await this._agentStore.saveAgent(input);
        const notified = this._rosterChange("agent", "saved", saved);
        if (!saved.persistentBrowser) await this._revokeAgentBrowserTasks(saved.id);
        return notified;
      });
    }
    return this._rosterChange("agent", "saved", await this._agentStore.saveAgent(input));
  }

  async archiveAgent(agentId) {
    this._assertOpen();
    return this._withAgentProfileLock(agentId, async () => {
      const archived = await this._agentStore.archiveAgent(agentId);
      const notified = this._rosterChange("agent", "archived", archived);
      await this._revokeAgentBrowserTasks(agentId);
      return notified;
    });
  }

  async duplicateAgent(agentId) {
    this._assertOpen();
    return this._rosterChange("agent", "saved", await this._agentStore.duplicateAgent(agentId));
  }

  async saveTeam(input) {
    this._assertOpen();
    return this._rosterChange("team", "saved", await this._agentStore.saveTeam(input));
  }

  async archiveTeam(teamId) {
    this._assertOpen();
    return this._rosterChange("team", "archived", await this._agentStore.archiveTeam(teamId));
  }

  async setAgentPinned(input) {
    this._assertOpen();
    return this._rosterChange(input.kind, "pinned", await this._agentStore.setPinned(input));
  }

  async startAgentTask(input) {
    this._assertOpen();
    const result = await this._agentService.startAgentTask(input);
    this._emitRoster(input.agentId !== undefined ? "agent" : "team", input.agentId ?? input.teamId, "conversation_started");
    return result;
  }

  async markAgentConversationsRead(input) {
    this._assertOpen();
    const result = await this._agentService.markAgentConversationsRead(input);
    this._emitRoster(input.agentId !== undefined ? "agent" : "team", input.agentId ?? input.teamId, "read");
    return result;
  }

  // Content-free change notices so a UI can re-read getAgentRoster() instead
  // of polling; profile text never travels in the notice itself.
  onAgentRosterEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("onAgentRosterEvent requires a listener function");
    this._rosterListeners.add(listener);
    return () => this._rosterListeners.delete(listener);
  }

  _rosterChange(kind, change, record) {
    this._emitRoster(kind, record.id, change);
    return record;
  }

  _emitRoster(kind, id, change) {
    for (const listener of this._rosterListeners) {
      try { listener({ kind, id, change }); } catch { /* an observer never affects roster state */ }
    }
  }

  // Team chat room. A room is addressed by its team id.
  async listRooms() {
    this._assertOpen();
    await this._recoverRooms();
    const teams = await this._agentStore.listTeams();
    return Promise.all(teams.map(async (team) => {
      const messages = await this._roomStore.read(team.id);
      return { roomId: team.id, teamId: team.id, name: team.name, archived: team.archived, lastMessage: messages.at(-1) ?? null, active: this._rooms.getRoundState(team.id).active };
    }));
  }

  async getRoom(teamId) {
    this._assertOpen();
    await this._recoverRooms();
    const team = await this._agentStore.getTeam(teamId).catch((error) => {
      if (["not_found", "invalid_id"].includes(error.code)) throw new RoomError("invalid_room", "team does not exist");
      throw error;
    });
    return { roomId: team.id, teamId: team.id, messages: await this._roomStore.read(team.id), round: this._rooms.getRoundState(team.id) };
  }

  async postRoomMessage(input) {
    this._assertOpen();
    await this._recoverRooms();
    if (!isPlainObject(input) || Object.keys(input).sort().join(",") !== "teamId,text") {
      throw new RoomError("invalid_message", "postRoomMessage takes exactly {teamId, text}");
    }
    return this._rooms.post(input.teamId, input.text);
  }

  async stopRoomRound(teamId) {
    this._assertOpen();
    await this._recoverRooms();
    return this._rooms.stop(teamId);
  }

  // {roomId, message} for each new message, {roomId, round} for round state.
  onRoomEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("onRoomEvent requires a listener function");
    this._roomListeners.add(listener);
    return () => this._roomListeners.delete(listener);
  }

  _emitRoomEvent(event) {
    for (const listener of this._roomListeners) {
      try { listener(structuredClone(event)); } catch { /* an observer never affects the room */ }
    }
  }

  // Once per host: restores room-task result notices and clears a round
  // lock a crashed process left (RoomOrchestrator.recover).
  _recoverRooms() {
    if (!this._roomsRecovered) {
      this._roomsRecovered = this._agentStore.listTeams()
        .then((teams) => this._rooms.recover(teams.map((team) => team.id)))
        .catch(() => {});
    }
    return this._roomsRecovered;
  }

  async _requestRoomTurn({ teamId, context, signal }) {
    let entry = this._roomPlanners.get(teamId);
    if (entry) clearTimeout(entry.timer);
    else {
      entry = { planner: this._makePlanner(`room-${teamId}`, this._plannerPin("child")), timer: null };
      this._roomPlanners.set(teamId, entry);
    }
    try {
      return await entry.planner.next(context, { signal });
    } catch (error) {
      await this._closeRoomPlanner(teamId, entry);
      throw error;
    } finally {
      if (this._roomPlanners.get(teamId) === entry) {
        entry.timer = setTimeout(() => { void this._closeRoomPlanner(teamId, entry); }, ROOM_PLANNER_IDLE_MS);
        entry.timer.unref?.();
      }
    }
  }

  async _closeRoomPlanner(teamId, entry) {
    clearTimeout(entry.timer);
    if (this._roomPlanners.get(teamId) === entry) this._roomPlanners.delete(teamId);
    await Promise.resolve(entry.planner.close?.()).catch(() => {});
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

  async listAgentSchedules() {
    this._assertOpen();
    return this._agentScheduleStore.list();
  }

  // The owner must exist and be unarchived when the schedule is saved; a
  // later archive makes the next run fail closed and disables the schedule.
  async saveAgentSchedule(input) {
    this._assertOpen();
    const kind = input?.kind;
    if (kind === "agent" || kind === "team") {
      let owner;
      try { owner = await (kind === "agent" ? this._agentStore.getAgent(input.ownerId) : this._agentStore.getTeam(input.ownerId)); }
      catch (error) { if (!["not_found", "invalid_id"].includes(error.code)) throw error; }
      if (!owner || owner.archived) throw new TaskHostError("agent_unavailable", `${kind} is not available for scheduling`);
    }
    const saved = await this._agentScheduleStore.save(input);
    this._emitRoster(saved.kind, saved.ownerId, "schedule_saved");
    this._agentScheduler?.tick().catch(() => {});
    return saved;
  }

  async deleteAgentSchedule(scheduleId) {
    this._assertOpen();
    const removed = await this._agentScheduleStore.remove(scheduleId);
    this._emitRoster(removed.kind, removed.ownerId, "schedule_deleted");
    return removed;
  }

  // Starts Agent schedules over this host. Each occurrence goes through the
  // same createTask queue/admission/approval path as a manual Agent start,
  // with the schedule's own approval choice and planner-call cap.
  async startAgentScheduler() {
    this._assertOpen();
    if (!this._agentScheduler) {
      this._agentScheduler = new AgentScheduler({
        ...this._schedulerOptions,
        store: this._agentScheduleStore,
        startTask: (schedule) => this._startScheduledAgentTask(schedule),
        getTaskState: async (taskId) => {
          await this._ensureQueue();
          return (await this._listTaskSummaries()).find((task) => task.taskId === taskId)?.state ?? null;
        },
      });
      await this._agentScheduler.start();
    }
    return this._agentScheduler;
  }

  async _startScheduledAgentTask(schedule) {
    this._assertOpen();
    const owner = schedule.kind === "agent" ? { agentId: schedule.ownerId } : { teamId: schedule.ownerId };
    const result = await this._agentService.startAgentTask({ ...owner, request: schedule.request }, {
      reviewFallback: schedule.onApproval === "deny" ? "deny" : "queue",
      maxPlannerCalls: schedule.maxPlannerCalls,
    });
    this._emitRoster(schedule.kind, schedule.ownerId, "conversation_started");
    return result;
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

  _createNewTask(goalInput, routineRun = null, pinnedRoutineDefinition = null, resolvedProfile = null, standalone = false, useImportedSessions = false, runScope = null, agentBrowserProfileBinding = null, onAgentBrowserProfileAttached = null) {
    const scope = runScope ?? { mcpProviders: null, reviewFallback: "queue", plannerModel: null };
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
          ...(agentBrowserProfileBinding ? { agentBrowserProfileBinding } : {}),
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
          if (scope.mcpProviders !== null) await taskStore.append({ type: "note", payload: { kind: "mcp_scope_selected", providers: [...scope.mcpProviders] } });
          if (scope.reviewFallback !== "queue") await taskStore.append({ type: "note", payload: { kind: "review_fallback_selected", mode: scope.reviewFallback } });
          if (scope.plannerModel) await taskStore.append({ type: "note", payload: { kind: "planner_model_selected", model: scope.plannerModel } });
          if (this._closeRequested) throw new TaskHostError("host_closed", "task host is closing or closed");
          if (binding) {
            await this._workGoalOrchestrator.recordContinuation(binding.goalId, binding.goalVersion, {
              taskId, origin: goalInput?.trigger ? "scheduler" : routineRun ? "routine" : "user",
            });
          }
        } catch (error) {
          let rollbackError = null;
          if (this._closeRequested) {
            try {
              await this._markUnstartedTaskStopped(taskStore, "host_shutdown_before_admission", "task_creation_cancelled");
              if (binding) {
                try { await this._workGoalOrchestrator.reconcileTask(taskId, { taskStore }); }
                catch (reconcileError) {
                  if (reconcileError.code !== "not_found") throw reconcileError;
                }
              }
            } catch (failure) {
              rollbackError = failure;
            }
          }
          let closeError = null;
          try { await this._closeUnattachedTaskStore(taskStore); }
          catch (failure) { closeError = failure; }
          if (rollbackError || closeError) {
            const failure = new AggregateError(
              [error, ...[rollbackError, closeError].filter(Boolean)],
              "shutdown cancelled task creation but durable rollback was incomplete",
              { cause: error },
            );
            failure.code = "task_creation_rollback_failed";
            throw failure;
          }
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
      this._runScopes.set(store.taskId, structuredClone(scope));
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
        this._runScopes.delete(store.taskId);
        await this._closeUnattachedTaskStore(store);
        throw error;
      }
      await this._skipRecoveredForNewTask();
      await this._queue.enqueue(store.taskId);
      const admitted = await this._admitNext();
      if (admitted !== store.taskId) {
        const goal = store.getGoal();
        await this._closeUnattachedTaskStore(store);
        onAgentBrowserProfileAttached?.();
        return { taskId: store.taskId, snapshot: { state: "queued", queuePosition: this._queue.pendingIds().indexOf(store.taskId) + 1 }, goal };
      }
      let attached;
      try {
        attached = await this._attachPrepared(store, routine);
      } catch (error) {
        if (!this._attachmentCleanupFailures.has(store.taskId)) await this._failNewTaskAttachment(store);
        throw error;
      }
      const { controller } = attached;
      const started = controller.start();
      onAgentBrowserProfileAttached?.();
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

  // Recovered entries wait for a person and block automatic admission. A new
  // task is that person choosing other work: the recovered ones leave the
  // FIFO without running (audited skips) and stay saved as paused, so the
  // new task is not stuck behind them.
  async _skipRecoveredForNewTask() {
    if (!this._coordinator.recoveredBlocked) return;
    for (const taskId of this._queue.pendingIds()) {
      await this._queue.skip(taskId, { reason: "superseded_by_new_task", actor: "trusted_host" });
      this._skippedRecovered.add(taskId);
    }
    this._coordinator.recoveredBlocked = false;
  }

  _admitNext(options = {}) {
    // close() stops all new admissions synchronously. Without this gate, a
    // just-failed attachment can release its slot and enqueue a new Browser
    // start while shutdown is already draining its attachment snapshot.
    if (this._closeRequested) return Promise.resolve(null);
    // Never admit another browser owner while a prior terminal task may still
    // have a live browser/MCP resource.
    if (this._terminalTeardownFailures.size > 0) return Promise.resolve(null);
    return this._coordinator.admitNext(options);
  }

  async _markUnstartedTaskStopped(store, pauseReason, noteKind) {
    const last = store.lastCheckpoint?.payload ?? {};
    await store.append({ type: "note", payload: { kind: noteKind, actor: "trusted_host" } });
    await store.checkpoint({
      ...last,
      task: { ...(last.task || {}), state: "stopped", pauseReason },
      budgets: last.budgets ?? { actionsUsed: 0, plannerCallsUsed: 0, activeMs: 0 },
    });
  }

  async _closeUnattachedTaskStore(store) {
    try {
      await store.close();
      this._unattachedStoreClosures.delete(store.taskId);
    } catch (error) {
      this._unattachedStoreClosures.set(store.taskId, { store, error });
      throw error;
    }
  }

  async _failNewTaskAttachment(store) {
    await this._markUnstartedTaskStopped(store, "attachment_failed", "attachment_failed");
    if (this._queue.activeIds().includes(store.taskId)) await this._queue.complete(store.taskId, "stopped");
    const binding = store.taskProfile?.workGoalBinding;
    if (binding) {
      await this._withWorkGoalAdmission(() => this._workGoalOrchestrator.resolveContinuation(
        binding.goalId, binding.goalVersion, { taskId: store.taskId, taskStore: store, taskState: "stopped" },
      )).catch(() => {});
      await this._workGoalOrchestrator.reconcileTask(store.taskId, { taskStore: store }).catch(() => {});
    }
    this._profileImporter?.releaseTask?.(store.taskId);
    await this._coordinator.releaseLease(store.taskId);
    this._runMemoryPolicies.delete(store.taskId);
    this._runScopes.delete(store.taskId);
    await this._closeUnattachedTaskStore(store);
    this._emit(store.taskId, { state: "stopped", pauseReason: "attachment_failed" });
    const nextId = this._queue.pendingIds()[0] ?? null;
    if (nextId) {
      const admitted = await this._admitNext();
      if (admitted) this._startQueued(admitted).catch((error) => this._emit(admitted, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
    }
  }

  async _finishTerminalTeardown(taskId, entry, previousFailure = null) {
    const pending = previousFailure?.pending || [
      { key: "mcp", run: () => entry.controller.closeMcp() },
      { key: "planner", run: () => entry.planner.close?.() },
      { key: "browser", run: () => entry.browser.dispose?.() },
      { key: "store", run: () => entry.store.close() },
    ];
    const results = await Promise.all(pending.map(async (operation) => {
      try {
        await operation.run();
        return { operation, status: "fulfilled" };
      } catch (error) {
        return { operation, status: "rejected", reason: error };
      }
    }));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) {
      this._terminalTeardownFailures.set(taskId, {
        entry,
        pending: failed.map((result) => result.operation),
      });
      this._emit(taskId, entry.snapshot, { error: "resource_teardown_failed" });
      throw new TaskHostError("resource_teardown_failed", "terminal task resources could not be closed");
    }

    try {
      await this._coordinator.releaseLease(taskId);
    } catch (error) {
      this._terminalTeardownFailures.set(taskId, { entry, pending: [], leasePending: true });
      this._emit(taskId, entry.snapshot, { error: "resource_teardown_failed" });
      throw new TaskHostError("resource_teardown_failed", `terminal task resource lease could not be released: ${error.message}`);
    }

    this._finalizeTerminalTeardown(taskId, entry);
  }

  _finalizeTerminalTeardown(taskId, entry) {
    this._terminalTeardownFailures.delete(taskId);
    this._unsubscribe(entry);
    this._active.delete(taskId);
    this._childCoordinator.unregisterStore(taskId);
    this._runMemoryPolicies.delete(taskId);
    this._runScopes.delete(taskId);
  }

  _retryTerminalTeardown(taskId) {
    const transition = this._queueTransition.then(async () => {
      const failure = this._terminalTeardownFailures.get(taskId);
      if (!failure) return false;
      if (failure.leasePending) {
        await this._coordinator.releaseLease(taskId);
        this._finalizeTerminalTeardown(taskId, failure.entry);
      } else await this._finishTerminalTeardown(taskId, failure.entry, failure);
      if (!this._closeRequested) {
        const nextId = await this._admitNext();
        if (nextId) this._startQueued(nextId).catch((error) => this._emit(nextId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
      }
      return true;
    });
    this._queueTransition = transition.catch(() => {});
    return transition;
  }

  onMemorySample() {
    if (this._closeRequested || !this._queueReady || !this._queue.isLoaded() || this._queue.pendingIds().length === 0) return Promise.resolve(null);
    const transition = this._queueTransition.then(async () => {
      await this._queueReady;
      if (this._closeRequested) return null;
      const taskId = await this._admitNext();
      if (taskId) this._startQueued(taskId).catch((error) => this._emit(taskId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
      return taskId;
    });
    this._queueTransition = transition.catch(() => {});
    return transition;
  }

  _recordTerminal(taskId, state) {
    if (this._terminalTeardowns.has(taskId)) return;
    this._terminalTeardowns.add(taskId);
    const transition = this._queueTransition.then(async () => {
      try {
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
          await this._finishTerminalTeardown(taskId, entry);
        } else {
          await this._coordinator.releaseLease(taskId);
        }
        this._terminalTeardowns.delete(taskId);
        if (this._closeRequested) return;
        const nextId = await this._admitNext();
        if (nextId) this._startQueued(nextId).catch((error) => this._emit(nextId, { state: "paused", pauseReason: "queue_start_failed", error: error.message }));
      } finally {
        this._terminalTeardowns.delete(taskId);
      }
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

  _startQueued(taskId) {
    const existing = this._queuedStartPromises.get(taskId);
    if (existing) return existing;
    let signalStoreReady;
    const storeReady = new Promise((resolve) => { signalStoreReady = resolve; });
    this._queuedStoreReady.set(taskId, storeReady);
    const run = this._startQueuedTask(taskId, signalStoreReady);
    const tracked = run.then(
      (value) => { this._clearQueuedStart(taskId, tracked); return value; },
      (error) => { this._clearQueuedStart(taskId, tracked); throw error; },
    );
    this._queuedStartPromises.set(taskId, tracked);
    return tracked;
  }

  _clearQueuedStart(taskId, promise) {
    if (this._queuedStartPromises.get(taskId) === promise) this._queuedStartPromises.delete(taskId);
    this._queuedStoreReady.delete(taskId);
  }

  async _startQueuedTask(taskId, signalStoreReady) {
    return this._trackAttachment(async () => {
      let store;
      try {
        store = await this._withStoreGate(() => TaskStore.load(taskId, { storageRoot: this._storageRoot }));
      } catch (error) {
        signalStoreReady(null);
        throw error;
      }
      this._queuedStores.set(taskId, store);
      signalStoreReady(store);
      try {
        if (this._closeRequested) { await this._closeUnattachedTaskStore(store); return; }
        const attach = async () => {
          // Profile revocation may have durably stopped and dequeued this
          // task while it waited for the Agent lock. Do not attach a browser
          // merely because this recovery/start promise was already in flight.
          const taskState = store.lastCheckpoint?.payload?.task?.state;
          const stillQueued = this._queue.activeIds().includes(taskId) || this._queue.pendingIds().includes(taskId);
          if (taskState === "stopped" && !stillQueued) { await this._closeUnattachedTaskStore(store); return { controller: null, started: Promise.resolve() }; }
          await this._assertAgentBrowserProfileAvailable(store);
          const routine = await this._resolveRoutineForStore(store);
          const { controller } = await this._attachPrepared(store, routine);
          // A queued task never ran, but a store loaded off disk always attaches
          // as paused/recovered, so it is released with resume(), not start().
          const snapshot = controller.getSnapshot();
          const started = snapshot.state === "paused" && snapshot.pauseReason === "recovered" ? controller.resume() : controller.start();
          return { controller, started };
        };
        const agentId = store.taskProfile?.agentBrowserProfile?.agentId;
        const result = agentId
          ? await this._withAgentProfileLock(agentId, attach)
          : await attach();
        return result;
      } catch (error) {
        if (error.code === "agent_profile_unavailable") {
          // The owner opted out after this task had already received an
          // admission slot. Mark it stopped durably without ever constructing
          // the old persistent partition, then release its queue slot.
          await store.append({ type: "note", payload: { kind: "agent_profile_unavailable", actor: "trusted_host" } });
          const last = store.lastCheckpoint?.payload ?? {};
          await store.checkpoint({ ...last, task: { ...(last.task || {}), state: "stopped", pauseReason: "agent_profile_unavailable" } });
          let nextId = null;
          if (this._queue.activeIds().includes(taskId)) {
            await this._queue.complete(taskId, "stopped");
            nextId = this._queue.pendingIds()[0] ?? null;
          } else if (this._queue.pendingIds().includes(taskId)) {
            nextId = this._queue.pendingIds()[0] === taskId
              ? await this._queue.skip(taskId, { reason: "agent_profile_unavailable", actor: "trusted_host" })
              : await this._queue.skipPending(taskId, { reason: "agent_profile_unavailable", actor: "trusted_host" });
          }
          await this._closeUnattachedTaskStore(store);
          await this._coordinator.releaseLease(taskId);
          this._runMemoryPolicies.delete(taskId);
          this._runScopes.delete(taskId);
          this._emit(taskId, { state: "stopped", pauseReason: "agent_profile_unavailable" });
          if (nextId) {
            const admitted = await this._admitNext();
            if (admitted) this._startQueued(admitted).catch((startError) => this._emit(admitted, { state: "paused", pauseReason: "queue_start_failed", error: startError.message }));
          }
          return;
        }
        if (!this._attachmentCleanupFailures.has(taskId)) await this._closeUnattachedTaskStore(store);
        throw error;
      } finally {
        if (this._queuedStores.get(taskId) === store) this._queuedStores.delete(taskId);
      }
    }).then((result) => result?.started).catch((error) => {
      // _trackAttachment may reject before entering its operation (for
      // example, shutdown wins the microtask race). Resolve revocation's
      // readiness wait in every failure path, not only TaskStore.load errors.
      signalStoreReady(null);
      throw error;
    });
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
      const queuedStore = this._queuedStores.get(taskId);
      if (queuedStore) {
        const checkpoint = queuedStore.lastCheckpoint?.payload ?? {};
        summaries.push({
          taskId,
          originalRequest: queuedStore.getGoal().originalRequest,
          createdAt: queuedStore.getGoal().createdAt,
          state: checkpoint.task?.state ?? "queued",
          pauseReason: checkpoint.task?.pauseReason ?? null,
          active: false,
          trigger: queuedStore.getGoal().trigger ?? null,
          routinePinned: false,
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
          await this._closeUnattachedTaskStore(store);
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
    // Queue recovery is asynchronous. If shutdown won that wait, report the
    // host lifecycle boundary rather than misclassifying the closed admission
    // gate as a transient memory denial.
    this._assertOpen();
    if (!this._active.has(taskId)) {
      // Gated with listTasks() peeks: both briefly hold this store's writer lock.
      await this._withStoreGate(async () => {
        const preflight = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
        try {
          await this._assertAgentBrowserProfileAvailable(preflight);
          await this._resolveRoutineForStore(preflight);
        }
        finally { await this._closeUnattachedTaskStore(preflight); }
      });
    }
    if (this._coordinator.recoveredBlocked) {
      if (this._queue.pendingIds()[0] !== taskId) throw new TaskHostError("queued_behind_other_task", "resume the oldest queued task first");
      const admitted = await this._admitNext({ recoveredHead: true });
      if (admitted !== taskId) throw new TaskHostError("memory_admission_denied", "the queued task is waiting for a measured memory lease");
      this._coordinator.recoveredBlocked = false;
    }
    if (this._skippedRecovered.has(taskId) && !this._active.has(taskId)) {
      // Back through the FIFO so it is admitted (and leased) like any task.
      this._skippedRecovered.delete(taskId);
      await this._queue.enqueue(taskId);
      const admitted = await this._admitNext();
      if (admitted !== taskId) return { state: "queued", queuePosition: this._queue.pendingIds().indexOf(taskId) + 1 };
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
    // "never attached" path below. The controller's own planner close may
    // have failed, so the old worker's exit is confirmed here first: a
    // failure propagates and keeps the stale entry, and no replacement
    // adapter is minted while the previous one may still be running.
    if (entry && entry.controller.getSnapshot().pauseReason === "memory_emergency") {
      await entry.planner?.close?.();
      this._unsubscribe(entry);
      this._active.delete(taskId);
      this._childCoordinator.unregisterStore(taskId);
      entry = null;
    }
    if (!entry) {
      const attach = async () => {
        const store = await this._withStoreGate(() => TaskStore.load(taskId, { storageRoot: this._storageRoot }));
        if (this._closeRequested) {
        if (!this._attachmentCleanupFailures.has(taskId)) await this._closeUnattachedTaskStore(store);
          throw new TaskHostError("host_closed", "task host is closing or closed");
        }
        let routine;
        try {
          await this._assertAgentBrowserProfileAvailable(store);
          routine = await this._resolveRoutineForStore(store);
          await this._getRunMemoryPolicy(taskId, store);
        } catch (error) {
          await this._closeUnattachedTaskStore(store);
          throw error;
        }
        let attachedEntry;
        try {
          attachedEntry = await this._attachPrepared(store, routine);
        } catch (error) {
          // _attachPrepared owns the store while partial browser/planner
          // cleanup is pending. Otherwise retain any failed close on the
          // host so a later close() can retry it.
          if (!this._attachmentCleanupFailures.has(taskId)) {
            try { await this._closeUnattachedTaskStore(store); }
            catch (closeError) {
              const failure = new AggregateError([error, closeError], "saved task attachment failed and its journal store could not be closed", {
                cause: error,
              });
              failure.code = "task_attach_cleanup_failed";
              throw failure;
            }
          }
          throw error;
        }
        // Like createTask(), enter the controller synchronously so a
        // concurrent close() sees the active entry and can take it over,
        // without this attachment barrier waiting for the task's run loop.
        const resumed = attachedEntry.controller.getSnapshot().state === "paused"
          ? attachedEntry.controller.resume(opts)
          : Promise.resolve();
        return { entry: attachedEntry, resumed };
      };
      let agentId = null;
      await this._withStoreGate(async () => {
        const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
        try { agentId = store.taskProfile?.agentBrowserProfile?.agentId ?? null; }
        finally { await this._closeUnattachedTaskStore(store); }
      });
      const attached = agentId
        ? await this._withAgentProfileLock(agentId, () => this._trackAttachment(attach))
        : await this._trackAttachment(attach);
      await attached.resumed;
      // Child plans are durable in the parent journal, but their in-memory
      // controllers belong to this host process. Re-admit queued assignments
      // only after the parent itself has been safely attached and resumed.
      this._childCoordinator.scheduleAdmission(taskId).catch(() => {});
      return attached.entry.controller.getSnapshot();
    }
    if (entry.controller.getSnapshot().state === "paused") {
      await entry.controller.resume(opts);
    }
    this._childCoordinator.scheduleAdmission(taskId).catch(() => {});
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

  async lendTask(taskId, requestId, terms) {
    const { controller } = this._require(taskId);
    return controller.lend(requestId, terms);
  }

  async revokeTaskLease(taskId, leaseId) {
    const { controller } = this._require(taskId);
    return controller.revokeLease(leaseId);
  }

  // Trusted host/main-process surface for generic MCP. Approval is never
  // accepted here: a proposal is queued for human review and settled only
  // by approveTask()/denyTask() on the same task.
  async listMcpConnections(taskId) {
    const { controller } = this._require(taskId);
    return controller.listMcpConnections();
  }

  async searchMcpTools(taskId, query) {
    const { controller } = this._require(taskId);
    return controller.searchMcpTools(query);
  }

  async describeMcpTool(taskId, connectionId, toolName) {
    const { controller } = this._require(taskId);
    return controller.describeMcpTool(connectionId, toolName);
  }

  async proposeMcpCall(taskId, request) {
    const { controller } = this._require(taskId);
    return controller.proposeMcpCall(request);
  }

  describeMcpApproval(taskId, requestId) {
    const { controller } = this._require(taskId);
    return controller.describeMcpApproval(requestId);
  }

  async pauseTask(taskId, reason) {
    const { controller } = this._require(taskId);
    return controller.pause(reason);
  }

  async stopTask(taskId) {
    const { controller } = this._require(taskId);
    const retryingTeardown = this._terminalTeardownFailures.has(taskId);
    const snapshot = await controller.stop();
    // Terminal notification schedules durable FIFO cleanup and resource
    // teardown on this shared chain. Do not report a stopped task while its
    // broker/browser/store are still live in the host.
    await this._queueTransition;
    if (retryingTeardown) await this._retryTerminalTeardown(taskId);
    if (this._terminalTeardownFailures.has(taskId)) {
      throw new TaskHostError("resource_teardown_failed", "task stopped, but host resource cleanup failed");
    }
    return snapshot;
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
    const queuedStore = this._queuedStores.get(taskId);
    if (queuedStore) {
      const checkpoint = queuedStore.lastCheckpoint?.payload ?? {};
      return {
        taskId,
        goal: queuedStore.getGoal(),
        recoveryReason: queuedStore.recoveryReason,
        active: false,
        harnessProfile: queuedStore.taskProfile?.duration.id || checkpoint.harnessProfile || selectHarnessProfile({ isRoutine: !!checkpoint.routineRun }),
        taskProfile: queuedStore.taskProfile ?? null,
        snapshot: checkpoint.task ?? { state: "queued", pauseReason: null },
      };
    }
    const store = await TaskStore.load(taskId, { storageRoot: this._storageRoot });
    try {
      const harnessProfile = store.taskProfile?.duration.id || store.lastCheckpoint?.payload?.harnessProfile || selectHarnessProfile({ isRoutine: !!store.lastCheckpoint?.payload?.routineRun });
      return { taskId, goal: store.getGoal(), recoveryReason: store.recoveryReason, active: false, harnessProfile, taskProfile: store.taskProfile ?? null };
    } finally {
      await this._closeUnattachedTaskStore(store);
    }
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
    if (this._closeRequested) return false;
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
        if (imported.sessions === 0) {
          this._usageLedger.setImported(provider, imported);
          results[provider] = { status: "no_records" };
          continue;
        }
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
    const subscription = await fetchClaudeSubscription({ configDir: claudeConfigDir, fetchFn: this._subscriptionFetch, platform: this._subscriptionPlatform, execFn: this._subscriptionExecFn });
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

  // The provider and (when chosen) model a new planner is pinned to. A task
  // pinned to a model (an Agent's choice) runs that model's provider.
  // A task on the "fast" harness profile always asks its planner CLI for the
  // provider's fast tier, whatever the global plannerFast setting says.
  _plannerPin(role, taskModel = null, { forceFast = false } = {}) {
    const fast = this._plannerFast || forceFast ? { plannerFast: true } : {};
    if (taskModel) return { role, plannerProvider: providerForModel(taskModel), plannerModel: taskModel, ...fast };
    return { role, plannerProvider: this._plannerProvider, ...(this._plannerModel ? { plannerModel: this._plannerModel } : {}), ...fast };
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
    this._plannerEffortMode = settings.plannerEffortMode;
    this._plannerProvider = settings.plannerProvider;
    this._plannerModel = settings.plannerModel;
    this._plannerFast = settings.plannerFast === true;
    this._mcpProviders = [...settings.mcpProviders];
    for (const entry of this._active.values()) {
      entry.controller.setPolicySettings({ ...settings, plannerEffort: this._effortForProfile(entry.store?.taskProfile) });
    }
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
    return controller.runUserControlled(async () => {
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
    this._closeRequested = true;
    const attempt = (async () => {
      // Stop scheduling first so no new occurrence is launched during shutdown.
      // This never stops or cancels tasks; they are paused below like any other.
      await this._scheduler?.stop();
      await this._agentScheduler?.stop();
      await this._rooms.close();
      await Promise.allSettled([...this._roomPlanners].map(([teamId, entry]) => this._closeRoomPlanner(teamId, entry)));
      // A create/load that started before close() must either attach before
      // this snapshot (so it gets cleaned up below) or observe the closed
      // state after its await, close its store, and reject. Never let a late
      // attachment escape this shutdown pass.
      await Promise.allSettled([...this._pendingAttachments]);
      await this._sessionAccessChain;
      await this._queueTransition;
      // Children own independent controllers/views/stores and are not in the
      // top-level active map. Pause and detach them before parent stores close;
      // accepted plans remain durable for explicit recovery next run.
      await this._childCoordinator.shutdown();
      const errors = [];
      for (const [taskId, ownership] of [...this._unattachedStoreClosures]) {
        try {
          await ownership.store.close();
          this._unattachedStoreClosures.delete(taskId);
        } catch (error) {
          ownership.error = error;
          errors.push(new TaskHostError("task_store_cleanup_failed", `unattached task store ${taskId} remains open: ${error.message}`));
        }
      }
      for (const [taskId, failure] of [...this._attachmentCleanupFailures]) {
        const pending = [];
        for (const operation of failure.pending) {
          try { await operation.run(); }
          catch (error) { pending.push({ ...operation, error }); }
        }
        if (pending.length) {
          failure.pending = pending;
          errors.push(new TaskHostError("attachment_cleanup_failed", `partial resources for task ${taskId} remain open`));
          continue;
        }
        try {
          this._childCoordinator.unregisterStore(taskId);
          await this._coordinator.releaseLease(taskId);
          this._attachmentCleanupFailures.delete(taskId);
          await this._closeUnattachedTaskStore(failure.store);
        } catch (error) {
          errors.push(error);
        }
      }
      const entries = [...this._active.values()];
      await Promise.all(entries.map(async (entry) => {
        const terminalFailure = this._terminalTeardownFailures.get(entry.store.taskId);
        if (terminalFailure) {
          try {
            if (terminalFailure.leasePending) {
              await this._coordinator.releaseLease(entry.store.taskId);
              this._finalizeTerminalTeardown(entry.store.taskId, entry);
            }
            else await this._finishTerminalTeardown(entry.store.taskId, entry, terminalFailure);
          } catch (error) {
            errors.push(error);
          }
          return;
        }
        const state = entry.controller.getSnapshot().state;
        let takeoverFailed = false;
        if (state === "running" || state === "awaiting_approval") {
          try {
            await entry.controller.takeOver("host_shutdown");
          } catch (error) {
            errors.push(error);
            takeoverFailed = true;
          }
        }
        // Do not close the browser or journal while the task has not durably
        // left an active state. Keep ownership attached so a later close()
        // retry can persist the host-shutdown pause first.
        if (takeoverFailed) return;

        this._unsubscribe(entry);

        try { await this._finishTerminalTeardown(entry.store.taskId, entry); }
        catch (error) { errors.push(error); }
      }));
      this._listeners.clear();
      this._rosterListeners.clear();
      this._roomListeners.clear();
      await Promise.resolve(this._workGoalStore.close?.()).catch((error) => errors.push(error));
      if (errors.length > 0) {
        throw new AggregateError(errors, "one or more task resources failed to close");
      }
    })();
    this._closePromise = attempt;
    // Keep a successful close cached, but allow a later close() call to retry
    // resources retained by _finishTerminalTeardown after a partial failure.
    attempt.catch(() => {
      if (this._closePromise === attempt) this._closePromise = null;
    });
    return attempt;
  }

  _assertOpen() {
    if (this._closeRequested) throw new TaskHostError("host_closed", "task host is closing or closed");
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
