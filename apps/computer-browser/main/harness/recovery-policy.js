// Generated from runtime-src/main/harness/recovery-policy.ts. Do not edit; run npm run build:runtime.
"use strict";
const RECOVERY_PER_REASON = 2;
const RECOVERY_TOTAL = 5;
// A recovery older than this no longer counts against the budget, so isolated
// failures hours apart each get their own retries. A failure loop retries within
// seconds and stays bounded; RECOVERY_LIFETIME bounds a loop slow enough to slip
// past the window (a planner that times out every few minutes).
const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_LIFETIME = 30;
function createRecoveryPolicy(maxTotal = RECOVERY_TOTAL, perReason = RECOVERY_PER_REASON, { now = Date.now, windowMs = RECOVERY_WINDOW_MS, lifetime = RECOVERY_LIFETIME } = {}) {
    const cap = typeof maxTotal === "number" && Number.isInteger(maxTotal) && maxTotal >= 0 ? maxTotal : RECOVERY_TOTAL;
    const recent = [];
    let spent = 0;
    return {
        tryConsume(reason) {
            const at = now();
            while (recent.length > 0 && at - recent[0].at >= windowMs)
                recent.shift();
            const used = recent.filter((entry) => entry.reason === reason).length;
            if (used >= perReason || recent.length >= cap || spent >= lifetime)
                return null;
            recent.push({ reason, at });
            spent += 1;
            return { attempt: used + 1, total: recent.length };
        },
        noteProgress() { recent.length = 0; },
        get total() { return recent.length; },
    };
}
module.exports = { RECOVERY_PER_REASON, RECOVERY_TOTAL, RECOVERY_WINDOW_MS, RECOVERY_LIFETIME, createRecoveryPolicy };
