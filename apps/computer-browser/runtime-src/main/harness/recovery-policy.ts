"use strict";

// Bounded self-recovery budget. A task gets a few automatic retries per pause
// reason (and overall) before it pauses and asks the person. The policy only
// counts; TaskController decides which pauses are recoverable at all.

interface RecoveryAttempt { attempt: number; total: number }
interface RecoveryPolicy {
  tryConsume(reason: string): RecoveryAttempt | null;
  readonly total: number;
}

const RECOVERY_PER_REASON = 2;
const RECOVERY_TOTAL = 5;

function createRecoveryPolicy(maxTotal: unknown = RECOVERY_TOTAL, perReason: number = RECOVERY_PER_REASON): RecoveryPolicy {
  const cap = typeof maxTotal === "number" && Number.isInteger(maxTotal) && maxTotal >= 0 ? maxTotal : RECOVERY_TOTAL;
  const byReason = new Map<string, number>();
  let total = 0;
  return {
    tryConsume(reason: string): RecoveryAttempt | null {
      const used = byReason.get(reason) ?? 0;
      if (used >= perReason || total >= cap) return null;
      byReason.set(reason, used + 1);
      total += 1;
      return { attempt: used + 1, total };
    },
    get total(): number { return total; },
  };
}

export = { RECOVERY_PER_REASON, RECOVERY_TOTAL, createRecoveryPolicy };
