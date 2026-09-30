"use strict";

// ResourceAdmission (multi-agent background runtime plan, Task 2): one
// promise-serialized ledger sitting on top of MemoryMonitor so that every
// top-level task AND every future child agent (Task 3/4) reserves memory
// through the SAME authority before any browser/planner is constructed.
// MemoryMonitor.canAdmitTask() alone answers "is there room right now", but
// its answer is only as fresh as the last sample() -- two callers evaluating
// concurrently against that same sample could each see enough headroom
// individually and both be admitted, together exceeding the budget. This
// module removes that race by (a) serializing every acquire()/release()
// through one internal chain, and (b) padding a budgeted request with the
// reservations of any other lease granted against the identical sample
// (tracked by MemoryMonitor.getLastSample()'s sampledAt), so those bytes are
// never spent twice before a fresh measurement confirms one way or another.
//
// A `parentPolicy.mode === "user_override"` lease bypasses both the budget
// check and the pressure-pause gate below -- this is the durable, per-run
// exception the design doc requires when a user explicitly disables HALO's
// admission ceiling for one parent run. It never disables MemoryMonitor's
// own sampling/pressure reporting; it only changes whether THIS ledger
// denies for memory reasons.

const { randomUUID } = require("node:crypto");

const DEFAULT_MAX_AGE_MS = 7500;
const PARENT_POLICY_MODES = ["budgeted", "user_override"];

class ResourceAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResourceAdmissionError";
    this.code = code;
  }
}

function normalizeParentPolicy(parentPolicy) {
  if (parentPolicy === undefined || parentPolicy === null) return null;
  if (typeof parentPolicy !== "object" || Array.isArray(parentPolicy)) {
    throw new ResourceAdmissionError("invalid_field", "parentPolicy must be a plain object when provided");
  }
  const { mode, parentTaskId, requestedAgentCount } = parentPolicy;
  if (!PARENT_POLICY_MODES.includes(mode)) {
    throw new ResourceAdmissionError("invalid_field", `parentPolicy.mode must be one of ${PARENT_POLICY_MODES.join("|")}`);
  }
  if (parentTaskId !== undefined && parentTaskId !== null && (typeof parentTaskId !== "string" || parentTaskId.length === 0)) {
    throw new ResourceAdmissionError("invalid_field", "parentPolicy.parentTaskId must be a non-empty string when provided");
  }
  if (requestedAgentCount !== undefined && requestedAgentCount !== null && (!Number.isInteger(requestedAgentCount) || requestedAgentCount < 1)) {
    throw new ResourceAdmissionError("invalid_field", "parentPolicy.requestedAgentCount must be a positive integer when provided");
  }
  return Object.freeze({ mode, parentTaskId: parentTaskId ?? null, requestedAgentCount: requestedAgentCount ?? null });
}

class ResourceAdmission {
  constructor({ memoryMonitor, now } = {}) {
    if (!memoryMonitor || typeof memoryMonitor.canAdmitTask !== "function" || typeof memoryMonitor.getPressureLevel !== "function") {
      throw new ResourceAdmissionError("invalid_config", "memoryMonitor with canAdmitTask/getPressureLevel is required");
    }
    this._memoryMonitor = memoryMonitor;
    this._now = typeof now === "function" ? now : Date.now;
    // leaseId -> { ownerId, reservedBytes, parentPolicy, sampledAt, createdAt }
    this._leases = new Map();
    this._ownerIds = new Set();
    this._chain = Promise.resolve();
  }

  acquire(request) {
    const operation = this._chain.then(() => this._acquireLocked(request));
    this._chain = operation.then(() => {}, () => {});
    return operation;
  }

  async _acquireLocked({ ownerId, reserveBytes, maxAgeMs = DEFAULT_MAX_AGE_MS, parentPolicy } = {}) {
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      throw new ResourceAdmissionError("invalid_field", "ownerId is required");
    }
    if (typeof reserveBytes !== "number" || !Number.isFinite(reserveBytes) || reserveBytes < 0) {
      throw new ResourceAdmissionError("invalid_field", "reserveBytes must be a non-negative finite number");
    }
    const policy = normalizeParentPolicy(parentPolicy);

    if (this._ownerIds.has(ownerId)) {
      return { admitted: false, reason: "duplicate_owner" };
    }

    if (policy && policy.mode === "user_override") {
      return this._grant({ ownerId, reservedBytes: reserveBytes, parentPolicy: policy, sampledAt: null });
    }

    const probe = this._memoryMonitor.canAdmitTask({ reserveBytes, maxAgeMs });
    if (!probe.allowed) return { admitted: false, reason: probe.reason };

    const sample = this._getLastSample();
    const sampledAt = sample ? sample.sampledAt : null;
    const pending = this._sumPendingForSample(sampledAt);
    if (pending > 0) {
      const padded = this._memoryMonitor.canAdmitTask({ reserveBytes: reserveBytes + pending, maxAgeMs });
      if (!padded.allowed) return { admitted: false, reason: "memory_budget_exceeded" };
    }

    const pressure = this._memoryMonitor.getPressureLevel();
    if (pressure === "pause" || pressure === "emergency") {
      return { admitted: false, reason: "memory_pressure_pause" };
    }

    return this._grant({ ownerId, reservedBytes: reserveBytes, parentPolicy: policy, sampledAt });
  }

  // Leases granted against the IDENTICAL sample count as pending. An explicit
  // user_override has no admission sample, so its reserve is conservatively
  // counted until a strictly newer complete sample could include its process
  // tree. This prevents an override task that is still starting from leaving
  // unmeasured headroom available to a concurrent budgeted task.
  _sumPendingForSample(sampledAt) {
    if (sampledAt === null || sampledAt === undefined) return 0;
    let sum = 0;
    for (const lease of this._leases.values()) {
      if (lease.sampledAt === sampledAt || (lease.sampledAt == null && sampledAt <= lease.createdAt)) {
        sum += lease.reservedBytes;
      }
    }
    return sum;
  }

  _grant({ ownerId, reservedBytes, parentPolicy, sampledAt }) {
    const leaseId = randomUUID();
    this._leases.set(leaseId, { ownerId, reservedBytes, parentPolicy, sampledAt, createdAt: this._now() });
    this._ownerIds.add(ownerId);
    return { admitted: true, leaseId, ownerId, reservedBytes };
  }

  release(leaseId) {
    const operation = this._chain.then(() => this._releaseLocked(leaseId));
    this._chain = operation.then(() => {}, () => {});
    return operation;
  }

  async _releaseLocked(leaseId) {
    if (typeof leaseId !== "string" || leaseId.length === 0) {
      throw new ResourceAdmissionError("invalid_field", "leaseId is required");
    }
    const lease = this._leases.get(leaseId);
    if (!lease) return; // idempotent: already released (or a retry after a failed teardown)
    this._leases.delete(leaseId);
    this._ownerIds.delete(lease.ownerId);
  }

  // Not every injected memoryMonitor implements getLastSample() (it is only
  // required for the same-sample lease-padding refinement above) -- callers
  // that omit it simply get no sample identity, so padding/snapshot fall
  // back to null rather than throwing.
  _getLastSample() {
    return typeof this._memoryMonitor.getLastSample === "function" ? this._memoryMonitor.getLastSample() : null;
  }

  getSnapshot() {
    const sample = this._getLastSample();
    const leases = [...this._leases.entries()].map(([leaseId, lease]) => ({
      leaseId,
      ownerId: lease.ownerId,
      reservedBytes: lease.reservedBytes,
      mode: lease.parentPolicy?.mode ?? "budgeted",
    }));
    const mode = leases.some((lease) => lease.mode === "user_override") ? "user_override" : "budgeted";
    return { mode, leases, sampledAt: sample ? sample.sampledAt : null };
  }
}

module.exports = { ResourceAdmission, ResourceAdmissionError };
