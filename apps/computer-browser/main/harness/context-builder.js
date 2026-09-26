"use strict";

// Reconstructs a planner's entire input from host-owned sources every call
// (design doc section 5, "컨텍스트 교체와 목표 이탈 방지"). This is the one
// place a model summary, a page's claims, or a stale in-process cache could
// smuggle a rewritten goal past the host -- so this function only ever
// copies the trusted `goal`/`state` inputs verbatim into their own fields;
// an optional `state.modelSummary` is echoed back tagged as
// `untrustedSummary` and is never merged into `goal` or `progress`.
//
// Memory discipline (design doc section 10): this function never
// accumulates history itself. `recentEvents` is bounded to the most recent
// MAX_RECENT_EVENTS_IN_CONTEXT regardless of how many were passed in, and
// the whole assembled packet is checked against MAX_CONTEXT_PACKET_BYTES.
// If it doesn't fit, nothing is truncated -- the goal text and criteria are
// never cut short to make room; the caller gets a context_limit error and
// must pause rather than silently ship a lossy goal to the planner.

const contracts = require("../../shared/harness-contracts");

class ContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

function buildContext({ goal, state, observation, recentEvents }) {
  contracts.validateGoalSpec(goal, "goal"); // defense in depth; callers should already hold a validated goal

  if (!contracts.isPlainObject(state)) {
    throw new ContextError("invalid_field", "state must be a plain object");
  }
  if (!Array.isArray(recentEvents)) {
    throw new ContextError("invalid_field", "recentEvents must be an array");
  }

  const { modelSummary, ...trustedProgress } = state;
  const boundedRecentEvents = recentEvents.slice(-contracts.MAX_RECENT_EVENTS_IN_CONTEXT);

  const packet = {
    taskId: goal.taskId,
    goalVersion: goal.goalVersion,
    goal: {
      originalRequest: goal.originalRequest,
      amendments: goal.amendments,
      constraints: goal.constraints,
      criteria: goal.criteria,
    },
    progress: trustedProgress,
    recentEvents: boundedRecentEvents,
    observation: observation === undefined ? null : observation,
    untrustedSummary: modelSummary === undefined ? null : { text: modelSummary, authority: "untrusted_summary" },
  };

  const size = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (size > contracts.MAX_CONTEXT_PACKET_BYTES) {
    throw new ContextError("context_limit", `context packet is ${size} bytes, exceeds ${contracts.MAX_CONTEXT_PACKET_BYTES}`);
  }
  return packet;
}

module.exports = { ContextError, buildContext };
