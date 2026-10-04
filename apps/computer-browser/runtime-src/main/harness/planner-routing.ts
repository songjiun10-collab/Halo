"use strict";

// Picks a planner model for a task up front, from the task's duration profile.
// Pure: the host supplies the models it can run (same provider as the user's
// configured planner) and this only orders them by tier. A task the user or
// an Agent pinned to a model is never routed, and a profile with no tier
// preference keeps the configured model.

interface RoutingInput {
  durationId: string;
  currentModel: string;
  candidates: readonly string[];
  tierOf: (model: string) => number;
}

// Fast tasks want response time; long tasks are the ambiguous multi-step
// work tier 1 exists for. short and middle keep what the user configured.
const TIER_BY_DURATION: Readonly<Record<string, number>> = Object.freeze({ fast: 4, long: 1 });

function desiredTier(durationId: string): number | null {
  return Object.hasOwn(TIER_BY_DURATION, durationId) ? TIER_BY_DURATION[durationId] : null;
}

function routedModel({ durationId, currentModel, candidates, tierOf }: RoutingInput): string | null {
  const want = desiredTier(durationId);
  if (want === null) return null;
  if (tierOf(currentModel) === want) return null;
  let best: string | null = null;
  let bestGap = Infinity;
  for (const model of candidates) {
    if (model === currentModel) continue;
    const tier = tierOf(model);
    const gap = Math.abs(tier - want);
    // Nearest tier wins; on a tie the stronger (lower) tier does.
    if (best === null || gap < bestGap || (gap === bestGap && tier < tierOf(best))) { best = model; bestGap = gap; }
  }
  if (best === null) return null;
  // Only move if it is actually closer to the target than the current model.
  return bestGap < Math.abs(tierOf(currentModel) - want) ? best : null;
}

export = { desiredTier, routedModel };
