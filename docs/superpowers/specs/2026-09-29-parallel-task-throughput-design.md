# HALO Parallel Task Throughput Design

Status: partially implemented (2026-09-29), committed on `feature/routine-scheduler`. Sub-project 1 of 2 for "run many tasks in a fixed time". Sub-project 2 is `2026-09-29-routine-scheduler-design.md`, which enqueues into the same queue and depends on this one only for throughput, not for correctness. Done: `TaskHost({ maxParallelTasks })` validated to an integer 1..8 (`main/harness/task-host.js`), the slot cap wired through `CoordinatorCore` (`main/harness/coordinator-core.js`), and `integration/concurrent-throughput-benchmark.js`. **Not done:** the benchmark has not been run against real Electron, no dated results section was added, and the conditional reserve recalibration (`ROUTINE_TASK_RESERVE_BYTES`) was not measured or decided either way — the 370 MB reserve is unchanged from before this spec. Deferred pending an explicit user request to run the Electron benchmark.

## Problem

The goal is more completed tasks per unit time. Today the host already has a parallel mode, but it is capped by two things that were never measured against a real workload:

1. `TaskHost._admitNextLocked` hardcodes `maxActive = executionMode === "parallel" ? 2 : 1`.
2. Every admitted task must obtain a `ResourceAdmission` lease of `MEASURED_BROWSER_TASK_RESERVE_BYTES` (370 MB) plus 1.25 x the planner high-water mark, against `MemoryMonitor`'s hard 1,000,000,000-byte cap (`DEFAULT_LIMIT_BYTES`, which `setLimitBytes` refuses to exceed).

With a 1 GB cap and a 370 MB reserve, memory admission already limits the host to about two browser tasks at once, whatever the slot count. Raising the slot cap alone would change nothing. The first job is therefore to measure what a concurrent task really costs and how throughput scales, then decide what to change.

## Decision

Do not raise the 1 GB cap. It is a deliberate safety limit. Instead:

1. Make the slot cap configurable (`maxParallelTasks`, default 2, 1..8) so memory admission, not a constant, is the binding limit.
2. Add an N-concurrent benchmark that drives the real `TaskHost` with real Electron `WebContentsView`s and reports tasks per minute, per-task incremental RSS, and admission decisions.
3. Use the measured per-task cost to decide whether the 370 MB reserve is too conservative for routine tasks, which start no planner worker. Change the reserve only if the measurement supports it, and record the number and method in the spec.

## Scope

In scope:

- `TaskHost({ maxParallelTasks })`, validated to an integer 1..8. It replaces the literal `2`. `executionMode: "sequential"` still forces 1.
- `integration/concurrent-throughput-benchmark.js`: N tasks submitted at once through `TaskHost.runRoutine` against the local fixture, for N = 1, 2, 3, 4 (configurable), repeated, with paired randomized order across N.
- A reserve recalibration for routine-only tasks, gated on the measurement.

Out of scope: raising the memory cap, a UI setting for `maxParallelTasks`, multi-process browsers, priorities or fairness between queued tasks (FIFO stays), and child-agent scheduling (`ChildAgentCoordinator` keeps its own admission).

## Design

### Slot cap

`maxActive = executionMode === "parallel" ? maxParallelTasks : 1`. The cap only limits `TaskQueue.admitNext`. `ResourceAdmission.acquire` remains the second gate, and a denied lease keeps the FIFO head queued exactly as today. The admission path, `_admissionChain` serialization, and lease release are unchanged.

### Benchmark

Each iteration creates a fresh `TaskHost` with a real `BrowserAdapter` factory, real `TaskStore` under a temp root, and a saved routine of `steps` local page navigations (reusing the routine-vs-planner fixture and its in-process approver). It submits N routine runs with `Promise.all(runRoutine)` and records:

- wall time from first submit to the last task reaching `awaiting_verification`, and tasks per minute (N over wall time);
- per-task run time, to expose queueing behind the admission gate;
- peak and steady RSS sampled every 100 ms (Electron processes), and the increment over an idle baseline divided by N;
- admission outcomes: how many tasks were admitted immediately, how many waited, and the `canAdmitTask` denial reasons;
- journal fsync count and p50 span, to show whether fsync contention rises with N.

The benchmark runs the production admission path with the real `MemoryMonitor`. A second mode sets `parallelTaskReserveBytes` small enough to admit all N, so that raw scaling and real incremental RSS are visible even when the production reserve would refuse them. That mode is diagnostic only and is labelled as such in the report.

### Reserve recalibration (conditional)

If the diagnostic mode shows that a routine task's incremental RSS is well below 370 MB, add a separate constant for tasks with no planner (`ROUTINE_TASK_RESERVE_BYTES`) set to the measured p95 plus a margin, and use it for routine runs only. Planner-backed tasks keep the current reserve. If the measurement does not support a lower value, leave the reserve alone and report that memory, not slots, is the ceiling.

## Verification

Tests before implementation:

- `maxParallelTasks` validation (non-integer, 0, 9 rejected; default 2 preserves current behavior).
- With `maxParallelTasks: 3` and ample fake memory, three queued tasks are admitted at once, a fourth waits, and completing one admits the fourth.
- With `maxParallelTasks: 3` and memory for two, the third stays queued (memory is still binding) and no browser is built for it.
- Sequential mode ignores `maxParallelTasks`.
- Benchmark report-shape smoke test with a fake browser, like `test/routine-vs-planner-benchmark.test.js`.

Then run the Electron benchmark, add a dated results section to the README next to the routine benchmark, and run the full suite.

## Limitations

- Throughput depends on the machine. Fsync-bound work may scale with N until the disk saturates, and page loads may compete for CPU; the benchmark measures both, it does not assume either.
- RSS is poll-sampled and is not a hard ceiling.
- Scheduled runs (sub-project 2) hold a slot while they wait for a human approval. Slots are not released on pause, so many review-heavy scheduled runs can starve the queue. This is accepted for now and revisited in the scheduler spec.
