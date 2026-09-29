# HALO Routine Scheduler Design

Status: implemented (2026-09-29), committed on `feature/routine-scheduler`. Sub-project 2 of 2. Builds on the routine execution design (`2026-09-28-routine-execution-design.md`, which put automatic schedules out of v1) and enqueues into the existing `TaskQueue`, so throughput comes from `2026-09-29-parallel-task-throughput-design.md`. `main/harness/scheduler.js`, `main/harness/schedule-store.js`, `shared/schedule-contracts.js` implement due evaluation, missed-run coalescing, `skip`/`queue` overlap, and `host_closed` shutdown handling as described below; `TaskHost` owns and starts the `Scheduler` (`main/harness/task-host.js`). Tests: `test/scheduler.test.js`, `test/schedule-store.test.js`, `test/schedule-contracts.test.js`, `test/routine-trigger.test.js`.

## Problem

Saved routines only run when a user starts one. The goal is to run them at fixed times or periods without a person present, still as ordinary HALO tasks that pass the normal permission and approval policy.

## Decision

A `Scheduler` owned by the same process that owns `TaskHost` (the background service in `--halo-background-service` mode, or the app process otherwise) reads a persisted `ScheduleStore` and, when a schedule is due, calls `host.runRoutine(routineId, revision, { trigger })`. It does nothing else: no new executor, no policy bypass, no direct browser access.

## Scope

In scope: schedule storage, due-time evaluation, missed-run and overlap policy, enqueueing runs, lifecycle with the host, and tests with an injected clock.

Out of scope: a schedule editor UI, cron syntax, time zones other than the host's local zone, launching the app at login (`LaunchAgentManager` already exists), unattended approval (see Approval), notifications, and cross-device sync.

## Data model

`ScheduleStore` keeps one JSON file per schedule under `<storageRoot>/schedules/`, written with the same atomic temp-write, fsync and rename pattern as `RoutineStore`. A `ScheduleDefinition` has:

- `scheduleId`, `routineId`, `revision` (an exact pinned revision, as `runRoutine` requires), `enabled`;
- `trigger`, one of `{ kind: "once", at: ISO-8601 }` or `{ kind: "interval", everyMs, anchor: ISO-8601 }` (minimum 60,000 ms; runs fall on `anchor + k * everyMs`, so the schedule does not drift);
- `overlap`: `"skip"` (default) or `"queue"`;
- `lastOccurrenceAt`, `lastTaskId`, `nextRunAt` (derived, persisted for inspection).

Deleting or tombstoning a routine disables its schedules. A schedule never follows a newer revision; the user re-pins explicitly, which keeps every run bound to a reviewed definition (the digest check in `TaskHost._resolveRoutineForStore` still applies).

## Behavior

### Due evaluation

The scheduler holds one timer for the earliest `nextRunAt` (injected `now` and `setTimeout` for tests). On fire it evaluates every enabled schedule with `nextRunAt <= now`, in `nextRunAt` order, then re-arms.

### Missed runs

If the host was down or the machine slept, a schedule that missed one or more occurrences runs **once** at start-up or wake (coalesced), then advances to the next future occurrence. It never replays a backlog. A `once` schedule more than one hour late is marked `missed` and not run, so a stale one-off does not fire long after its intent.

### Overlap

`"skip"`: if the previous run's task is still queued or active, record a skipped occurrence and advance. `"queue"`: enqueue anyway. The default prevents a slow or stuck run from piling up duplicates.

### Enqueue path

The run goes through `host.runRoutine`, so it is admitted by FIFO, `maxParallelTasks`, and memory admission like any other task.

**Delivery guarantee.** "Persist a record, then call `runRoutine`" gives at-most-once: a crash between the two loses the occurrence. Reversing the order gives at-least-once: a crash after the task exists but before the record is written runs the occurrence twice. Neither is exactly-once, and the scheduler does not claim it. Instead it makes task creation idempotent per occurrence, so a retry can find out whether the occurrence already produced a task:

1. Every occurrence has a deterministic key, `scheduleId@occurrenceAt` (the scheduled time, not the wall-clock time of the attempt).
2. `runRoutine(routineId, revision, { trigger: { scheduleId, occurrenceAt } })` writes that trigger into the task's goal. The goal is written by `TaskStore.create` itself, so the key exists atomically with the task. It cannot live in the later `routineRun` checkpoint: `_createNewTask` creates the store first and checkpoints the pin afterwards, and a crash in that window would leave a task with no key. `harness-contracts.js` gains an optional, validated `goal.trigger`, and task summaries expose it.
3. Before creating a task for an occurrence, the scheduler scans task summaries for that key (and, under the host's creation serialization, `runRoutine` re-checks it). If a task exists, the occurrence is recorded as done with that `taskId` and nothing new is created. If none exists, it creates one.
4. `lastOccurrenceAt` and `lastTaskId` are written after `runRoutine` returns. A crash before that write is repaired on restart by step 3.
5. A task found with a trigger but **no routine pin** (a crash between `TaskStore.create` and the pin checkpoint) is not runnable as a routine and would otherwise be adopted by queue reconcile as a plain task. The scheduler stops it and retries the occurrence.

This is idempotent task creation, and it is exactly-once only for *creating* the task: it does not make the browser actions of one run exactly-once (that stays the existing journal and recovery behavior), and it depends on `TaskStore` listing tasks reliably. Two scheduler processes over one storage root are unsupported.

### Approval

The scheduler does not weaken approval. A scheduled run that reaches a `review` decision waits in the approval queue like a manual run; with nobody present it stays paused and holds its slot until someone approves, denies, or stops it. Routines made only of read-only or allowed actions (navigation and scrolling under the user's chosen permission mode) run to `awaiting_verification` unattended. Because criteria use `verification: "user"`, a completed scheduled run still ends in `awaiting_verification` for a person to confirm. The design deliberately adds no auto-approve path.

### Lifecycle

`Scheduler.start()` loads schedules and arms the timer after the host is open and its queue is reconciled; `stop()` clears the timer and never touches running tasks (matching the rule that a closed UI is not task cancellation). `TaskHost.close()` stops the scheduler first.

## Errors

A failed `runRoutine` (routine deleted, revision missing, digest mismatch, host closing) records `lastError` on the schedule and advances to the next occurrence. Three consecutive failures disable the schedule and record why, so a broken schedule cannot retry forever.

## Verification

Tests before implementation, all with an injected clock and a fake host:

- `once` and `interval` due evaluation, anchor arithmetic without drift, and the 60 s minimum.
- Coalesced missed runs (three missed intervals produce one run), and a stale `once` marked `missed`.
- Overlap `skip` versus `queue`.
- Idempotent creation, with crash points injected: (a) crash before the task exists creates exactly one task on restart; (b) crash after `TaskStore.create` and the pin but before the schedule record is written creates no second task and records the existing `taskId`; (c) crash between `TaskStore.create` and the pin stops the pin-less task and creates exactly one routine task; (d) a retry of the same occurrence never creates a second task.
- Tombstoned routine disables its schedules; three consecutive failures disable a schedule.
- `stop()` clears the timer and does not call any task-stopping method.
- `ScheduleStore` atomic write, corrupt-file rejection, and permission mode 0600.

Then an integration test that runs a real `TaskHost` with a fake browser and an accelerated clock, and confirms N schedules due at the same instant produce N tasks admitted in FIFO order under the parallel cap.

## Limitations

- A sleeping machine does not run schedules; runs coalesce on wake.
- Review-heavy scheduled runs hold slots while waiting for a person.
- Local time changes (DST) shift `interval` occurrences only through the anchor, and this spec does not attempt wall-clock daily schedules.
