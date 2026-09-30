"use strict";

// ChildAgentCoordinator (multi-agent background runtime plan, Task 3): the
// single authority that turns a parent planner's accepted `child_plan`
// proposal into durable, host-minted child TaskStores, and the single place
// that later reconstructs "what children does this parent have" from the
// parent's own journal. A child's identity, storage location, and lifecycle
// record are ALWAYS derived from the host-authored `child_plan_accepted`
// journal event -- never from a child's own self-report -- so a corrupt or
// missing parent-child link fails closed (`corrupt_child_link`) instead of
// silently reconstructing a plan from whatever a child claims about itself.
//
// This module does not construct any browser/planner/worker -- it only
// persists the parent<->child linkage and mints each child's TaskStore
// (closed immediately after creation). Actually dispatching work to a child
// is Task 4's responsibility (task-controller.js).

const crypto = require("node:crypto");
const contracts = require("../../shared/harness-contracts");
const { TaskStore } = require("./task-store");
const { TaskController } = require("./task-controller");
const { resolveTaskProfile } = require("../../shared/task-profile-router");
const { validateTaskProfileSelectedPayload } = require("../../shared/task-profile-contracts");
const { MessageMailbox, MessageMailboxError } = require("./message-mailbox");

class ChildAgentCoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChildAgentCoordinatorError";
    this.code = code;
  }
}

async function readAllEvents(store) {
  const events = [];
  let since = 0;
  for (;;) {
    const page = await store.getEvents({ since });
    if (page.length === 0) return events;
    events.push(...page);
    since = page[page.length - 1].seq;
  }
}

// Task 4: a child has exactly ONE hidden WebContentsView (no separate
// visible surface, unlike a top-level task) plus its own planner worker
// subtree. No real measurement exists yet for this shape -- Task 7's
// benchmark provides that -- so this is a conservative placeholder that
// still makes budgeted admission fail closed rather than reserving nothing.
const DEFAULT_CHILD_RESERVE_BYTES = 200_000_000;

class ChildAgentCoordinator {
  constructor({
    storageRoot,
    getResourceAdmission,
    makeChildBrowser,
    makePlanner,
    approve,
    hostVerifier,
    memoryMonitor,
    memoryStore,
    now,
    segmentRotationCalls,
    noProgressThreshold,
    plannerEffort,
    reserveBytesPerChild = DEFAULT_CHILD_RESERVE_BYTES,
  } = {}) {
    if (typeof storageRoot !== "string" || storageRoot.length === 0) {
      throw new ChildAgentCoordinatorError("invalid_config", "storageRoot is required");
    }
    this._storageRoot = storageRoot;
    // The following are all OPTIONAL: a coordinator constructed with only
    // `storageRoot` (every Task 3 test does exactly this) can still accept/
    // list/cancel plans -- it simply never actually starts a child, which is
    // the documented fail-closed behavior when the host hasn't wired up
    // real resource admission / browser / planner factories.
    this._getResourceAdmission = typeof getResourceAdmission === "function" ? getResourceAdmission : null;
    this._makeChildBrowser = typeof makeChildBrowser === "function" ? makeChildBrowser : null;
    this._makePlanner = typeof makePlanner === "function" ? makePlanner : null;
    this._approve = typeof approve === "function" ? approve : null;
    this._hostVerifier = hostVerifier;
    this._memoryMonitor = memoryMonitor;
    this._memoryStore = memoryStore;
    this._now = now;
    this._segmentRotationCalls = segmentRotationCalls;
    this._noProgressThreshold = noProgressThreshold;
    this._plannerEffort = plannerEffort;
    this._reserveBytesPerChild = reserveBytesPerChild;
    // parentTaskId -> { planId, childIds, assignments, parentGoalVersion,
    //                   memoryPolicy, state: "queued"|"cancelled" }
    // In-memory cache only; always reconstructible from the parent's own
    // journal via _reconstructPlan() after a restart (see _resolveActivePlan).
    this._plans = new Map();
    // childId -> parentTaskId, populated only for plans THIS instance
    // accepted -- startChild(childId)'s single-argument lookup.
    this._childParent = new Map();
    // childId -> { controller, browser, planner, store, leaseId, origin, parentTaskId, unsubscribe }
    this._liveChildren = new Map();
    // childId -> { outcome: "completed"|"stopped"|"failed", reason? }
    this._terminalChildren = new Map();
    // A failed start whose teardown itself failed keeps its lease reserved.
    // This is intentionally fail-closed: releasing it could admit another
    // child while the first one's browser/planner/store may still be alive.
    this._failedStartLeases = new Map();
    // Subagent communication protocol Task 4: taskId -> its currently OPEN
    // TaskStore handle, for every top-level task this process has attached
    // (registered by task-host.js's _attach()/detach paths -- this
    // coordinator never opens a second handle to a store someone else
    // already holds the exclusive writer lock for). A live child's own
    // store is already tracked in _liveChildren, so it is never duplicated
    // here.
    this._activeStores = new Map();
    // Serialize each child's parent-to-child steer quota check with the
    // corresponding durable append so concurrent sends cannot pass the
    // one-unobserved-steer limit together.
    this._steerLocks = new Map();
    // Parent goal changes and all messages within that parent's accepted
    // child plan share one serialization point, so a stale-version check
    // cannot be invalidated before the corresponding message append.
    this._parentGoalLocks = new Map();
    // conversationId in this V1 scheme is exactly the childId: a child has
    // exactly one parent (Global Constraints: no nested/shared children), so
    // the childId alone already uniquely identifies the relationship.
    this._mailbox = new MessageMailbox({
      getTaskStore: (taskId) => this._activeStores.get(taskId) || this._liveChildren.get(taskId)?.store,
      getConversationTaskIds: (conversationId) => this._relationshipForConversation(conversationId),
      now: this._now,
    });
  }

  // task-host.js registers/unregisters every top-level task's own store
  // handle here as it attaches/detaches it, so this coordinator's mailbox
  // can reach a parent's journal without ever opening a competing handle.
  registerStore(taskId, store) {
    this._activeStores.set(taskId, store);
  }

  unregisterStore(taskId) {
    this._activeStores.delete(taskId);
  }

  _relationshipForConversation(conversationId) {
    const parentTaskId = this._childParent.get(conversationId);
    if (!parentTaskId) return null; // unknown conversation: mailbox treats this as unauthorized_route
    return { parentTaskId, childTaskId: conversationId };
  }

  // Validates and accepts a parent planner's child_plan proposal: mints one
  // TaskStore per assignment under the parent's own directory, then persists
  // ONE child_plan_accepted event to the parent journal recording every
  // minted childId -- before any worker/browser/view is ever constructed for
  // them (plan Step 5's ordering requirement).
  async acceptParentPlan(parentTaskId, proposal, { parentStore, memoryPolicy, memoryPolicyAuditEventId = null } = {}) {
    if (typeof parentTaskId !== "string" || !contracts.UUID_RE.test(parentTaskId)) {
      throw new ChildAgentCoordinatorError("invalid_field", "parentTaskId must be a UUID");
    }
    if (!parentStore || typeof parentStore.getGoal !== "function" || typeof parentStore.append !== "function") {
      throw new ChildAgentCoordinatorError("invalid_config", "parentStore with getGoal/append is required");
    }
    if (parentStore.taskProfile?.capability?.id !== "multi_agent") {
      throw new ChildAgentCoordinatorError("capability_not_authorized", "parent task must have a persisted Multi-agent capability profile");
    }
    if (!contracts.MEMORY_POLICIES.includes(memoryPolicy)) {
      throw new ChildAgentCoordinatorError("invalid_field", `memoryPolicy must be one of ${contracts.MEMORY_POLICIES.join("|")}`);
    }
    if (memoryPolicyAuditEventId !== null && (
      typeof memoryPolicyAuditEventId !== "string" ||
      memoryPolicyAuditEventId.length === 0 ||
      memoryPolicyAuditEventId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(memoryPolicyAuditEventId)
    )) {
      throw new ChildAgentCoordinatorError("invalid_field", "memoryPolicyAuditEventId must be null or a bounded non-empty ID string");
    }

    let validated;
    try {
      validated = contracts.validateProposalEnvelope(proposal);
    } catch (err) {
      throw new ChildAgentCoordinatorError("invalid_proposal", err.message);
    }
    if (validated.kind !== "child_plan") {
      throw new ChildAgentCoordinatorError("invalid_proposal", "proposal.kind must be child_plan");
    }
    if (validated.taskId !== parentTaskId) {
      throw new ChildAgentCoordinatorError("invalid_proposal", "proposal.taskId must match parentTaskId");
    }

    const existing = await this._resolveActivePlan(parentTaskId);
    if (existing && existing.state !== "cancelled") {
      throw new ChildAgentCoordinatorError("plan_already_active", `parent task ${parentTaskId} already has an active child plan`);
    }

    const currentGoal = parentStore.getGoal();
    if (validated.parentGoalVersion !== currentGoal.goalVersion) {
      throw new ChildAgentCoordinatorError(
        "stale_goal_version",
        `child_plan targets goalVersion ${validated.parentGoalVersion} but parent is at ${currentGoal.goalVersion}`,
      );
    }

    const planId = crypto.randomUUID();
    const createdChildIds = [];
    let assignments;
    try {
      assignments = [];
      for (const a of validated.assignments) {
        const childId = crypto.randomUUID();
        const origin = contracts.deriveOrigin(a.entryUrl);
        const childProfile = resolveTaskProfile({
          goalInput: { originalRequest: a.subgoal },
          parentProfile: parentStore.taskProfile,
          parentBinding: { parentTaskId, planId, parentGoalVersion: validated.parentGoalVersion },
        });
        const childStore = await TaskStore.createChild(
          { originalRequest: a.subgoal },
          { storageRoot: this._storageRoot, parentTaskId, childId, resolvedProfile: childProfile },
        );
        await childStore.close();
        createdChildIds.push(childId);
        assignments.push({ childId, subgoal: a.subgoal, entryUrl: a.entryUrl, origin });
      }

      // The plan is only real once THIS event lands in the parent journal --
      // if append() fails (e.g. the store closed underneath us), every child
      // directory minted above must be rolled back too, same as a failure
      // partway through the creation loop.
      await parentStore.append({
        type: "child_plan_accepted",
        payload: {
          planId,
          parentGoalVersion: validated.parentGoalVersion,
          requestedAgentCount: validated.requestedAgentCount,
          memoryPolicy,
          memoryPolicyAuditEventId,
          actor: "parent_agent",
          assignments: assignments.map(({ childId, subgoal, entryUrl, origin }) => ({ childId, subgoal, entryUrl, origin })),
        },
      });
    } catch (err) {
      await this._cleanupChildren(parentTaskId, createdChildIds);
      throw err;
    }

    const childIds = assignments.map((a) => a.childId);
    const plan = {
      planId,
      childIds,
      assignments,
      parentGoalVersion: validated.parentGoalVersion,
      memoryPolicy,
      memoryPolicyAuditEventId,
      parentTaskProfile: parentStore.taskProfile,
      state: "queued",
    };
    this._plans.set(parentTaskId, plan);
    for (const childId of childIds) this._childParent.set(childId, parentTaskId);
    // Best-effort: try to admit/start whatever this plan's resources/origin
    // serialization currently allow. A coordinator with no makeChildBrowser/
    // resourceAdmission configured (or one that simply can't admit right
    // now) leaves every assignment durably queued -- that is not a failure
    // of acceptParentPlan itself, which already succeeded the instant the
    // child_plan_accepted event above landed.
    this.scheduleAdmission(parentTaskId).catch(() => {});
    return { planId, childIds, state: "queued" };
  }

  // Safe summaries of a parent's current children -- never touches a child's
  // own journal/self-report, only the parent-authored plan. Returns [] once
  // the plan is cancelled or if the parent has never accepted one.
  async listChildren(parentTaskId) {
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return [];
    return plan.assignments.map(({ childId, subgoal, entryUrl, origin }) => ({
      childId,
      subgoal,
      entryUrl,
      origin,
      state: this._childState(childId),
    }));
  }

  // "queued" (not yet started), "running" (live controller attached), or a
  // recorded terminal outcome ("completed"|"stopped"|"failed") -- never
  // derived from anything the child itself reports, only from this
  // coordinator's own bookkeeping around starting/retiring it.
  _childState(childId) {
    if (this._liveChildren.has(childId)) return "running";
    const terminal = this._terminalChildren.get(childId);
    if (terminal) return terminal.outcome;
    return "queued";
  }

  async cancelPlan(parentTaskId, reason, { parentStore } = {}) {
    if (!parentStore || typeof parentStore.append !== "function") {
      throw new ChildAgentCoordinatorError("invalid_config", "parentStore with append is required");
    }
    if (typeof reason !== "string" || reason.length === 0) {
      throw new ChildAgentCoordinatorError("invalid_field", "reason is required");
    }
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") {
      throw new ChildAgentCoordinatorError("no_active_plan", `parent task ${parentTaskId} has no active child plan to cancel`);
    }

    // Drain every live child of this parent BEFORE recording the
    // cancellation -- stop() always forces a transition to "stopped", and
    // this controller's own onChange handler (see _attachChild) retires it
    // (releases its lease, disposes its view/store) as soon as that lands.
    const liveChildIds = [...this._liveChildren.entries()]
      .filter(([, live]) => live.parentTaskId === parentTaskId)
      .map(([childId]) => childId);
    for (const childId of liveChildIds) {
      const live = this._liveChildren.get(childId);
      if (!live) continue; // already retired by its own onChange while we awaited a prior stop()
      try {
        await live.controller.stop();
      } catch {
        // Best-effort: a controller that fails to stop cleanly must not
        // block the plan's own cancellation from being recorded.
      }
    }

    await parentStore.append({
      type: "child_plan_cancelled",
      payload: { planId: plan.planId, reason },
    });
    this._plans.set(parentTaskId, { ...plan, state: "cancelled" });
  }

  // In-memory cache first (this coordinator instance's own bookkeeping is
  // authoritative for a plan it just accepted/cancelled); falls back to
  // reconstructing from the parent's journal (e.g. after a process restart),
  // caching the result so repeated calls do not re-scan the whole journal.
  async _resolveActivePlan(parentTaskId) {
    const cached = this._plans.get(parentTaskId);
    if (cached) return cached;
    const reconstructed = await this._reconstructPlan(parentTaskId);
    if (reconstructed) this._plans.set(parentTaskId, reconstructed);
    return reconstructed;
  }

  // Rebuilds a parent's child-plan state purely from its own journal: the
  // latest child_plan_accepted event, minus whether a later
  // child_plan_cancelled for that SAME planId exists. Every referenced child
  // must have a loadable store of its own -- a child that cannot be loaded
  // means the link is corrupt, and this throws rather than silently
  // reconstructing the plan from the child's own self-report (Review Focus:
  // "parent이 corrupt/missing parent-child journal link을 발견하면 일시정지").
  async _reconstructPlan(parentTaskId) {
    let since = 0;
    let latestAccepted = null;
    const cancelledPlanIds = new Set();
    let parentTaskProfile = null;
    for (;;) {
      const page = await TaskStore.readEvents(parentTaskId, { storageRoot: this._storageRoot }, { since });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.type === "child_plan_accepted") {
          latestAccepted = event;
        } else if (event.type === "task_profile_selected") {
          parentTaskProfile = event.payload;
        } else if (event.type === "child_plan_cancelled") {
          cancelledPlanIds.add(event.payload.planId);
        }
      }
      since = page[page.length - 1].seq;
    }
    if (!latestAccepted) return null;

    const planId = latestAccepted.payload.planId;
    const { parentGoalVersion, memoryPolicy } = latestAccepted.payload;
    const memoryPolicyAuditEventId = latestAccepted.payload.memoryPolicyAuditEventId ?? null;
    if (cancelledPlanIds.has(planId)) {
      return {
        planId,
        childIds: latestAccepted.payload.assignments.map((a) => a.childId),
        assignments: latestAccepted.payload.assignments,
        parentGoalVersion,
        memoryPolicy,
        memoryPolicyAuditEventId,
        parentTaskProfile,
        state: "cancelled",
      };
    }

    const assignments = [];
    for (const a of latestAccepted.payload.assignments) {
      let childStore;
      try {
        childStore = await TaskStore.loadChild(a.childId, { storageRoot: this._storageRoot, parentTaskId });
      } catch (err) {
        throw new ChildAgentCoordinatorError(
          "corrupt_child_link",
          `child ${a.childId} referenced by plan ${planId} could not be loaded: ${err.message}`,
        );
      }
      await childStore.close();
      assignments.push({ childId: a.childId, subgoal: a.subgoal, entryUrl: a.entryUrl, origin: a.origin });
      this._childParent.set(a.childId, parentTaskId);
    }

    return {
      planId,
      childIds: assignments.map((a) => a.childId),
      assignments,
      parentGoalVersion,
      memoryPolicy,
      memoryPolicyAuditEventId,
      parentTaskProfile,
      state: "queued",
    };
  }

  // Attempts startChild() for every currently-queued assignment of a
  // parent, in assignment order. Safe to call repeatedly -- right after a
  // plan is accepted, and again whenever a sibling terminates and frees a
  // resource lease or an origin-serialization slot (see _retireChild).
  // Never throws for an ordinary "not eligible yet" outcome; a genuinely
  // corrupt/unknown plan surfaces through _resolveActivePlan as usual.
  async scheduleAdmission(parentTaskId) {
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return;
    for (const assignment of plan.assignments) {
      await this.startChild(assignment.childId);
    }
  }

  // Attempts to admit and start ONE specific queued child. Looks up its
  // parent via the childId -> parentTaskId map populated by
  // acceptParentPlan()/_reconstructPlan() -- childIds are host-minted UUIDs,
  // globally unique across every parent this coordinator instance knows
  // about. Returns { started:false, reason } for any ordinary reason a
  // child stays queued (not configured, no admitted lease, a same-origin
  // sibling still running, already running/terminal); only a genuinely
  // corrupt child link throws.
  async startChild(childId) {
    const parentTaskId = this._childParent.get(childId);
    if (!parentTaskId) return { started: false, reason: "unknown_child" };
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return { started: false, reason: "plan_cancelled" };
    const assignment = plan.assignments.find((a) => a.childId === childId);
    if (!assignment) return { started: false, reason: "unknown_child" };
    if (this._liveChildren.has(childId)) return { started: false, reason: "already_running" };
    if (this._terminalChildren.has(childId)) return { started: false, reason: "already_terminal" };
    if (!this._makeChildBrowser || !this._makePlanner) return { started: false, reason: "not_configured" };
    const resourceAdmission = this._getResourceAdmission && this._getResourceAdmission();
    if (!resourceAdmission) return { started: false, reason: "not_configured" };

    // Review Focus: a parent goal amended while children are still queued
    // must reject the stale assignment BEFORE any browser/planner is ever
    // constructed for it -- never after. This reads the parent's journal
    // directly (no lock, no live store handle needed), so it works whether
    // or not this coordinator instance is the one that originally accepted
    // the plan.
    const currentGoalVersion = await this._currentParentGoalVersion(parentTaskId);
    if (currentGoalVersion !== null && plan.parentGoalVersion !== null && currentGoalVersion !== plan.parentGoalVersion) {
      this._terminalChildren.set(childId, { outcome: "failed", reason: "stale_goal_version" });
      return { started: false, reason: "stale_goal_version" };
    }

    // Concurrent siblings of the SAME parent with the SAME normalized origin
    // must serialize -- a second assignment sharing that origin waits here
    // until the first one retires (see _retireChild's re-schedule call).
    for (const live of this._liveChildren.values()) {
      if (live.parentTaskId === parentTaskId && live.origin === assignment.origin) {
        return { started: false, reason: "origin_serialized" };
      }
    }

    const lease = await resourceAdmission.acquire({
      ownerId: childId,
      reserveBytes: this._reserveBytesPerChild,
      parentPolicy: { mode: plan.memoryPolicy, parentTaskId, requestedAgentCount: plan.assignments.length },
    });
    if (!lease.admitted) return { started: false, reason: lease.reason };

    try {
      await this._attachChild(parentTaskId, assignment, lease.leaseId, plan);
    } catch (error) {
      if (error.cleanupComplete === false) {
        this._failedStartLeases.set(childId, lease.leaseId);
      } else {
        // _attachChild has awaited all teardown before it rejects. Only now
        // is the reserved capacity safe to make available to another child.
        await resourceAdmission.release(lease.leaseId);
      }
      throw error;
    }
    return { started: true };
  }

  // Reconstructs "the parent's current goal version" purely from its own
  // journal (every event is stamped with the goalVersion active when it was
  // appended, and goalVersion only ever increases via goal_amended) -- never
  // by re-opening the parent's TaskStore, which would contend for its
  // exclusive writer lock while the parent's own TaskController already
  // holds it open.
  async _currentParentGoalVersion(parentTaskId) {
    let since = 0;
    let latest = null;
    for (;;) {
      const page = await TaskStore.readEvents(parentTaskId, { storageRoot: this._storageRoot }, { since });
      if (page.length === 0) break;
      for (const event of page) {
        if (latest === null || event.goalVersion > latest) latest = event.goalVersion;
      }
      since = page[page.length - 1].seq;
    }
    return latest;
  }

  // Constructs the ONE unique TaskController/BrowserAdapter/planner for a
  // single child and starts it: this is the single call site for all of
  // Global Constraints' "one agent ID owns exactly one view/adapter/
  // planner/journal/lifecycle record". The host (not the child's own
  // planner) performs the ONE initial navigation to entryUrl via
  // userNavigate() -- the pre-existing trusted path that bypasses the
  // observe-only action-policy gate entirely -- before the child's planner
  // is ever consulted.
  async _attachChild(parentTaskId, assignment, leaseId, plan) {
    const { childId, entryUrl, origin } = assignment;
    let childStore = null;
    let browser = null;
    let planner = null;
    let controller = null;
    let live = null;
    try {
      childStore = await TaskStore.loadChild(childId, { storageRoot: this._storageRoot, parentTaskId });
      const parentProfile = plan.parentTaskProfile || null;
      const childProfile = childStore.taskProfile;
      const isLegacyPair = !parentProfile && !childProfile;
      if (!isLegacyPair) {
        if (!parentProfile || !childProfile || childProfile.capability.id !== "browser") {
          throw new ChildAgentCoordinatorError("profile_binding_invalid", "profiled child plan requires a persisted Browser child profile");
        }
        validateTaskProfileSelectedPayload(parentProfile);
        const binding = childProfile.parentBinding;
        if (!binding || binding.parentTaskId !== parentTaskId || binding.planId !== plan.planId
            || binding.parentGoalVersion !== plan.parentGoalVersion
            || childProfile.duration.id !== parentProfile.duration.id
              && ["short", "middle", "long"].indexOf(childProfile.duration.id) > ["short", "middle", "long"].indexOf(parentProfile.duration.id)) {
          throw new ChildAgentCoordinatorError("profile_binding_invalid", "child profile is not bound to the accepted parent plan or exceeds its horizon");
        }
      }
      browser = this._makeChildBrowser(parentTaskId, childId, origin);
      await browser.userNavigate({ type: "navigate", url: entryUrl });
      planner = this._makePlanner(childId);
      // permissionMode is LITERALLY "observe" here, never a parameter --
      // Global Constraints: child policy is exactly observe+scroll, and this
      // is the one call site that ever constructs a child's TaskController.
      controller = new TaskController({
        store: childStore,
        planner,
        browser,
        approve: this._approve ? (descriptor) => this._approve(childId, descriptor) : async () => ({ decision: "deny" }),
        hostVerifier: this._hostVerifier,
        memoryMonitor: this._memoryMonitor,
        memoryStore: this._memoryStore,
        permissionMode: "observe",
        harnessProfile: childStore.taskProfile?.duration?.id || "middle",
        plannerEffort: this._plannerEffort,
        now: this._now,
        segmentRotationCalls: this._segmentRotationCalls,
        noProgressThreshold: this._noProgressThreshold,
        // Subagent communication protocol Task 4: this coordinator is the
        // relationship/quota authority for every message this child sends or
        // receives -- the child's own controller only ever calls back here.
        sendMessage: (validated) => this.handleSendMessage(childId, validated),
        listPendingMessages: () => this.listPendingMessages(childId),
        recordMessagesConsumed: (ids, plannerCall) => this.recordMessagesConsumed(childId, ids, plannerCall),
      });

      live = { controller, browser, planner, store: childStore, leaseId, origin, parentTaskId };
      this._liveChildren.set(childId, live);
      live.unsubscribe = controller.onChange((snapshot) => {
        if (snapshot.state === "completed" || snapshot.state === "stopped") {
          live.unsubscribe?.();
          this._retireChild(parentTaskId, childId, snapshot.state).catch(() => {});
        }
      });
      // childStore was minted by acceptParentPlan() and immediately closed
      // (Global Constraints: no browser/planner exists until a child is
      // actually admitted), so loadChild() above always reopens it as a
      // "recovered" store -- TaskController's constructor therefore always
      // starts it "paused", never "idle". start() would reject that
      // unconditionally; resume() is the correct call here, exactly as
      // TaskHost.resumeSavedTask() re-attaches any other reloaded store.
      await controller.resume();
    } catch (error) {
      const attachError = error instanceof Error ? error : new Error(String(error));
      // Remove observers/registration before asking the controller to stop;
      // otherwise its stop event could race this rollback through
      // _retireChild() and release the same lease before teardown finishes.
      live?.unsubscribe?.();
      if (this._liveChildren.get(childId) === live) this._liveChildren.delete(childId);

      const teardown = [];
      const attemptTeardown = async (operation) => {
        try {
          await operation();
          teardown.push(null);
        } catch (teardownError) {
          teardown.push(teardownError);
        }
      };
      // Keep order: stop/drain controller writes before closing its journal;
      // then release the view and worker before releasing the store lock.
      if (controller) await attemptTeardown(() => controller.stop());
      if (browser) await attemptTeardown(() => browser.dispose?.());
      if (planner) await attemptTeardown(() => planner.close?.());
      if (childStore) await attemptTeardown(() => childStore.close());
      const cleanupComplete = teardown.length === 0 || teardown.every((failure) => failure === null);
      this._terminalChildren.set(childId, {
        outcome: "failed",
        reason: cleanupComplete ? "child_start_failed" : "child_start_cleanup_failed",
      });
      // startChild() returns the lease only when teardown completed. If a
      // disposer/close failed, keep capacity reserved and surface the
      // original attach error without losing that fail-closed state.
      attachError.cleanupComplete = cleanupComplete;
      if (!cleanupComplete) attachError.cleanupErrors = teardown.filter(Boolean).map((failure) => failure?.message || String(failure));
      throw attachError;
    }
  }

  // Tears down a finished child's OWNED resources (view/adapter via
  // browser.dispose(), its TaskStore handle) and releases its resource
  // lease, then re-attempts scheduling for the same parent -- a same-origin
  // sibling that was serialized behind this one, or any other queued
  // assignment now unblocked by the freed lease, gets another chance here.
  async _retireChild(parentTaskId, childId, controllerState) {
    const live = this._liveChildren.get(childId);
    if (!live) return;
    this._liveChildren.delete(childId);
    this._terminalChildren.set(childId, { outcome: controllerState === "completed" ? "completed" : "stopped" });
    try {
      await live.browser.dispose?.();
    } catch {
      // Best-effort: a failed view teardown must not prevent the lease
      // release or block a queued sibling from ever getting a turn.
    }
    try {
      await live.store.close();
    } catch {
      // Best-effort, same reasoning as above.
    }
    const resourceAdmission = this._getResourceAdmission && this._getResourceAdmission();
    await resourceAdmission?.release(live.leaseId);
    await this.scheduleAdmission(parentTaskId).catch(() => {});
  }

  // Reads the CHILD's own durable checkpoint/journal directly -- never the
  // child's self-report -- to decide whether its claimed result may be
  // treated as real. Fails closed at every step: no checkpoint, a
  // non-"completed" checkpoint state, no verified criteria, or a verified
  // criterion whose evidenceId does not actually appear as a real
  // evidence_recorded event in the child's OWN journal, all return
  // { ok:false, reason }. Only a genuinely corrupt/unknown child link
  // throws. On success, when `parentStore` is provided, durably records the
  // parent's OWN synthesis event citing exactly the evidence it verified.
  async verifyChildResult(parentTaskId, childId, { parentStore } = {}) {
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") {
      throw new ChildAgentCoordinatorError("no_active_plan", `parent task ${parentTaskId} has no active child plan`);
    }
    const assignment = plan.assignments.find((a) => a.childId === childId);
    if (!assignment) {
      throw new ChildAgentCoordinatorError("unknown_child", `${childId} is not a child of parent ${parentTaskId}`);
    }

    let childStore;
    try {
      childStore = await TaskStore.loadChild(childId, { storageRoot: this._storageRoot, parentTaskId });
    } catch (err) {
      throw new ChildAgentCoordinatorError("corrupt_child_link", `child ${childId} could not be loaded: ${err.message}`);
    }
    try {
      const checkpointPayload = childStore.lastCheckpoint && childStore.lastCheckpoint.payload;
      if (!checkpointPayload || !checkpointPayload.task) {
        return { ok: false, reason: "no_checkpoint" };
      }
      if (checkpointPayload.task.state !== "completed") {
        return { ok: false, reason: "not_completed", state: checkpointPayload.task.state };
      }
      const verifiedStatuses = (checkpointPayload.criteriaStatus || []).filter(([, v]) => v.status === "verified");
      if (verifiedStatuses.length === 0) {
        return { ok: false, reason: "no_verified_criteria" };
      }

      // Cross-check against the child's OWN journal: a checkpoint claiming a
      // criterion "verified" with no backing evidence_recorded event for
      // that exact evidenceId is exactly the self-report-laundering pattern
      // this method exists to catch -- the checkpoint blob alone is never
      // sufficient authority.
      const recordedEvidenceIds = new Set();
      let since = 0;
      for (;;) {
        const page = await TaskStore.readEvents(childId, { storageRoot: this._storageRoot, parentTaskId }, { since });
        if (page.length === 0) break;
        for (const event of page) {
          if (event.type === "evidence_recorded") recordedEvidenceIds.add(event.payload.evidence.id);
        }
        since = page[page.length - 1].seq;
      }
      const verifiedCriteria = verifiedStatuses
        .filter(([, v]) => recordedEvidenceIds.has(v.evidenceId))
        .map(([criterionId, v]) => ({ criterionId, evidenceId: v.evidenceId }));
      if (verifiedCriteria.length === 0) {
        return { ok: false, reason: "missing_evidence_record" };
      }

      if (parentStore) {
        await parentStore.append({
          type: "child_result_verified",
          payload: {
            childId,
            planId: plan.planId,
            childCheckpointGoalVersion: childStore.getGoal().goalVersion,
            verifiedCriteria,
          },
        });
      }
      return { ok: true, verifiedCriteria };
    } finally {
      await childStore.close().catch(() => {});
    }
  }

  // Subagent communication protocol Task 4: the single authority for
  // "is this sender allowed to message this recipient, and under what
  // host-derived envelope" -- called from a controller's send_message
  // handler for BOTH a parent's own top-level controller (senderTaskId is
  // the parent) and a child's controller (senderTaskId is the child).
  // Never trusts the proposal's own recipientTaskId beyond checking it
  // against the one accepted relationship this coordinator actually knows
  // (no sibling routing, no forged sender/recipient IDs).
  async handleSendMessage(senderTaskId, proposal) {
    if (!contracts.UUID_RE.test(senderTaskId || "")) {
      throw new ChildAgentCoordinatorError("invalid_field", "senderTaskId must be a UUID");
    }
    const parentTaskId = this._childParent.get(senderTaskId) || senderTaskId;
    return this.withParentGoalLock(parentTaskId, () => this._handleSendMessage(senderTaskId, proposal));
  }

  async withParentGoalLock(parentTaskId, operation) {
    if (!contracts.UUID_RE.test(parentTaskId || "") || typeof operation !== "function") {
      throw new ChildAgentCoordinatorError("invalid_config", "parentTaskId and lock operation are required");
    }
    const previous = this._parentGoalLocks.get(parentTaskId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this._parentGoalLocks.set(parentTaskId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this._parentGoalLocks.get(parentTaskId) === tail) this._parentGoalLocks.delete(parentTaskId);
    }
  }

  async _handleSendMessage(senderTaskId, proposal) {
    if (!contracts.UUID_RE.test(senderTaskId || "")) {
      throw new ChildAgentCoordinatorError("invalid_field", "senderTaskId must be a UUID");
    }
    if (!contracts.isPlainObject(proposal) || proposal.kind !== "send_message") {
      throw new ChildAgentCoordinatorError("invalid_proposal", "proposal.kind must be send_message");
    }
    const recipientTaskId = proposal.recipientTaskId;

    let parentTaskId, childTaskId, conversationId, plan;
    const parentOfSender = this._childParent.get(senderTaskId);
    if (parentOfSender) {
      // Sender is a known child: may only message its own parent. steer is
      // parent-to-child-only (defense in depth -- planner-stdio.js's
      // role:"child" transport already rejects this at the wire boundary).
      if (recipientTaskId !== parentOfSender) {
        throw new ChildAgentCoordinatorError("unauthorized_route", "a child may only message its own parent");
      }
      if (proposal.messageKind === "steer") {
        throw new ChildAgentCoordinatorError("unauthorized_route", "steer is a parent-to-child-only message kind");
      }
      parentTaskId = parentOfSender;
      childTaskId = senderTaskId;
      conversationId = senderTaskId;
      plan = await this._resolveActivePlan(parentTaskId);
    } else {
      // Sender must be a parent whose active plan's accepted children
      // include the claimed recipient.
      plan = await this._resolveActivePlan(senderTaskId);
      if (!plan || plan.state === "cancelled" || !plan.childIds.includes(recipientTaskId)) {
        throw new ChildAgentCoordinatorError("unauthorized_route", "recipient is not an accepted child of this parent");
      }
      parentTaskId = senderTaskId;
      childTaskId = recipientTaskId;
      conversationId = recipientTaskId;

    }

    if (!plan || plan.state === "cancelled") {
      throw new ChildAgentCoordinatorError("no_active_plan", "no active child plan for this conversation");
    }

    // Validate both directions against the current parent goal. A child on
    // an accepted-but-stale assignment may not message its parent either.
    const currentGoalVersion = await this._currentParentGoalVersion(parentTaskId);
    if (currentGoalVersion !== null && plan.parentGoalVersion !== null && currentGoalVersion !== plan.parentGoalVersion) {
      throw new ChildAgentCoordinatorError("stale_goal_version", "parent goal has moved since this child plan was accepted");
    }

    const envelope = {
      conversationId,
      parentTaskId,
      childTaskId,
      senderTaskId,
      recipientTaskId,
      parentGoalVersion: plan.parentGoalVersion,
      kind: proposal.messageKind,
      idempotencyKey: proposal.idempotencyKey,
    };
    if (proposal.text !== undefined) envelope.text = proposal.text;
    if (proposal.handoff !== undefined) envelope.handoff = proposal.handoff;
    if (proposal.evidenceRefs !== undefined) envelope.evidenceRefs = proposal.evidenceRefs;
    if (proposal.inReplyToMessageId !== undefined) envelope.inReplyToMessageId = proposal.inReplyToMessageId;

    try {
      if (senderTaskId === parentTaskId && proposal.messageKind === "steer") {
        return await this._withSteerLock(childTaskId, async () => {
          await this._enforceSteerLimits(parentTaskId, childTaskId);
          return this._mailbox.send(envelope);
        });
      }
      return await this._mailbox.send(envelope);
    } catch (err) {
      if (err instanceof MessageMailboxError) throw new ChildAgentCoordinatorError(err.code, err.message);
      throw err;
    }
  }

  async _withSteerLock(childTaskId, operation) {
    const previous = this._steerLocks.get(childTaskId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this._steerLocks.set(childTaskId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this._steerLocks.get(childTaskId) === tail) this._steerLocks.delete(childTaskId);
    }
  }

  // Section 10 v1 defaults: at most one unobserved parent-to-child steer per
  // child, and at most MAX_STEER_PER_CHILD_PER_WINDOW steers to the same
  // child within any rolling STEER_RATE_WINDOW_MS window. Both are checked
  // BEFORE the steer is ever appended to the parent's journal (Review
  // Focus: "...must be rejected before recipient state changes").
  async _enforceSteerLimits(parentTaskId, childTaskId) {
    const pendingFromParent = await this._mailbox.listPending({ senderTaskId: parentTaskId, recipientTaskId: childTaskId });
    const unobservedSteers = pendingFromParent.filter((m) => m.kind === "steer");
    if (unobservedSteers.length >= contracts.MAX_UNOBSERVED_STEER_PER_CHILD) {
      throw new ChildAgentCoordinatorError("pending_steer_exists", "child already has an unobserved steer message");
    }

    const parentStore = this._activeStores.get(parentTaskId);
    if (!parentStore) {
      throw new ChildAgentCoordinatorError("task_unavailable", `task store unavailable for ${parentTaskId}`);
    }
    const events = await readAllEvents(parentStore);
    const nowMs = typeof this._now === "function" ? this._now() : Date.now();
    const windowStart = nowMs - contracts.STEER_RATE_WINDOW_MS;
    const recentSteers = events.filter(
      (e) =>
        e.type === "message_sent" &&
        e.payload.kind === "steer" &&
        e.payload.recipientTaskId === childTaskId &&
        Date.parse(e.at) >= windowStart,
    );
    if (recentSteers.length >= contracts.MAX_STEER_PER_CHILD_PER_WINDOW) {
      throw new ChildAgentCoordinatorError("steer_rate_limit", "too many steer messages to this child in the last rolling window");
    }
  }

  // Aggregated, relationship-authorized pending messages FOR recipientTaskId
  // -- a child's only possible sender is its own parent; a parent's pending
  // messages are aggregated across every one of its accepted children, in
  // assignment order (each child's own messages stay in that child's
  // journal order). Never trusts a caller-supplied sender: this is exactly
  // the "listPending caller authorization belongs in coordinator" boundary.
  async listPendingMessages(recipientTaskId) {
    const parentOfRecipient = this._childParent.get(recipientTaskId);
    if (parentOfRecipient) {
      return this._mailbox.listPending({ senderTaskId: parentOfRecipient, recipientTaskId });
    }
    const plan = await this._resolveActivePlan(recipientTaskId);
    if (!plan || plan.state === "cancelled") return [];
    const results = [];
    for (const childId of plan.childIds) {
      const fromChild = await this._mailbox.listPending({ senderTaskId: childId, recipientTaskId });
      results.push(...fromChild);
    }
    return results;
  }

  // Thin pass-through: MessageMailbox.recordConsumed() already validates
  // every ID is genuinely pending for this recipient against durable
  // journals and fails closed on any append error -- the caller (Task
  // Controller) is the one that must not process that turn's proposal when
  // this throws.
  async recordMessagesConsumed(recipientTaskId, consumedMessageIds, observedAtPlannerCall) {
    try {
      return await this._mailbox.recordConsumed(recipientTaskId, consumedMessageIds, observedAtPlannerCall);
    } catch (err) {
      if (err instanceof MessageMailboxError) throw new ChildAgentCoordinatorError(err.code, err.message);
      throw err;
    }
  }

  async _cleanupChildren(parentTaskId, childIds) {
    for (const childId of childIds) {
      try {
        await TaskStore.removeChild(childId, { storageRoot: this._storageRoot, parentTaskId });
      } catch {
        // Best-effort only: this already runs on a failure path, and a
        // leftover child directory here is inert (structurally invisible to
        // every top-level API) rather than unsafe.
      }
    }
  }
}

module.exports = { ChildAgentCoordinator, ChildAgentCoordinatorError };
