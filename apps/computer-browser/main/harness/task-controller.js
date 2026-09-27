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
const { buildContext } = require("./context-builder");
const { validateProposal, verifyCriterion, canComplete } = require("./progress");

class TaskControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskControllerError";
    this.code = code;
  }
}

const NOOP_MEMORY_MONITOR = { getPressureLevel: () => "normal" };

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
  } = {}) {
    if (!store) throw new TaskControllerError("invalid_config", "store is required");
    if (!planner) throw new TaskControllerError("invalid_config", "planner is required");
    if (!browser) throw new TaskControllerError("invalid_config", "browser is required");
    if (!approve) throw new TaskControllerError("invalid_config", "approve is required");
    if (!hostVerifier) throw new TaskControllerError("invalid_config", "hostVerifier is required");

    this._store = store;
    this._planner = planner;
    this._browser = browser;
    this._approve = approve;
    this._hostVerifier = hostVerifier;
    this._memoryMonitor = memoryMonitor || NOOP_MEMORY_MONITOR;
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
  }

  getGoal() {
    return this._goal;
  }

  getSnapshot() {
    return {
      state: this._task.state,
      pauseReason: this._task.pauseReason,
      goalVersion: this._goal.goalVersion,
      budgets: { ...this._budgets },
      segment: { ...this._segment },
      criteriaStatus: [...this._criteriaStatus.entries()].map(([criterionId, v]) => ({ criterionId, ...v })),
      approvalQueue: this._approvalQueue.map(({ id, summary, actionType, createdAt }) => ({ id, summary, action: actionType, createdAt })),
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
        await this._store.append({
          type: "approval_cancelled",
          payload: {
            requestId: item.id,
            actionType: item.actionType,
            goalVersion: item.goalVersion,
            reason: cancelReason,
          },
        });
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
  async _dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch) {
    const op = (async () => {
      const result = await this._dispatchApproved(descriptor, action, epoch);
      if (this._stopHappenedSince(epoch)) return { stale: true, result };
      await this._afterActionDispatched(proposal, result, epoch);
      return { stale: false, result };
    })();
    const result = await this._trackInFlight(op);
    this._emit();
    return result;
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
    // 재생하지 않는다").
    this._lastObservation = null;
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

    if (outcome === "verified" && this._task.state === "awaiting_verification") {
      const completion = canComplete(this._goal, this._evidenceForCompletionCheck());
      if (completion.complete) {
        this._task = { state: "completed", pauseReason: null };
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
    const dispatched = await this._dispatchApprovedAndApplyTracked(item.proposal, item.descriptor, item.action, epoch);
    if (dispatched.stale || this._stopHappenedSince(epoch)) return this.getSnapshot();
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

        if (this._budgets.plannerCallsUsed >= this._goal.limits.maxPlannerCalls || this._budgets.activeMs >= this._goal.limits.maxActiveMs) {
          await this._pauseWith("budget_exhausted");
          break;
        }

        let observation;
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
        if (this._stopHappenedSince(epoch)) break;
        this._lastObservation = observation;

        const context = buildContext({
          goal: this._goal,
          state: {
            criteriaStatus: this.getSnapshot().criteriaStatus,
            segment: { ...this._segment },
            budgets: { ...this._budgets },
          },
          observation,
          recentEvents: this._store.eventsSinceCheckpoint || [],
        });

        let proposal;
        try {
          proposal = await this._planner.next(context, { signal: undefined });
          this._budgets.plannerCallsUsed += 1;
        } catch (error) {
          if (this._stopHappenedSince(epoch)) break;
          // planner-stdio.js's PlannerTransportError distinguishes "no
          // worker command is configured at all" (code "planner_unavailable")
          // from a genuine transport failure (timeout, malformed response,
          // etc.) -- the design doc requires the former to surface honestly
          // as its own pause reason rather than the generic planner_error,
          // so a host UI can tell "nothing is wired up" apart from "the
          // configured planner broke".
          await this._pauseWith(error && error.code === "planner_unavailable" ? "planner_unavailable" : "planner_error");
          break;
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
          validated = validateProposal(proposal, { goal: this._goal });
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
      const descriptor = {
        requestId,
        action: action.type,
        origin: (this._lastObservation && this._lastObservation.url) || "",
        summary: `Planner proposes ${action.type}`,
        selfProvenance: "untrusted",
        source: "page_content",
        targetScope: "external",
      };

      let decision;
      try {
        decision = await this._approve(descriptor);
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
        continue;
      }

      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch);
      if (dispatched.stale || this._stopHappenedSince(epoch)) return "stop_loop";
      if (this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
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
  async _dispatchApproved(descriptor, action, epoch) {
    if (this._stopHappenedSince(epoch)) {
      return { status: "not_dispatched", actionId: null, action, descriptor };
    }
    const actionId = randomUUID();
    await this._store.append({ type: "action_started", payload: { actionId } });
    let result;
    try {
      result = await this._browser.execute(action, { signal: undefined, documentEpoch: null });
    } catch {
      result = { status: "failed", errorCode: "execute_threw" };
    }
    if (!this._stopHappenedSince(epoch)) {
      this._budgets.actionsUsed += 1;
    }
    await this._store.append({ type: "action_outcome", payload: { actionId, status: result.status } });
    return { ...result, actionId, action, descriptor };
  }

  async _afterActionDispatched(proposal, result, epoch) {
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
        await this._store.append({ type: "evidence_recorded", payload: { evidence: finalEvidence } });
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
