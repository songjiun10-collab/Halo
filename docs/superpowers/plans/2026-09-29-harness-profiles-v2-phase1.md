# Harness v2 Phase 1: HarnessProfile Interface Implementation Plan

**Goal:** Introduce the `HarnessProfile` (`short`/`middle`/`long`) interface described in the Harness v2 design without changing any existing execution semantics; map all current task behavior to `middle`, with the one structurally decidable exception (a saved routine run) mapping to `short`.

**Architecture:** A new pure, dependency-free module (`shared/harness-profile.js`, mirroring the existing `shared/harness-contracts.js` pattern) owns the profile enum, validation, and the Phase 1 deterministic selection rule. `TaskController` gains a minimal read-only `isRoutine()` accessor. `TaskHost.getTaskDetail()` is the only call site wired to compute and expose `harnessProfile`, for both active and recovered/saved-only tasks. No journal event, checkpoint schema, TaskStore digest, planner behavior, batching, durability, or recovery logic changes in this phase.

**Tech Stack:** Electron main-process JavaScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md` (Rollout, Phase 1).

## Global Constraints

- No execution-affecting behavior may change in this phase: policy, approval, batching, durability, planner cadence, and recovery stay exactly as they are today for every task.
- `harnessProfile` is read-only/informational output in this phase; nothing consumes it to alter dispatch yet.
- Do not touch TaskStore's journal/checkpoint schema, event digests, or `EVENT_TYPES`.
- `long` is not auto-selectable yet; only `short` (saved routine) and `middle` (everything else) are reachable from `selectHarnessProfile` in this phase, matching the design's explicit routing table entry for routines.
- Do not commit or push without completing and green-running the full existing `apps/computer-browser` test suite (aside from pre-existing, unrelated failures already present on `develop`).

## Review Focus

- `selectHarnessProfile`/`validateHarnessProfile` must be pure and independently unit-testable, with no fs/IPC/Electron dependency.
- `isRoutine()` must reflect exactly the same signal (`_routineRun !== null`) the controller already uses internally for routine-specific durability/recovery paths; it must not introduce a second, divergent notion of "is this a routine task."
- `getTaskDetail()` must compute `harnessProfile` identically for an active task (via the live controller) and a recovered/saved-only task (via `store.lastCheckpoint.payload.routineRun`), so the value does not depend on whether the task happens to be attached.
- No existing test's expected behavior may change; only new assertions/fields are added.

---

### Task 1: HarnessProfile contracts module

**Files:**
- Create: `apps/computer-browser/shared/harness-profile.js`
- Create: `apps/computer-browser/test/harness-profile.test.js`

**Interfaces:**
- Exports `HARNESS_PROFILES` (`["short","middle","long"]`), `HarnessProfileError`, `validateHarnessProfile(value)`, `selectHarnessProfile({isRoutine})`.

- [x] Write tests for the exact profile set, valid-value acceptance, invalid/non-string/empty rejection, and the `isRoutine` → `short`/default → `middle` selection rule.
- [x] Implement the module.
- [x] Run `node --test test/harness-profile.test.js`. (5/5 green)

### Task 2: TaskController routine signal

**Files:**
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/test/task-controller.test.js`

**Interfaces:**
- Adds `TaskController.isRoutine()` returning `this._routineRun !== null`.

- [x] Add a test constructing both a plain and a routine-run controller and asserting `isRoutine()` for each.
- [x] Implement the accessor next to the existing `getGoal()`.
- [x] Run `node --test test/task-controller.test.js`. (65/65 green)

### Task 3: Wire `harnessProfile` into `getTaskDetail()`

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/test/task-host.test.js`

**Interfaces:**
- `getTaskDetail(taskId)` return value gains `harnessProfile`, computed via `selectHarnessProfile({isRoutine})` for both the active-controller branch and the store-load (recovered/saved-only) branch.

- [x] Extend the existing active/saved-only `getTaskDetail()` test with `harnessProfile` assertions (`"middle"` for both).
- [x] Extend the existing `runRoutine()` test with a `harnessProfile === "short"` assertion via `getTaskDetail()`.
- [x] Implement the wiring.
- [x] Run `node --test test/task-host.test.js`. (47/47 green)

### Task 4: Full regression

**Files:** none (verification only).

- [x] Run `node --test` across `apps/computer-browser`. (632/639 pass; the 2 pre-existing failures — `test/agent-viewport-host.test.js`, `test/control-api.test.js` — reproduce identically on `develop` before this change and are unrelated to it.)
- [x] Confirm no existing assertion's expected value changed; only new fields/tests were added.
