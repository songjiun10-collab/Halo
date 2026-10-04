// Generated from runtime-src/main/harness/planner-routing.ts. Do not edit; run npm run build:runtime.
"use strict";
// Fast tasks want response time; long tasks are the ambiguous multi-step
// work tier 1 exists for. short and middle keep what the user configured.
const TIER_BY_DURATION = Object.freeze({ fast: 4, long: 1 });
function desiredTier(durationId) {
    return Object.hasOwn(TIER_BY_DURATION, durationId) ? TIER_BY_DURATION[durationId] : null;
}
function routedModel({ durationId, currentModel, candidates, tierOf }) {
    const want = desiredTier(durationId);
    if (want === null)
        return null;
    if (tierOf(currentModel) === want)
        return null;
    let best = null;
    let bestGap = Infinity;
    for (const model of candidates) {
        if (model === currentModel)
            continue;
        const tier = tierOf(model);
        const gap = Math.abs(tier - want);
        // Nearest tier wins; on a tie the stronger (lower) tier does.
        if (best === null || gap < bestGap || (gap === bestGap && tier < tierOf(best))) {
            best = model;
            bestGap = gap;
        }
    }
    if (best === null)
        return null;
    // Only move if it is actually closer to the target than the current model.
    return bestGap < Math.abs(tierOf(currentModel) - want) ? best : null;
}
module.exports = { desiredTier, routedModel };
