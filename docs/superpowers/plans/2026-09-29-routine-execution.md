# HALO Routine Execution v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add locally saved immutable routine definitions and run them through the ordinary durable HALO TaskController policy and approval path.

**Architecture:** A strict shared definition validator and local `RoutineStore` provide pinned revisions. A `RoutineRunner` only proposes one action per turn; TaskHost supplies it to an ordinary task, while TaskController records explicit routine advancement/denial events and checkpoints the cursor. The main-process IPC surface reuses the trusted harness sender gate.

**Tech Stack:** Electron main-process JavaScript, existing TaskStore/TaskController, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-28-routine-execution-design.md`

## Global Constraints

- Manual-start local routines only; no schedules, arbitrary JavaScript, shell, sync, or embedded credentials.
- V1 step kinds are `navigate`, `follow_link`, and `scroll`; exactly one action per TaskController turn.
- The exact normalized HTTP(S) origin allowlist is independently enforced by RoutineRunner; host policy and approval remain authoritative.
- Follow-link resolution uses exact accessible name and optional expected href; zero or multiple matches fail closed.
- Serialized definitions are at most 64 KiB; at most 64 steps; URLs at most 2048 characters; accessible names at most 256 characters.
- Routine revisions are immutable; deletion tombstones listings but retains revisions for active/recoverable tasks.
- Cursor recovery uses host-authored `routine_step_advanced` records plus a checkpoint cursor; integrity ambiguity fails closed.
- Policy deny/quarantine durably pauses with `routine_step_denied`; uncertain dispatched actions are never replayed automatically.
- Routine IPC is fixed-allowlist only and uses existing `registerIpc` / `isTrustedSender` checks.
- The planner-vs-routine benchmark is not evidence of model quality and runs only after correctness/recovery tests.

## Review Focus

- Symlink, oversized, malformed, and unknown-field routine files must reject before task resources are created; test in RoutineStore.
- Duplicate or absent exact link names and cross-origin targets must pause without guessing; test in RoutineRunner.
- Missing, duplicate, reordered, or digest-mismatched advancement records must fail closed; test recovery in TaskController/TaskHost.
- Denied and quarantined actions must pause durably instead of looping; test TaskController policy decisions.
- Renderer calls from an untrusted sender must not access routine storage or start runs; test IPC using existing sender fixtures.

---

### Task 1: Definition validation and immutable RoutineStore

**Files:**
- Create: `apps/computer-browser/shared/routine-contracts.js`
- Create: `apps/computer-browser/main/harness/routine-store.js`
- Create: `apps/computer-browser/test/routine-store.test.js`

**Interfaces:**
- Produces `validateRoutineDefinition(input) -> normalizedDefinition`, `RoutineStore({storageRoot})`, `list()`, `get(routineId, revision?)`, `save(input)`, `delete(routineId)`.
- Store saves each revision with exclusive create; only the current-revision index is atomically replaced. Delete tombstones current listing and retains revision files.

- [x] Write tests for schema bounds/unknown keys/origins, immutable revisions, tombstone retention, symlink refusal, and corrupt digest refusal.
- [x] Run `node --test test/routine-store.test.js`; confirm expected failures for missing modules/interfaces.
- [x] Implement validator and store following neighboring local stores' permission and no-follow patterns.
- [x] Run `node --test test/routine-store.test.js`; confirm all pass. (30/30 green)

### Task 2: RoutineRunner proposal contract

**Files:**
- Create: `apps/computer-browser/main/harness/routine-runner.js`
- Create: `apps/computer-browser/test/routine-runner.test.js`
- Modify: `apps/computer-browser/shared/harness-contracts.js`

**Interfaces:**
- Consumes Task 1's validated immutable definition and the existing `planner.next(context)` contract.
- Produces `RoutineRunner({definition, cursor})`, `next(context)`, plus current-step metadata for host advancement.
- Adds strict routine event types/payload schemas for `routine_step_advanced` and `routine_step_denied`.

- [x] Test one-action proposals for navigate/follow_link/scroll, correct task/goal/observation bindings, unique exact link matching, origin rejection, and completion.
- [x] Test zero/multiple match and invalid cross-origin observed target fail closed.
- [x] Run focused tests to observe the missing-runner/event failures.
- [x] Implement bounded, no-browser-authority runner and event validation.
- [x] Re-run `node --test test/routine-runner.test.js test/routine-store.test.js`. (9/9 + 30/30 green)

### Task 3: Durable cursor and denied-step pause

**Files:**
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Modify: `apps/computer-browser/test/task-controller.test.js`
- Modify: `apps/computer-browser/test/task-store.test.js`

**Interfaces:**
- TaskController receives optional pinned routine metadata `{routineId, revision, digest, cursor}` and exposes current cursor to checkpoint creation.
- On accepted routine action outcome, append `routine_step_advanced` durably before continuing; on policy deny/quarantine, append `routine_step_denied` and pause.
- TaskStore streaming replay produces a bounded routine-recovery summary independent of the 10-event model-context ring; it validates post-checkpoint advancement order and action/outcome bindings without materializing the full journal.
- Recovery validates checkpoint cursor against that summary and pinned step digests before any planner invocation; an outcome without matching advancement never causes replay.

- [x] Add tests for durable advancement, cursor checkpoint/recovery, an action outcome without advancement, >10 unrelated events without cursor loss, missing/duplicate/out-of-order/digest-mismatch failures, and deny/quarantine pause.
- [x] Run focused tests to verify red failures against current behavior.
- [x] Implement advancement only after accepted outcome and fail-closed reconciliation on reattach.
- [x] Run task-controller/store plus routine focused tests. (107/107 green)

### Task 4: TaskHost lifecycle and trusted IPC

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/main/ipc.js`
- Modify: `apps/computer-browser/preload/index.js`
- Modify: `apps/computer-browser/main/index.js`
- Modify: `apps/computer-browser/test/task-host.test.js`
- Modify: `apps/computer-browser/test/harness-ipc.test.js`
- Create: `apps/computer-browser/test/routine-task-e2e.test.js`

**Interfaces:**
- TaskHost exposes `listRoutines/getRoutine/saveRoutine/deleteRoutine/runRoutine`.
- `runRoutine(routineId, revision)` loads/validates pinned definition before memory admission or browser creation, creates an ordinary task with host-authored goal and routine metadata, and uses RoutineRunner as its proposal provider.
- Preload exposes only the fixed five routine calls. IPC reuses the current trusted sender checks.

- [x] Test invalid/missing revision fails before browser/planner resource factories; saved run pins exact revision/digest; run/resume retains memory-policy admission.
- [x] Test all five IPC methods and sender rejection using existing trusted-sender fixtures.
- [x] Run focused tests to verify red failures.
- [x] Implement host lifecycle and IPC bridge without exposing paths or definition payload on run.
- [x] Run TaskHost, IPC, and routine E2E tests. (59/59 focused host/IPC/E2E/benchmark tests green after final host change; 3/3 routine-task-e2e tests cover full-loop completion, cross-host-restart recovery, and durable denial pause)

### Task 5: Benchmark and full regression

**Files:**
- Create: `apps/computer-browser/integration/routine-vs-planner-benchmark.js`
- Create: `apps/computer-browser/test/routine-vs-planner-benchmark.test.js` (if benchmark has testable report schema)
- Modify: `apps/computer-browser/README.md` or a focused benchmark note for invocation/limits.

**Interfaces:**
- Both modes share Electron build, BrowserAdapter, TaskController, TaskStore, policy, memory admission, viewport, and success criteria.
- Report paired randomized iterations, warm/cold labels, p50/p95, action/planner counts, approval/store costs, sampled RSS cadence, planner startup/warm-up separately, and cleanup.

- [x] Add a smoke test proving both modes use the same deterministic scenario and emit comparable report fields. (`test/routine-vs-planner-benchmark.test.js`, 8 tests)
- [x] Run the smoke test red before implementation. (MODULE_NOT_FOUND)
- [x] Implement benchmark only after recovery and denial tests pass. (`integration/routine-vs-planner-benchmark.js` + `integration/README.routine-vs-planner-benchmark.md`)
- [x] Run routine-focused tests, existing computer-browser full test suite, and benchmark smoke; report any environment-only limitations. (195/195 routine-focused files green; full suite 670/670 before final TaskHost-only adjustment, followed by 59/59 relevant regression tests green; real Electron fair-order benchmark: 50 steps × 6 pairs, all 12 iterations passed, uniform requests. Routine warm p50 1,494.9 ms vs scripted planner 1,129.8 ms; paired planner-minus-routine p50 -355.2 ms. Poll-sampled peak RSS 501,940,224 B vs 554,860,544 B. See benchmark README for limits.)
- [x] Run `git diff --check` and review only routine-scoped changes; preserve all unrelated working-tree changes. (routine-scoped whitespace check clean; checkout contains unrelated in-progress edits)
