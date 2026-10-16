"use strict";

// Maps how a Halo run ended onto WebArena-Verified's agent-response schema.
// Only a task the agent itself declared finished is reported SUCCESS; every
// other ending is an error status so a stopped, timed-out or unanswered run is
// never scored as a pass by construction.

const TASK_TYPES = new Set(["RETRIEVE", "MUTATE", "NAVIGATE"]);
const MAX_ITEMS = 100;

function buildAgentResponse({ taskType, state, pauseReason = null, answer = null, timedOut = false }) {
  if (!TASK_TYPES.has(taskType)) throw new RangeError(`unknown task_type ${taskType}`);
  const base = { task_type: taskType, retrieved_data: null };
  if (timedOut) return { ...base, status: "UNKNOWN_ERROR", error_details: "run hit the time limit" };
  if (state === "completed" || state === "awaiting_verification") {
    if (taskType === "RETRIEVE") {
      const isObject = answer && typeof answer === "object" && !Array.isArray(answer) && Object.keys(answer).length > 0;
      if (isObject) return { ...base, status: "SUCCESS", retrieved_data: answer, error_details: null };
      if (!Array.isArray(answer) || answer.length === 0) return { ...base, status: "NOT_FOUND_ERROR", error_details: "finished without an extracted answer" };
      return { ...base, status: "SUCCESS", retrieved_data: answer.slice(0, MAX_ITEMS), error_details: null };
    }
    return { ...base, status: "SUCCESS", error_details: null };
  }
  if (state === "paused" && pauseReason === "need_user") return { ...base, status: "UNKNOWN_ERROR", error_details: "agent asked the user for input" };
  return { ...base, status: "UNKNOWN_ERROR", error_details: `run ended in ${state}${pauseReason ? `/${pauseReason}` : ""}` };
}

module.exports = { buildAgentResponse, TASK_TYPES };
