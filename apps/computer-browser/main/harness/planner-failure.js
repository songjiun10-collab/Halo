"use strict";

// CLI exception messages may contain prompts or credentials. Only these
// host-defined labels cross the failure boundary.
const FAILURE_CODES = Object.freeze([
  "authentication_failed", "rate_limited", "http_error", "network_error", "timeout", "invalid_response",
  "planner_failed", "busy", "cancelled", "spawn_failed", "stdin_write_failed",
  "cli_error", "cli_exit_nonzero", "invalid_cli_output", "invalid_proposal_json",
  "invalid_proposal", "output_too_large", "invalid_config", "invalid_model", "invalid_attachment", "computer_use_provider_unavailable",
  "invalid_field", "invalid_effort", "closed",
]);
function failureCode(error) {
  return FAILURE_CODES.includes(error?.code) ? error.code : "planner_failed";
}
module.exports = { FAILURE_CODES, failureCode };
