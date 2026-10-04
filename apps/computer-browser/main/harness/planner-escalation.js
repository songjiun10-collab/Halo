// Generated from runtime-src/main/harness/planner-escalation.ts. Do not edit; run npm run build:runtime.
"use strict";
function escalationTarget({ currentModel, candidates, tried = new Set(), tierOf }) {
    const currentTier = tierOf(currentModel);
    let best = null;
    let bestTier = -1;
    for (const model of candidates) {
        if (model === currentModel || tried.has(model))
            continue;
        const tier = tierOf(model);
        // Strictly stronger (lower number), and the smallest step up among those.
        if (tier >= currentTier)
            continue;
        if (best === null || tier > bestTier) {
            best = model;
            bestTier = tier;
        }
    }
    return best;
}
module.exports = { escalationTarget };
