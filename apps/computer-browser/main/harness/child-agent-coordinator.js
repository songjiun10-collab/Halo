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
const { TeamBoardStore, BOARD_KINDS, MAX_BOARD_TEXT_CHARS } = require("./team-board-store");

// Team board (see readTeamBoard): newest entries a sibling's context and the
// renderer's plan summary carry.
const BOARD_CONTEXT_ENTRIES = 12;
const BOARD_SUMMARY_ENTRIES = 20;

// A handoff's structured summary as one bounded line of board text.
function handoffText(handoff) {
  const parts = [`${handoff.objective}: ${handoff.currentState}`];
  for (const result of handoff.verifiedResults ?? []) parts.push(`result: ${result.text}`);
  if (handoff.unresolved?.length) parts.push(`unresolved: ${handoff.unresolved.join("; ")}`);
  if (handoff.risks?.length) parts.push(`risks: ${handoff.risks.join("; ")}`);
  if (handoff.suggestedNextAction) parts.push(`next: ${handoff.suggestedNextAction}`);
  return parts.join(" | ");
}

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

// A live child's controller state as the renderer's ChildAgentStatus.
function liveSummaryStatus(state) {
  if (state === "awaiting_approval") return "waiting_for_review";
  if (state === "paused") return "paused";
  return "running";
}

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
    onPlanChange,
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
    // A value, or a function resolved as each child starts so a host settings
    // change reaches children created afterwards.
    this._plannerEffort = plannerEffort;
    this._reserveBytesPerChild = reserveBytesPerChild;
    // Optional display hook: called with a parentTaskId whenever a child's
    // summary status may have changed (see getPlanSummary).
    this._onPlanChange = typeof onPlanChange === "function" ? onPlanChange : null;
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
    // childId -> teardown promise for children removed from _liveChildren
    // but whose owned resources have not all finished retiring yet.
    this._retiringChildren = new Map();
    // Parent plans being cancelled must not admit queued siblings during the
    // asynchronous child-drain window.
    this._cancellingPlans = new Set();
    // childId -> { outcome: "completed"|"stopped"|"failed", reason? }
    this._terminalChildren = new Map();
    // A failed start whose teardown itself failed keeps its lease reserved.
    // This is intentionally fail-closed: releasing it could admit another
    // child while the first one's browser/planner/store may still be alive.
    this._failedStartLeases = new Map();
    // Tracks child starts before they enter _liveChildren so shutdown can
    // account for an attach blocked in initial navigation or resume.
    this._startingChildren = new Map();
    // Once the owning TaskHost shuts down, child plans remain durable/queued
    // but this coordinator must not admit more work. A fresh host can recover
    // them through scheduleAdmission() after the parent is explicitly resumed.
    this._shuttingDown = false;
    this._shutdownPromise = null;
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
    this._board = new TeamBoardStore({ storageRoot });
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

  _childPlannerEffort() {
    return typeof this._plannerEffort === "function" ? this._plannerEffort() : this._plannerEffort;
  }

  shutdown() {
    this._shuttingDown = true;
    if (this._shutdownPromise) return this._shutdownPromise;
    const attempt = (async () => {
      const errors = [];
      const startsAtShutdown = [...this._startingChildren.values()];
      await Promise.all(startsAtShutdown.map((start) => start.ready));
      const retiringAtStart = [...this._retiringChildren.entries()];
      for (const [childId, live] of [...this._liveChildren]) {
        try {
          // Host shutdown pauses child journals instead of marking the
          // assignments terminal; the next host can resume the accepted plan.
          await live.controller.takeOver("host_shutdown");
          live.unsubscribe?.();
          if (this._liveChildren.get(childId) === live) this._liveChildren.delete(childId);
          const retirement = {
            parentTaskId: live.parentTaskId,
            live,
            terminalOutcome: null,
            pending: [
              { key: "mcp", run: () => live.controller.closeMcp() },
              { key: "planner", run: () => live.planner.close?.() },
              { key: "browser", run: () => live.browser.dispose?.() },
              { key: "store", run: () => live.store.close() },
            ],
            promise: null,
          };
          this._retiringChildren.set(childId, retirement);
          await this._runChildRetirement(retirement);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const [childId, retirement] of retiringAtStart) {
        try { await this._runChildRetirement(retirement); }
        catch (error) { errors.push(error); }
      }
      for (const [childId, failedStart] of [...this._failedStartLeases]) {
        try { await this._retryFailedStartCleanup(childId, failedStart); }
        catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, "one or more child resources failed to pause for host shutdown");
    })();
    this._shutdownPromise = attempt;
    attempt.catch(() => {
      if (this._shutdownPromise === attempt) this._shutdownPromise = null;
    });
    return attempt;
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
    if (!["multi_agent", "multi_agent_computer_use"].includes(parentStore.taskProfile?.capability?.id)) {
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

    // A parent may mark an assignment for Docker execution, but the current
    // host has no isolated planner/container runtime yet. Reject the plan
    // before creating child stores; never silently downgrade that request to
    // an ordinary host child.
    if (validated.assignments.some((assignment) => assignment.execution === "docker")) {
      throw new ChildAgentCoordinatorError(
        "isolation_unavailable",
        "this host does not have the Docker-isolated child runtime enabled",
      );
    }

    // The parent's Intent Lock binds its children too: a plan may not send a
    // child to an entry the parent itself could not navigate to, and every
    // child inherits the lock (its controller hands it to the child browser).
    const parentLock = currentGoal.lock ?? null;
    for (const a of validated.assignments) {
      const verdict = contracts.evaluateLock(parentLock, { action: "navigate", targetOrigin: contracts.deriveOrigin(a.entryUrl) });
      if (!verdict.allowed) {
        throw new ChildAgentCoordinatorError("intent_lock_denied", `child entryUrl is denied by the parent's Intent Lock (${verdict.reason})`);
      }
    }
    const childGoalInput = (subgoal) => (parentLock ? { originalRequest: subgoal, lock: { rules: parentLock.rules } } : { originalRequest: subgoal });

    const planId = crypto.randomUUID();
    const createdChildIds = [];
    let assignments;
    try {
      assignments = [];
      for (const a of validated.assignments) {
        const childId = crypto.randomUUID();
        const origin = contracts.deriveOrigin(a.entryUrl);
        const childProfile = resolveTaskProfile({
          goalInput: childGoalInput(a.subgoal),
          parentProfile: parentStore.taskProfile,
          parentBinding: { parentTaskId, planId, parentGoalVersion: validated.parentGoalVersion },
        });
        const childStore = await TaskStore.createChild(
          childGoalInput(a.subgoal),
          { storageRoot: this._storageRoot, parentTaskId, childId, resolvedProfile: childProfile },
        );
        await childStore.close();
        createdChildIds.push(childId);
        assignments.push({ childId, subgoal: a.subgoal, entryUrl: a.entryUrl, origin, execution: a.execution ?? "host" });
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
          assignments: assignments.map(({ childId, subgoal, entryUrl, origin, execution }) => ({ childId, subgoal, entryUrl, origin, execution })),
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
    this._notifyPlanChange(parentTaskId);
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
    return plan.assignments.map(({ childId, subgoal, entryUrl, origin, execution }) => ({
      childId,
      subgoal,
      entryUrl,
      origin,
      execution: execution ?? "host",
      state: this._childState(childId),
    }));
  }

  // The renderer's ChildPlanSummary (frontend/src/session/child-agents.ts),
  // built from the same parent-authored plan as listChildren(). null when
  // there is no plan or it was cancelled. evidenceCount stays 0: this
  // coordinator never reads a child's own journal for display.
  async getPlanSummary(parentTaskId) {
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return null;
    const agents = plan.assignments.map(({ childId, origin, subgoal }) => {
      const terminal = this._terminalChildren.get(childId);
      return {
        agentId: childId,
        status: this._liveChildren.get(childId)?.summaryStatus ?? this._childState(childId),
        assignedOrigin: origin,
        evidenceCount: 0,
        // The parent-authored label, so the UI names a child by its job, not its UUID.
        ...(typeof subgoal === "string" && subgoal ? { subgoal: subgoal.slice(0, 200) } : {}),
        ...(terminal?.reason ? { reason: terminal.reason } : {}),
      };
    });
    const count = (status) => agents.filter((agent) => agent.status === status).length;
    const board = (await this._planBoard(parentTaskId, plan)).slice(-BOARD_SUMMARY_ENTRIES)
      .map((entry) => ({ entryId: entry.entryId, agentId: entry.childTaskId, kind: entry.kind, text: entry.text, at: entry.at }));
    return {
      requestedAgentCount: agents.length,
      activeAgentCount: count("running") + count("waiting_for_review") + count("paused"),
      queuedAgentCount: count("queued"),
      parentGoalVersion: plan.parentGoalVersion,
      memoryPolicy: plan.memoryPolicy,
      // The current host can only admit ordinary workers. Do not offer Docker
      // selection to the parent planner until the isolated runtime and its
      // provider broker are actually wired and available.
      executionModes: ["host"],
      agents,
      ...(board.length ? { board } : {}),
    };
  }

  _notifyPlanChange(parentTaskId) {
    if (!this._onPlanChange) return;
    try {
      this._onPlanChange(parentTaskId);
    } catch {
      // A display observer never affects child lifecycle.
    }
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
    this._cancellingPlans.add(parentTaskId);

    const startsInPlan = [...this._startingChildren.values()]
      .filter((start) => start.parentTaskId === parentTaskId);
    await Promise.all(startsInPlan.map((start) => start.ready));

    // Drain every live or already-retiring child BEFORE recording the
    // cancellation. Controller.stop() emits a terminal snapshot before its
    // observer's asynchronous teardown has completed, so joining stop() alone
    // is not enough to guarantee that the child's view/store/lease are gone.
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
      let retirement = live.retirement || this._retiringChildren.get(childId)?.promise;
      const snapshot = live.controller.getSnapshot();
      if (!retirement && this._liveChildren.has(childId) && ["completed", "stopped"].includes(snapshot.state)) {
        // The controller may already have emitted its terminal change before
        // cancelPlan attached to the observer's retirement promise. Reconcile
        // from the controller's own trusted snapshot rather than treating an
        // absent observer promise as proof that teardown completed.
        retirement = this._retireChild(parentTaskId, childId, snapshot.state);
      }
      if (retirement) await retirement;
      else if (this._liveChildren.has(childId)) {
        throw new ChildAgentCoordinatorError("child_stop_failed", `child ${childId} remains live after stop was requested`);
      }
    }
    const alreadyRetiring = [...this._retiringChildren.entries()]
      .filter(([, retirement]) => retirement.parentTaskId === parentTaskId)
      .map(([, retirement]) => this._runChildRetirement(retirement));
    for (const retirement of alreadyRetiring) {
      await retirement;
    }

    // A start rollback may have failed after removing the child from the live
    // map. Retry the exact failed close operations before recording cancel.
    for (const [childId, failedStart] of [...this._failedStartLeases]) {
      if (failedStart.parentTaskId === parentTaskId) await this._retryFailedStartCleanup(childId, failedStart);
    }

    await parentStore.append({
      type: "child_plan_cancelled",
      payload: { planId: plan.planId, reason },
    });
    this._plans.set(parentTaskId, { ...plan, state: "cancelled" });
    this._cancellingPlans.delete(parentTaskId);
    this._notifyPlanChange(parentTaskId);
  }

  _retryFailedStartCleanup(childId, failedStart) {
    if (failedStart.promise) return failedStart.promise;
    const attempt = (async () => {
      const errors = [];
      for (const operation of failedStart.pending) {
        try {
          await operation.run();
          failedStart.pending = failedStart.pending.filter((pending) => pending !== operation);
        } catch (error) {
          errors.push({ key: operation.key, error });
        }
      }
      if (failedStart.pending.length > 0) {
        const failure = new AggregateError(errors.map((item) => item.error), "child start cleanup failed; ownership remains reserved", {
          cause: errors[0]?.error,
        });
        failure.code = "child_start_cleanup_failed";
        failure.cleanupErrors = errors.map(({ key, error }) => ({ key, message: error?.message || String(error) }));
        throw failure;
      }
      const resourceAdmission = this._getResourceAdmission && this._getResourceAdmission();
      if (!resourceAdmission || typeof resourceAdmission.release !== "function") {
        const failure = new Error("resource admission is unavailable; child lease remains reserved");
        failure.code = "child_start_cleanup_failed";
        throw failure;
      }
      await resourceAdmission.release(failedStart.leaseId);
      this._failedStartLeases.delete(childId);
      const terminal = this._terminalChildren.get(childId);
      if (terminal?.reason === "child_start_cleanup_failed") {
        this._terminalChildren.set(childId, { outcome: "failed", reason: "child_start_failed" });
        this._notifyPlanChange(failedStart.parentTaskId);
      }
    })();
    failedStart.promise = attempt;
    attempt.catch(() => {}).finally(() => {
      if (failedStart.promise === attempt) failedStart.promise = null;
    });
    return attempt;
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
      assignments.push({ childId: a.childId, subgoal: a.subgoal, entryUrl: a.entryUrl, origin: a.origin, execution: a.execution ?? "host" });
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
    if (this._shuttingDown || this._cancellingPlans.has(parentTaskId)) return;
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled" || this._shuttingDown || this._cancellingPlans.has(parentTaskId)) return;
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
  startChild(childId) {
    if (this._shuttingDown) return Promise.resolve({ started: false, reason: "host_shutting_down" });
    const parentTaskId = this._childParent.get(childId);
    if (parentTaskId && this._cancellingPlans.has(parentTaskId)) {
      return Promise.resolve({ started: false, reason: "plan_cancelling" });
    }
    const current = this._startingChildren.get(childId);
    if (current) return current.promise;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const start = { parentTaskId, ready, resolveReady, promise: null };
    const promise = this._startChild(childId, start);
    start.promise = promise;
    this._startingChildren.set(childId, start);
    promise.then(resolveReady, resolveReady).then(() => {
      if (this._startingChildren.get(childId) === start) this._startingChildren.delete(childId);
    });
    return promise;
  }

  async _startChild(childId, start) {
    const parentTaskId = this._childParent.get(childId);
    if (!parentTaskId) return { started: false, reason: "unknown_child" };
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return { started: false, reason: "plan_cancelled" };
    if (this._shuttingDown) return { started: false, reason: "host_shutting_down" };
    if (this._cancellingPlans.has(parentTaskId)) return { started: false, reason: "plan_cancelling" };
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
      this._notifyPlanChange(parentTaskId);
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

    if (this._shuttingDown || this._cancellingPlans.has(parentTaskId)) {
      await resourceAdmission.release(lease.leaseId);
      return { started: false, reason: this._shuttingDown ? "host_shutting_down" : "plan_cancelling" };
    }

    try {
      await this._attachChild(parentTaskId, assignment, lease.leaseId, plan, start);
    } catch (error) {
      if (error.cleanupComplete === false) {
        this._failedStartLeases.set(childId, {
          parentTaskId,
          leaseId: lease.leaseId,
          pending: error.cleanupPending || [],
          promise: null,
        });
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
  async _attachChild(parentTaskId, assignment, leaseId, plan, start = null) {
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
              && ["short", "middle", "long"].indexOf(childProfile.duration.id === "fast" ? "short" : childProfile.duration.id) > ["short", "middle", "long"].indexOf(parentProfile.duration.id === "fast" ? "short" : parentProfile.duration.id)) {
          throw new ChildAgentCoordinatorError("profile_binding_invalid", "child profile is not bound to the accepted parent plan or exceeds its horizon");
        }
      }
      // The trusted entry navigation below bypasses the adapter's lock (it is
      // the user path), so the child's own inherited lock is checked here,
      // which also covers plans reconstructed from the journal.
      const entryVerdict = contracts.evaluateLock(childStore.getGoal().lock ?? null, { action: "navigate", targetOrigin: contracts.deriveOrigin(entryUrl) });
      if (!entryVerdict.allowed) {
        throw new ChildAgentCoordinatorError("intent_lock_denied", `child entryUrl is denied by its Intent Lock (${entryVerdict.reason})`);
      }
      browser = this._makeChildBrowser(parentTaskId, childId, origin, assignment.execution ?? "host");
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
        // No person can answer a child's approval queue (children are not
        // TaskHost tasks), so a child never waits for one: a mode-denied
        // action is skipped as before instead of widened, and a review is
        // denied and journaled rather than left stuck.
        reviewFallback: "deny",
        harnessProfile: childStore.taskProfile?.duration?.id || "middle",
        plannerEffort: this._childPlannerEffort(),
        now: this._now,
        segmentRotationCalls: this._segmentRotationCalls,
        noProgressThreshold: this._noProgressThreshold,
        // Subagent communication protocol Task 4: this coordinator is the
        // relationship/quota authority for every message this child sends or
        // receives -- the child's own controller only ever calls back here.
        sendMessage: (validated) => this.handleSendMessage(childId, validated),
        listPendingMessages: () => this.listPendingMessages(childId),
        recordMessagesConsumed: (ids, plannerCall) => this.recordMessagesConsumed(childId, ids, plannerCall),
        readTeamBoard: () => this.readTeamBoard(childId),
      });

      live = { controller, browser, planner, store: childStore, leaseId, origin, parentTaskId };
      this._liveChildren.set(childId, live);
      live.summaryStatus = "running";
      this._notifyPlanChange(parentTaskId);
      live.unsubscribe = controller.onChange((snapshot) => {
        const summaryStatus = liveSummaryStatus(snapshot.state);
        if (summaryStatus !== live.summaryStatus) {
          live.summaryStatus = summaryStatus;
          this._notifyPlanChange(parentTaskId);
        }
        if (snapshot.state === "completed" || snapshot.state === "stopped") {
          live.unsubscribe?.();
          live.retirement = this._retireChild(parentTaskId, childId, snapshot.state);
          live.retirement.catch(() => {});
        }
      });
      start?.resolveReady();
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
      const cleanupPending = [];
      const attemptTeardown = async (key, operation) => {
        try {
          await operation();
        } catch (teardownError) {
          teardown.push(teardownError);
          cleanupPending.push({ key, run: operation });
        }
      };
      // Keep order: stop/drain controller writes before closing its journal;
      // then release the view and worker before releasing the store lock.
      if (controller) await attemptTeardown("controller", () => controller.stop());
      if (browser) await attemptTeardown("browser", () => browser.dispose?.());
      if (planner) await attemptTeardown("planner", () => planner.close?.());
      if (childStore) await attemptTeardown("store", () => childStore.close());
      const cleanupComplete = teardown.length === 0 || teardown.every((failure) => failure === null);
      this._terminalChildren.set(childId, {
        outcome: "failed",
        reason: cleanupComplete ? "child_start_failed" : "child_start_cleanup_failed",
      });
      this._notifyPlanChange(parentTaskId);
      // startChild() returns the lease only when teardown completed. If a
      // disposer/close failed, keep capacity reserved and surface the
      // original attach error without losing that fail-closed state.
      attachError.cleanupComplete = cleanupComplete;
      if (!cleanupComplete) {
        attachError.cleanupErrors = teardown.map((failure) => failure?.message || String(failure));
        attachError.cleanupPending = cleanupPending;
      }
      throw attachError;
    }
  }

  // Tears down a finished child's OWNED resources (view/adapter via
  // browser.dispose(), its TaskStore handle) and releases its resource
  // lease, then re-attempts scheduling for the same parent -- a same-origin
  // sibling that was serialized behind this one, or any other queued
  // assignment now unblocked by the freed lease, gets another chance here.
  _retireChild(parentTaskId, childId, controllerState) {
    const existing = this._retiringChildren.get(childId);
    if (existing) return this._runChildRetirement(existing);
    const live = this._liveChildren.get(childId);
    if (!live) return Promise.resolve();
    this._liveChildren.delete(childId);
    this._terminalChildren.set(childId, { outcome: controllerState === "completed" ? "completed" : "stopped" });
    this._notifyPlanChange(parentTaskId);
    const retirement = {
      parentTaskId,
      live,
      terminalOutcome: controllerState === "completed" ? "completed" : "stopped",
      pending: [
        { key: "mcp", run: () => live.controller.closeMcp() },
        { key: "planner", run: () => live.planner.close?.() },
        { key: "browser", run: () => live.browser.dispose?.() },
        { key: "store", run: () => live.store.close() },
      ],
      promise: null,
    };
    this._retiringChildren.set(childId, retirement);
    return this._runChildRetirement(retirement);
  }

  _runChildRetirement(retirement) {
    if (retirement.promise) return retirement.promise;
    const attempt = (async () => {
      const errors = [];
      // Attempt every resource close, retaining only the operations that
      // failed. The resource lease is deliberately last: a live view/worker
      // must never lose its reservation or admit a sibling after teardown
      // failure.
      for (const operation of retirement.pending) {
        try {
          await operation.run();
          retirement.pending = retirement.pending.filter((pending) => pending !== operation);
        } catch (error) {
          errors.push({ key: operation.key, error });
        }
      }
      if (retirement.pending.length > 0) {
        this._terminalChildren.set(retirement.live.store.taskId, { outcome: "failed", reason: "child_retirement_failed" });
        this._notifyPlanChange(retirement.parentTaskId);
        const failure = new AggregateError(errors.map((item) => item.error), "child resource retirement failed; ownership remains reserved", {
          cause: errors[0]?.error,
        });
        failure.code = "child_retirement_failed";
        failure.cleanupErrors = errors.map(({ key, error }) => ({ key, message: error?.message || String(error) }));
        throw failure;
      }

      const resourceAdmission = this._getResourceAdmission && this._getResourceAdmission();
      try {
        if (!resourceAdmission || typeof resourceAdmission.release !== "function") {
          throw new Error("resource admission is unavailable; child lease remains reserved");
        }
        await resourceAdmission.release(retirement.live.leaseId);
      } catch (error) {
        this._terminalChildren.set(retirement.live.store.taskId, { outcome: "failed", reason: "child_retirement_failed" });
        this._notifyPlanChange(retirement.parentTaskId);
        const failure = new AggregateError([error], "child resource lease release failed; ownership remains reserved", { cause: error });
        failure.code = "child_retirement_failed";
        throw failure;
      }
      const { parentTaskId, live } = retirement;
      if (this._retiringChildren.get(live.store.taskId) === retirement) {
        this._retiringChildren.delete(live.store.taskId);
      }
      if (retirement.terminalOutcome) {
        this._terminalChildren.set(live.store.taskId, { outcome: retirement.terminalOutcome });
      } else {
        this._terminalChildren.delete(live.store.taskId);
      }
      this._notifyPlanChange(parentTaskId);
      if (!this._shuttingDown) await this.scheduleAdmission(parentTaskId).catch(() => {});
    })();
    retirement.promise = attempt;
    attempt.then(
      () => { if (retirement.promise === attempt) retirement.promise = null; },
      () => { if (retirement.promise === attempt) retirement.promise = null; },
    );
    return attempt;
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
      const sent = await this._mailbox.send(envelope);
      if (senderTaskId === childTaskId) await this._postToBoard(parentTaskId, plan, envelope, sent);
      return sent;
    } catch (err) {
      if (err instanceof MessageMailboxError) throw new ChildAgentCoordinatorError(err.code, err.message);
      throw err;
    }
  }

  // A child's progress/evidence/handoff to its parent is also posted to the
  // plan's board, keyed by the message id so a resend is posted once. The
  // board is advisory: a failed post never fails the message.
  async _postToBoard(parentTaskId, plan, envelope, sent) {
    if (!BOARD_KINDS.includes(envelope.kind) || typeof sent?.messageId !== "string") return;
    const text = (envelope.kind === "handoff" ? handoffText(envelope.handoff) : envelope.text ?? "").trim();
    if (!text) return;
    await this._board.post(parentTaskId, {
      entryId: sent.messageId,
      parentGoalVersion: plan.parentGoalVersion ?? 1,
      childTaskId: envelope.childTaskId,
      kind: envelope.kind,
      text: text.slice(0, MAX_BOARD_TEXT_CHARS),
      at: new Date(typeof this._now === "function" ? this._now() : Date.now()).toISOString(),
    }).catch(() => {});
  }

  // Board entries of the parent's active plan: its current goal version and
  // its accepted children only. [] for no or a cancelled plan.
  async _planBoard(parentTaskId, plan) {
    if (!plan || plan.state === "cancelled") return [];
    const version = plan.parentGoalVersion ?? 1;
    const entries = await this._board.read(parentTaskId).catch(() => []);
    return entries.filter((entry) => entry.parentGoalVersion === version && plan.childIds.includes(entry.childTaskId));
  }

  // What a CHILD reads of its siblings' posts, as untrusted notes named by
  // each sibling's parent-authored subgoal. null for anything not a child of
  // an active plan (a parent already receives these as messages).
  async readTeamBoard(childTaskId) {
    const parentTaskId = this._childParent.get(childTaskId);
    if (!parentTaskId) return null;
    const plan = await this._resolveActivePlan(parentTaskId);
    if (!plan || plan.state === "cancelled") return null;
    const labels = new Map((plan.assignments ?? []).map((a, i) => [a.childId, (typeof a.subgoal === "string" && a.subgoal ? a.subgoal : `Agent ${i + 1}`).slice(0, 80)]));
    const entries = (await this._planBoard(parentTaskId, plan))
      .filter((entry) => entry.childTaskId !== childTaskId)
      .slice(-BOARD_CONTEXT_ENTRIES)
      .map((entry) => ({ from: labels.get(entry.childTaskId) ?? "Agent", kind: entry.kind, text: entry.text, at: entry.at }));
    return { authority: "untrusted_sibling_notes", parentTaskId, entries };
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
