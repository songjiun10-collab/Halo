"use strict";

// Which stronger model a stuck task may move to. Pure: the host supplies the
// candidates it can actually run; this only orders them by tier. A task moves
// up at most one rung at a time, never back down and never to a model it has
// already tried, so escalation cannot loop or silently fall to a weaker model.

interface EscalationInput {
  currentModel: string;
  candidates: readonly string[];
  tried?: ReadonlySet<string>;
  tierOf: (model: string) => number;
}

function escalationTarget({ currentModel, candidates, tried = new Set<string>(), tierOf }: EscalationInput): string | null {
  const currentTier = tierOf(currentModel);
  let best: string | null = null;
  let bestTier = -1;
  for (const model of candidates) {
    if (model === currentModel || tried.has(model)) continue;
    const tier = tierOf(model);
    // Strictly stronger (lower number), and the smallest step up among those.
    if (tier >= currentTier) continue;
    if (best === null || tier > bestTier) { best = model; bestTier = tier; }
  }
  return best;
}

export = { escalationTarget };
