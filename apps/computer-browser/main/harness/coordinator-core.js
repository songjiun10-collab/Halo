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
    this._leases = new Map();
    this._chain = Promise.resolve();
    this.recoveredBlocked = false;
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
    if ((this.recoveredBlocked && !recoveredHead) || this._isAdmissionBlocked()) return null;
    const candidateId = this._queue.pendingIds()[0];
    if (!candidateId) return null;
    const activeCount = this._queue.activeIds().length;
    const maxActive = this._executionMode === "parallel" ? this._maxParallelTasks : 1;
    if (activeCount >= maxActive) return null;
    const selected = await this._getRunMemoryPolicy(candidateId);
    if (this._isAdmissionBlocked()) return null;
    const resourceAdmission = this._getResourceAdmission();
    // Monitor-less injected hosts retain sequential behavior. Production
    // supplies MemoryMonitor and always takes the shared lease path.
    if (!resourceAdmission) return this._queue.admitNext({ maxActive: 1 });
    let reserveBytes = this._parallelTaskReserveBytes;
    if (reserveBytes === undefined) {
      const plannerHighWater = this._getExternalProcessHighWaterBytes("planner");
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
      maxAgeMs: ADMISSION_MAX_AGE_MS,
      parentPolicy: { mode: selected.mode, parentTaskId: candidateId, requestedAgentCount: 1 },
    });
    if (!admission.admitted) return null;
    if (this._isAdmissionBlocked()) {
      await resourceAdmission.release(admission.leaseId);
      return null;
    }
    try {
      const admittedId = await this._queue.admitNext({ maxActive });
      if (admittedId === candidateId) {
        this._leases.set(candidateId, admission.leaseId);
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
