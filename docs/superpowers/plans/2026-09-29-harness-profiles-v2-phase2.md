# Harness v2 Phase 2: Short Harness Implementation Plan

**Goal:** Give the `short` harness profile real execution behavior — safe batching, reduced planner cadence, incremental observation, and semantic durability — per the design's Short Harness section, with each optimization independently benchmarked against the current (Middle-equivalent) baseline. `middle` and `long` behavior must not change in this phase.

**Architecture:** `TaskController` now receives and stores an explicit `harnessProfile` (Phase 2 Task 1, done), selected by `TaskHost` as the sole profile-selection authority. Later tasks read `this._harnessProfile` at specific, narrow decision points (batch sizing, planner-call gating, observation depth, checkpoint cadence) rather than branching broadly through the controller. Every behavior change stays inside the existing authority boundary: policy, approval, and ResourceAdmission are unaffected by profile (Global Constraints, unchanged from Phase 1).

**Tech Stack:** Electron main-process JavaScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md` (Short Harness section; Rollout Phase 2).

## Global Constraints

- No profile can bypass review, ResourceAdmission, or change policy outcomes for an identical proposed action (Verification section of the spec).
- `middle` and `long` must be bit-for-bit behaviorally identical to current `develop` after every task in this plan; only `short` may diverge.
- A batch still ends at every authority boundary listed in the spec (approval boundary, externally-visible side effect, navigation/document-epoch change, unexpected state, policy change, uncertainty, evidence boundary) — profile only changes how aggressively *safe* batching is pursued, never which boundaries exist.
- `execution_uncertain` is never auto-retried, regardless of profile.
- Each optimization (batching / planner cadence / observation / durability) must land as its own task with its own before/after benchmark number, per the spec's Ablation section — no "Short is faster" claim without a `git diff`-attributable cause.
- Do not commit or push without a green `node --test` run across `apps/computer-browser` (aside from the two pre-existing, unrelated failures already present on `develop`: `test/agent-viewport-host.test.js`, `test/control-api.test.js`).

## Review Focus

- Any profile-gated branch must default to today's behavior when `harnessProfile` is `middle` or `long`; a missing/omitted profile must never silently become `short`.
- Batching changes must preserve every existing authority-boundary test in `test/task-controller.test.js`'s read-only-batch suite unmodified for `middle`.
- Planner-cadence changes must not weaken no-progress detection (`_noProgressThreshold`) or segment rotation (`_segmentRotationCalls`) for `middle`/`long`.
- Durability changes must preserve exact recovery correctness (`execution_uncertain` classification, checkpoint/journal replay) for `middle`/`long`; `short`'s "semantic segment boundary" durability must still be provably recoverable, not merely faster.

---

### Task 1: Thread `harnessProfile` into TaskController as a real, host-selected input

**Files:**
- Modified: `apps/computer-browser/main/harness/task-controller.js`
- Modified: `apps/computer-browser/main/harness/task-host.js`
- Modified: `apps/computer-browser/test/task-controller.test.js`

**Interfaces:**
- `TaskController` constructor accepts optional `harnessProfile`; validates it via `validateHarnessProfile` and defaults via `selectHarnessProfile({isRoutine})` when omitted (e.g. a directly-constructed test/child controller). Adds `getHarnessProfile()`.
- `TaskHost._attach()` computes `harnessProfile` via `selectHarnessProfile({isRoutine: !!routine})` and passes it explicitly, making TaskHost the sole selection authority per the spec's "Profile selection" section.
- `TaskHost.getTaskDetail()`'s active branch now reads `active.controller.getHarnessProfile()` instead of recomputing it.

- [x] Add tests: explicit invalid profile rejected; explicit valid profile (`"long"`) accepted and returned; routine/non-routine defaulting still `short`/`middle`.
- [x] Implement the constructor/host wiring.
- [x] Run `node --test test/task-controller.test.js test/task-host.test.js test/harness-profile.test.js test/child-agent-coordinator.test.js`. (160/160 green)
- [x] Run the full `apps/computer-browser` suite. (633/640 pass; the same 2 pre-existing, unrelated failures as Phase 1.)

### Task 2: Safe batching for `short`

**Design note (how the cap became profile-aware without weakening it elsewhere):** `validateProposalEnvelope()` (the shared security boundary in `shared/harness-contracts.js` used by routines, child agents, and message handling alike) now takes an optional `{maxActions}` override. It is restricted to a fixed, pre-reviewed allowlist (`ALLOWED_PROPOSAL_MAX_ACTIONS = [MAX_ACTIONS_PER_PROPOSAL, MAX_ACTIONS_PER_PROPOSAL_SHORT]`) — an unrecognized override throws `invalid_field` rather than silently widening the boundary to whatever a caller passes. `shared/harness-profile.js` owns the single mapping from profile to bound (`maxActionsPerProposal(profile)`); every other existing caller of `validateProposalEnvelope` (child-agent-coordinator's `child_plan` validation, and any future non-`actions`-kind proposal) omits the option entirely and keeps exactly today's `MAX_ACTIONS_PER_PROPOSAL` behavior.

**Files:**
- Modified: `apps/computer-browser/shared/harness-contracts.js` (`MAX_ACTIONS_PER_PROPOSAL_SHORT` constant, `{maxActions}` option + allowlist check on `validateProposalEnvelope`).
- Modified: `apps/computer-browser/shared/harness-profile.js` (`maxActionsPerProposal(profile)`).
- Modified: `apps/computer-browser/main/harness/progress.js` (threads `context.maxActions` through).
- Modified: `apps/computer-browser/main/harness/task-controller.js` (passes `maxActionsPerProposal(this._harnessProfile)` at its one `validateProposal` call site).
- Modified: `apps/computer-browser/main/harness/routine-runner.js` (`maxBatchActions` constructor option, defaulting to `MAX_ACTIONS_PER_PROPOSAL`, used in place of the hardcoded constant when batching consecutive scroll steps).
- Modified: `apps/computer-browser/main/harness/task-host.js` (both `RoutineRunner` construction sites now pass `maxBatchActions: maxActionsPerProposal("short")`, since a routine task is always `short`).
- Modified: `apps/computer-browser/test/harness-profile.test.js`, `test/task-controller.test.js`, `test/routine-runner.test.js`.

**Interfaces:** batching aggressiveness for `short` increases only for actions already provably safe to batch (read-only, no cross-boundary effect — the existing `isReadOnlyAction`/`_dispatchReadOnlyBatch` gate is unchanged); `middle`/`long` keep exactly today's `MAX_ACTIONS_PER_PROPOSAL`-bounded (3) behavior.

- [x] Design note above.
- [x] Add tests proving `short` accepts and batches more read-only actions per turn than `middle` rejects under an otherwise identical 4-action proposal (`task-controller.test.js`), that `RoutineRunner`'s `maxBatchActions` batches past the old 3-cap (`routine-runner.test.js`), that `maxBatchActions` fails closed on a non-positive-integer, and that `maxActionsPerProposal` maps correctly per profile and rejects an invalid one (`harness-profile.test.js`).
- [x] Implement.
- [x] Benchmark (in-process, `TaskController` + fake store/browser, not the full Electron integration harness): completing the *same* 6 read-only scroll actions —
  | | planner calls | approval calls | journal appends |
  |---|---:|---:|---:|
  | middle (2 turns, its own 3-cap) | 3 | 2 | 12 |
  | short (1 turn, 6 ≤ its 8-cap) | 2 | 1 | 12 |

  Batching more read-only actions per turn measurably reduces planner and approval round-trips (33% fewer planner calls, 50% fewer approvals for this fixed workload); journal append count is unaffected by batch width (each action still produces its own `action_started`/`action_outcome` pair — only the `durable`/fsync flag on the non-final entries changes, which Task 5 addresses, not Task 2).
- [x] Run focused (`harness-profile.test.js`, `task-controller.test.js` 88/88, `routine-runner.test.js`, `routine-store.test.js`, `routine-task-e2e.test.js`: 166/166 combined) + full regression (638/645; the same 2 pre-existing, unrelated failures).

### Task 3: Reduced planner cadence for `short`

**Files (expected):** `main/harness/task-controller.js`, `main/harness/context-builder.js`, new/modified tests.

**Interfaces (expected):** for `short`, the planner is not invoked merely because one browser action completed when the current segment's expected next step is still structurally determinable (e.g. mid-batch); `middle`/`long` planner-call triggers are unchanged.

- [ ] Write failing tests establishing the exact current planner-call triggers for `middle` as a locked baseline (regression net before touching anything).
- [ ] Write failing tests for the new `short` no-unnecessary-replan behavior.
- [ ] Implement.
- [ ] Benchmark planner-call count and latency, `short` vs `middle`, on the same fixed scripted task as Task 2.
- [ ] Run focused + full regression.

### Task 4: Incremental observation for `short`

**Files (expected):** `main/harness/browser-adapter.js`, `main/harness/context-builder.js`, new/modified tests.

**Interfaces (expected):** `short` prefers delta/shallow observation over full observation per the spec's ordered preference list; a document-epoch change still invalidates unproven references for every profile.

- [ ] Design note: what "delta observation" concretely means against the current `BrowserAdapter.observe()` contract, and how staleness is proven rather than assumed.
- [ ] Failing tests for delta validity/invalidation, `middle` observation behavior unchanged.
- [ ] Implement.
- [ ] Benchmark observation bytes/time, `short` vs `middle`.
- [ ] Run focused + full regression.

### Task 5: Semantic durability for `short`

**Files (expected):** `main/harness/task-controller.js`, `main/harness/task-store.js`, new/modified tests.

**Interfaces (expected):** `short` checkpoints at semantic segment boundaries instead of after every low-risk action; critical authority/evidence events remain durable regardless of profile (unchanged Global Constraint).

- [ ] Failing recovery tests: crash mid-segment for `short` must still classify correctly as completed/not-executed/`execution_uncertain`, never silently lose a boundary.
- [ ] Implement.
- [ ] Benchmark journal fsync count/time, `short` vs `middle`.
- [ ] Run focused + full regression.

### Task 6: Ablation report and full regression

- [ ] Combine Tasks 2-5's benchmark numbers into one ablation table (baseline → +batching → +planner cadence → +observation → +durability), per the spec's Ablation section.
- [ ] Run `node --test` across `apps/computer-browser`; confirm no `middle`/`long` test's expected value changed.
- [ ] Update `docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md`'s Rollout section to mark Phase 2 implemented, with a link to this plan and the ablation numbers.
