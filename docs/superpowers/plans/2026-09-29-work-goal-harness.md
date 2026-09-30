# HALO Work Goal Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a durable project-scoped Work Goal lifecycle that links and budgets multiple HALO tasks without bypassing the existing policy, approval, evidence, profile, queue, or provenance gates.

**Architecture:** A pure `work-goal-contracts.js` validates bounded Goal specs and a closed append-only event schema. `WorkGoalStore` provides durable journal/replay and project active-goal serialization; `WorkGoalOrchestrator` owns lifecycle, evidence validation, task reservations, and recovery reconciliation. `TaskHost` remains the only task binder/admitter; TaskStore profile events retain an optional immutable Goal binding. Main IPC/preload expose only trusted host operations.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Electron IPC; local JSONL journal + atomic manifests using existing TaskStore/TaskQueue durability patterns.

**Spec:** `docs/superpowers/specs/2026-09-29-work-goal-harness-design.md`

## Global Constraints

- At most one active/paused/blocked Work Goal exists per project storage root.
- New project Tasks inherit the active Work Goal unless host explicitly marks them standalone.
- WorkGoal metadata never grants execution authority; existing Task profile, policy, approval, evidence, provenance, resource, and recovery paths remain authoritative.
- TaskStore's optional `workGoalBinding` is exactly `{goalId, goalVersion, reservationId}`; historical Task profiles without it remain valid.
- Goal completion requires exact current-version verified evidence for every required host-evidence criterion or explicit trusted user verification.
- Uncertain or nonterminal Task checkpoints retain their full reserved allowance; missing/corrupt data never frees capacity implicitly.
- Goal objective UTF-8 cap 16 KiB; criteria cap 64 × 512 chars; task count cap 10,000; actions/planner calls cap 1,000,000; active time cap 31,536,000,000 ms.
- No provider token accounting, renderer UI, unbounded autonomous task creation, or independent child-Task WorkGoal binding in v1.

## Review Focus

- Concurrent start/reservation/archive and lock ordering — simultaneous operations must not create two active Goals, overbook a budget, or deadlock.
- Cross-store crash points — reserve, TaskStore bind, link, continuation record, and queue admission must recover idempotently without releasing capacity.
- Legacy and forged Task profile bindings — omitted legacy binding remains readable; malformed, mismatched, or caller-forged binding fails closed.
- Evidence/event reference substitution — only current-version verified evidence for the exact matching criterion can satisfy host evidence.
- Task creation routes — createTask, routine, and scheduled routine all inherit active Goal/budget, while explicit standalone work does not.

---

### Task 1: Work Goal contracts and deterministic replay

**Files:**
- Create: `apps/computer-browser/shared/work-goal-contracts.js`
- Create: `apps/computer-browser/test/work-goal-contracts.test.js`
- Modify: `docs/superpowers/specs/2026-09-29-work-goal-harness-design.md` only if an implementation conflict requires a documented ruling.

**Interfaces:**
- Produces `validateWorkGoalSpec(value)`, `validateWorkGoalInput(value)`, `validateWorkGoalEvent(event)`, and `replayWorkGoalEvents(events)`.
- Replay returns `{spec, status, seq, tasks, reservations, progress, verifiedCriteria, blockerStreak}`; invalid order/version/state throws an error with a stable `code`.
- Event envelope: `{seq,eventId,goalId,goalVersion,type,payload,at}` with exact allowed fields and closed event types/payloads from the spec.

- [x] Write focused contract tests for spec bounds, exact fields, event envelopes, legal state transitions, stale versions, duplicate reservation idempotency/conflict, blocker threshold, and criteria completion.
- [x] Run `node --test apps/computer-browser/test/work-goal-contracts.test.js`; confirm failures identify missing module/behavior.
- [x] Implement only the pure schemas and reducer required by those tests.
- [x] Re-run the focused suite and mutation-check invalid fields, wrong state transitions, skipped sequence, event-ID reuse, budget overbooking and amendment below outstanding reservation.

### Task 2: Durable WorkGoalStore

**Files:**
- Create: `apps/computer-browser/main/harness/work-goal-store.js`
- Create: `apps/computer-browser/test/work-goal-store.test.js`

**Interfaces:**
- `new WorkGoalStore({storageRoot, now})`, `load()`, `create(input)` (host-assigns UUID and version 1), `append(eventInput)`, `getActive()`, `get(goalId)`, `listHistory()`, `close()`.
- Storage: `<storageRoot>/work-goals/`, per-goal `events.jsonl`, atomic active pointer, 0700 directories, 0600 files, no-follow regular-file reads, fsynced append and atomic pointer update.
- One project registry lock serializes active slot mutations; per-goal write chain/lock serializes event append and expected-version changes.

- [x] Write real-filesystem tests for create/load/history, 0700/0600 modes, symlink rejection, torn final line recovery, complete-line corruption rejection, duplicate active goal, lock conflict, and expected-version races.
- [x] Run focused tests and verify expected failures before implementation.
- [x] Implement store using existing TaskStore/TaskQueue primitives/patterns; do not expose arbitrary path arguments.
- [x] Re-run store and contract tests; verify corrupt/mismatched active pointer cannot override journal-derived state. Store tests passed 12/12.

### Task 3: Durable optional Task binding

**Files:**
- Modify: `apps/computer-browser/shared/task-profile-contracts.js`
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Modify: `apps/computer-browser/test/task-profile-contracts.test.js`
- Modify: `apps/computer-browser/test/task-store.test.js`

**Interfaces:**
- `workGoalBinding` is optional only in the persisted `task_profile_selected` contract and, when present, exactly `{goalId, goalVersion, reservationId}`. Host-resolved profiles do not carry caller-supplied goal bindings.
- `TaskStore.create(goalInput,{storageRoot,taskId,onTiming,resolvedProfile,workGoalBinding})` durably writes the binding in the initial `task_profile_selected` event.
- `TaskStore.createChild()` remains unbound in v1. TaskStore replay exposes and validates legacy or bound profile data.

- [x] Write tests proving old unbound stores still load and valid bindings round-trip; wrong IDs/version/reservation, unknown fields, and binding on incompatible task profile fail closed.
- [x] Run contract/store focused tests to verify new cases fail before implementation.
- [x] Implement optional exact binding validation and persistence without changing event order or legacy format.
- [x] Re-run focused suites; mutation-check that changing goalId/version or dropping binding causes a failing assertion.

### Task 4: WorkGoalOrchestrator lifecycle and evidence rules

**Files:**
- Create: `apps/computer-browser/main/harness/work-goal-orchestrator.js`
- Create: `apps/computer-browser/test/work-goal-orchestrator.test.js`

**Interfaces:**
- Orchestrator: `startWorkGoal(input: WorkGoalInput)`, `getActiveWorkGoal()`, `listWorkGoalHistory({limit=50,cursor=null}) -> {items,nextCursor}`, `amendWorkGoal(expectedVersion,nextSpec)`, `recordWorkGoalProgress(goalId,expectedVersion,evidenceRefs)`, `verifyWorkGoalCriterion(goalId,expectedVersion,criterionId)`, `pauseWorkGoal`, `resumeWorkGoal`, `completeWorkGoal`, `archiveWorkGoal`. Host assigns initial UUID/version and actor identity. History page size is capped at 100; recovery uses the separate unbounded internal journal reader.
- It wraps `WorkGoalStore` and owns lifecycle validation, evidence-reference verification via `TaskStore.readEvents()`/validated TaskStore recovery data, criterion verification, and reservation reconciliation primitives. It does not create or admit Tasks.

- [x] Write real-store orchestrator tests for expected-version amendment, evidence event/task/version/criterion matching, stale user verification, pause/resume/block/archive transitions, completion gating, and reservation usage reconciliation; Task 6 proves renderer cannot forge the actor.
- [x] Run `node --test apps/computer-browser/test/work-goal-orchestrator.test.js`; verify expected missing behavior.
- [x] Implement orchestrator operations over the validated store and real TaskStore readers; keep actor identity host-owned.
- [x] Re-run orchestrator/store/contract tests and mutation-check evidence substitution, stale version, missing terminal checkpoint, and repeated reconciliation.

### Task 5: TaskHost task binding, budgets, and recovery

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/context-builder.js`
- Modify: `apps/computer-browser/test/task-host.test.js`
- Modify: `apps/computer-browser/test/task-controller.test.js`
- Modify: `apps/computer-browser/test/context-builder.test.js`

**Interfaces:**
- TaskHost exposes Work Goal lifecycle methods and uses WorkGoalOrchestrator as the project-goal authority.
- `createTask(goalInput, options={})` supports existing profile selectors plus `standalone`; arbitrary Goal IDs and origin fields are forbidden. Routine/scheduled creation derives origin internally.
- Task creation runs the cross-store transaction under a host admission gate, chooses taskId first, clamps normalized Task limits, durably writes the bound Task profile, then reserves/links/records continuation before queue admission. A failed TaskStore create does not consume a Goal reservation; a crash in a later uncertain boundary remains fail-closed.
- `_attach()` injects a trusted WorkGoalContext reader keyed by durable `{goalId,goalVersion}` binding. TaskController reads it on every planner turn; `buildContext()` emits it separately from the immutable Task `goal`, bounded by the existing packet cap. Standalone/legacy tasks omit the field.
- Recovery reconciles reservations from TaskStore binding and validated terminal checkpoint. Only completed/stopped checkpoints release exact unused limits; uncertain/missing/corrupt/nonterminal state keeps capacity reserved.

- [x] Write TaskHost/controller/context tests for active-goal uniqueness, default binding across ordinary/routine Tasks, explicit standalone escape, task/action/planner/time caps, concurrent reservations, exact bound-version WorkGoal context on every planner turn, context-size fail-closed behavior, and queue admission ordering.
- [x] Run focused TaskHost tests and verify expected missing behavior.
- [x] Implement TaskHost integration at `_createNewTask()`, `_attach()`, and `_ensureQueue()`, plus separate WorkGoal context in TaskController/context-builder, without changing explicit task resume or queue semantics.
- [x] Re-run host/orchestrator/store suites and mutation-check stale checkpoint, reservation retry, and lock-boundary cases against the full suite. Focused suites passed 87/87; full suite passed 917/917.

### Task 6: Trusted IPC and end-to-end verification

**Files:**
- Modify: `apps/computer-browser/main/ipc.js`
- Modify: `apps/computer-browser/preload/index.js`
- Modify: `apps/computer-browser/test/harness-ipc.test.js`
- Create: `apps/computer-browser/test/preload-api.test.js`

**Interfaces:**
- Expose Work Goal lifecycle methods through trusted main-frame harness IPC only; actor identity is assigned by main, never accepted as caller-provided text.
- Renderer surface is additive; no UI changes.

- [x] Write IPC tests for every new trusted channel, argument forwarding, untrusted sender rejection, and channel cleanup.
- [x] Run focused IPC tests and verify failures before wiring methods.
- [x] Add main/preload methods and exact TaskHost dispatch mappings.
- [x] Run all new Work Goal tests, then `npm --prefix apps/computer-browser test` and `git diff --check`; compare against the clean 854/854 baseline and report every failure and all scope limitations. Current suite is 917/917; baseline was 854/854.
- [x] Review the complete diff against the spec and security boundaries before claiming completion.
