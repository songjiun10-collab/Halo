# Remote-sandbox OS-wide computer use (design memo, post-beta)

Status: idea, not scheduled. Out of scope for the January beta.

## Decision

OS-wide computer use is never enabled on the user's own machine. It may be
offered only as an opt-in mode that runs inside a disposable remote VM
(for example a user-owned Oracle Cloud Always Free instance).

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
