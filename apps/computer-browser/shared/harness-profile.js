"use strict";

// Harness profile interface (see docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md,
// Rollout Phase 1: "Introduce HarnessProfile without changing current
// execution semantics. Map existing behavior to Middle.").
//
// A profile changes how much planning, context, durability, observation,
// and recovery a task receives. It never changes execution authority:
// policy, approval, and ResourceAdmission are unaffected by profile
// selection. This module is pure (no fs/IPC) so it stays independently
// testable and reusable, matching the pattern of shared/harness-contracts.js.

const { MAX_ACTIONS_PER_PROPOSAL, MAX_ACTIONS_PER_PROPOSAL_SHORT } = require("./harness-contracts");

/** @type {ReadonlyArray<HarnessProfile>} */
const HARNESS_PROFILES = Object.freeze(["short", "middle", "long"]);

/** @typedef {"short" | "middle" | "long"} HarnessProfile */

class HarnessProfileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "HarnessProfileError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {HarnessProfile}
 */
function validateHarnessProfile(value) {
  if (typeof value !== "string" || !isHarnessProfile(value)) {
    throw new HarnessProfileError("invalid_harness_profile", "harnessProfile must be one of short|middle|long");
  }
  return value;
}

/**
 * @param {string} value
 * @returns {value is HarnessProfile}
 */
function isHarnessProfile(value) {
  return /** @type {ReadonlyArray<string>} */ (HARNESS_PROFILES).includes(value);
}

// Deterministic host routing (design doc "Initial automatic selection"):
// only the rule that is structurally decidable at this layer today is
// implemented -- a saved bounded routine always selects Short. Every other
// task maps to Middle, matching current behavior exactly (Phase 1 must not
// change execution semantics). Long is not auto-selected until a later
// phase introduces the signals ("long-running/background research",
// "requires durable continuation") this module has no way to observe yet.
/**
 * @param {{ isRoutine?: boolean }} [options]
 * @returns {HarnessProfile}
 */
function selectHarnessProfile({ isRoutine = false } = {}) {
  return isRoutine ? "short" : "middle";
}

// Harness v2 Phase 2 Task 2: the single source of truth for how many
// actions a proposal may batch together, by profile. "short" is the only
// profile that gets the wider, still-bounded batch (see
// MAX_ACTIONS_PER_PROPOSAL_SHORT's own comment for why this is a fixed
// second constant rather than an arbitrary number); every other profile
// keeps today's unchanged batch bound.
/**
 * @param {unknown} profile
 * @returns {number}
 */
function maxActionsPerProposal(profile) {
  validateHarnessProfile(profile);
  return profile === "short" ? MAX_ACTIONS_PER_PROPOSAL_SHORT : MAX_ACTIONS_PER_PROPOSAL;
}

module.exports = {
  HARNESS_PROFILES,
  HarnessProfileError,
  validateHarnessProfile,
  selectHarnessProfile,
  maxActionsPerProposal,
};
