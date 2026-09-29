"use strict";

// The long-running task state machine (design doc sections 5-7): drives
// observe -> plan -> approve -> execute -> verify -> checkpoint, one action
// dispatch at a time, rebuilding the planner's entire context from durable
// state every call (never from an in-process transcript) so the goal
// survives any number of context resets. Every dependency is injected --
// store (Task 1), planner (Task 3's PlannerStdioAdapter or a fake/scripted
// one), browser (Task 4's real adapter or a fake), approve (Task 4's real
// approver client or a fake), hostVerifier (progress.js's deterministic
// verifier), memoryMonitor (Task 5's real one or a no-op) -- so this file
// has no direct dependency on Electron, a real approver process, or a real
// model.
//
// Memory discipline (design doc section 10): the only state held in memory
// here is the current goal, a small progress/budget summary, and a bounded
// no-progress-detection window -- never the full action/observation
// history (that lives in the durable journal, read back only in small
// bounded slices via context-builder.js).

const { randomUUID } = require("node:crypto");
const contracts = require("../../shared/harness-contracts");
const { validateHarnessProfile, selectHarnessProfile, maxActionsPerProposal } = require("../../shared/harness-profile");
const { buildContext } = require("./context-builder");
const { validateProposal, verifyCriterion, canComplete } = require("./progress");
const { isReadOnlyAction } = require("./permission-policy");

class TaskControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskControllerError";
    this.code = code;
  }
}

const NOOP_MEMORY_MONITOR = { getPressureLevel: () => "normal" };

// A human (or the policy approver's secret scanner) reviewing an approval
// request needs to see WHAT the action targets, not just its type and the
// page it was proposed from -- otherwise a navigate/follow_link/scroll is
// approved blind. Only derived from the host's own last observation, never
// from planner-supplied free text.
function describeActionTarget(action, lastObservation) {
  if (action.type === "navigate") {
    return typeof action.url === "string" ? action.url : null;
  }
  if (action.type === "follow_link") {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    if (element && typeof element.href === "string") return element.href;
    return typeof action.elementId === "string" ? `element ${action.elementId}` : null;
  }
  if (action.type === "scroll") {
    const direction = typeof action.direction === "string" ? action.direction : "?";
    const amount = action.amount !== undefined ? String(action.amount) : "?";
    return `${direction} ${amount}`;
  }
  return null;
}

function observationKey(observation) {
  // A comparison key for no-progress detection, not a cryptographic hash --
  // it only needs to be deterministic and cheap to compare. The real
  // BrowserAdapter stamps every observation with a fresh random `id`
  // (_randomId()), so that field must be excluded here -- otherwise no two
  // observations of the identical page would ever compare equal and the
  // no-progress safety net would never fire against a real browser.
  if (!observation || typeof observation !== "object") return String(observation);
  const { id, ...rest } = observation;
  try {
    return JSON.stringify(rest);
  } catch {
    return String(observation);
  }
}

class TaskController {
  constructor({
    store,
    planner,
    browser,
    approve,
    hostVerifier,
    memoryMonitor,
    now,
    segmentRotationCalls,
    noProgressThreshold,
    memoryStore,
    permissionMode = "browse",
    plannerEffort = "medium",
    onChildPlan,
    sendMessage,
    listPendingMessages,
    recordMessagesConsumed,
    routineRunner,
    routineRun,
    batchReadOnlyActions = true,
    harnessProfile,
  } = {}) {
    if (!store) throw new TaskControllerError("invalid_config", "store is required");
    if (!planner) throw new TaskControllerError("invalid_config", "planner is required");
    if (!browser) throw new TaskControllerError("invalid_config", "browser is required");
    if (!approve) throw new TaskControllerError("invalid_config", "approve is required");
    if (!hostVerifier) throw new TaskControllerError("invalid_config", "hostVerifier is required");

    this._store = store;
    this._planner = planner;
    this._routineRunner = routineRunner || null;
    this._batchReadOnlyActions = batchReadOnlyActions !== false;
    const checkpointedRoutineRun = store.lastCheckpoint?.payload?.routineRun;
    this._routineRun = checkpointedRoutineRun ? { ...checkpointedRoutineRun } : routineRun ? { ...routineRun } : null;
    if (this._routineRunner && (!this._routineRun ||
        typeof this._routineRun.routineId !== "string" ||
        !Number.isInteger(this._routineRun.revision) ||
        typeof this._routineRun.digest !== "string" ||
        !Number.isInteger(this._routineRun.cursor) || this._routineRun.cursor < 0)) {
      throw new TaskControllerError("invalid_routine", "routine runner requires a pinned routine ID, revision, digest, and cursor");
    }
    // Harness v2 Phase 2 Task 1 (see docs/superpowers/plans/2026-09-29-harness-profiles-v2-phase2.md):
    // the host is the profile-selection authority (selectHarnessProfile() in
    // TaskHost/_attach), never the model or the task's own text -- this
    // constructor only validates and stores what it is given, defaulting via
    // the same pure rule when the caller omits it (e.g. a directly
    // constructed test controller). Nothing yet reads _harnessProfile to
    // change execution behavior; that starts in a later Phase 2 task.
    this._harnessProfile = validateHarnessProfile(
      harnessProfile !== undefined ? harnessProfile : selectHarnessProfile({ isRoutine: this._routineRun !== null }),
    );
    this._browser = browser;
    this._approve = approve;
    this._hostVerifier = hostVerifier;
    // Multi-agent background runtime plan, Task 4: only a PARENT controller
    // is ever constructed with this -- a child controller (built exclusively
    // by ChildAgentCoordinator._attachChild) never receives it, so a
    // child_plan proposal reaching a child's own loop (which should already
    // be impossible -- its PlannerStdioAdapter's role:"child" rejects that
    // proposal kind at the wire boundary) has no delegation path here either.
    // No nested child agents (Global Constraints): a child controller can
    // never itself accept a child_plan.
    this._onChildPlan = typeof onChildPlan === "function" ? onChildPlan : null;
    // Subagent communication protocol Task 4: host-derived envelope/relation-
    // ship authority lives in ChildAgentCoordinator (task-host.js/child-
    // agent-coordinator.js wire these), never here -- this controller only
    // knows how to fetch its own pending messages, ask the planner, and
    // durably acknowledge what it admitted, symmetrically for a parent's own
    // top-level controller and a child's controller.
    this._sendMessage = typeof sendMessage === "function" ? sendMessage : null;
    this._listPendingMessages = typeof listPendingMessages === "function" ? listPendingMessages : null;
    this._recordMessagesConsumed = typeof recordMessagesConsumed === "function" ? recordMessagesConsumed : null;
    this._memoryMonitor = memoryMonitor || NOOP_MEMORY_MONITOR;
    this._memoryStore = memoryStore || null;
    const { PERMISSION_MODES, evaluateActionPolicy } = require("./permission-policy");
    if (!PERMISSION_MODES.includes(permissionMode)) throw new TaskControllerError("invalid_config", "permissionMode is invalid");
    this._permissionMode = permissionMode;
    this._plannerEffort = plannerEffort;
    this._evaluateActionPolicy = evaluateActionPolicy;
    this._browser.setPermissionMode?.(permissionMode);
    this._now = typeof now === "function" ? now : Date.now;
    this._segmentRotationCalls =
      typeof segmentRotationCalls === "number" ? segmentRotationCalls : contracts.SEGMENT_ROTATION_CALLS;
    this._noProgressThreshold =
      typeof noProgressThreshold === "number" ? noProgressThreshold : contracts.NO_PROGRESS_REPLAN_THRESHOLD;

    this._goal = store.getGoal();
    this._epoch = 0;
    this._loopRunning = false;
    this._listeners = new Set();
    this._lastEmittedSnapshot = null;
    this._pendingCheckpoints = 0;
    this._snapshotTrusted = true;

    // Transition admission gate (2026-09-27 concurrent-takeover fix): every
    // externally-invoked mutator (approve/deny/amend/confirmCriterion) must
    // synchronously see this closed the instant pause()/stop()/takeOver() is
    // CALLED -- not once its queued _doTransition eventually runs, since
    // _enqueueTransition defers via Promise.then and a synchronous caller
    // could otherwise slip an approve() through the gap. _admissionOpen is
    // therefore set to false synchronously inside pause()/stop()/takeOver()
    // themselves, and only ever reopened at the tail of _doTransition, after
    // its checkpoint durably succeeds, and only when no further transition
    // is still queued behind it (see _pendingTransitions).
    this._admissionOpen = true;
    this._pendingTransitions = 0;
    this._transitionChain = Promise.resolve();
    // Every admitted mutating operation that can independently touch the
    // durable journal outside the loop's own iteration -- approve()'s own
    // dispatch AND the loop's own internal dispatch inside
    // _dispatchActionsBatch -- registers its promise here so a transition's
    // drain step waits for its TRUE outcome before checkpointing, rather
    // than racing it (see _dispatchApprovedTracked).
    this._inFlightOps = new Set();

    this._budgets = { actionsUsed: 0, plannerCallsUsed: 0, activeMs: 0 };
    this._activeSince = null;
    this._segment = { index: 0, callsInSegment: 0 };
    this._criteriaStatus = new Map(); // criterionId -> {status, evidenceId}
    this._noProgress = { lastKey: null, consecutive: 0, hasReplannedOnce: false };
    this._approvalQueue = [];
    this._lastObservation = null;
    // Harness v2 Phase 2 Task 4: an already-captured Observation from the
    // most recently dispatched action, reusable ONLY when that action was
    // itself an "observe" (a real snapshot, not a guess) and the browser's
    // own document epoch still matches it (see its use at the top of the
    // main loop). Cleared on any other dispatched action so a stale
    // reference is never carried past something that could have changed
    // the page.
    this._reusableObservation = null;

    // A task that already reached a TERMINAL state (completed/stopped) was
    // checkpointed synchronously the instant it got there (see the
    // "completed" transition below and confirmCriterion()), so the last
    // checkpoint is authoritative and must win over recoveryReason --
    // otherwise every reload (2026-09-27 follow-up, found while verifying
    // the real-Electron 3-page journey) reports an already-finished task as
    // plain "paused"/"recovered", indistinguishable from one merely
    // interrupted mid-flight. That is not just a mislabel: resume() accepts
    // any "paused" state unconditionally, so a caller correctly following
    // the paused->resume() protocol would re-invoke the planner/browser on
    // a task that has nothing left to do. Only completed/stopped are
    // restored this way -- awaiting_verification is intentionally left to
    // the existing recovered/execution_uncertain derivation below (deciding
    // how confirmCriterion() should interact with a peeked, not-yet-
    // attached awaiting_verification task is a separate, broader question,
    // not addressed here).
    const checkpointedTask = store.lastCheckpoint && store.lastCheckpoint.payload && store.lastCheckpoint.payload.task;
    if (checkpointedTask && (checkpointedTask.state === "completed" || checkpointedTask.state === "stopped")) {
      this._task = { state: checkpointedTask.state, pauseReason: checkpointedTask.pauseReason ?? null };
      return;
    }

    // Initial state comes from how the store itself was opened -- a freshly
    // created task starts idle; anything loaded back off disk starts paused
    // so nothing auto-resumes without an explicit human decision (design
    // doc section 4: "재시작으로 복구된 task는 자동 출발하지 않고
    // paused: recovered/execution_uncertain에서 사용자 resume을 받는다").
    if (store.recoveryReason === "execution_uncertain") {
      this._task = { state: "paused", pauseReason: "execution_uncertain" };
    } else if (store.recoveryReason === "recovered") {
      this._task = { state: "paused", pauseReason: "recovered" };
    } else {
      this._task = { state: "idle", pauseReason: null };
    }

    // A nonterminal checkpoint still carries real progress -- restore it
    // rather than let the freshly constructed zero budgets/segment/criteria
    // silently replace it, which would let a recovered task exceed its
    // action/planner-call/time limits or re-derive already-verified
    // criteria as pending.
    const checkpointedPayload = store.lastCheckpoint && store.lastCheckpoint.payload;
    if (checkpointedPayload) {
      if (checkpointedPayload.budgets) this._budgets = { ...checkpointedPayload.budgets };
      if (checkpointedPayload.segment) this._segment = { ...checkpointedPayload.segment };
      if (checkpointedPayload.criteriaStatus) this._criteriaStatus = new Map(checkpointedPayload.criteriaStatus);
    }
    if (this._routineRunner && this._routineRun && store.routineRecovery) {
      const recovered = store.routineRecovery;
      if (recovered.routineId !== this._routineRun.routineId || recovered.revision !== this._routineRun.revision || recovered.digest !== this._routineRun.digest) {
        throw new TaskControllerError("routine_cursor_mismatch", "recovered routine pin differs from its checkpoint");
      }
      this._routineRun.cursor = recovered.cursor;
      if (recovered.blocked === "denied") {
        this._routineRun.blocked = "denied";
        this._task = { state: "paused", pauseReason: "routine_step_denied" };
      } else if (recovered.blocked === "failed") {
        this._routineRun.blocked = "failed";
        this._task = { state: "paused", pauseReason: "routine_step_failed" };
      } else if (recovered.incomplete) {
        this._routineRun.incomplete = true;
        this._task = { state: "paused", pauseReason: "routine_recovery_incomplete" };
      }
    }
  }

  getGoal() {
    return this._goal;
  }

  // Read-only signal for harness profile selection (see
  // shared/harness-profile.js selectHarnessProfile); never itself grants or
  // changes execution authority.
  isRoutine() {
    return this._routineRun !== null;
  }

  getHarnessProfile() {
    return this._harnessProfile;
  }

  setPolicySettings({ permissionMode, plannerEffort } = {}) {
    const { PERMISSION_MODES } = require("./permission-policy");
    const allowedEfforts = ["low", "medium", "high", "xhigh", "max"];
    if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) throw new TaskControllerError("invalid_permission_mode", "permissionMode is invalid");
    if (plannerEffort !== undefined && !allowedEfforts.includes(plannerEffort)) throw new TaskControllerError("invalid_planner_effort", "plannerEffort is invalid");
    if (permissionMode !== undefined) this._permissionMode = permissionMode;
    if (plannerEffort !== undefined) this._plannerEffort = plannerEffort;
    this._browser.setPermissionMode?.(this._permissionMode);
  }

  getSnapshot() {
    return {
      state: this._task.state,
      pauseReason: this._task.pauseReason,
      goalVersion: this._goal.goalVersion,
      budgets: { ...this._budgets },
      segment: { ...this._segment },
      criteriaStatus: [...this._criteriaStatus.entries()].map(([criterionId, v]) => ({ criterionId, ...v })),
      approvalQueue: this._approvalQueue.map(({ id, summary, actionType, createdAt, descriptor }) => ({ id, summary, action: actionType, createdAt, target: descriptor?.target ?? null })),
    };
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("onChange requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    // A transition may have changed _task optimistically before its durable
    // checkpoint, or be draining a mutator. Publish only a settled snapshot.
    // Browser events use the host's last published snapshot for this reason.
    if (!this._admissionOpen || this._pendingTransitions > 0 || this._inFlightOps.size > 0 || this._pendingCheckpoints > 0 || !this._snapshotTrusted) return;
    const snapshot = this.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this._lastEmittedSnapshot) return;
    this._lastEmittedSnapshot = serialized;
    for (const listener of this._listeners) {
      try {
        Promise.resolve(listener(structuredClone(snapshot))).catch(() => {});
      } catch {
        // Observers must never change the outcome of a committed operation.
      }
    }
  }

  getEvents(options) {
    return this._store.getEvents(options);
  }

  async recordHostNote(payload) {
    if (!contracts.isPlainObject(payload) || payload.kind !== "credential_autofill_requested" ||
        typeof payload.credentialId !== "string" || typeof payload.origin !== "string") {
      throw new TaskControllerError("invalid_host_note", "unsupported host audit note");
    }
    await this._store.append({ type: "note", payload });
  }

  isUserControlled() {
    return this._admissionOpen && this._pendingTransitions === 0 && this._inFlightOps.size === 0 &&
      this._pendingCheckpoints === 0 && this._snapshotTrusted && this._task.pauseReason !== "memory_emergency" &&
      ["idle", "paused", "awaiting_verification", "completed", "stopped"].includes(this._task.state);
  }

  async userNavigate(action) {
    this._checkAdmission();
    if (!this.isUserControlled()) {
      throw new TaskControllerError("invalid_state", "take over the task before using its browser");
    }
    if (typeof this._browser.userNavigate !== "function") {
      throw new TaskControllerError("browser_unavailable", "this task browser does not support user navigation");
    }
    this._admissionOpen = false;
    try {
      return await this._trackInFlight(Promise.resolve().then(() => this._browser.userNavigate(action)));
    } finally {
      // A concurrent stop/takeover owns the gate until its drain finishes.
      if (this._pendingTransitions === 0) this._admissionOpen = true;
    }
  }

  _stopHappenedSince(epoch) {
    return epoch !== this._epoch;
  }

  _checkAdmission() {
    if (!this._admissionOpen) {
      throw new TaskControllerError("admission_closed", "a pause/stop/takeOver transition is in progress");
    }
  }

  // A failed _doTransition (a durable append/checkpoint error) can leave
  // _task.state already optimistically flipped to its target value -- the
  // same pre-existing pattern _pauseWith always used, state set before the
  // checkpoint await -- even though nothing was ever durably confirmed and
  // admission was correctly left closed (fail-closed). Nothing is currently
  // in flight in that case (_pendingTransitions is back to 0 once the
  // failure has fully unwound), so pause()/takeOver()'s normal
  // running/awaiting_approval guard would otherwise wedge them shut forever
  // with no way to retry. This condition identifies exactly that "stuck
  // from a prior failure, safe to retry" state and nothing else.
  _transitionRetryable() {
    return !this._admissionOpen && this._pendingTransitions === 0;
  }

  // FIFO for the three control-ownership transitions (pause/stop/takeOver):
  // a second concurrent call naturally runs after the first and finds
  // nothing left to do, rather than racing it. `fn` runs regardless of
  // whether the previous transition in the chain succeeded or threw (so one
  // failure can never wedge the queue), and the chain itself is re-caught so
  // it stays alive for the next enqueue. _pendingTransitions is incremented
  // synchronously here (before any await), which is what lets pause()/
  // stop()/takeOver() close admission and have that closure visible to a
  // synchronously-following approve() call, even though `fn` itself only
  // runs later once the chain reaches it.
  _enqueueTransition(fn) {
    this._pendingTransitions += 1;
    const run = this._transitionChain.then(fn, fn);
    this._transitionChain = run.catch(() => {});
    // .finally()'s own returned promise re-throws whatever `run` rejected
    // with; nothing else observes THIS particular derived promise (the
    // rejection itself is already surfaced to the real caller via the
    // `return run` below), so it needs its own no-op .catch() or Node
    // reports it as a second, spurious unhandledRejection.
    run.finally(() => {
      this._pendingTransitions -= 1;
    }).catch(() => {});
    return run;
  }

  // The actual transition body, run strictly one-at-a-time via
  // _enqueueTransition. Admission is ALREADY closed by the caller
  // (pause/stop/takeOver) before this was even enqueued -- this function
  // never opens or closes it except at its own tail. Order matters: cancel
  // still-queued approvals durably BEFORE removing them from memory (so a
  // failed append leaves the item retryable, never silently lost), THEN
  // drain every in-flight mutator so a transition can never checkpoint while
  // an admitted approve()/dispatch's true outcome is still undetermined,
  // THEN checkpoint the final state, and only reopen admission after that
  // checkpoint durably succeeds -- and only if this is the last transition
  // still pending (an earlier transition in a back-to-back burst must never
  // reopen the window a later, already-queued transition still needs
  // closed). Any append/checkpoint failure here propagates and leaves
  // admission closed (fail-closed) and _task unchanged, exactly like every
  // other store.append()/checkpoint() call in this file.
  async _doTransition({ finalState, pauseReason, cancelQueue, cancelReason }) {
    if (cancelQueue) {
      const queued = [...this._approvalQueue];
      for (const item of queued) {
        // durable:false: this loop is always followed by this._checkpoint()
        // below (before any other await point reachable from here), and
        // checkpoint() itself flushes any pending non-durable bytes before
        // it commits -- so every approval_cancelled here is guaranteed
        // durable by the time this transition finishes, without paying for
        // its own fsync when there are several queued at once.
        await this._store.append({
          type: "approval_cancelled",
          payload: {
            requestId: item.id,
            actionType: item.actionType,
            goalVersion: item.goalVersion,
            reason: cancelReason,
          },
        }, { durable: false });
        const idx = this._approvalQueue.findIndex((q) => q.id === item.id);
        if (idx !== -1) this._approvalQueue.splice(idx, 1);
      }
    }
    await Promise.allSettled([...this._inFlightOps]);
    this._leaveActive();
    this._task = { state: finalState, pauseReason: finalState === "stopped" ? null : pauseReason };
    await this._checkpoint();
    if (this._pendingTransitions === 1) {
      // No other transition is still queued behind this one (the count
      // still includes this call itself -- it only decrements after this
      // function returns, in _enqueueTransition's .finally) -- safe to
      // reopen now that the checkpoint above durably landed.
      this._admissionOpen = true;
    }
  }

  // Register an already-started asynchronous operation before yielding to the
  // event loop. Transitions close admission synchronously, then drain this set
  // before checkpointing so an admitted write cannot land after ownership has
  // already been returned to the person.
  async _trackInFlight(op) {
    this._inFlightOps.add(op);
    try {
      return await op;
    } finally {
      this._inFlightOps.delete(op);
    }
  }

  // Keep the whole committed action lifecycle in the drain set: after
  // action_outcome, _afterActionDispatched may still append evidence and
  // checkpoint progress. A transition must wait for that tail too, not just
  // for browser.execute() to finish.
  async _dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch, { durable = true } = {}) {
    const op = (async () => {
      const result = await this._dispatchApproved(descriptor, action, epoch, { durable });
      if (this._stopHappenedSince(epoch)) return { stale: true, result };
      if (this._routineRunner && result.status !== "not_dispatched") {
        const binding = this._routineRunner.getCurrentStep?.();
        if (!binding) {
          await this._pauseWith("routine_cursor_mismatch");
          return { stale: false, result };
        }
        if (result.status === "ok") {
          // Inside a read-only batch only the last advancement is durable; its fsync also flushes the earlier ones.
          await this._store.append({ type: "routine_step_advanced", payload: { ...binding, actionId: result.actionId } }, { durable });
          // No per-step checkpoint: the durable advancement record above is the cursor's source of truth and
          // streamJournalReplay re-derives it after the last checkpoint; every pause/stop/finish checkpoints.
          this._routineRun.cursor = this._routineRunner.advance(binding);
        } else {
          await this._store.append({ type: "routine_step_failed", payload: {
            ...binding,
            actionId: result.actionId,
            status: result.status === "cancelled" ? "cancelled" : "failed",
            ...(typeof result.errorCode === "string" ? { errorCode: result.errorCode } : {}),
          } });
          await this._pauseWith("routine_step_failed");
          return { stale: false, result };
        }
      }
      await this._afterActionDispatched(proposal, result, epoch);
      return { stale: false, result };
    })();
    const result = await this._trackInFlight(op);
    this._emit();
    return result;
  }

  async _denyRoutineStep(decision) {
    const binding = this._routineRunner?.getCurrentStep?.();
    if (!binding || !this._routineRun) {
      await this._pauseWith("routine_cursor_mismatch");
      return;
    }
    const normalizedDecision = decision.decision === "quarantine" ? "quarantine" : "deny";
    const reasons = Array.isArray(decision.reasons)
      ? decision.reasons.filter((reason) => typeof reason === "string").slice(0, 16)
      : [];
    await this._store.append({ type: "routine_step_denied", payload: { ...binding, decision: normalizedDecision, reasons } });
    this._routineRun.blocked = "denied";
    await this._pauseWith("routine_step_denied");
  }

  _enterActive() {
    if (this._activeSince === null) this._activeSince = this._now();
  }

  _leaveActive() {
    if (this._activeSince !== null) {
      this._budgets.activeMs += this._now() - this._activeSince;
      this._activeSince = null;
    }
  }

  async _checkpoint() {
    this._pendingCheckpoints += 1;
    try {
      await this._store.checkpoint({
        task: { ...this._task },
        budgets: { ...this._budgets },
        segment: { ...this._segment },
        criteriaStatus: [...this._criteriaStatus.entries()],
        ...(this._routineRun ? { routineRun: { ...this._routineRun } } : {}),
      });
      this._snapshotTrusted = true;
    } catch (error) {
      this._snapshotTrusted = false;
      throw error;
    } finally {
      this._pendingCheckpoints -= 1;
    }
  }

  async _pauseWith(reason) {
    this._leaveActive();
    this._task = { state: "paused", pauseReason: reason };
    await this._checkpoint();
    this._emit();
  }

  // 900MB emergency pressure (user mandate, design doc section 10): tear
  // down this controller's OWNED resources -- its BrowserAdapter's
  // WebContentsView and its planner's worker child process -- rather than
  // merely pausing. dispose()/close() failing (e.g. the view was already
  // destroyed by something else) must never prevent the pause itself from
  // landing, so each is best-effort. Distinct pauseReason
  // ("memory_emergency") from the plain "memory_pressure" (800MB) pause so
  // resume() can refuse to reuse now-disposed resources instead of the
  // resume/reload storm the user explicitly prohibited -- recovering a
  // memory_emergency task requires a fresh TaskHost re-attachment (new
  // browser/planner instances), exactly like a process restart.
  async _pauseForMemoryEmergency() {
    this._leaveActive();
    this._task = { state: "paused", pauseReason: "memory_emergency" };
    await this._checkpoint();
    try {
      await this._browser.dispose?.();
    } catch {
      // best-effort -- see comment above
    }
    try {
      await this._planner.close?.();
    } catch {
      // best-effort -- see comment above
    }
    try {
      // Release the writer.lock so a fresh re-attachment (TaskHost's
      // resumeSavedTask(), or a real process restart) can actually
      // TaskStore.load() this task again -- without this, the abandoned
      // instance's still-held lock would make recovery impossible without
      // the whole host process exiting first.
      await this._store.close();
    } catch {
      // best-effort -- see comment above
    }
    this._emit();
  }

  async _pauseForMemoryPressure(pressure) {
    if (pressure === "emergency") {
      await this._pauseForMemoryEmergency();
    } else {
      await this._pauseWith("memory_pressure");
    }
  }

  async start() {
    if (this._task.state !== "idle") {
      throw new TaskControllerError("invalid_state", `start() requires state idle, got ${this._task.state}`);
    }
    this._task = { state: "running", pauseReason: null };
    this._emit();
    return this._runLoop();
  }

  async resume(opts = {}) {
    this._checkAdmission();
    if (this._task.state !== "paused") {
      throw new TaskControllerError("invalid_state", `resume() requires state paused, got ${this._task.state}`);
    }
    if (this._routineRunner && (this._routineRun?.blocked || this._routineRun?.incomplete || this._store.recoveryReason === "execution_uncertain")) {
      throw new TaskControllerError("routine_recovery_incomplete", "a denied, failed, or uncertain routine step cannot be replayed; stop or inspect the task instead");
    }
    if (this._task.pauseReason === "execution_uncertain" && !opts.confirmed) {
      throw new TaskControllerError(
        "confirmation_required",
        "resume() from execution_uncertain requires resume({confirmed: true}) -- the dangling action is never auto-replayed",
      );
    }
    if (this._task.pauseReason === "memory_emergency") {
      // This controller's own browser/planner were already disposed when
      // emergency pressure hit -- there is nothing left here to resume into,
      // and no confirmed:true can rescue that (unlike execution_uncertain,
      // resuming THIS controller is not an option at all, not just gated).
      // Recovery requires a fresh TaskHost re-attachment (new browser/
      // planner instances), exactly like a process restart.
      throw new TaskControllerError(
        "resources_disposed",
        "this controller's browser/planner were disposed after a memory emergency -- re-attach the task fresh instead of resuming this instance",
      );
    }
    this._task = { state: "running", pauseReason: null };
    // Any interruption's cursor is meaningless now -- resume always starts
    // the next iteration with a completely fresh observation (design doc
    // section 7: "resume은 새 observation부터 시작한다. 이미 끝난 action은
    // 재생하지 않는다"). Phase 2 Task 4's reuse cache must never survive a
    // resume either, for the same reason.
    this._lastObservation = null;
    this._reusableObservation = null;
    this._emit();
    return this._runLoop();
  }

  async pause(reason = "user") {
    if (!["running", "awaiting_approval"].includes(this._task.state) && !this._transitionRetryable()) {
      return this.getSnapshot();
    }
    // Close admission and invalidate any in-flight planner/approver
    // round-trip SYNCHRONOUSLY, before _enqueueTransition ever schedules
    // _doTransition -- _enqueueTransition chains via Promise.then, which
    // only runs on a later microtask, so a synchronously-following approve()
    // call must see the closed gate right here, not after that microtask.
    this._admissionOpen = false;
    this._epoch += 1;
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "paused", pauseReason: reason, cancelQueue: false, cancelReason: null }),
    );
    this._emit();
    return this.getSnapshot();
  }

  async stop() {
    // No state guard, matching stop()'s pre-existing behavior: it always
    // forces a transition to stopped regardless of current state.
    this._admissionOpen = false;
    this._epoch += 1;
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "stopped", pauseReason: null, cancelQueue: true, cancelReason: "stop" }),
    );
    this._emit();
    return this.getSnapshot();
  }

  // Trusted-IPC-only (task-host.js/ipc.js gate this like every other
  // HARNESS_METHODS channel): a human takes control back from the agent.
  // Cancels any still-queued approval requests with a durable
  // approval_cancelled audit record (never silently drops one), and -- via
  // the shared admission gate/drain in _doTransition -- waits for any
  // already-admitted approve()/dispatch to reach its TRUE outcome first,
  // rather than labeling something "cancelled" that already ran.
  async takeOver(reason = "user_takeover") {
    if (!["running", "awaiting_approval"].includes(this._task.state) && !this._transitionRetryable()) {
      return this.getSnapshot();
    }
    this._admissionOpen = false;
    this._epoch += 1;
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "paused", pauseReason: reason, cancelQueue: true, cancelReason: reason }),
    );
    this._emit();
    return this.getSnapshot();
  }

  async amend(amendmentInput) {
    this._checkAdmission();
    const goal = await this._trackInFlight(this._amend(amendmentInput));
    this._emit();
    return goal;
  }

  async _amend(amendmentInput) {
    if (["stopped", "completed"].includes(this._task.state)) {
      throw new TaskControllerError("invalid_state", `cannot amend a task in state ${this._task.state}`);
    }
    const nextGoal = await this._store.amendGoal(amendmentInput);
    this._goal = nextGoal;
    // A goal amendment invalidates any stale in-flight proposal/approval
    // tied to the old goalVersion (design doc section 7).
    this._epoch += 1;
    await this._checkpoint();
    return nextGoal;
  }

  // Task 5: the trusted-IPC-only path (main/ipc.js gates the caller with
  // trusted-sender.js) that lets a human satisfy a "user"-verification
  // criterion. progress.js's verifyCriterion() only ever honors a
  // PRE-EXISTING verified/rejected evidence entry for a "user"-kind
  // criterion -- nothing in the planner/browser loop can set that itself.
  // Rejects a stale goalVersion or an evidenceId that doesn't match the
  // currently pending one, so a confirmation the UI queued against an old
  // amendment or an old pending item can never be silently applied to
  // whatever is current now.
  async confirmCriterion({ criterionId, goalVersion, evidenceId, outcome } = {}) {
    this._checkAdmission();
    const snapshot = await this._trackInFlight(this._confirmCriterion({ criterionId, goalVersion, evidenceId, outcome }));
    this._emit();
    return snapshot;
  }

  async _confirmCriterion({ criterionId, goalVersion, evidenceId, outcome } = {}) {
    if (this._task.state === "stopped") {
      throw new TaskControllerError("invalid_state", "cannot confirm a criterion on a stopped task");
    }
    if (outcome !== "verified" && outcome !== "rejected") {
      throw new TaskControllerError("invalid_field", "outcome must be 'verified' or 'rejected'");
    }
    if (goalVersion !== this._goal.goalVersion) {
      throw new TaskControllerError(
        "stale_goal_version",
        `confirmCriterion targets goalVersion ${goalVersion}, current is ${this._goal.goalVersion}`,
      );
    }
    const criterion = this._goal.criteria.find((c) => c.id === criterionId);
    if (!criterion) {
      throw new TaskControllerError("unknown_criterion", `unknown criterionId ${criterionId}`);
    }
    const current = this._criteriaStatus.get(criterionId);
    if (!current || current.goalVersion !== goalVersion || current.evidenceId !== evidenceId) {
      throw new TaskControllerError(
        "stale_evidence",
        `no pending evidence ${evidenceId} for criterion ${criterionId} at goalVersion ${goalVersion}`,
      );
    }

    const confirmed = {
      id: randomUUID(),
      taskId: this._goal.taskId,
      goalVersion,
      criterionId,
      kind: "user_confirmation",
      at: new Date(this._now()).toISOString(),
      verification: outcome,
      verifierId: "user",
      details: { confirmsEvidenceId: evidenceId },
    };
    await this._store.append({ type: "evidence_recorded", payload: { evidence: confirmed } });
    this._criteriaStatus.set(criterionId, { status: outcome, evidenceId: confirmed.id, goalVersion });

    if (this._task.state === "awaiting_verification") {
      if (outcome === "verified") {
        const completion = canComplete(this._goal, this._evidenceForCompletionCheck());
        if (completion.complete) {
          this._task = { state: "completed", pauseReason: null };
          await this._checkpoint();
        }
      } else {
        // A rejected criterion cannot complete the task as-is, but leaving
        // the task stuck in awaiting_verification forever gives the user no
        // durable path back to replanning. Fail closed into a state Resume
        // already accepts, with a pauseReason that names why.
        this._task = { state: "paused", pauseReason: "evidence_rejected" };
        await this._checkpoint();
      }
    }
    return this.getSnapshot();
  }

  async approve(requestId) {
    this._checkAdmission();
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    const wasAwaitingApproval = this._approvalQueue.length === 0 && this._task.state === "awaiting_approval";
    if (wasAwaitingApproval) {
      this._task = { state: "running", pauseReason: null };
    }
    // Approval-binding staleness check (design doc section 7): pause/stop/
    // amend all bump the epoch, and every binding expires after 60s
    // regardless. A stale item was never re-validated against the current
    // goal/epoch, so it must be dropped -- exactly like a deny() -- rather
    // than dispatched against a goal or execution context it no longer
    // corresponds to.
    if (this._stopHappenedSince(item.epoch) || this._now() >= item.expiresAt) {
      this._emit();
      if (wasAwaitingApproval) return this._runLoop();
      return this.getSnapshot();
    }
    this._enterActive();
    const epoch = this._epoch;
    if (item.actions) {
      const outcome = await this._runApprovedReadOnlyBatch(item.proposal, item.actions, epoch);
      if (outcome === "stop_loop" || this._stopHappenedSince(epoch)) return this.getSnapshot();
    } else {
      const dispatched = await this._dispatchApprovedAndApplyTracked(item.proposal, item.descriptor, item.action, epoch);
      if (dispatched.stale || this._stopHappenedSince(epoch)) return this.getSnapshot();
    }
    if (this._task.state === "running") return this._runLoop();
    return this.getSnapshot();
  }

  async deny(requestId) {
    this._checkAdmission();
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    // Nothing was ever dispatched for a queued-but-denied item (no
    // action_started was written for it -- see _dispatchActionsBatch), so
    // there is no action lifecycle event to close out here, only the queue
    // entry to drop.
    this._approvalQueue.splice(index, 1);
    if (this._approvalQueue.length === 0 && this._task.state === "awaiting_approval") {
      this._task = { state: "running", pauseReason: null };
      this._emit();
      return this._runLoop();
    }
    this._emit();
    return this.getSnapshot();
  }

  // --- internal loop ---

  async _runLoop() {
    if (this._loopRunning) return this.getSnapshot();
    this._loopRunning = true;
    try {
      // Planner process startup is independent of the first page observation.
      // Start it now so its cold launch can overlap with that browser work;
      // no request is sent until the normal observe -> plan boundary below.
      if (typeof this._planner.warm === "function") {
        try {
          this._planner.warm();
        } catch {
          // Keep the established planner_error handling at next(); a warm-up
          // failure is not itself a model response or an execution decision.
        }
      }
      while (this._task.state === "running") {
        const epoch = this._epoch;
        this._enterActive();

        const pressure = this._memoryMonitor.getPressureLevel();
        if (pressure === "pause" || pressure === "emergency") {
          await this._pauseForMemoryPressure(pressure);
          break;
        }

        const activeMs = this._budgets.activeMs + (this._activeSince !== null ? this._now() - this._activeSince : 0);
        if (this._budgets.plannerCallsUsed >= this._goal.limits.maxPlannerCalls || activeMs >= this._goal.limits.maxActiveMs) {
          await this._pauseWith("budget_exhausted");
          break;
        }

        let observation;
        // Harness v2 Phase 2 Task 4 (incremental observation, short only):
        // reuse the last dispatched action's own observation instead of
        // unconditionally re-observing, but only when the browser itself
        // proves nothing has navigated since that snapshot was taken --
        // getDocumentEpoch() is the same authority execute()'s own
        // stale_document guard already trusts, so this is a real proof, not
        // an assumption. A browser fake without getDocumentEpoch() (most
        // unit-test fakes) simply never qualifies, which is the safe
        // default: always re-observe.
        const reusable = this._harnessProfile === "short" ? this._reusableObservation : null;
        if (reusable && typeof this._browser.getDocumentEpoch === "function" &&
            this._browser.getDocumentEpoch() === reusable.documentEpoch) {
          observation = reusable;
        } else {
          try {
            observation = await this._browser.observe({
              signal: undefined,
              initial: this._budgets.actionsUsed === 0 && this._budgets.plannerCallsUsed === 0,
            });
          } catch {
            if (this._stopHappenedSince(epoch)) break;
            await this._pauseWith("observation_error");
            break;
          }
        }
        this._reusableObservation = null;
        if (this._stopHappenedSince(epoch)) break;
        this._lastObservation = observation;

        let customMemory = [];
        try {
          if (this._memoryStore) {
            const memory = await this._memoryStore.forContext(observation.url);
            customMemory = memory.entries;
          }
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          await this._pauseWith("context_error");
          break;
        }
        if (this._stopHappenedSince(epoch)) break;

        let pendingMessages = [];
        try {
          if (this._listPendingMessages) {
            pendingMessages = await this._listPendingMessages();
          }
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          await this._pauseWith("context_error");
          break;
        }
        if (this._stopHappenedSince(epoch)) break;

        let context;
        try {
          context = buildContext({
            goal: this._goal,
            state: {
              criteriaStatus: this.getSnapshot().criteriaStatus,
              segment: { ...this._segment },
              budgets: { ...this._budgets },
              plannerEffort: this._plannerEffort,
            },
            observation,
            recentEvents: this._store.eventsSinceCheckpoint || [],
            customMemory,
            pendingMessages,
          });
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          await this._pauseWith("context_error");
          break;
        }
        // The admitted subset only -- never mutated after this point. Used
        // below to durably acknowledge exactly what was actually shown to
        // the planner, before its proposal is handled (fail-closed: see the
        // recordMessagesConsumed block right after planner.next() resolves).
        const admittedMessageIds = context.pendingMessages.map((m) => m.messageId);

        let proposal;
        try {
          proposal = await this._planner.next(context, { signal: undefined });
        } catch (error) {
          if (this._stopHappenedSince(epoch)) break;
          // planner-stdio.js's PlannerTransportError distinguishes "no
          // worker command is configured at all" (code "planner_unavailable")
          // from a genuine transport failure (timeout, malformed response,
          // etc.) -- the design doc requires the former to surface honestly
          // as its own pause reason rather than the generic planner_error,
          // so a host UI can tell "nothing is wired up" apart from "the
          // configured planner broke".
          const routinePause = ["routine_step_unresolved", "routine_origin_violation", "routine_cursor_mismatch", "invalid_routine"]
            .includes(error?.code) ? error.code : null;
          await this._pauseWith(routinePause || (error && error.code === "planner_unavailable" ? "planner_unavailable" : "planner_error"));
          break;
        }
        this._budgets.plannerCallsUsed += 1;
        if (this._stopHappenedSince(epoch)) break;

        // Subagent communication protocol Task 4 (Review Focus: "crash/
        // failure after planner response but before durable
        // message_turn_consumed must not process the generated proposal").
        // Durably ack exactly the admitted batch BEFORE the proposal below
        // is ever validated/dispatched; a stop that raced in above already
        // broke out, so a stopped controller never marks a steer observed.
        if (admittedMessageIds.length > 0 && !this._recordMessagesConsumed) {
          await this._pauseWith("message_ack_unavailable");
          break;
        }
        if (admittedMessageIds.length > 0) {
          try {
            await this._recordMessagesConsumed(admittedMessageIds, this._budgets.plannerCallsUsed);
          } catch {
            if (this._stopHappenedSince(epoch)) break;
            await this._pauseWith("message_ack_failed");
            break;
          }
        }
        if (this._stopHappenedSince(epoch)) break;

        this._segment.callsInSegment += 1;
        if (this._segment.callsInSegment >= this._segmentRotationCalls) {
          this._segment.callsInSegment = 0;
          this._segment.index += 1;
        }
        this._emit();

        let validated;
        try {
          validated = validateProposal(proposal, { goal: this._goal, maxActions: maxActionsPerProposal(this._harnessProfile) });
        } catch {
          // An off-goal/stale/malformed proposal is never executed; give the
          // planner another turn with a fresh observation rather than
          // silently doing nothing forever.
          continue;
        }

        if (validated.kind === "finish") {
          const completion = canComplete(this._goal, this._evidenceForCompletionCheck());
          this._leaveActive();
          if (completion.complete) {
            this._task = { state: "completed", pauseReason: null };
          } else {
            this._task = { state: "awaiting_verification", pauseReason: null };
          }
          await this._checkpoint();
          this._emit();
          break;
        }

        if (validated.kind === "need_user") {
          await this._pauseWith("need_user");
          break;
        }

        if (validated.kind === "replan") {
          continue; // model asked to reconsider; no dispatch, just loop again
        }

        if (validated.kind === "child_plan") {
          if (!this._onChildPlan) {
            // No parent-level delegation handler wired on this controller --
            // never silently pretend to have spawned anything; give the
            // planner another turn with a fresh observation instead.
            continue;
          }
          try {
            await this._onChildPlan(validated);
          } catch (error) {
            await this._pauseWith("child_plan_failed");
            break;
          }
          continue; // the parent's own loop keeps observing/planning independently of its children
        }

        if (validated.kind === "send_message") {
          if (!this._sendMessage) {
            // Without the coordinator boundary, the message cannot be
            // authenticated or durably accepted. Do not silently drop it.
            await this._pauseWith("send_message_unavailable");
            break;
          }
          try {
            await this._sendMessage(validated);
          } catch (error) {
            await this._pauseWith("send_message_failed");
            break;
          }
          continue; // host messaging, not a browser action; never mutates an in-flight action
        }

        // kind === "actions"
        const outcome = await this._dispatchActionsBatch(validated, epoch);
        if (outcome === "stop_loop") break;
      }
    } finally {
      this._loopRunning = false;
    }
    return this.getSnapshot();
  }

  _evidenceForCompletionCheck() {
    // Each entry keeps the goalVersion it was actually verified under (set
    // in _afterActionDispatched), NOT the controller's current goalVersion --
    // otherwise a criterion verified before an amend() would silently keep
    // counting toward the NEW version's completion, defeating progress.js's
    // canComplete() re-verification-after-amendment check.
    const evidence = [];
    for (const [criterionId, v] of this._criteriaStatus.entries()) {
      if (v.status === "verified") {
        evidence.push({ criterionId, verification: "verified", goalVersion: v.goalVersion });
      }
    }
    return evidence;
  }

  async _dispatchActionsBatch(proposal, epoch) {
    if (this._batchReadOnlyActions && proposal.actions.length > 1 && proposal.actions.every((action) => isReadOnlyAction(action.type))) {
      const outcome = await this._dispatchReadOnlyBatch(proposal, epoch);
      if (outcome !== "individual") return outcome;
    }
    for (const action of proposal.actions) {
      if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
        await this._pauseWith("budget_exhausted");
        return "stop_loop";
      }

      const pressure = this._memoryMonitor.getPressureLevel();
      if (pressure === "pause" || pressure === "emergency") {
        await this._pauseForMemoryPressure(pressure);
        return "stop_loop";
      }

      const requestId = randomUUID();
      const descriptor = this._describeAction(action, requestId);

      let decision;
      const policy = this._evaluateActionPolicy(this._permissionMode, action.type);
      if (!policy.allowed) {
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [policy.reason || "permission_mode_denied"] });
          return "stop_loop";
        }
        continue;
      }
      try {
        decision = policy.approval === "bypass"
          ? { decision: "allow", reasons: ["explicit_full_permission"] }
          : policy.approval === "human"
            ? { decision: "review", reasons: ["human_confirmation_required"] }
            : await this._approve(descriptor);
      } catch {
        if (this._stopHappenedSince(epoch)) return "stop_loop";
        await this._pauseWith("approver_error");
        return "stop_loop";
      }
      if (this._stopHappenedSince(epoch)) return "stop_loop";

      if (decision.decision === "review") {
        this._approvalQueue.push({
          id: requestId,
          summary: descriptor.summary,
          actionType: action.type,
          createdAt: new Date().toISOString(),
          // Approval-binding contract (design doc section 7): a queued item
          // is only ever dispatchable while the epoch it was queued under is
          // still current (pause/stop/amend all bump the epoch, so any of
          // them invalidates it) and before its 60s window expires. See
          // approve()'s staleness check below.
          epoch,
          goalVersion: this._goal.goalVersion,
          expiresAt: this._now() + contracts.APPROVAL_EXPIRY_MS,
          descriptor,
          action,
          proposal,
        });
        this._leaveActive();
        this._task = { state: "awaiting_approval", pauseReason: null };
        await this._checkpoint();
        this._emit();
        return "stop_loop";
      }
      if (decision.decision !== "allow") {
        // deny/quarantine: skip this action, keep the loop going with the rest.
        if (this._routineRunner && (decision.decision === "deny" || decision.decision === "quarantine")) {
          await this._denyRoutineStep(decision);
          return "stop_loop";
        }
        continue;
      }

      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch);
      if (dispatched.stale || this._stopHappenedSince(epoch)) return "stop_loop";
      if (this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
    }
    return "continue";
  }

  _describeAction(action, requestId, suffix = "") {
    const target = describeActionTarget(action, this._lastObservation);
    return {
      requestId,
      action: action.type,
      origin: (this._lastObservation && this._lastObservation.url) || "",
      target,
      summary: `${target ? `Planner proposes ${action.type}: ${target}` : `Planner proposes ${action.type}`}${suffix}`,
      selfProvenance: "untrusted",
      source: "page_content",
      targetScope: "external",
    };
  }

  // Read-only batch (design 2026-09-29-readonly-action-batching): the approver judges each distinct action type
  // once for the whole batch, and only the last action's records are durable. Returns "individual" when policy
  // does not allow every action, so the ordinary per-action path keeps its own skip/deny semantics.
  async _dispatchReadOnlyBatch(proposal, epoch) {
    const actions = proposal.actions;
    const firstByType = new Map();
    for (const action of actions) {
      if (!firstByType.has(action.type)) firstByType.set(action.type, action);
    }
    const policies = new Map();
    for (const type of firstByType.keys()) {
      const policy = this._evaluateActionPolicy(this._permissionMode, type);
      if (!policy.allowed) return "individual";
      policies.set(type, policy);
    }

    const suffix = ` (batch of ${actions.length} read-only actions)`;
    let decision = { decision: "allow", reasons: [] };
    let reviewDescriptor = null;
    const severity = { allow: 0, review: 1, deny: 2, quarantine: 2 };
    for (const [type, action] of firstByType) {
      const policy = policies.get(type);
      const descriptor = this._describeAction(action, randomUUID(), suffix);
      let next;
      try {
        next = policy.approval === "bypass"
          ? { decision: "allow", reasons: ["explicit_full_permission"] }
          : policy.approval === "human"
            ? { decision: "review", reasons: ["human_confirmation_required"] }
            : await this._approve(descriptor);
      } catch {
        if (this._stopHappenedSince(epoch)) return "stop_loop";
        await this._pauseWith("approver_error");
        return "stop_loop";
      }
      if (this._stopHappenedSince(epoch)) return "stop_loop";
      if ((severity[next.decision] ?? 2) > (severity[decision.decision] ?? 2)) decision = next;
      if (next.decision === "review" && !reviewDescriptor) reviewDescriptor = descriptor;
    }

    if (decision.decision === "review") {
      const descriptor = reviewDescriptor ?? this._describeAction(actions[0], randomUUID(), suffix);
      this._approvalQueue.push({
        id: descriptor.requestId,
        summary: descriptor.summary,
        actionType: actions[0].type,
        createdAt: new Date().toISOString(),
        epoch,
        goalVersion: this._goal.goalVersion,
        expiresAt: this._now() + contracts.APPROVAL_EXPIRY_MS,
        descriptor,
        action: actions[0],
        actions,
        proposal,
      });
      this._leaveActive();
      this._task = { state: "awaiting_approval", pauseReason: null };
      await this._checkpoint();
      this._emit();
      return "stop_loop";
    }
    if (decision.decision !== "allow") {
      if (this._routineRunner) {
        await this._denyRoutineStep(decision);
        return "stop_loop";
      }
      return "continue";
    }
    return this._runApprovedReadOnlyBatch(proposal, actions, epoch);
  }

  async _runApprovedReadOnlyBatch(proposal, actions, epoch) {
    for (let index = 0; index < actions.length; index += 1) {
      if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
        await this._pauseWith("budget_exhausted");
        return "stop_loop";
      }
      const pressure = this._memoryMonitor.getPressureLevel();
      if (pressure === "pause" || pressure === "emergency") {
        await this._pauseForMemoryPressure(pressure);
        return "stop_loop";
      }
      const descriptor = this._describeAction(actions[index], randomUUID());
      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, actions[index], epoch, {
        durable: index === actions.length - 1,
      });
      if (dispatched.stale || this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
    }
    return "continue";
  }

  // The single commit point: this staleness check runs exactly once,
  // synchronously, as the very first thing here -- before action_started is
  // ever written. Once past it, this function is committed and must run to
  // completion (real execute(), real action_outcome) no matter what happens
  // to the epoch afterward -- it must never retroactively relabel something
  // "cancelled" once action_started may already be durable. A concurrent
  // pause/stop/takeOver instead WAITS for this call's true outcome via
  // _dispatchApprovedAndApplyTracked's entry in _inFlightOps.
  async _dispatchApproved(descriptor, action, epoch, { durable = true } = {}) {
    if (this._stopHappenedSince(epoch)) {
      return { status: "not_dispatched", actionId: null, action, descriptor };
    }
    const actionId = randomUUID();
    // action_started stays durable (default): recovery's execution_uncertain
    // check depends on this specific write being fsync'd before execute()
    // ever runs -- see streamJournalReplay's openActionId handling.
    await this._store.append({ type: "action_started", payload: { actionId } }, { durable });
    let result;
    try {
      // Carry the epoch of the observation the proposal was actually based
      // on, not null: null disables BrowserAdapter.execute()'s stale-
      // document guard outright, letting a follow_link/scroll proposed
      // against a page that has since redirected or navigated act on the
      // wrong document instead of failing closed with stale_document.
      const documentEpoch = this._lastObservation ? this._lastObservation.documentEpoch : null;
      result = await this._browser.execute(action, { signal: undefined, documentEpoch });
    } catch {
      result = { status: "failed", errorCode: "execute_threw" };
    }
    // Count every committed execution regardless of whether ownership
    // changed (resume -> takeover) while it was in flight: action_started,
    // the real execute(), and action_outcome all already happened, so
    // skipping the budget increment here would let repeated takeover during
    // execution perform more real actions than maxActions allows.
    this._budgets.actionsUsed += 1;
    // durable:false: the NEXT action_started's own durable append (same
    // loop, common case) or the checkpoint at whatever pause/stop follows
    // this one (rare case) flushes this write before either commits
    // anything that depends on it. Worst case on a real crash right after
    // this line, this outcome simply isn't on disk yet -- recovery then
    // sees an open action_started with no outcome and reports
    // execution_uncertain, the same fail-closed result as today; it never
    // reports success for something that did not durably complete.
    await this._store.append({ type: "action_outcome", payload: { actionId, status: result.status } }, { durable: false });
    return { ...result, actionId, action, descriptor };
  }

  async _afterActionDispatched(proposal, result, epoch) {
    // Harness v2 Phase 2 Task 4: only a successful "observe" action leaves a
    // reusable snapshot; any other dispatched action (even read-only ones
    // like scroll) clears it, since this cache's only safety property is
    // "the last thing we dispatched was itself the observation in hand."
    this._reusableObservation = result.action?.type === "observe" && result.status === "ok" && result.observation
      ? result.observation
      : null;

    // No-progress detection: 3 consecutive dispatches of the identical
    // (action, observation) pair with no newly-verified criterion earns one
    // free forced replan; a second such streak pauses no_progress (design
    // doc section 5).
    const key = `${JSON.stringify(result.action)}::${observationKey(this._lastObservation)}`;
    let madeProgress = false;

    if (result.evidenceCandidate) {
      for (const criterionId of proposal.criterionIds) {
        const criterion = this._goal.criteria.find((c) => c.id === criterionId);
        if (!criterion) continue;
        const candidateEvidence = {
          id: randomUUID(),
          taskId: this._goal.taskId,
          goalVersion: this._goal.goalVersion,
          criterionId,
          kind: result.evidenceCandidate.kind || "host_check",
          observationId: result.evidenceCandidate.observationId,
          sourceUrl: result.evidenceCandidate.sourceUrl,
          artifactHash: result.evidenceCandidate.artifactHash,
          at: new Date().toISOString(),
          verification: "pending",
        };
        const verdict = verifyCriterion(criterion, [candidateEvidence], this._hostVerifier);
        const finalEvidence = { ...candidateEvidence };
        if (verdict.status !== "pending") {
          finalEvidence.verification = verdict.status;
          finalEvidence.verifierId = "host";
        }
        // durable:false, same reasoning as action_outcome above: this is
        // still inside the autonomous per-action hot path (right after
        // action_outcome, before this._criteriaStatus.set() below), and the
        // next action_started or the checkpoint before any pause/stop
        // flushes it. checkpoint()'s own flush-before-snapshot ordering is
        // exactly what keeps a checkpointed criteriaStatus from ever
        // outrunning the evidence record that justified it.
        await this._store.append({ type: "evidence_recorded", payload: { evidence: finalEvidence } }, { durable: false });
        const previous = this._criteriaStatus.get(criterionId);
        this._criteriaStatus.set(criterionId, {
          status: verdict.status,
          evidenceId: finalEvidence.id,
          goalVersion: finalEvidence.goalVersion,
        });
        if (verdict.status === "verified" && (!previous || previous.status !== "verified" || previous.goalVersion !== finalEvidence.goalVersion)) {
          madeProgress = true;
        }
      }
    }

    if (madeProgress) {
      this._noProgress = { lastKey: null, consecutive: 0, hasReplannedOnce: false };
      return;
    }

    if (key === this._noProgress.lastKey) {
      this._noProgress.consecutive += 1;
    } else {
      this._noProgress = { lastKey: key, consecutive: 1, hasReplannedOnce: this._noProgress.hasReplannedOnce };
    }

    if (this._noProgress.consecutive >= this._noProgressThreshold) {
      if (!this._noProgress.hasReplannedOnce) {
        this._noProgress = { lastKey: key, consecutive: 0, hasReplannedOnce: true };
        await this._store.append({ type: "note", payload: { msg: "no-progress streak detected; forcing one replan" } });
      } else {
        await this._pauseWith("no_progress");
      }
    }
  }
}

module.exports = { TaskController, TaskControllerError };
