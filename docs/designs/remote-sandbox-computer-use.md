# Remote-sandbox OS-wide computer use (design memo, post-beta)

Status: idea, not scheduled. Out of scope for the January beta.

## Decision

Default: OS-wide computer use runs only inside a disposable remote VM
(for example a user-owned Oracle Cloud Always Free instance).

Local mode (on the user's own machine) is allowed only behind the
authenticated unlock described below. Authentication proves the human
consented; it does not make the actions safe, so it is one layer, not the
whole defence.

## Local mode: authenticated unlock

- Per-session OS-level authentication (Touch ID / device passcode), re-asked
  on expiry. A saved "remember me" never unlocks it.
- Time-boxed session with a visible indicator and one-key kill switch.
- Scoped to an explicit app/window allowlist chosen at unlock; everything else
  (password managers, banking, messengers, terminals, system settings) denied.
- Each irreversible or external-effect action still goes to the human, as in
  the browser mode.
- Local audit log of every action and the observation it was bound to.
- Fail closed if auth, scope, or observation binding cannot be verified.

## Unlock condition

Connecting a cloud account is not enough. The host unlocks the mode only after
it verifies, per session:

1. The VM holds no user session, cookie, credential, or personal file.
2. The VM is disposable (fresh image or snapshot reset per task).
3. Egress is restricted (no private-network reach back to the user).
4. The coordinate action is still bound to the current observation.

If any check fails or cannot be made, fail closed and keep the mode locked.

## Unchanged boundaries

- Approval gate still applies; payments, external-account login, and
  irreversible effects go to the human.
- Screen is streamed (VNC/noVNC); actions arrive as bounded coordinate actions.
- Browser-only computer use (`click_at`, `type_at`, `press_key`) is unaffected.

## Threats to model

- Credential or session leakage into the VM (the main failure).
- VM used as a pivot into the user's network.
- Stale observation acting on a changed screen (cf. E003 observation-bounded
  revalidation).
- Cost or resource abuse of the user's cloud account.

## Open questions (unverified)

- Oracle account age and identity requirements; credit card requirement.
- Current Always Free limits, capacity availability, and idle reclamation policy.
- Whether per-user cloud onboarding is acceptable friction.
- Whether a hosted, HALO-run sandbox is a better product than user-owned cloud.
