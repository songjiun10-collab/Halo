"use strict";

// Bounded self-recovery budget. A task gets a few automatic retries per pause
// reason (and overall) before it pauses and asks the person. The policy only
// counts; TaskController decides which pauses are recoverable at all.

interface RecoveryAttempt { attempt: number; total: number }
interface RecoveryState { version: 1; spent: number; recent: { reason: string; at: number }[] }
interface RecoveryPolicy {
  tryConsume(reason: string): RecoveryAttempt | null;
  // Real progress (a page never seen before, a newly verified criterion) starts a
  // new epoch: the per-reason and overall counts reset, the lifetime cap does not.
  noteProgress(): void;
  readonly total: number;
  snapshot(): RecoveryState;
}

const RECOVERY_PER_REASON = 2;
const RECOVERY_TOTAL = 5;
// A recovery older than this no longer counts against the budget, so isolated
// failures hours apart each get their own retries. A failure loop retries within
// seconds and stays bounded; RECOVERY_LIFETIME bounds a loop slow enough to slip
// past the window (a planner that times out every few minutes).
const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_LIFETIME = 30;

function createRecoveryPolicy(
  maxTotal: unknown = RECOVERY_TOTAL,
  perReason: number = RECOVERY_PER_REASON,
  { now = Date.now, windowMs = RECOVERY_WINDOW_MS, lifetime = RECOVERY_LIFETIME, state }: { now?: () => number; windowMs?: number; lifetime?: number; state?: unknown } = {},
): RecoveryPolicy {
  const cap = typeof maxTotal === "number" && Number.isInteger(maxTotal) && maxTotal >= 0 ? maxTotal : RECOVERY_TOTAL;
  if (state !== undefined) {
    const value = state as RecoveryState;
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.spent) || value.spent < 0 || value.spent > RECOVERY_LIFETIME
      || !Array.isArray(value.recent) || value.recent.length > value.spent
      || value.recent.some((entry) => !entry || typeof entry.reason !== "string" || !entry.reason.length || entry.reason.length > 128
        || !Number.isSafeInteger(entry.at) || entry.at < 0)) {
      throw new Error("invalid_recovery_state: persisted recovery budget is malformed");
    }
  }
  const restored = state as RecoveryState | undefined;
  const recent = restored ? restored.recent.map((entry) => ({ ...entry })) : [];
  let spent = restored?.spent ?? 0;
  return {
    tryConsume(reason: string): RecoveryAttempt | null {
      const at = now();
      while (recent.length > 0 && at - recent[0].at >= windowMs) recent.shift();
      const used = recent.filter((entry) => entry.reason === reason).length;
      if (used >= perReason || recent.length >= cap || spent >= lifetime) return null;
      recent.push({ reason, at });
      spent += 1;
      return { attempt: used + 1, total: recent.length };
    },
    noteProgress(): void { recent.length = 0; },
    get total(): number { return recent.length; },
    snapshot(): RecoveryState { return { version: 1, spent, recent: recent.map((entry) => ({ ...entry })) }; },
  };
}

// Host-authored, bounded diagnostics, not web/provider text and never permission.
// This changes the next planner's available evidence, not model weights.
function buildRecoveryFeedback(state: RecoveryState) {
  const reason = state.recent.at(-1)?.reason;
  const nextActions: Record<string, string> = {
    planner_error: "retry_planner_from_current_state",
    observation_error: "capture_fresh_observation",
    context_error: "rebuild_context_from_durable_goal",
    no_progress: "replan_using_new_evidence",
  };
  const guidance: Record<string, string> = {
    planner_error: "Re-read the current goal and observation; check proposal shape. Do not repeat uncertain actions or infer success from a transport failure.",
    observation_error: "Use the fresh observation, not old coordinates or element IDs. Do not repeat uncertain actions.",
    context_error: "Rebuild from the host goal and verified evidence; missing context is not success. Do not repeat uncertain actions.",
    no_progress: "Change the approach using current evidence instead of repeating the same ineffective action. Do not repeat uncertain actions.",
  };
  if (!reason || !Object.hasOwn(guidance, reason)) return undefined;
  const attemptsInWindow = state.recent.filter((entry) => entry.reason === reason).length;
  return { authority: "host_diagnostic_not_permission", reason, attempt: attemptsInWindow,
    attemptsInWindow, recoveryAttemptsSpent: state.spent, nextAction: nextActions[reason], guidance: guidance[reason] };
}

interface ProposalBinding { taskId: string; goalVersion: number; basedOnObservationId: string; maxActions: number }
function buildProposalFeedback(rawCode: unknown, current: ProposalBinding) {
  const guidance: Record<string, string> = {
    invalid_proposal_json: "Return exactly one valid JSON proposal, without prose or markdown. Use the current binding below.",
    invalid_proposal: "Return a proposal matching the tool contract and current binding. Do not change the goal or claim permission.",
    wrong_task: "Use the current taskId below; never borrow another task's authority.",
    stale_goal_version: "Use the current goalVersion below and re-read the current goal before proposing work.",
    stale_observation: "Use the current basedOnObservationId below and fresh element or coordinate bindings; do not execute against old observations.",
    off_goal: "Use only criterion IDs present in goal.criteria; do not invent completion criteria.",
    unknown_enum: "Use only proposal kinds and actions supported by the current tool contract.",
    unknown_field: "Remove fields not allowed by the current proposal kind and tool contract.",
    invalid_shape: "Include only fields required or allowed for the selected proposal kind.",
    invalid_field: "Use the required field types from the tool contract and current binding.",
    field_too_large: "Respect field size limits and current maxActions; split larger work into separate proposals.",
    invalid_coordinate_action: "Use one bounded coordinate action with the current observation binding; do not mix coordinate actions in a batch.",
  };
  const code = typeof rawCode === "string" && Object.hasOwn(guidance, rawCode) ? rawCode : "invalid_proposal";
  const feedback = { authority: "host_diagnostic_not_permission", code, guidance: guidance[code],
    current: { taskId: current.taskId, goalVersion: current.goalVersion,
      basedOnObservationId: current.basedOnObservationId.slice(0, 128), maxActions: current.maxActions } };
  // Escaping is part of the byte cost. Preserve the exact valid binding and
  // shrink only host prose when an unusual 128-char ID expands in JSON.
  if (Buffer.byteLength(JSON.stringify(feedback), "utf8") > 1024) feedback.guidance = "Use current binding.";
  if (Buffer.byteLength(JSON.stringify(feedback), "utf8") > 1024) throw new Error("proposal_feedback_too_large");
  return feedback;
}

export = { RECOVERY_PER_REASON, RECOVERY_TOTAL, RECOVERY_WINDOW_MS, RECOVERY_LIFETIME, createRecoveryPolicy, buildRecoveryFeedback, buildProposalFeedback };
