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

function buildContext({ goal, state, observation, recentEvents, customMemory = [], pendingMessages = [], navigation = null }) {
  contracts.validateGoalSpec(goal, "goal"); // defense in depth; callers should already hold a validated goal

  if (!contracts.isPlainObject(state)) {
    throw new ContextError("invalid_field", "state must be a plain object");
  }
  if (!Array.isArray(recentEvents)) {
    throw new ContextError("invalid_field", "recentEvents must be an array");
  }
  if (!Array.isArray(customMemory)) {
    throw new ContextError("invalid_field", "customMemory must be an array");
  }
  if (!Array.isArray(pendingMessages)) {
    throw new ContextError("invalid_field", "pendingMessages must be an array");
  }

  if (navigation !== null && (!contracts.isPlainObject(navigation) || !Array.isArray(navigation.visited) || !Array.isArray(navigation.frontier))) {
    throw new ContextError("invalid_field", "navigation must be null or { visited: [], frontier: [] }");
  }

  const { modelSummary, ...trustedProgress } = state;
  const boundedRecentEvents = recentEvents.slice(-contracts.MAX_RECENT_EVENTS_IN_CONTEXT);

  const basePacket = {
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
    userMemory: { authority: "untrusted_user_memory", entries: customMemory },
    // Host-recorded, but every URL/name originated in a page the browser
    // loaded, so it is data to consider, never an instruction.
    navigationHistory: navigation === null ? null : { authority: "untrusted_page_derived", visited: navigation.visited, frontier: navigation.frontier },
    pendingMessages: [],
  };

  const baseSize = Buffer.byteLength(JSON.stringify(basePacket), "utf8");
  if (baseSize > contracts.MAX_CONTEXT_PACKET_BYTES) {
    throw new ContextError("context_limit", `context packet is ${baseSize} bytes, exceeds ${contracts.MAX_CONTEXT_PACKET_BYTES}`);
  }

  // Subagent communication protocol section 8.1: admit a deterministic,
  // ordered prefix of eligible pending messages, subject to a per-turn count
  // cap, a serialized-message-bytes cap, AND the pre-existing total packet
  // ceiling -- whichever is hit first. A message-budget collision never
  // becomes a context_error/pause: if nothing fits, admit none and leave
  // every pending message pending for a later turn (never truncated or
  // summarized away).
  const admitted = [];
  let messageBytes = 0;
  for (const message of pendingMessages) {
    if (admitted.length >= contracts.MAX_MESSAGES_PER_TURN) break;
    const candidateBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (messageBytes + candidateBytes > contracts.MAX_MESSAGE_TURN_CONTEXT_BYTES) break;
    const candidatePacket = { ...basePacket, pendingMessages: [...admitted, message] };
    const candidateSize = Buffer.byteLength(JSON.stringify(candidatePacket), "utf8");
    if (candidateSize > contracts.MAX_CONTEXT_PACKET_BYTES) break;
    admitted.push(message);
    messageBytes += candidateBytes;
  }

  return { ...basePacket, pendingMessages: admitted };
}

module.exports = { ContextError, buildContext };
