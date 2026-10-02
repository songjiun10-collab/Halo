"use strict";

// Route-based planner effort (GPT-6 Astra direction: spend reasoning where
// the work needs it). The user's plannerEffort stays the ceiling; "auto" only
// lowers routes that are cheap by construction, so it can reduce cost but
// never increase it. The route is derived from the task's persisted profile,
// so a resumed task gets the same effort without any new stored field.

const PLANNER_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const EFFORT_MODES = Object.freeze(["auto", "fixed"]);
// Children are observe+scroll helpers; short tasks are quick lookups.
const AUTO_ROUTE_EFFORT = Object.freeze({ child: "low", short: "low" });

class PlannerEffortPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlannerEffortPolicyError";
    this.code = code;
  }
}

function routeForProfile(taskProfile) {
  const id = taskProfile?.duration?.id;
  return id === "short" || id === "long" ? id : "middle";
}

function effortForRoute({ base, mode, route }) {
  if (!PLANNER_EFFORTS.includes(base)) throw new PlannerEffortPolicyError("invalid_planner_effort", "plannerEffort is invalid");
  if (!EFFORT_MODES.includes(mode)) throw new PlannerEffortPolicyError("invalid_planner_effort_mode", "plannerEffortMode is invalid");
  const routeEffort = mode === "auto" ? AUTO_ROUTE_EFFORT[route] : undefined;
  if (routeEffort === undefined) return base;
  return PLANNER_EFFORTS.indexOf(routeEffort) < PLANNER_EFFORTS.indexOf(base) ? routeEffort : base;
}

module.exports = { effortForRoute, routeForProfile, EFFORT_MODES, PlannerEffortPolicyError };
