"use strict";

// One verdict per planner action, in a fixed order: the user's Intent Lock
// first (nothing overrides it), then the permission mode, then any lease the
// user lent for this action and origin. Pure: the caller journals and acts.

const { evaluateLock } = require("../../shared/harness-contracts");
const { evaluateActionPolicy } = require("./permission-policy");
const { LEASE_ACTIONS, findLease } = require("./capability-lease");

function originOf(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function actionTargetOrigin(action, lastObservation) {
  if (["click_at", "type_at"].includes(action.type)) return lastObservation && typeof lastObservation.url === "string" ? originOf(lastObservation.url) : null;
  if (action.type === "navigate") return typeof action.url === "string" ? originOf(action.url) : null;
  if (action.type === "follow_link") {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    return element && typeof element.href === "string" ? originOf(element.href) : null;
  }
  if (["click", "type", "submit_form"].includes(action.type)) {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    if (!element) return null;
    const target = action.type === "type" ? lastObservation.url : element.formAction || element.href || lastObservation.url;
    return typeof target === "string" ? originOf(target) : null;
  }
  return lastObservation && typeof lastObservation.url === "string" ? originOf(lastObservation.url) : null;
}

function evaluateGate({ lock, mode, leases, action, targetOrigin, now }) {
  const verdict = evaluateLock(lock ?? null, { action, targetOrigin });
  if (!verdict.allowed) return { outcome: "lock_denied", reason: verdict.reason, ruleIndex: verdict.ruleIndex };
  const policy = evaluateActionPolicy(mode, action);
  const leasable = LEASE_ACTIONS.includes(action) && policy.approval !== "bypass" && policy.reason !== "unsupported_action";
  const lease = leasable ? findLease(leases, { action, origin: targetOrigin }, now) : null;
  return { outcome: policy.allowed ? "mode_allowed" : "mode_denied", policy, lease };
}

module.exports = { actionTargetOrigin, evaluateGate };
