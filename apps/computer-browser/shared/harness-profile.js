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

const HARNESS_PROFILES = Object.freeze(["short", "middle", "long"]);

class HarnessProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarnessProfileError";
    this.code = code;
  }
}

function validateHarnessProfile(value) {
  if (typeof value !== "string" || !HARNESS_PROFILES.includes(value)) {
    throw new HarnessProfileError("invalid_harness_profile", "harnessProfile must be one of short|middle|long");
  }
  return value;
}

// Deterministic host routing (design doc "Initial automatic selection"):
// only the rule that is structurally decidable at this layer today is
// implemented -- a saved bounded routine always selects Short. Every other
// task maps to Middle, matching current behavior exactly (Phase 1 must not
// change execution semantics). Long is not auto-selected until a later
// phase introduces the signals ("long-running/background research",
// "requires durable continuation") this module has no way to observe yet.
function selectHarnessProfile({ isRoutine = false } = {}) {
  return isRoutine ? "short" : "middle";
}

module.exports = { HARNESS_PROFILES, HarnessProfileError, validateHarnessProfile, selectHarnessProfile };
