"use strict";

// Admission seam for the task coordinator: parallel cap, memory reserve,
// lease bookkeeping. Depends only on injected collaborators (queue, resource
// admission, memory policy lookup) so it can move to another process
// unchanged; it must never require Electron, browser, planner or UI code.

const MEASURED_BROWSER_TASK_RESERVE_BYTES = 370_000_000;
const ADMISSION_MAX_AGE_MS = 7500;

class CoordinatorCoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoordinatorCoreError";
    this.code = code;
  }
}

class CoordinatorCore {
  constructor({
    queue,
    ensureQueue,
    getResourceAdmission,
    getRunMemoryPolicy,
    getExternalProcessHighWaterBytes,
    executionMode = "sequential",
    maxParallelTasks = 2,
    parallelTaskReserveBytes,
    isAdmissionBlocked = () => false,
    reclaimMemory,
  } = {}) {
    if (!queue || typeof queue.admitNext !== "function") throw new CoordinatorCoreError("invalid_config", "queue is required");
    if (typeof ensureQueue !== "function") throw new CoordinatorCoreError("invalid_config", "ensureQueue is required");
    if (typeof getResourceAdmission !== "function") throw new CoordinatorCoreError("invalid_config", "getResourceAdmission is required");
    if (typeof getRunMemoryPolicy !== "function") throw new CoordinatorCoreError("invalid_config", "getRunMemoryPolicy is required");
    if (typeof isAdmissionBlocked !== "function") throw new CoordinatorCoreError("invalid_config", "isAdmissionBlocked is required");
    this._queue = queue;
    this._ensureQueue = ensureQueue;
    this._getResourceAdmission = getResourceAdmission;
    this._getRunMemoryPolicy = getRunMemoryPolicy;
    this._getExternalProcessHighWaterBytes = typeof getExternalProcessHighWaterBytes === "function" ? getExternalProcessHighWaterBytes : () => undefined;
    this._executionMode = executionMode;
    this._maxParallelTasks = maxParallelTasks;
    this._parallelTaskReserveBytes = parallelTaskReserveBytes;
    this._isAdmissionBlocked = isAdmissionBlocked;
    // Optional: frees reclaimable memory (e.g. idle browser tabs) and returns true
    // when something was released, so admission can retry once against a fresh sample.
    this._reclaimMemory = typeof reclaimMemory === "function" ? reclaimMemory : null;
    this._leases = new Map();
    this._chain = Promise.resolve();
    this.recoveredBlocked = false;
    this._waitReason = null; // {taskId, reason} for the queue head's last refused admission
  }

  // Why a queued task has not started, for the person watching. The head reports
  // the reason its last admission attempt was refused; the rest are behind it.
  getWaitReason(taskId, position) {
    if (position > 1) return "behind_queue";
    return this._waitReason && this._waitReason.taskId === taskId ? this._waitReason.reason : null;
  }

  _wait(taskId, reason) {
    this._waitReason = taskId ? { taskId, reason } : null;
    return null;
  }

  hasLease(taskId) {
    return this._leases.has(taskId);
  }

  async releaseLease(taskId) {
    const leaseId = this._leases.get(taskId);
    if (!leaseId) return;
    await this._getResourceAdmission()?.release(leaseId);
    this._leases.delete(taskId);
  }

  admitNext(options = {}) {
    const operation = this._chain.then(() => this._admitNextLocked(options));
    this._chain = operation.then(() => {}, () => {});
    return operation;
  }

  async _admitNextLocked({ recoveredHead = false } = {}) {
    await this._ensureQueue();
    const candidateId = this._queue.pendingIds()[0];
    if (!candidateId) return this._wait(null);
    if (this.recoveredBlocked && !recoveredHead) return this._wait(candidateId, "recovered_needs_user");
    if (this._isAdmissionBlocked()) return this._wait(candidateId, "shutting_down_previous_task");
    const activeCount = this._queue.activeIds().length;
    const maxActive = this._executionMode === "parallel" ? this._maxParallelTasks : 1;
    if (activeCount >= maxActive) return this._wait(candidateId, "waiting_for_running_task");
    const selected = await this._getRunMemoryPolicy(candidateId);
    if (this._isAdmissionBlocked()) return this._wait(candidateId, "shutting_down_previous_task");
    const resourceAdmission = this._getResourceAdmission();
    // Monitor-less injected hosts retain sequential behavior. Production
    // supplies MemoryMonitor and always takes the shared lease path.
    if (!resourceAdmission) return this._queue.admitNext({ maxActive: 1 });
    let reserveBytes = this._parallelTaskReserveBytes;
    if (reserveBytes === undefined) {
      const plannerHighWater = this._getExternalProcessHighWaterBytes("planner");
      // The first task bootstraps the planner measurement in a single slot.
      // Any additional budgeted task needs the measured planner increment.
      if (activeCount > 0 && selected.mode === "budgeted" && (!Number.isFinite(plannerHighWater) || plannerHighWater <= 0)) return this._wait(candidateId, "measuring_first_task");
      reserveBytes = MEASURED_BROWSER_TASK_RESERVE_BYTES +
        (Number.isFinite(plannerHighWater) && plannerHighWater > 0 ? Math.ceil(plannerHighWater * 1.25) : 0);
    }
    if (!Number.isFinite(reserveBytes) || reserveBytes <= 0) return null;
    const request = {
      ownerId: candidateId,
      reserveBytes,
      maxAgeMs: ADMISSION_MAX_AGE_MS,
      parentPolicy: { mode: selected.mode, parentTaskId: candidateId, requestedAgentCount: 1 },
    };
    let admission = await resourceAdmission.acquire(request);
    if (!admission.admitted && admission.reason === "memory_budget_exceeded" && this._reclaimMemory) {
      let reclaimed = false;
      try { reclaimed = await this._reclaimMemory(); } catch { reclaimed = false; }
      if (reclaimed) admission = await resourceAdmission.acquire(request);
    }
    if (!admission.admitted) return this._wait(candidateId, admission.reason || "admission_refused");
    if (this._isAdmissionBlocked()) {
      await resourceAdmission.release(admission.leaseId);
      return this._wait(candidateId, "shutting_down_previous_task");
    }
    try {
      const admittedId = await this._queue.admitNext({ maxActive });
      if (admittedId === candidateId) {
        this._leases.set(candidateId, admission.leaseId);
        this._wait(null);
        return admittedId;
      }
      await resourceAdmission.release(admission.leaseId);
      return null;
    } catch (error) {
      await resourceAdmission.release(admission.leaseId);
      throw error;
    }
  }
}

module.exports = { CoordinatorCore, CoordinatorCoreError, MEASURED_BROWSER_TASK_RESERVE_BYTES };
