class PermissionPolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PermissionPolicyError";
    this.code = code;
  }
}

const PERMISSION_MODES: readonly string[] = Object.freeze(["observe", "browse", "interact", "full"]);
const ACTIONS: readonly string[] = Object.freeze([
  "observe", "scroll", "find_text", "http_get", "navigate", "follow_link", "click", "type", "select_option", "click_at", "type_at", "press_key", "play_loop", "submit_form", "download",
  "os_observe", "os_click_at", "os_type_text", "os_press_key",
]);
const ACTION_SET = new Set<string>(ACTIONS);
const READ_ONLY = new Set<string>(["observe", "scroll", "find_text"]);
const BROWSE_ACTIONS = new Set<string>([...READ_ONLY, "navigate", "follow_link", "http_get"]);
const INTERACT_ACTIONS = new Set<string>(["click", "type", "select_option", "click_at", "type_at", "press_key", "play_loop", "os_observe", "os_click_at", "os_type_text", "os_press_key"]);
const FULL_ACTIONS = new Set<string>([...BROWSE_ACTIONS, ...INTERACT_ACTIONS, "submit_form"]);

interface PolicyVerdict {
  allowed: boolean;
  outcome: "deny" | "human_review" | "allow";
  approval: "approver" | "human" | "bypass" | "none";
  reason: "unsupported_action" | "permission_mode_denied" | null;
}

function evaluateActionPolicy(mode: string, action: string): PolicyVerdict {
  if (!PERMISSION_MODES.includes(mode)) {
    throw new PermissionPolicyError("invalid_permission_mode", `unknown permission mode: ${String(mode)}`);
  }
  if (!ACTION_SET.has(action)) {
    throw new PermissionPolicyError("unknown_action", `unknown browser action: ${String(action)}`);
  }

  // Every validated mode assigns both below; these defaults only satisfy the compiler.
  let allowed = false;
  let approval: PolicyVerdict["approval"] = "none";
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

function isReadOnlyAction(action: string): boolean {
  return READ_ONLY.has(action);
}

export = { ACTIONS, PERMISSION_MODES, PermissionPolicyError, evaluateActionPolicy, isReadOnlyAction };
