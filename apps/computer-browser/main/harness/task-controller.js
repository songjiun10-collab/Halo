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
  // it only needs to be deterministic and cheap to compare.
  try {
    return JSON.stringify(observation);
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

    this._budgets = { actionsUsed: 0, plannerCallsUsed: 0, activeMs: 0 };
    this._activeSince = null;
    this._segment = { index: 0, callsInSegment: 0 };
    this._criteriaStatus = new Map(); // criterionId -> {status, evidenceId}
    this._noProgress = { lastKey: null, consecutive: 0, hasReplannedOnce: false };
    this._approvalQueue = [];
    this._lastObservation = null;

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

  _stopHappenedSince(epoch) {
    return epoch !== this._epoch;
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
    await this._store.checkpoint({
      task: { ...this._task },
      budgets: { ...this._budgets },
      segment: { ...this._segment },
      criteriaStatus: [...this._criteriaStatus.entries()],
    });
  }

  async _pauseWith(reason) {
    this._leaveActive();
    this._task = { state: "paused", pauseReason: reason };
    await this._checkpoint();
  }

  async start() {
    if (this._task.state !== "idle") {
      throw new TaskControllerError("invalid_state", `start() requires state idle, got ${this._task.state}`);
    }
    this._task = { state: "running", pauseReason: null };
    return this._runLoop();
  }

  async resume(opts = {}) {
    if (this._task.state !== "paused") {
      throw new TaskControllerError("invalid_state", `resume() requires state paused, got ${this._task.state}`);
    }
    if (this._task.pauseReason === "execution_uncertain" && !opts.confirmed) {
      throw new TaskControllerError(
        "confirmation_required",
        "resume() from execution_uncertain requires resume({confirmed: true}) -- the dangling action is never auto-replayed",
      );
    }
    this._task = { state: "running", pauseReason: null };
    // Any interruption's cursor is meaningless now -- resume always starts
    // the next iteration with a completely fresh observation (design doc
    // section 7: "resume은 새 observation부터 시작한다. 이미 끝난 action은
    // 재생하지 않는다").
    this._lastObservation = null;
    return this._runLoop();
  }

  async pause(reason = "user") {
    if (!["running", "awaiting_approval"].includes(this._task.state)) return this.getSnapshot();
    this._epoch += 1; // invalidate any in-flight planner/approver round-trip
    await this._pauseWith(reason);
    return this.getSnapshot();
  }

  async stop() {
    this._epoch += 1;
    this._leaveActive();
    this._task = { state: "stopped", pauseReason: null };
    await this._checkpoint();
    return this.getSnapshot();
  }

  async amend(amendmentInput) {
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

  async approve(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    if (this._approvalQueue.length === 0 && this._task.state === "awaiting_approval") {
      this._task = { state: "running", pauseReason: null };
    }
    this._enterActive();
    const epoch = this._epoch;
    const result = await this._dispatchApproved(item.descriptor, item.action, epoch);
    if (this._stopHappenedSince(epoch)) return this.getSnapshot();
    await this._afterActionDispatched(item.proposal, result, epoch);
    if (this._task.state === "running") return this._runLoop();
    return this.getSnapshot();
  }

  async deny(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    // Nothing was ever dispatched for a queued-but-denied item (no
    // action_started was written for it -- see _dispatchActionsBatch), so
    // there is no action lifecycle event to close out here, only the queue
    // entry to drop.
    this._approvalQueue.splice(index, 1);
    if (this._approvalQueue.length === 0 && this._task.state === "awaiting_approval") {
      this._task = { state: "running", pauseReason: null };
      return this._runLoop();
    }
    return this.getSnapshot();
  }

  // --- internal loop ---

  async _runLoop() {
    if (this._loopRunning) return this.getSnapshot();
    this._loopRunning = true;
    try {
      while (this._task.state === "running") {
        const epoch = this._epoch;
        this._enterActive();

        const pressure = this._memoryMonitor.getPressureLevel();
        if (pressure === "pause" || pressure === "emergency") {
          await this._pauseWith("memory_pressure");
          break;
        }

        if (this._budgets.plannerCallsUsed >= this._goal.limits.maxPlannerCalls || this._budgets.activeMs >= this._goal.limits.maxActiveMs) {
          await this._pauseWith("budget_exhausted");
          break;
        }

        let observation;
        try {
          observation = await this._browser.observe({ signal: undefined });
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
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          await this._pauseWith("planner_error");
          break;
        }
        if (this._stopHappenedSince(epoch)) break;

        this._segment.callsInSegment += 1;
        if (this._segment.callsInSegment >= this._segmentRotationCalls) {
          this._segment.callsInSegment = 0;
          this._segment.index += 1;
        }

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
        await this._pauseWith("memory_pressure");
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
          descriptor,
          action,
          proposal,
        });
        this._leaveActive();
        this._task = { state: "awaiting_approval", pauseReason: null };
        await this._checkpoint();
        return "stop_loop";
      }
      if (decision.decision !== "allow") {
        // deny/quarantine: skip this action, keep the loop going with the rest.
        continue;
      }

      const result = await this._dispatchApproved(descriptor, action, epoch);
      if (this._stopHappenedSince(epoch)) return "stop_loop";
      await this._afterActionDispatched(proposal, result, epoch);
      if (this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
    }
    return "continue";
  }

  async _dispatchApproved(descriptor, action, epoch) {
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
