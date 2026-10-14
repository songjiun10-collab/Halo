# TODOS

## Browser harness

### Port the useful harness/compare20-fixes work onto develop (no merge)

**What:** Re-implement the stabilizing work from `origin/harness/compare20-fixes` on top of `develop`, in stages, each with its tests.

**Why:** The branch holds 30 commits that are not in `develop`; merging it conflicts in 13 files (task-controller.js, task-host.js, ipc.js, preload and others), and its new action types (`hw_step`, `evaluate`, `copy`, `find`, `zoom`, `select_all`) would skip today's privacy, payment and effect checks.

**Context:** Found in the whole-browser eng review (develop eng-review file, 2026-10-14, decision D9 A). Order matters:
1. The action-safety module and action-type declaration test (review task T3) land first. Every ported action type then declares its privacy, payment and effect handling or fails the suite; `hw_step` enters only through that module.
2. Stabilizers: repeat-failure limit (`repeatFailureLimit`), rejecting a finish with no recorded evidence (`finishEvidenceRejections`), a click on an already-selected target counts as success.
3. Planner identity fill (missing taskId/goalVersion/basedOnObservationId taken from host context) and the answer grounding check.
4. The rest (real-Chromium tests, find/zoom, team comms, session vault), one group at a time.
Leave out: `web/oxyism-homepage.tar.gz`, the `web/oxyism-site` submodule link, and the navigation jitter (it exists to look less robotic to bot detection). Planner prompt text there caps `need_user` text at 2000 chars while develop's research verifier uses 2800; pick one. Deleting the old branch needs its own explicit confirmation after the port is verified (a delete attempt was refused by the sandbox on 2026-10-13).
Review notes already read: permission-policy, action-gate, session-vault, ipc and task-controller changes; not yet read: cdp-*, child-agent-coordinator, comms-guard, team-budgets, human-handoff, frontend components.

**Effort:** XL
**Priority:** P2
**Depends on:** Review task T3 (action-safety module)

## Completed
