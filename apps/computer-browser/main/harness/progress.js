"use strict";

// Pure completion/progress gates for the long-horizon browser harness. See
// docs/superpowers/specs/2026-09-27-long-horizon-browser-harness-design.md
// section 3 ("WorkPlan/Evidence 파생 데이터") and section 5 (완료 기준).
//
// The one rule every function here enforces: a model can PROPOSE evidence
// and work, but only a host-supplied `hostVerifier` callback, or a
// pre-existing evidence entry that some other trusted path (real user
// confirmation via IPC) already marked "verified", can ever move a
// criterion toward completion. Nothing here understands natural-language
// intent -- `hostVerifier` is a deterministic callback injected by the
// caller (Task 4 wires it to real artifact/DOM checks); this module never
// claims to be a semantic judge of "did the model actually do the task".

const contracts = require("../../shared/harness-contracts");

class ProgressError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProgressError";
    this.code = code;
  }
}

function wrapContractError(err) {
  if (err instanceof contracts.ContractError) return new ProgressError(err.code, err.message);
  return err;
}

// Validates a Planner proposal against the CURRENT goal it claims to be
// based on. Rejects (throws ProgressError):
//   - wrong_task           taskId doesn't match this task
//   - stale_goal_version   proposal targets a goalVersion that is no longer current
//   - off_goal             proposal references a criterionId that doesn't exist
// Wire-shape problems (unknown kind, bad batch size, etc.) surface as
// whatever code shared/harness-contracts.js's validateProposalEnvelope used.
function validateProposal(proposal, context) {
  let validated;
  try {
    validated = contracts.validateProposalEnvelope(proposal);
  } catch (err) {
    throw wrapContractError(err);
  }

  const goal = context && context.goal;
  if (!contracts.isPlainObject(goal)) {
    throw new ProgressError("invalid_field", "context.goal is required to validate a proposal");
  }
  if (validated.taskId !== goal.taskId) {
    throw new ProgressError("wrong_task", `proposal.taskId ${validated.taskId} does not match task ${goal.taskId}`);
  }
  if (validated.goalVersion !== goal.goalVersion) {
    throw new ProgressError(
      "stale_goal_version",
      `proposal.goalVersion ${validated.goalVersion} does not match current goalVersion ${goal.goalVersion}`,
    );
  }
  const knownIds = new Set(goal.criteria.map((c) => c.id));
  const unknown = validated.criterionIds.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new ProgressError("off_goal", `proposal references unknown criterionIds: ${unknown.join(", ")}`);
  }
  return validated;
}

// Decides one criterion's verdict from its candidate Evidence entries.
//   - verification: "user"  only a pre-existing verified/rejected entry
//                            counts (some trusted IPC path set that flag;
//                            this function never sets it itself).
//   - verification: "host"  hostVerifier(criterion, candidateEvidence) is
//                            the sole authority; the candidate's own
//                            self-reported `verification` field is ignored,
//                            since a model could have set that field itself.
function verifyCriterion(criterion, evidenceList, hostVerifier) {
  const candidates = evidenceList.filter((e) => e.criterionId === criterion.id);

  if (criterion.verification === "user") {
    const confirmed = candidates.find((e) => e.verification === "verified");
    if (confirmed) return { criterionId: criterion.id, status: "verified", evidenceId: confirmed.id };
    const rejected = candidates.find((e) => e.verification === "rejected");
    if (rejected) return { criterionId: criterion.id, status: "rejected", evidenceId: rejected.id };
    return { criterionId: criterion.id, status: "pending" };
  }

  let firstRejected = null;
  for (const candidate of candidates) {
    const verdict = hostVerifier(criterion, candidate);
    if (verdict === true) return { criterionId: criterion.id, status: "verified", evidenceId: candidate.id };
    if (verdict === false && !firstRejected) firstRejected = candidate;
  }
  if (firstRejected) return { criterionId: criterion.id, status: "rejected", evidenceId: firstRejected.id };
  return { criterionId: criterion.id, status: "pending" };
}

// The final completion gate: every REQUIRED criterion must have a
// currently-verified evidence entry for the CURRENT goalVersion. Evidence
// verified under a superseded goalVersion is preserved by the store but
// does not count here -- an amendment always re-opens verification
// (section 3: "목표 amendment 후 기존 evidence는 보존하되 기본적으로 새
// 버전에 재검증한다").
function canComplete(goal, evidenceList) {
  const required = goal.criteria.filter((c) => c.required);
  const missingIds = [];
  for (const criterion of required) {
    const satisfied = evidenceList.some(
      (e) => e.criterionId === criterion.id && e.verification === "verified" && e.goalVersion === goal.goalVersion,
    );
    if (!satisfied) missingIds.push(criterion.id);
  }
  return {
    complete: missingIds.length === 0,
    missingIds,
    status: missingIds.length === 0 ? "completed" : "awaiting_verification",
  };
}

module.exports = { ProgressError, validateProposal, verifyCriterion, canComplete };
