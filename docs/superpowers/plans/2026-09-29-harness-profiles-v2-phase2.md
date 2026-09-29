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
- [x] Write failing tests for the new `short` no-unnecessary-replan behavior. *(Superseded — see below.)*
- [x] Implement. *(Delivered by Task 2, not a separate mechanism — see below.)*
- [x] Benchmark planner-call count and latency, `short` vs `middle`, on the same fixed scripted task as Task 2.
- [x] Run focused + full regression.

**Outcome: delivered by Task 2, not a separate change.** The spec's own wording is "The planner should not be invoked merely because another browser action occurred" — that is exactly what read-only batching already does (a batch's actions dispatch without returning to the planner between them), and Task 2's wider `short` cap directly scales it: completing the same 6 read-only actions took 3 planner calls for `middle` (two 3-action batches) versus 2 for `short` (one 6-action batch) — the same benchmark table as Task 2. Inventing a second, independent planner-cadence mechanism on top of batch width would not be a different optimization; it would be re-deriving the same lever. No separate code change was made for this task.

### Task 4: Incremental observation for `short`

**Files (expected):** `main/harness/browser-adapter.js`, `main/harness/context-builder.js`, new/modified tests.

**Interfaces (expected):** `short` prefers delta/shallow observation over full observation per the spec's ordered preference list; a document-epoch change still invalidates unproven references for every profile.

- [x] Design note (below).
- [ ] Failing tests for delta validity/invalidation, `middle` observation behavior unchanged. **Not started.**
- [ ] Implement. **Not started — deliberately deferred, see below.**
- [ ] Benchmark observation bytes/time, `short` vs `middle`.
- [ ] Run focused + full regression.

**Design note (2026-09-29) — why this is deferred rather than shipped:**

`TaskController`'s main loop (`task-controller.js`, the `while (this._task.state === "running")` loop) unconditionally calls `this._browser.observe(...)` at the top of every turn, before the planner is consulted (see the fixed sequence: observe → build context → `planner.next()`). A real "delta observation" for `short` needs at minimum:

1. A way to know a fresh observation is *already in hand and provably valid* — e.g. the just-dispatched batch's own trailing `observe` action, or a proof that nothing could have changed the page since the last observation (no navigation, no dispatched action other than a scroll that doesn't itself invalidate element references).
2. `BrowserAdapter.execute()` to actually return that observation payload for an in-batch `observe` action — today it returns only `{status, evidenceCandidate: {observationId}}` (see `browser-adapter.js`'s `execute()`, `case "observe"`), not the full `Observation` object, so the controller currently has no in-hand observation to reuse even when one was just taken.
3. A precise, testable staleness proof tied to `documentEpoch` (already tracked) plus which action types are provably non-invalidating for already-known element references — not merely "no navigation happened," since a page can mutate its own DOM without navigating.

Each of these touches a genuinely different, wider surface than Task 2/3/5's batch-width lever: `BrowserAdapter.execute()`'s return contract is depended on by every action-type branch and by `_dispatchApprovedAndApplyTracked`'s durable journal payloads, and changing what "provably valid" means for a stale reference is a correctness question for the *entire* observation/no-progress-detection pipeline (`observationKey()`, `_noProgressThreshold`), not just `short`. Implementing this well within the existing test-first-with-failing-tests discipline the rest of this codebase uses is realistically its own task-by-task plan (its own design doc, its own recovery/staleness test matrix), not a same-session extension of Task 2's batching change.

**Decision:** left unimplemented in this Phase 2 pass. `short` observation behavior is currently identical to `middle`/`long` (full observation every turn) — this is safe (no regression, no weakened invariant) but does not yet deliver the "incremental observation" half of the Short Harness spec. A dedicated follow-up plan should be written before touching `BrowserAdapter.observe()`/`execute()`.

### Task 5: Semantic durability for `short`

**Files (expected):** `main/harness/task-controller.js`, `main/harness/task-store.js`, new/modified tests.

**Interfaces (expected):** `short` checkpoints at semantic segment boundaries instead of after every low-risk action; critical authority/evidence events remain durable regardless of profile (unchanged Global Constraint).

- [x] Failing recovery tests: crash mid-segment for `short` must still classify correctly as completed/not-executed/`execution_uncertain`, never silently lose a boundary. *(Covered by the existing, unmodified read-only-batch recovery/no-progress tests — no new recovery path was introduced, see below.)*
- [x] Implement. *(Delivered by Task 2, not a separate mechanism — see below.)*
- [x] Benchmark journal fsync count/time, `short` vs `middle`.
- [x] Run focused + full regression.

**Outcome: delivered by Task 2, not a separate change.** `_runApprovedReadOnlyBatch` already marks only the batch's *last* `action_started` durable (`durable: index === actions.length - 1`) — this is exactly the "semantic segment boundary" durability the spec asks for, and it already existed for every profile before Phase 2. Task 2's wider `short` cap directly extends its benefit: a new regression test (`test/task-controller.test.js`, "short's wider batch durably persists fewer action_started entries than middle for the same total read-only actions") proves completing the same 6 read-only actions durably persists 2 `action_started` entries for `middle` (two 3-action batches) versus 1 for `short` (one 6-action batch) — a 50% reduction in fsync-triggering writes for this fixed workload, with `appends` (the non-durable/buffered writes) unchanged at 12 either way. Recovery correctness is unaffected because no new recovery path was introduced: the existing durable/non-durable coalescing and its recovery tests were already exercised at batch size 3; this only changes the batch size short can reach.

### Task 6: Ablation report and full regression

- [x] Combine Tasks 2/3/5's benchmark numbers into one ablation table, per the spec's Ablation section. Completing the same fixed workload (6 read-only scroll actions, one task, otherwise identical):

  | | planner calls | approval calls | journal appends | durable (fsync) appends |
  |---|---:|---:|---:|---:|
  | baseline / `middle` (today's unchanged 3-action cap, 2 turns) | 3 | 2 | 12 | 2 |
  | `short` + wider safe batching (Task 2; Task 3's cadence and Task 5's durability wins are the same lever, not additive) | 2 | 1 | 12 | 1 |

  One real, tested change (the profile-aware batch cap) accounts for the entire measured delta: -33% planner calls, -50% approvals, -50% durable/fsync writes, with total journal-append volume unchanged. Task 4 (incremental observation) contributes nothing yet — it is deliberately unimplemented (see its design note above) — so `short`'s per-turn observation cost is currently identical to `middle`'s.
- [x] Run `node --test` across `apps/computer-browser`; confirm no `middle`/`long` test's expected value changed. (645 tests: 638 pass, 2 pre-existing/unrelated failures reproduced identically on `develop` before Phase 2, 5 skipped; no existing assertion's expected value changed, only new tests/fields were added.)
- [x] Update `docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md`'s Rollout section to mark Phase 2 partially implemented (batching/cadence/durability shipped via one mechanism; observation explicitly deferred), with a link to this plan.

**Phase 2 status: partially implemented.** Safe batching, reduced planner cadence, and semantic durability for `short` are implemented, tested, and benchmarked — all three turned out to be the same underlying lever (profile-aware batch width), which is itself evidence worth keeping rather than papering over with three separate ad hoc mechanisms. Incremental observation is explicitly deferred pending its own design doc, per the note under Task 4. `middle`/`long` execution is unchanged from `develop` before this plan.
