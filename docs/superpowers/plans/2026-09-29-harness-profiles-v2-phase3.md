# Harness v2 Phase 3: Long Profile Reachability and Restart Correctness Implementation Plan

**Goal:** Make `harnessProfile: "long"` explicitly selectable through the real `TaskHost.createTask()` path (not just as a raw `TaskController` constructor param reachable only from unit tests), and prove it survives a real process-restart cycle — the specific ask in the design's Rollout Phase 3 ("verify restart/context reconstruction").

**Scoping note (2026-09-29):** the design's Phase 3 wording — "move the existing long-horizon machinery behind the Long profile" — reads as if Middle currently has some lighter-weight machinery that needs relocating behind Long. It doesn't: this codebase's context/recovery machinery (`TaskStore`'s durable event journal, `context-builder.js` always reconstructing context from durable state rather than trusting planner/model memory) has been profile-agnostic since before `harnessProfile` existed, and Phase 1 explicitly mapped all non-routine tasks to `middle` using that exact unchanged machinery. There is nothing to move: Middle and Long are behaviorally identical today, which matches the spec's own description of both (Middle: "recovers an interrupted task from the latest trustworthy checkpoint"; Long: "context is reconstructed from host-owned state," "must not turn crash recovery into action replay") — neither describes a capability this codebase lacks. Building a deliberately *lighter* Middle (e.g. discarding some durable state Long would keep) is not implied by "verify restart/context reconstruction" and isn't attempted here. What *was* missing, and is the actual deliverable of this phase: `long` was never reachable outside a unit test, and nothing durably remembered an explicit profile choice across a restart — every reattach silently recomputed `middle` for any non-routine task via `_attach()`'s stateless `selectHarnessProfile({isRoutine})` default.

**Architecture:** `TaskHost.createTask()` gains an optional `{harnessProfile}` override (host/UI-only, per the design's "Explicit user/host selection is allowed" — never the model or task text). `TaskController`'s constructor and `TaskHost.getTaskDetail()`'s non-active branch both now give a durably checkpointed `harnessProfile` priority over `_attach()`'s stateless default, mirroring the exact pattern `_routineRun` already used. `_createNewTask()` writes an upfront checkpoint carrying the override (same as a routine's pinned revision already gets), so the choice survives even a crash before the task's first natural checkpoint.

**Tech Stack:** Electron main-process JavaScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-29-harness-profiles-v2-design.md` (Rollout Phase 3).

## Global Constraints

- The common path (no explicit override, no routine) must be byte-for-byte unchanged: no new checkpoint, no new field read differently, matching every existing Phase 1/2 test.
- An explicit override is validated (`validateHarnessProfile`) before it can ever reach a checkpoint or a controller.
- `goalInput` itself never carries `harnessProfile` — it stays outside `GoalSpec`'s closed, versioned schema entirely, avoiding a `SCHEMA_VERSION` bump and its migration risk. The checkpoint's already-freeform `payload` (which `routineRun` already uses the same way) is the only place this is durably recorded.
- `runRoutine()` does not expose an override: a routine's `harnessProfile` is always `"short"`, tied structurally to `RoutineRunner`'s own fixed `maxBatchActions:"short"` batching — letting a routine be relabeled `"long"` while its actual batching stays short-shaped would be a lie the checkpoint would then durably repeat.

## Review Focus

- `getTaskDetail()`'s active and non-active branches must report the identical `harnessProfile` for the identical task at every point in its lifecycle (before first checkpoint doesn't apply once an override forces one; after any pause; after a real restart).
- A restart must be simulated as a genuinely new `TaskHost` instance over the same `storageRoot` (not just calling methods on the same object), per the existing `listTasks() reconciles ... after restart` test's own pattern.
- `_checkpoint()`'s new `harnessProfile` field must never grow checkpoint size meaningfully (it's a 4-9 character string) and must never appear as an unknown-key rejection anywhere `checkpoint.payload` is read back.

---

### Task 1: Explicit, durable, restart-surviving `harnessProfile` selection

**Files:**
- Modified: `apps/computer-browser/main/harness/task-controller.js` (constructor reads `store.lastCheckpoint?.payload?.harnessProfile` first; `_checkpoint()` now always includes `harnessProfile`).
- Modified: `apps/computer-browser/main/harness/task-host.js` (`createTask(goalInput, {harnessProfile})`; `_createNewTask`'s new `harnessProfileOverride` param and upfront checkpoint; `_attach`'s new param; `getTaskDetail()`'s non-active branch now checks the checkpoint first).
- Modified: `apps/computer-browser/test/task-host.test.js`.

**Interfaces:**
- `TaskHost.createTask(goalInput, {harnessProfile} = {})` — `harnessProfile` omitted keeps exactly today's default (`selectHarnessProfile({isRoutine:false})` → `"middle"` for every non-routine task); an invalid value throws `HarnessProfileError` (`invalid_harness_profile`) before any store/browser/planner resource is created.
- `TaskController` and `TaskHost.getTaskDetail()` both now resolve `harnessProfile` with the same three-tier priority: durably checkpointed value > explicit constructor/override input > `selectHarnessProfile({isRoutine})` default.

- [x] Add a test that an invalid explicit `harnessProfile` is rejected by `createTask()`.
- [x] Add a restart test: create a task with `harnessProfile:"long"` and a second with no override, drive both to `paused`, close the host, open a brand-new `TaskHost` on the same `storageRoot`, and assert `getTaskDetail()` reports `"long"`/`"middle"` correctly both before (store-load-only) and after (`resumeSavedTask()`) reattachment.
- [x] Implement.
- [x] Run focused tests. (First pass caught a real bug: `getTaskDetail()`'s non-active branch never read the newly-persisted checkpoint field at all, so the restart test failed `'middle' !== 'long'`. Fixed by giving it the same checkpoint-priority read `TaskController`'s constructor already has. Second run: `task-host.test.js` 49/49 green.)
- [x] Run full regression. (`apps/computer-browser` 646/653; same 2 pre-existing, unrelated failures as every prior phase.)

### Task 2: Context reconstruction verification — no new mechanism found to verify separately

Per the scoping note above, context reconstruction after restart is not profile-specific machinery this phase introduces — it is the same `context-builder.js` / durable-journal-replay path every profile has always used, already covered by the suite's existing (profile-agnostic) recovery tests (`test/task_controller` resume/recovery cases, `test/task-host.test.js`'s own restart/reconciliation tests, `test/routine-task-e2e.test.js`'s cross-restart recovery). Task 1's restart test additionally proves the profile label itself survives restart and is visible via the same `getTaskDetail()` surface a host/UI would actually use. No separate Task 2 implementation was needed; recorded here so this phase's scope decision is explicit rather than silently skipped.

**Phase 3 status: implemented.** `long` is now reachable through the real `TaskHost.createTask()` path and durably survives a real restart, proven by a genuine new-`TaskHost`-instance test. No existing test's expected value changed anywhere in Phase 1, 2, or 3.
