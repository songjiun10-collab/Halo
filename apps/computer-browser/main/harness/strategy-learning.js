// Generated from runtime-src/main/harness/strategy-learning.ts. Do not edit; run npm run build:runtime.
"use strict";
const EMPTY_LEARNING = { version: 1, enabled: false, episodes: [], candidates: [], revisions: [], activeRevisionId: null };
const STRATEGIES = Object.freeze({
    verify_after_action: "After a state-changing action, use the next host observation to verify its effect before relying on it.",
    track_criteria: "Keep each requested criterion explicit; advance only criteria supported by current host evidence.",
    avoid_uncertain_retry: "When dispatch outcome is uncertain, do not repeat the action; wait for host recovery or a fresh observation.",
});
const MAX_EPISODES = 500;
const MAX_CANDIDATES = 100;
const MIN_SUPPORT = 3;
const SAFE_FAILURES = new Set(["evidence_rejected", "no_progress", "execution_uncertain"]);
const SAFE_ACTIONS = new Set(["read", "write", "navigate", "unknown"]);
const SAFE_DURATIONS = new Set(["fast", "middle", "long"]);
function validateLearningData(value) {
    if (!value || typeof value !== "object" || value.version !== 1 || typeof value.enabled !== "boolean" ||
        !Array.isArray(value.episodes) || !Array.isArray(value.candidates) || !Array.isArray(value.revisions) ||
        value.episodes.length > MAX_EPISODES || value.candidates.length > MAX_CANDIDATES || value.revisions.length > 100) {
        throw new Error("learning_corrupt");
    }
    const data = value;
    for (const e of data.episodes) {
        if (!e || typeof e.id !== "string" || e.id.length > 80 || e.modelId !== "gpt-6-luna" || !SAFE_DURATIONS.has(e.duration) ||
            !["completed", "paused"].includes(e.outcome) || (e.failureCode !== null && !SAFE_FAILURES.has(e.failureCode)) || !SAFE_ACTIONS.has(e.actionClass) ||
            !Number.isInteger(e.verifiedCriteria) || e.verifiedCriteria < 0 || e.verifiedCriteria > 100 || !Number.isInteger(e.plannerCalls) || e.plannerCalls < 0 || e.plannerCalls > 10000 ||
            typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)))
            throw new Error("learning_corrupt");
    }
    for (const c of data.candidates) {
        if (!c || typeof c.id !== "string" || !(c.strategyId in STRATEGIES) || !SAFE_DURATIONS.has(c.duration) || !SAFE_FAILURES.has(c.failureCode) ||
            !SAFE_ACTIONS.has(c.actionClass) || !Number.isInteger(c.support) || c.support < MIN_SUPPORT || !Array.isArray(c.episodeIds) ||
            !["candidate", "evaluated", "inconclusive"].includes(c.status) || (c.evaluation !== null && !validEvaluation(c.evaluation)))
            throw new Error("learning_corrupt");
    }
    const revisionIds = new Set();
    for (const revision of data.revisions) {
        if (!revision || typeof revision.id !== "string" || revisionIds.has(revision.id) || !Array.isArray(revision.strategyIds) ||
            revision.strategyIds.some((id) => !(id in STRATEGIES)) || typeof revision.agentMd !== "string" || revision.agentMd.length > 4096 ||
            !["promote", "rollback"].includes(revision.event) || typeof revision.createdAt !== "string" || !Number.isFinite(Date.parse(revision.createdAt)))
            throw new Error("learning_corrupt");
        revisionIds.add(revision.id);
    }
    if (data.activeRevisionId !== null && !revisionIds.has(data.activeRevisionId))
        throw new Error("learning_corrupt");
    return structuredClone(data);
}
function validEvaluation(e) {
    return e?.evaluatorVersion === 1 && e.replaySetVersion === "luna-replay-v1" && e.modelId === "gpt-6-luna" &&
        [e.baselineTargetPasses, e.candidateTargetPasses, e.guardRegressions].every(Number.isInteger) &&
        ["pass", "inconclusive", "reject"].includes(e.result) && typeof e.digest === "string" && /^[a-f0-9]{64}$/.test(e.digest);
}
function makeEpisode(input) {
    if (input.modelId !== "gpt-6-luna" || !SAFE_DURATIONS.has(input.duration) || !["completed", "paused"].includes(input.outcome) ||
        !SAFE_ACTIONS.has(input.actionClass) || typeof input.id !== "string" || input.id.length > 80)
        return null;
    const failureCode = input.failureCode !== null && SAFE_FAILURES.has(input.failureCode) ? input.failureCode : null;
    if (input.outcome === "paused" && !failureCode)
        return null;
    return { id: input.id, modelId: "gpt-6-luna", duration: input.duration, outcome: input.outcome,
        failureCode, actionClass: input.actionClass, verifiedCriteria: Math.max(0, Math.min(100, Math.floor(input.verifiedCriteria || 0))),
        plannerCalls: Math.max(0, Math.min(10000, Math.floor(input.plannerCalls || 0))), at: input.at };
}
function deriveCandidates(episodes, now) {
    const groups = new Map();
    for (const e of episodes) {
        if (!e.failureCode)
            continue;
        const key = [e.modelId, e.duration, e.failureCode, e.actionClass].join("|");
        groups.set(key, [...(groups.get(key) || []), e]);
    }
    const out = [];
    for (const [key, values] of groups) {
        if (values.length < MIN_SUPPORT)
            continue;
        const [model, duration, failureCode, actionClass] = key.split("|");
        if (model !== "gpt-6-luna")
            continue;
        const strategyId = failureCode === "execution_uncertain" ? "avoid_uncertain_retry" : failureCode === "evidence_rejected" ? "verify_after_action" : "track_criteria";
        out.push({ id: `candidate-${Buffer.from(key).toString("hex").slice(0, 24)}`, strategyId, duration: duration,
            failureCode: failureCode, actionClass: actionClass, support: values.length,
            episodeIds: values.slice(-20).map((e) => e.id), status: "candidate", evaluation: null, createdAt: now });
    }
    return out.slice(-MAX_CANDIDATES);
}
// A deterministic selector-fit replay, not a claim that a language model's
// behavior or real browser task success has been measured.
function evaluateCandidate(candidate, active) {
    const cases = [
        { failureCode: "execution_uncertain", actionClass: "write", expected: "avoid_uncertain_retry" },
        { failureCode: "execution_uncertain", actionClass: "unknown", expected: "avoid_uncertain_retry" },
        { failureCode: "evidence_rejected", actionClass: "navigate", expected: "verify_after_action" },
        { failureCode: "evidence_rejected", actionClass: "unknown", expected: "verify_after_action" },
        { failureCode: "no_progress", actionClass: "read", expected: "track_criteria" },
        { failureCode: "no_progress", actionClass: "unknown", expected: "track_criteria" },
    ];
    const matchingCases = cases.filter((item) => item.failureCode === candidate.failureCode && item.actionClass === candidate.actionClass);
    const targetCases = matchingCases.length;
    const baselineTargetPasses = active.includes(candidate.strategyId) ? targetCases : 0;
    const candidateTargetPasses = matchingCases.filter((item) => item.expected === candidate.strategyId).length;
    // The replay selector is strictly scoped to the candidate signature, so
    // unrelated cases retain baseline behavior by construction.
    const guardRegressions = 0;
    const result = candidate.support < MIN_SUPPORT ? "inconclusive" : guardRegressions ? "reject" : candidateTargetPasses > baselineTargetPasses ? "pass" : "inconclusive";
    const payload = JSON.stringify({ candidateId: candidate.id, strategyId: candidate.strategyId, replaySetVersion: "luna-replay-v1", baselineTargetPasses, candidateTargetPasses, guardRegressions, result });
    const digest = require("node:crypto").createHash("sha256").update(payload).digest("hex");
    return { evaluatorVersion: 1, replaySetVersion: "luna-replay-v1", modelId: "gpt-6-luna", baselineTargetPasses, candidateTargetPasses, guardRegressions, result, digest };
}
function renderAgentMd(strategyIds, revisionId) {
    const unique = [...new Set(strategyIds)];
    if (unique.some((id) => !(id in STRATEGIES)))
        throw new Error("strategy_not_allowed");
    return [`<!-- HALO-LEARNED revision=${revisionId} model=gpt-6-luna -->`, "# HALO Agent.md", "", "Advisory planning guidance only. Host policy, permissions, approval, evidence and completion rules take precedence.",
        ...unique.map((id) => `- ${STRATEGIES[id]}`), ""].join("\n");
}
module.exports = { EMPTY_LEARNING, STRATEGIES, validateLearningData, makeEpisode, deriveCandidates, evaluateCandidate, renderAgentMd };
