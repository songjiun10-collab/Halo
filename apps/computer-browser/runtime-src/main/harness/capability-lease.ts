// Capability Lease: a user-lent, task-scoped permission for one action type on
// one origin, for a few minutes and a few uses. Pure helpers only; the task
// controller owns the list and journals every grant, use and revoke.

const LEASE_ACTIONS: readonly string[] = Object.freeze(["navigate", "follow_link", "click", "type", "select_option", "click_at", "type_at", "press_key", "submit_form"]);
const LEASE_DEFAULTS = Object.freeze({ minutes: 10, uses: 3 });

class LeaseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

// The sheet offers the defaults; the user can only shrink them.
interface LeaseTerms { minutes?: number; uses?: number }
interface Lease {
  id: string; taskId: string; action: string; origin: string;
  grantedAt: number; expiresAt: number; deadline: number; usesLeft: number;
  revoked: boolean; revocationRecorded: boolean;
}

function lendTerms(terms: LeaseTerms = {}): { minutes: number; uses: number } {
  const minutes = terms.minutes ?? LEASE_DEFAULTS.minutes;
  const uses = terms.uses ?? LEASE_DEFAULTS.uses;
  for (const [value, max] of [[minutes, LEASE_DEFAULTS.minutes], [uses, LEASE_DEFAULTS.uses]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new LeaseError("invalid_lease_terms", `lease terms must be whole numbers from 1 to ${max}`);
  }
  return { minutes, uses };
}

function createLease({ id, taskId, action, origin, now, wallNow = now, minutes, uses }: { id: string; taskId: string; action: string; origin: string; now: number; wallNow?: number; minutes: number; uses: number }): Lease {
  const durationMs = minutes * 60_000;
  return {
    id,
    taskId,
    action,
    origin,
    grantedAt: wallNow,
    expiresAt: wallNow + durationMs,
    // expiresAt is for audit/UI only. Authorization uses the process-local
    // monotonic deadline so wall-clock rollback cannot extend the lease.
    deadline: now + durationMs,
    usesLeft: uses,
    revoked: false,
    revocationRecorded: false,
  };
}

function isLeaseLive(lease: Lease, now: number): boolean {
  return !lease.revoked && lease.usesLeft > 0 && now < lease.deadline;
}

function findLease(leases: Lease[], { action, origin }: { action: string; origin: string | null }, now: number): Lease | null {
  if (!origin) return null;
  const live = leases.filter((l) => l.action === action && l.origin === origin && isLeaseLive(l, now));
  live.sort((a, b) => a.deadline - b.deadline);
  return live[0] ?? null;
}

export = { LEASE_ACTIONS, LEASE_DEFAULTS, LeaseError, lendTerms, createLease, isLeaseLive, findLease };
