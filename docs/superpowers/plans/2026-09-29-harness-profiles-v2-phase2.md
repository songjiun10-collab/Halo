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

**Files (expected):**
- Modify: `apps/computer-browser/shared/harness-contracts.js` (thread a profile-aware proposal action-count bound through `validateProposal`'s call sites, or introduce a controller-side re-batching step that is itself bounded by the existing `MAX_ACTIONS_PER_PROPOSAL` contract — needs its own design note before implementation, since `validateProposal` is a shared security boundary used by routines, child agents, and message handling, not something to widen casually).
- Modify: `apps/computer-browser/main/harness/task-controller.js` (`_dispatchActionsBatch`/`_dispatchReadOnlyBatch`).
- New/modify tests in `test/task-controller.test.js`.

**Interfaces (expected):** batching aggressiveness for `short` increases only for actions already provably safe to batch (read-only, no cross-boundary effect); `middle` keeps exactly today's `MAX_ACTIONS_PER_PROPOSAL`-bounded behavior.

- [ ] Write a short design note on exactly how the contract-level cap becomes profile-aware without weakening it for any other caller (routine runner, child agents, message proposals all currently share the same constant).
- [ ] Add failing tests proving `short` batches more read-only actions per turn than `middle` under otherwise identical proposals, and that every authority-boundary termination rule still applies to `short`.
- [ ] Implement.
- [ ] Benchmark: approval calls, journal writes, and wall time for a fixed read-only-heavy scripted task, `short` vs `middle`, using the existing `integration/routine-vs-planner-benchmark.js` pattern as a template.
- [ ] Run focused + full regression.

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
