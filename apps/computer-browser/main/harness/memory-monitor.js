"use strict";

// MemoryMonitor (design doc section 10, user mandate 2026-09-27): sums the
// REAL OS process memory of every process HALO's computer-browser actually
// launches -- Electron main/renderer/GPU/utility (via app.getAppMetrics(),
// values in KB per Electron's documented MemoryInfo structure) plus any
// externally-spawned process this host registers (the Python approver, a
// local planner worker) via an injected OS-level lookup. This must never be
// satisfied by measuring V8 heap size alone or by excluding worker
// processes from the total -- both getAppMetrics and getExternalMemoryBytes
// are real, injectable seams so this module has no direct Electron/child-
// process dependency of its own (Task 5's host wiring supplies the real
// ones), and tests exercise the actual summation/dedup/pressure logic.
//
// Honest limitation (must not be papered over): this is polling-based.
// Between two sample() calls, a page or process can spike arbitrarily high
// and back down before the next poll -- no purely userspace, non-realtime
// poll loop can guarantee an absolute instantaneous hard cap against that.
// This does not excuse skipping real measurement or the pressure response;
// it is a real, disclosed bound on what polling can promise.

const DEFAULT_LIMIT_BYTES = 1_000_000_000; // decimal 1GB cap -- see class doc
const CAUTION_FRACTION = 0.7;
const PAUSE_FRACTION = 0.8;
const EMERGENCY_FRACTION = 0.9;

class MemoryMonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryMonitorError";
    this.code = code;
  }
}

function processKey(pid, creationTime) {
  return `${pid}:${creationTime}`;
}

class MemoryMonitor {
  constructor({ getAppMetrics, getExternalMemoryBytes, limitBytes, now } = {}) {
    if (typeof getAppMetrics !== "function") {
      throw new MemoryMonitorError("invalid_config", "getAppMetrics is required");
    }
    this._getAppMetrics = getAppMetrics;
    this._getExternalMemoryBytes = typeof getExternalMemoryBytes === "function" ? getExternalMemoryBytes : async () => null;
    this._limitBytes = DEFAULT_LIMIT_BYTES;
    if (limitBytes !== undefined) this.setLimitBytes(limitBytes);
    // pid -> {pid, creationTime, label}
    this._externalProcesses = new Map();
    this._lastTotalBytes = 0;
    this._lastSampleDegraded = false;
    this._lastSample = null;
    this._externalHighWaterBytes = new Map();
    this._now = typeof now === "function" ? now : Date.now;
  }

  // The user's own configured cap can be lowered (a more conservative
  // measurement-informed value) but never raised above the hard 1GB
  // ceiling -- this rejects any attempt to do so outright rather than
  // silently clamping, so a misconfiguration is loud, not silent.
  setLimitBytes(limitBytes) {
    if (typeof limitBytes !== "number" || !Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new MemoryMonitorError("invalid_field", "limitBytes must be a positive finite number");
    }
    if (limitBytes > DEFAULT_LIMIT_BYTES) {
      throw new MemoryMonitorError("limit_too_high", `limitBytes ${limitBytes} exceeds the 1,000,000,000-byte hard cap`);
    }
    this._limitBytes = limitBytes;
  }

  registerExternalProcess({ pid, creationTime, label } = {}) {
    if (typeof pid !== "number") throw new MemoryMonitorError("invalid_field", "pid is required");
    if (typeof creationTime !== "number") throw new MemoryMonitorError("invalid_field", "creationTime is required");
    if (typeof label !== "string" || label.length === 0) throw new MemoryMonitorError("invalid_field", "label is required");
    this._externalProcesses.set(pid, { pid, creationTime, label });
  }

  unregister(pid, creationTime) {
    const current = this._externalProcesses.get(pid);
    if (!current) return;
    // Lifecycle callbacks can arrive late. When the OS recycles a pid for a
    // newer worker, an old exit event must not unregister the new process.
    if (creationTime !== undefined && current.creationTime !== creationTime) return;
    this._externalProcesses.delete(pid);
  }

  // {totalBytes, unmeasurable: string[], byProcess: [{key,label,bytes|null}]}
  async sample() {
    const counted = new Map(); // processKey -> bytes
    const unmeasurable = [];
    const byProcess = [];

    for (const metric of this._getAppMetrics()) {
      const key = processKey(metric.pid, metric.creationTime ?? metric.pid);
      const kb = metric.memory && typeof metric.memory.workingSetSize === "number" ? metric.memory.workingSetSize : null;
      if (kb === null) {
        unmeasurable.push(`electron:${metric.type || "unknown"}:pid=${metric.pid}`);
        byProcess.push({ key, label: `electron:${metric.type || "unknown"}`, bytes: null });
        continue;
      }
      const bytes = kb * 1024;
      counted.set(key, bytes);
      byProcess.push({ key, label: `electron:${metric.type || "unknown"}`, bytes });
    }

    for (const { pid, creationTime, label } of this._externalProcesses.values()) {
      const key = processKey(pid, creationTime);
      if (counted.has(key)) continue; // Electron already reported this exact (pid, creationTime)
      let bytes = null;
      try {
        bytes = await this._getExternalMemoryBytes(pid);
      } catch {
        bytes = null;
      }
      // The child may have exited (and its pid may already have been
      // unregistered/reused) while the asynchronous OS lookup was pending.
      // Revalidate the generation for both successful and failed lookups;
      // otherwise a late successful `ps` result can count an unrelated
      // process against this old registration.
      const current = this._externalProcesses.get(pid);
      if (!current || processKey(current.pid, current.creationTime) !== key) continue;
      if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
        // The external child may have exited while this asynchronous `ps`
        // lookup was in flight. Its lifecycle callback unregisters it at
        // exit; if that exact (pid, creationTime) is no longer live by the
        // time lookup settles, do not report a stale sample as an
        // unmeasurable *current* process (and do not accidentally attribute
        // a recycled pid to its previous owner).
        unmeasurable.push(`external:${label}:pid=${pid}`);
        byProcess.push({ key, label: `external:${label}`, bytes: null });
        continue;
      }
      counted.set(key, bytes);
      const highWater = this._externalHighWaterBytes.get(label) ?? 0;
      this._externalHighWaterBytes.set(label, Math.max(highWater, bytes));
      byProcess.push({ key, label: `external:${label}`, bytes });
    }

    let totalBytes = 0;
    for (const bytes of counted.values()) totalBytes += bytes;

    // An unmeasurable process's bytes are simply missing from totalBytes --
    // replacing _lastTotalBytes outright would silently undercount it as
    // zero. Keep the more conservative of the two readings instead, and flag
    // the degraded state so getPressureLevel() (which has no other
    // visibility into per-process unmeasurable status) can fail closed.
    const degraded = unmeasurable.length > 0;
    this._lastTotalBytes = degraded ? Math.max(totalBytes, this._lastTotalBytes) : totalBytes;
    this._lastSampleDegraded = degraded;
    this._lastSample = { totalBytes, unmeasurable: [...unmeasurable], sampledAt: this._now() };
    return { totalBytes, unmeasurable, byProcess, sampledAt: this._lastSample.sampledAt };
  }

  // Admission is stricter than pressure reporting: a stale or incomplete
  // sample cannot justify starting another renderer/worker. `reserveBytes`
  // must come from a measured conservative per-task increment, not a guess.
  canAdmitTask({ reserveBytes, maxAgeMs = 7500 } = {}) {
    if (typeof reserveBytes !== "number" || !Number.isFinite(reserveBytes) || reserveBytes < 0 ||
        typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new MemoryMonitorError("invalid_field", "reserveBytes and maxAgeMs must be non-negative finite numbers");
    }
    const sample = this._lastSample;
    const ageMs = sample ? Math.max(0, this._now() - sample.sampledAt) : null;
    const common = {
      usedBytes: sample?.totalBytes ?? null,
      reserveBytes,
      limitBytes: this._limitBytes,
      ageMs,
    };
    if (!sample || ageMs > maxAgeMs) return { ...common, allowed: false, reason: "memory_sample_stale" };
    if (sample.unmeasurable.length > 0) return { ...common, allowed: false, reason: "memory_unmeasurable" };
    if (sample.totalBytes + reserveBytes >= this._limitBytes) return { ...common, allowed: false, reason: "memory_budget_exceeded" };
    return { ...common, allowed: true, reason: null };
  }

  // Exposes the same sample canAdmitTask()/getPressureLevel() already
  // consult, so a caller (ResourceAdmission) can tell whether two admission
  // decisions were made against the identical measurement -- canAdmitTask's
  // own return value has no stable sample identity, only a relative ageMs.
  getLastSample() {
    return this._lastSample ? { ...this._lastSample, unmeasurable: [...this._lastSample.unmeasurable] } : null;
  }

  getExternalProcessHighWaterBytes(label) {
    if (typeof label !== "string" || !label) throw new MemoryMonitorError("invalid_field", "label is required");
    return this._externalHighWaterBytes.get(label) ?? null;
  }

  // Reflects the most recent sample() -- callers (task-controller.js's
  // per-dispatch check) are expected to sample() on their own cadence, not
  // have every check trigger a fresh OS query.
  getPressureLevel() {
    const total = this._lastTotalBytes;
    let level;
    if (total >= this._limitBytes * EMERGENCY_FRACTION) level = "emergency";
    else if (total >= this._limitBytes * PAUSE_FRACTION) level = "pause";
    else if (total >= this._limitBytes * CAUTION_FRACTION) level = "caution";
    else level = "normal";
    // A degraded (partially unmeasurable) sample cannot honestly report
    // normal/caution -- an unmeasured process could already be well past the
    // real pressure this reading shows. Fail closed to "pause" rather than
    // let a hot-loop caller read a falsely comfortable level.
    if (this._lastSampleDegraded && (level === "normal" || level === "caution")) return "pause";
    return level;
  }
}

module.exports = { MemoryMonitor, MemoryMonitorError, DEFAULT_LIMIT_BYTES };
