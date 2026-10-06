"use strict";

// Bounded self-recovery budget. A task gets a few automatic retries per pause
// reason (and overall) before it pauses and asks the person. The policy only
// counts; TaskController decides which pauses are recoverable at all.

interface RecoveryAttempt { attempt: number; total: number }
interface RecoveryPolicy {
  tryConsume(reason: string): RecoveryAttempt | null;
  // Real progress (a page never seen before, a newly verified criterion) starts a
  // new epoch: the per-reason and overall counts reset, the lifetime cap does not.
  noteProgress(): void;
  readonly total: number;
}

const RECOVERY_PER_REASON = 2;
const RECOVERY_TOTAL = 5;
// A recovery older than this no longer counts against the budget, so isolated
// failures hours apart each get their own retries. A failure loop retries within
// seconds and stays bounded; RECOVERY_LIFETIME bounds a loop slow enough to slip
// past the window (a planner that times out every few minutes).
const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_LIFETIME = 30;

function createRecoveryPolicy(
  maxTotal: unknown = RECOVERY_TOTAL,
  perReason: number = RECOVERY_PER_REASON,
  { now = Date.now, windowMs = RECOVERY_WINDOW_MS, lifetime = RECOVERY_LIFETIME }: { now?: () => number; windowMs?: number; lifetime?: number } = {},
): RecoveryPolicy {
  const cap = typeof maxTotal === "number" && Number.isInteger(maxTotal) && maxTotal >= 0 ? maxTotal : RECOVERY_TOTAL;
  const recent: { reason: string; at: number }[] = [];
  let spent = 0;
  return {
    tryConsume(reason: string): RecoveryAttempt | null {
      const at = now();
      while (recent.length > 0 && at - recent[0].at >= windowMs) recent.shift();
      const used = recent.filter((entry) => entry.reason === reason).length;
      if (used >= perReason || recent.length >= cap || spent >= lifetime) return null;
      recent.push({ reason, at });
      spent += 1;
      return { attempt: used + 1, total: recent.length };
    },
    noteProgress(): void { recent.length = 0; },
    get total(): number { return recent.length; },
  };
}

export = { RECOVERY_PER_REASON, RECOVERY_TOTAL, RECOVERY_WINDOW_MS, RECOVERY_LIFETIME, createRecoveryPolicy };
