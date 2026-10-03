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
const workGoalContracts = require("../../shared/work-goal-contracts");
const { validateWorkGoalBinding } = require("../../shared/task-profile-contracts");
const { selectBuiltinPlaybooks } = require("./skill-library");
const { derivePlannerAdaptation } = require("./planner-adaptation");

const WORK_GOAL_CONTEXT_FIELDS = Object.freeze([
  "goalId", "goalVersion", "objective", "successCriteria", "verifiedCriterionIds", "remainingBudget",
]);
const WORK_GOAL_BUDGET_FIELDS = Object.freeze(Object.keys(workGoalContracts.MAX_BUDGET));

class ContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

function validatedWorkGoalContext(workGoalBinding, workGoal) {
  if (workGoalBinding === undefined && workGoal === undefined) return undefined;
  if (workGoalBinding === undefined || workGoal === undefined) {
    throw new ContextError("invalid_field", "bound Work Goal context requires both binding and content");
  }
  try {
    validateWorkGoalBinding(workGoalBinding);
    if (!contracts.isPlainObject(workGoal) ||
        WORK_GOAL_CONTEXT_FIELDS.some((field) => !Object.hasOwn(workGoal, field)) ||
        Object.keys(workGoal).some((field) => !WORK_GOAL_CONTEXT_FIELDS.includes(field))) {
      throw new Error("Work Goal context has an invalid shape");
    }
    contracts.assertUuid(workGoal.goalId, "workGoal.goalId");
    if (!Number.isSafeInteger(workGoal.goalVersion) || workGoal.goalVersion <= 0 ||
        workGoal.goalId !== workGoalBinding.goalId || workGoal.goalVersion !== workGoalBinding.goalVersion) {
      throw new Error("Work Goal context does not match the Task binding");
    }
    workGoalContracts.validateWorkGoalInput({
      objective: workGoal.objective,
      successCriteria: workGoal.successCriteria,
    });
    if (!Array.isArray(workGoal.verifiedCriterionIds)) throw new Error("verifiedCriterionIds must be an array");
    const criterionIds = new Set(workGoal.successCriteria.map((criterion) => criterion.id));
    const verified = new Set();
    for (const id of workGoal.verifiedCriterionIds) {
      if (!criterionIds.has(id) || verified.has(id)) throw new Error("verifiedCriterionIds contains an unknown or duplicate ID");
      verified.add(id);
    }
    if (!contracts.isPlainObject(workGoal.remainingBudget)) throw new Error("remainingBudget must be an object");
    for (const [field, amount] of Object.entries(workGoal.remainingBudget)) {
      if (!WORK_GOAL_BUDGET_FIELDS.includes(field) || !Number.isSafeInteger(amount) ||
          amount < 0 || amount > workGoalContracts.MAX_BUDGET[field]) {
        throw new Error("remainingBudget contains an invalid amount");
      }
    }
  } catch (error) {
    throw new ContextError("invalid_field", `invalid bound Work Goal context: ${error.message}`);
  }
  // Take an independent snapshot: the caller can update its authoritative
  // state after this turn, but cannot mutate a packet already handed to the
  // planner through a shared nested object reference.
  return {
    goalId: workGoal.goalId,
    goalVersion: workGoal.goalVersion,
    objective: workGoal.objective,
    successCriteria: workGoal.successCriteria.map((criterion) => ({ ...criterion })),
    verifiedCriterionIds: [...workGoal.verifiedCriterionIds],
    remainingBudget: { ...workGoal.remainingBudget },
  };
}

// A child's team board (ChildAgentCoordinator.readTeamBoard): siblings'
// notes, newest kept, within its own byte budget and the packet ceiling,
// after pending messages (which come from the parent and matter more).
const MAX_BOARD_CONTEXT_BYTES = 8 * 1024;

function validTeamBoard(teamBoard) {
  if (teamBoard === undefined || teamBoard === null) return null;
  if (!contracts.isPlainObject(teamBoard) || !Array.isArray(teamBoard.entries) || typeof teamBoard.parentTaskId !== "string"
    || !teamBoard.entries.every((e) => contracts.isPlainObject(e) && typeof e.text === "string" && typeof e.from === "string" && typeof e.kind === "string")) {
    throw new ContextError("invalid_field", "teamBoard must be { parentTaskId, entries: [{from, kind, text, at}] }");
  }
  return teamBoard;
}

// P1 (2026-10-02 harness efficiency design, section 5): an opt-in list of
// host-owned references the planner may read with a context_read action. Only
// ids, labels, sizes and short summaries travel in the packet; bodies do not.
const MAX_MANIFEST_CONTEXT_BYTES = 8 * 1024;

function validContextManifest(manifest) {
  if (manifest === undefined) return undefined;
  if (!contracts.isPlainObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.refs) || manifest.refs.length > 128
    || !manifest.refs.every((r) => contracts.isPlainObject(r) && typeof r.refId === "string" && typeof r.kind === "string"
      && typeof r.authority === "string" && typeof r.revision === "string" && Number.isInteger(r.byteLength) && typeof r.summary === "string")) {
    throw new ContextError("invalid_field", "contextManifest must be { version: 1, refs: [{refId, kind, authority, revision, byteLength, summary}] }");
  }
  // The catalog may hold 128 refs; the packet shows only the newest that fit
  // in MAX_MANIFEST_CONTEXT_BYTES and says how many it left out.
  const kept = [];
  for (const ref of [...manifest.refs].reverse()) {
    const candidate = { version: 1, refs: [ref, ...kept], omittedRefs: manifest.refs.length - kept.length - 1 };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_MANIFEST_CONTEXT_BYTES) break;
    kept.unshift(ref);
  }
  return { version: 1, refs: kept, omittedRefs: manifest.refs.length - kept.length };
}

function buildContext({ goal, state, observation, recentEvents, customMemory = [], pendingMessages = [], navigation = null, workGoalBinding, workGoal, teamBoard, contextManifest }) {
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

  const board = validTeamBoard(teamBoard);
  const manifest = validContextManifest(contextManifest);

  if (navigation !== null && (!contracts.isPlainObject(navigation) || !Array.isArray(navigation.visited) || !Array.isArray(navigation.frontier))) {
    throw new ContextError("invalid_field", "navigation must be null or { visited: [], frontier: [] }");
  }

  const { modelSummary, ...trustedProgress } = state;
  const boundedRecentEvents = recentEvents.slice(-contracts.MAX_RECENT_EVENTS_IN_CONTEXT);
  const boundWorkGoal = validatedWorkGoalContext(workGoalBinding, workGoal);
  const builtinPlaybooks = selectBuiltinPlaybooks(goal);

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
    ...(builtinPlaybooks === undefined ? {} : { haloPlaybooks: builtinPlaybooks }),
    // Host-recorded, but every URL/name originated in a page the browser
    // loaded, so it is data to consider, never an instruction.
    navigationHistory: navigation === null ? null : { authority: "untrusted_page_derived", visited: navigation.visited, frontier: navigation.frontier },
    pendingMessages: [],
    ...(boundWorkGoal === undefined ? {} : { workGoal: boundWorkGoal }),
    ...(manifest === undefined ? {} : { contextManifest: manifest }),
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

  const packet = { ...basePacket, pendingMessages: admitted };
  // Optional style metadata gets space only after goal, observations, and
  // incoming messages. Personalization must never turn a fitting task into a
  // context_error or displace communication that the planner needs to consume.
  const adapt = (input) => {
    const plannerAdaptation = derivePlannerAdaptation({ goal, state: trustedProgress, observation, customMemory });
    const candidate = { ...input, plannerAdaptation };
    return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= contracts.MAX_CONTEXT_PACKET_BYTES ? candidate : input;
  };
  if (!board) return adapt(packet);
  const notes = [];
  let noteBytes = 0;
  for (const entry of [...board.entries].reverse()) {
    const note = { from: entry.from, kind: entry.kind, text: entry.text, ...(typeof entry.at === "string" ? { at: entry.at } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(note), "utf8");
    if (noteBytes + bytes > MAX_BOARD_CONTEXT_BYTES) break;
    const candidate = { ...packet, teamBoard: { authority: "untrusted_sibling_notes", parentTaskId: board.parentTaskId, entries: [note, ...notes] } };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > contracts.MAX_CONTEXT_PACKET_BYTES) break;
    notes.unshift(note);
    noteBytes += bytes;
  }
  return adapt({ ...packet, teamBoard: { authority: "untrusted_sibling_notes", parentTaskId: board.parentTaskId, entries: notes } });
}

module.exports = { ContextError, buildContext };
