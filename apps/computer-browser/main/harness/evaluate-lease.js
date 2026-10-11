"use strict";

// Leases gating the `evaluate` (page-script) action. Evaluate is never on by
// default: it needs an explicit, origin-scoped, expiring, use-limited grant,
// and every grant/use/denial is recorded for audit.

class EvaluateLeases {
  constructor({ ttlMs = 60000, maxUses = 3, now = () => Date.now() } = {}) {
    this._ttl = ttlMs;
    this._maxUses = maxUses;
    this._now = now;
    this._leases = new Map();
    this._audit = [];
  }

  _key(taskId, origin) {
    return `${taskId}|${origin}`;
  }

  grant(taskId, origin, purpose) {
    this._leases.set(this._key(taskId, origin), { purpose, expiresAt: this._now() + this._ttl, uses: 0 });
    this._audit.push({ type: "grant", taskId, origin, purpose, at: this._now() });
  }

  revoke(taskId, origin) {
    if (this._leases.delete(this._key(taskId, origin))) this._audit.push({ type: "revoke", taskId, origin, at: this._now() });
  }

  authorize(taskId, origin) {
    const lease = this._leases.get(this._key(taskId, origin));
    let result;
    if (!lease) result = { allowed: false, reason: "no_lease" };
    else if (this._now() >= lease.expiresAt) {
      this._leases.delete(this._key(taskId, origin));
      result = { allowed: false, reason: "expired" };
    } else if (lease.uses >= this._maxUses) result = { allowed: false, reason: "uses_exhausted" };
    else {
      lease.uses += 1;
      result = { allowed: true };
    }
    this._audit.push({ type: result.allowed ? "use" : "denied", taskId, origin, ...(result.allowed ? {} : { reason: result.reason }), at: this._now() });
    return result;
  }

  audit() {
    return this._audit.map((entry) => ({ ...entry }));
  }
}

module.exports = { EvaluateLeases };
