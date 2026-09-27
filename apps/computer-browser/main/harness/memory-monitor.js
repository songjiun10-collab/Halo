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
  constructor({ getAppMetrics, getExternalMemoryBytes, limitBytes } = {}) {
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
      byProcess.push({ key, label: `external:${label}`, bytes });
    }

    let totalBytes = 0;
    for (const bytes of counted.values()) totalBytes += bytes;

    this._lastTotalBytes = totalBytes;
    return { totalBytes, unmeasurable, byProcess };
  }

  // Reflects the most recent sample() -- callers (task-controller.js's
  // per-dispatch check) are expected to sample() on their own cadence, not
  // have every check trigger a fresh OS query.
  getPressureLevel() {
    const total = this._lastTotalBytes;
    if (total >= this._limitBytes * EMERGENCY_FRACTION) return "emergency";
    if (total >= this._limitBytes * PAUSE_FRACTION) return "pause";
    if (total >= this._limitBytes * CAUTION_FRACTION) return "caution";
    return "normal";
  }
}

module.exports = { MemoryMonitor, MemoryMonitorError, DEFAULT_LIMIT_BYTES };
