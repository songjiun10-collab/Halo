// Generated from runtime-src/main/harness/recovery-policy.ts. Do not edit; run npm run build:runtime.
"use strict";
const RECOVERY_PER_REASON = 2;
const RECOVERY_TOTAL = 5;
function createRecoveryPolicy(maxTotal = RECOVERY_TOTAL, perReason = RECOVERY_PER_REASON) {
    const cap = typeof maxTotal === "number" && Number.isInteger(maxTotal) && maxTotal >= 0 ? maxTotal : RECOVERY_TOTAL;
    const byReason = new Map();
    let total = 0;
    return {
        tryConsume(reason) {
            const used = byReason.get(reason) ?? 0;
            if (used >= perReason || total >= cap)
                return null;
            byReason.set(reason, used + 1);
            total += 1;
            return { attempt: used + 1, total };
        },
        get total() { return total; },
    };
}
module.exports = { RECOVERY_PER_REASON, RECOVERY_TOTAL, createRecoveryPolicy };
