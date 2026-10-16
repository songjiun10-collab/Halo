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

## Kill switch (required, both modes)

A mode without a working kill switch must not ship.

- One global hotkey plus an always-visible button; works even if the app UI
  or the planner is hung.
- Enforced by the host, not the model: it revokes the capability lease, drops
  queued actions, and cancels in-flight input before returning.
- After a kill the mode is locked and needs a fresh authenticated unlock.
- Remote mode: also stops the stream and destroys or snapshot-resets the VM.
- Triggered automatically on auth expiry, scope violation, observation-binding
  failure, or loss of the host heartbeat (fail closed).
- Tested: a test must show no action is dispatched after a kill.

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
- Always Free limits as shown on oracle.com (founder's phone screenshots, 2026-10-16, Korean page; not fetched by us):
  - Two AMD VMs, each 1/8 OCPU and 1 GB memory. Too small to run Chromium; do not plan on them.
  - Arm Ampere A1: 4 cores and 24 GB memory in total (3,000 OCPU-hours and 18,000 GB-hours per month), usable as one VM or up to four. 4 OCPU x 750 h and 24 GB x 750 h are exactly one always-on VM, so that is the realistic sandbox: one A1 VM, or several that share the same allowance.
  - Block volumes: 2, 200 GB total. Object storage 10 GB, archive 10 GB.
  - A separate 30-day trial gives US$300 in credits.
  - Consequence: the sandbox runs on arm64 Linux. Electron and Chromium ship arm64 Linux builds, but HALO has not been run there; that is untested.
- Still unverified: capacity availability in the chosen region, idle reclamation policy, and the exact unit of the A1 allowance if the memo ever needs more than one always-on instance.
- Whether per-user cloud onboarding is acceptable friction.
- Whether a hosted, HALO-run sandbox is a better product than user-owned cloud.
