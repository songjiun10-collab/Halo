# Antigravity / Cursor planner adapters (experimental)

These are planners, not independent executors. Their final JSON goes through
the existing HALO proposal validation, budgets, action gate and approval policy.
No standalone Gemini CLI adapter is installed.

## Setup and authentication

- Install the official `agy` or Cursor `agent` CLI separately. HALO does not install it.
- Start the HALO host with `GEMINI_API_KEY` for Antigravity, or `CURSOR_API_KEY`
  for Cursor. Keys are only forwarded to that provider subprocess, not the UI.
- Optional operator-only executable overrides: `HALO_ANTIGRAVITY_CLI_COMMAND`
  and `HALO_CURSOR_CLI_COMMAND`. Model/page input cannot supply an executable.
- Select Antigravity default / Cursor Auto in Settings or the model picker.
- Desktop subscription login is **not inherited**. Antigravity uses its documented
  Gemini API authentication provider; this may be separately billed from the
  desktop subscription. Do not confuse it with a Gemini CLI integration.

## Boundary and limits

Each bridge creates a private temporary HOME and workspace. User configuration,
MCP definitions, hooks, plugins and repository instructions are not copied.
Explicit deny rules cover file reads/writes, shell, web fetch and MCP; Antigravity
also denies browser actuation and unsandboxed execution. Cursor uses ask mode.
No force/yolo/skip-permissions option is passed. Fast mode is unsupported and is
not forwarded. Antigravity effort maps to low/medium/high; Cursor CLI has no effort
override here. Usage token/cost accounting is not yet supported; HALO still charges
its existing planner-call budget.

This is **vendor policy isolation, not an OS sandbox**. Fake-transport tests prove
HALO's launch/configuration and output contracts, not the installed CLI's policy
implementation. Live adversarial CLI testing and version certification are still
required before treating these adapters as a containment guarantee. Missing keys,
nonzero exits, error envelopes and invalid proposals do not yield executable actions.

Official references:

- https://www.antigravity.google/docs/cli/headless/
- https://www.antigravity.google/docs/cli/permissions
- https://www.antigravity.google/docs/cli/install
- https://cursor.com/docs/cli/reference/parameters
- https://cursor.com/docs/cli/reference/permissions
- https://cursor.com/docs/cli/reference/configuration
