"use strict";

class PermissionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PermissionPolicyError";
    this.code = code;
  }
}

const PERMISSION_MODES = Object.freeze(["observe", "browse", "interact", "full"]);
const ACTIONS = Object.freeze([
  "observe", "scroll", "navigate", "follow_link", "click", "type", "submit_form", "download",
]);
const ACTION_SET = new Set(ACTIONS);
const READ_ONLY = new Set(["observe", "scroll"]);
const BROWSE_ACTIONS = new Set([...READ_ONLY, "navigate", "follow_link"]);
const INTERACT_ACTIONS = new Set(["click", "type"]);
const FULL_ACTIONS = new Set([...BROWSE_ACTIONS, ...INTERACT_ACTIONS, "submit_form"]);

function evaluateActionPolicy(mode, action) {
  if (!PERMISSION_MODES.includes(mode)) {
    throw new PermissionPolicyError("invalid_permission_mode", `unknown permission mode: ${String(mode)}`);
  }
  if (!ACTION_SET.has(action)) {
    throw new PermissionPolicyError("unknown_action", `unknown browser action: ${String(action)}`);
  }

  let allowed;
  let approval;
  switch (mode) {
    case "observe":
      allowed = READ_ONLY.has(action);
      approval = allowed ? "approver" : "none";
      break;
    case "browse":
      allowed = BROWSE_ACTIONS.has(action);
      approval = allowed ? "approver" : "none";
      break;
    case "interact":
      allowed = BROWSE_ACTIONS.has(action) || INTERACT_ACTIONS.has(action);
      approval = !allowed ? "none" : INTERACT_ACTIONS.has(action) ? "human" : "approver";
      break;
    case "full":
      allowed = FULL_ACTIONS.has(action);
      approval = allowed ? "bypass" : "none";
      break;
  }

  return {
    allowed,
    outcome: !allowed ? "deny" : approval === "human" ? "human_review" : "allow",
    approval,
    reason: allowed ? null : action === "download" ? "unsupported_action" : "permission_mode_denied",
  };
}

function isReadOnlyAction(action) {
  return READ_ONLY.has(action);
}

module.exports = { ACTIONS, PERMISSION_MODES, PermissionPolicyError, evaluateActionPolicy, isReadOnlyAction };
