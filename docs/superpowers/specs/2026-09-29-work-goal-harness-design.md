# HALO Work Goal Harness

**Date:** 2026-09-29  
**Status:** Approved for implementation  
**Scope:** Local backend lifecycle for one durable, project-scoped work goal spanning multiple HALO tasks. Implementation must follow this document and its explicit non-goals.

## Purpose

HALO already persists each `TaskSpec` and can recover that task's controller,
budget, evidence, and execution state. A task is still only one bounded
execution unit. There is no durable project-level objective that remains
active while multiple Tasks are completed, paused, or restarted.

Add a small work-goal layer inspired by the useful `/goal` properties:

- keep the original objective and success criteria across app/host restarts;
- preserve progress and evidence references instead of replacing them with a
  fresh conversation summary;
- make continuation, pause, blocked, and completion state explicit;
- enforce an optional aggregate work budget without changing per-task limits;
- refuse to report completion until each required criterion has authoritative
  evidence or explicit user verification.

This is not a second browser executor or a new permission principal. Every
linked task still uses the existing profile router, TaskHost, TaskController,
policy, approval, evidence, provenance, executor, and recovery code.

## Current checkout facts

- `TaskHost` owns multiple independent `TaskStore` records under one
  `storageRoot`; `TaskQueue` orders tasks but contains only task IDs and does
  not own objectives or evidence.
- `GoalSpec` is persisted per Task. Its `originalRequest`, criteria, and
  per-task limits are not a lifecycle record for a project spanning several
  Tasks.
- TaskStore journals and checkpoints already provide local durable-write,
  replay, symlink rejection, and recovery patterns suitable for a higher-level
  store.
- Task profiles are host-resolved and durably bound to each Task. A Work Goal
  must not bypass or rewrite those decisions.
- The planner protocol returns task-level proposals and does not currently
  report authoritative provider token usage. HALO must not invent token usage
  from request bytes, action count, or wall time.

## Terms and ownership

```text
Work Goal (one active per project storageRoot)
  ├─ immutable/versioned objective and completion criteria
  ├─ append-only progress, blocker, budget, and lifecycle records
  └─ linked HALO Tasks (one or many)
       └─ TaskSpec + Duration/Capability profile + TaskController
            └─ shared HALO policy / approval / evidence / provenance core
```

`WorkGoal` is the long-lived project objective. `TaskSpec` remains the
executable request for one browser, routine, research, computer-use, or
multi-agent task. A top-level Task may be linked to at most one Work Goal.
V1 links only top-level Tasks; child Tasks remain owned by their parent Task
and are constrained by existing child admission rules, not independently
bound or counted by Work Goal. Child IDs remain visible only through the
existing child API.

## Selected approach

Use a dedicated `WorkGoalStore` and `WorkGoalOrchestrator` above TaskHost.
Keep one active Work Goal per project `storageRoot`; retain completed and
archived goals as history. TaskHost is the only component allowed to bind new
Tasks to the active Work Goal. The orchestrator reads TaskStore evidence and
usage; it cannot dispatch browser actions or approve them.

Alternatives rejected for v1:

1. **Enlarge TaskSpec:** conflates a per-execution request with a project
   objective and makes amendments/restarts across multiple Tasks ambiguous.
2. **Prompt/session-only memory:** loses the objective and progress on process
   restart and cannot bind claims to durable Task evidence.
3. **Unrestricted autonomous subtask-spawning agent:** adds a new planner
   protocol and unbounded task creation before the shared lifecycle has a
   stable durable goal boundary. A later, separately reviewed phase may add
   automatic task decomposition behind explicit budgets and the same router.

The v1 continuation model is explicit and bounded: the active Work Goal is
automatically available to host-created continuation Tasks, while the user or
an existing scheduler/approved workflow initiates each new Task. The Goal
record survives when a Task finishes; it does not silently spawn new Tasks.

## Data model

### WorkGoalSpec

```text
WorkGoalSpec = {
  schemaVersion: 1,
  goalId: UUID,
  version: positive integer,
  objective: non-empty string,
  successCriteria: [
    { id: stable ID, text: non-empty string, required: true,
      verification: "host_evidence" | "user" }
  ],
  budget: {
    maxTasks?: positive integer,
    maxActions?: positive integer,
    maxPlannerCalls?: positive integer,
    maxActiveMs?: positive integer
  }
}
```

The user/renderer start input is `WorkGoalInput`, containing only
`objective`, `successCriteria`, and optional `budget`. The host assigns
`schemaVersion`, `goalId`, and initial `version: 1`; callers cannot choose a
goal identity or initial version.

Unknown fields, duplicate criterion IDs, malformed limits, and oversized
objectives fail closed. V1 bounds `objective` to 16 KiB UTF-8, criteria to 64
items with 512 characters each, `maxTasks` to 10,000, `maxActions` and
`maxPlannerCalls` to 1,000,000 each, and `maxActiveMs` to 31,536,000,000
(365 days). The objective and criteria are immutable within a version. An
explicit user amendment supplies a complete next `WorkGoalSpec` with the same
`goalId` and exactly `version + 1`; it never silently edits the old version.
Existing linked Tasks keep the goal version they were created against. New
Tasks bind to the current version.
An amendment invalidates prior criterion verification for completion purposes;
evidence from an older version may remain in progress history but cannot by
itself satisfy a criterion in the new version.

There is no `maxTokens` in v1. The current planner/worker boundary does not
provide authoritative token usage, so token-budget enforcement would be
fictional. The schema may add it only after a provider supplies validated,
per-request usage metadata and that usage is durably recorded. Reports must
show token usage as unavailable, not zero or an estimate.

### Event journal

The per-goal append-only journal is the source of truth. Its initial closed
event set is:

- `work_goal_created`
- `work_goal_amended`
- `work_goal_task_reserved`
- `work_goal_task_reservation_cancelled`
- `work_goal_task_linked`
- `work_goal_task_reservation_reconciled`
- `work_goal_task_reservation_released`
- `work_goal_progress_recorded`
- `work_goal_blocker_observed`
- `work_goal_continuation_attempted`
- `work_goal_continuation_enqueued`
- `work_goal_continuation_resolved`
- `work_goal_paused`
- `work_goal_resumed`
- `work_goal_criterion_verified`
- `work_goal_completed`
- `work_goal_archived`

Every event binds `goalId`, event ID, sequence, timestamp, and the positive
`goalVersion` that was current when it was appended. `progress_recorded` is not free-form proof: it must include
one or more references to `evidence_recorded` events in linked TaskStores.
Each reference includes `taskId`, `eventId`, and `evidenceId`; the host checks
that the evidence is `verification: "verified"`, belongs to that event and
Task, matches the same Work Goal version, and has a `criterionId` equal to
the Work Goal criterion being supported. Pending/rejected evidence, notes,
action outcomes, and planner text are never proof. Human verification records
the trusted actor and exact criterion/version; model text cannot impersonate
that actor.

The envelope is exactly `{seq, eventId, goalId, goalVersion, type, payload,
at}`: `seq` is a positive contiguous integer, IDs are UUIDs, timestamps are
ISO strings, and unknown envelope fields/event types fail closed. `created`
stores the full v1 spec; `amended` stores the complete next spec; `task_reserved`
stores reservation ID, Task ID, and each reserved limit; `task_linked` stores
the matching reservation ID and Task ID; `task_reservation_reconciled` stores
the terminal Task state and validated usage; `task_reservation_released`
stores the exact released allowance; `progress_recorded` stores bounded
evidence references; `blocker_observed` stores stable host reason/phase and
Task ID; `continuation_attempted` stores Task ID and a host-derived origin
(`user`, `routine`, or `scheduler`); `paused`, `resumed`, and `archived` store
the host-owned actor; `criterion_verified` stores criterion ID and actor;
`completed` stores the exact set of criteria validated complete by the host.
Each payload is closed-schema validated by the Work Goal contract module.

New hosts record continuation admission with `continuation_enqueued`, then
record either a validated `blocker_observed` result or a neutral
`continuation_resolved` result. Results are buffered and drained in durable
continuation-admission order, so concurrent Tasks cannot overwrite each
other's pending blocker state or let later outcomes overtake unresolved earlier
attempts. A neutral result breaks the consecutive-blocker streak. Progress,
amendment, and explicit Goal pause/resume reset the pending ordered sequence.
The legacy `continuation_attempted` event remains readable during recovery;
the first `continuation_enqueued` event starts ordered tracking and
conservatively resets any ambiguous legacy streak instead of reinterpreting
old journal events.

`task_reserved` is idempotent by reservation ID. `task_linked` binds exactly
one reservation to one Task. `task_reservation_reconciled` records the
authoritative TaskStore terminal state and measured usage; it does not release
unused capacity by itself. `task_reservation_released` records the exact
unused allowance released after reconciliation. A reservation can be linked,
reconciled, and released at most once. Replaying a retry with the same
reservation ID returns the original result; a different payload for that ID
is corruption and fails closed.

Legal state transitions are: absent→active via `created`; active→active via
`amended`; active→paused via user `paused`; paused→active via user `resumed`;
active→blocked after the third qualifying consecutive blocker; blocked→active
via user `resumed` or newly verified progress; active→complete only after
host validation of every criterion; complete→archived via user `archived`.
Paused and blocked goals may be archived by explicit user action to free the
project's active slot. `active` may only be archived after it is explicitly
paused. Any other transition, stale expected version, duplicate
completion/archive, or illegal event ordering is rejected without appending.

An unlinked `reserved` allocation may only be cancelled by an explicit host
repair after TaskStore loading returns the authoritative `not_found` result.
The cancellation event records `reason: "task_store_absent"` and returns the
entire reservation to the Goal budget. Missing/corrupt/mismatched data is not
proof of absence and remains held. A cancelled Task ID remains recorded in
the reservation index and cannot be reused for another reservation.

A materialized snapshot is a disposable read optimization. If present, it is
atomically written from the journal and verified against the last event ID and
sequence. Recovery replays the journal; a corrupt or mismatched snapshot is
ignored or rejected according to the established TaskStore precedent, never
used to skip journal validation.

## Lifecycle

```text
absent ──start──> active ──user pause──> paused
                    │                    │
                    ├──3 repeated blockers──> blocked
                    ├──verified criteria──> complete ──archive──> archived
                    └──explicit amendment──> active at version + 1

paused ──explicit resume──> active
blocked ──new verified progress or explicit user retry──> active
```

- Only one goal may be `active`, `paused`, or `blocked` for a project at a
  time. Starting a different goal while one is nonterminal fails with
  `active_goal_exists`; replacing it requires explicit archive/pause first.
- Completion is a host transition, not a planner proposal. Every required
  criterion must have valid evidence tied to its current Goal version, or a
  user-verification event tied to that criterion. For host evidence, the
  referenced Task must be bound to the same Goal version. Linked Task
  completion by itself is insufficient.
- A model may recommend `complete`, `blocked`, or amendment, but only the
  WorkGoalOrchestrator can validate and record the corresponding transition.
- A blocker fingerprint uses a fixed allowlist of stable `pauseReason` codes
  (`planner_unavailable`, `planner_error`, `observation_error`,
  `context_error`, `no_progress`, `budget_exhausted`, `child_plan_failed`,
  `message_ack_failed`, `send_message_failed`, `routine_step_failed`), never
  raw model/page text. The fingerprint is the pair `(reasonCode, phase)`;
  Task ID is recorded as the source but is not part of the fingerprint.
  `blocked` requires three consecutive host-originated
  top-level continuation Tasks (`user`, `routine`, or `scheduler`) that each
  durably pause with the same allowlisted reason and no newly verified
  progress between them. Each accepted continuation writes
  `continuation_attempted` before Task admission; a blocker event references
  the linked Task ID and checkpointed reason. Approval waits, user pauses,
  `execution_uncertain`, memory pressure, and still-running Tasks are not
  blocker attempts. An explicit user `resumed` transition clears the streak;
  verified progress also resets it.
- `paused` requires explicit user action. HALO must not self-pause a Goal
  merely because a Task is waiting for approval; that wait is represented by
  the linked Task's actual state.
- Goal status may not become `complete` merely because a turn/task ended or a
  model declared success.

## Budget and Task binding

Goal budgets aggregate across all linked top-level Tasks. A requested
continuation Task is routed and profile-resolved by the existing
`resolveTaskProfile()` before resources are built. Its per-task GoalSpec limits
are clamped to both the user's limits and the remaining Work Goal allowance;
profile routing may not increase them.

Budget reservation and task creation cross two durable stores, so they are not
an atomic filesystem transaction. Use an idempotent reservation protocol:

1. Host validates the active Goal/version, task request, resolved profile, and
   remaining budget.
2. The TaskStore first durably records the unique Goal binding and exact
   clamped effective limits in its initial profile event. This avoids
   consuming project capacity when TaskStore creation itself fails. A crash
   before reservation leaves a non-runnable Task orphan: the host context
   reader refuses it because no matching reservation exists. The profile
   contract therefore gains an optional, exact `workGoalBinding` object
   (`goalId`, `goalVersion`, `reservationId`) for linked Tasks; legacy Tasks
   omit it. Recovery cross-checks the binding against the Work Goal journal
   and rejects missing, extra, mismatched, or over-budget profiles.
3. Goal journal durably reserves the maximum effective Task limits with that
   reservation ID. Each reservation records all effective Task axes
   (`maxTasks: 1`, `maxActions`, `maxPlannerCalls`, and `maxActiveMs`), even
   when the Goal currently leaves an aggregate axis uncapped. This preserves
   enough accounting to safely add that cap in a later amendment.
4. Goal journal records the Task link after verifying its profile binding and
   limits against the reservation.
5. The host records `continuation_attempted` and only then admits the Task to
   TaskQueue.
6. Startup reconciliation resolves interrupted reservations from their bound
   TaskStore. A missing/corrupt/mismatched TaskStore never releases capacity
   automatically; it remains reserved and visible as an orphan requiring
   explicit repair.

Implicit Task creation is allowed only while the bound Work Goal is `active`.
If the project Goal is paused or blocked, TaskHost rejects the request before
creating a TaskStore; the user may explicitly request a standalone Task.

The simplest safe accounting is reservation-based, not guessed from a
possibly stale checkpoint. For an active Task, its remaining effective limit
stays reserved. When it reaches a durable terminal state, the host reconciles
exact usage from the authoritative TaskStore and releases only the unused
reservation. Paused, recovered, queued, or `execution_uncertain` Tasks retain
their reservation. Concurrent Tasks must reserve under the WorkGoalStore's
serialized write chain before admission, so they cannot spend the same
remaining allowance.

An amendment may raise caps or add a previously uncapped axis, but it cannot
lower any configured cap beneath already consumed usage plus full reservations
still held for active/unreconciled Tasks. `maxTasks` cannot be lowered beneath
linked Tasks plus pending reservations. This check is replayed from the
append-only reservation history, so an amendment never makes existing work
retroactively over-budget.

For v1, `maxActions`, `maxPlannerCalls`, and `maxActiveMs` account for the
effective top-level Task profile and its parent-owned usage ledger. Child-agent
work is constrained by the existing parent/resource admission limits and is
not added a second time to Work Goal totals. Consequently, these fields are
not a standalone cap on aggregate provider/browser work across children; this
known boundary must be visible in status output and revisited before claiming
an aggregate multi-agent work cap.

For each linked Task, effective limits are the minimum of the validated
per-task GoalSpec limit and the Work Goal's remaining aggregate allowance.
Unspecified Work Goal dimensions do not add a project cap. Reconciliation
uses only the TaskStore's validated checkpoint whose sequence is covered by
the replayed journal and whose state is durably `completed` or `stopped`; its
`budgets.actionsUsed`, `plannerCallsUsed`, and `activeMs` are authoritative.
Active time is the controller's accumulated active duration, excluding
paused/waiting time. Missing, corrupt, stale, or nonterminal checkpoints keep
the entire remaining reservation held; usage is never inferred from event
counts. `maxTasks` counts all successfully linked top-level Tasks, including
terminal ones.

The Work Goal is a separate host-owned context object,
`{goalId, goalVersion, objective, successCriteria, verifiedCriterionIds,
remainingBudget}`, not merged into the Task's own `GoalSpec` or task completion
criteria. On every planner turn, the host supplies a bounded `workGoal`
context for the Task's bound version. Existing Task request/criteria remain
unchanged, so a partial Task can finish without claiming the whole Work Goal
complete. An evidence reference can support a Work Goal criterion only when
that Task independently recorded verified evidence with the exact matching
criterion ID/version. User Work Goal verification is a separate host event
and does not accept a caller-supplied actor identity. A Task bound to an older
Work Goal version continues seeing only that version's context and cannot
satisfy current version criteria.

`maxTasks` counts top-level linked Tasks, not child agents; child tasks remain
subject to the existing Multi-agent resource and concurrency budgets. A later
spec may define whether to aggregate child action limits; v1 does not double
count them in the Work Goal budget because the parent TaskController and
ResourceAdmission own that execution. This limitation is surfaced in reports.

## Orchestrator / host surface

The exact public IPC names remain an implementation-plan decision, but the
backend responsibilities are:

- `startWorkGoal(input: WorkGoalInput)` — host-assign ID/version, validate,
  and durably create only when no
  nonterminal goal exists;
- `getActiveWorkGoal()` and `listWorkGoalHistory()` — return validated,
  bounded summaries and task links, not full unbounded journals. History uses
  `listWorkGoalHistory({limit = 50, cursor = null}) -> {items, nextCursor}`;
  `limit` is an integer from 1 through 100, and `cursor` is a Goal UUID from
  the preceding page. Ordering is stable by `goalId`; the next cursor is null
  on the final page. Evidence is revalidated only for returned summaries.
  Internal recovery retains its separate unbounded journal/history reader.
- `amendWorkGoal(expectedVersion, patch)` — user-authored optimistic version
  update; reject stale versions;
- `createTask(...)` — while a project has an active Goal, bind new project
  work to that Goal and its current version by default. A task may be marked
  standalone only through an explicit `standalone: true` host option. Generic
  user-created, routine, and scheduled tasks otherwise bind to the active Goal
  by default. The host supplies Work Goal context separately from the Task's
  own request and criteria. Callers cannot bind an
  arbitrary Goal ID or older version. With no active Goal, behavior remains
  unchanged;
- `recordWorkGoalProgress(goalId, expectedVersion, evidenceRefs)` — validate
  every reference against TaskStore before append;
- `verifyWorkGoalCriterion(goalId, expectedVersion, criterionId)` — trusted
  user verification; the host derives the actor from its trusted local IPC
  boundary and does not accept an actor string from renderer/model input;
- `pauseWorkGoal`, `resumeWorkGoal`, `completeWorkGoal`, and
  `archiveWorkGoal` — transition methods with the lifecycle checks above.

The WorkGoalOrchestrator never directly constructs BrowserAdapter, calls a
provider with page-derived authority, or creates a child outside TaskHost. A
Task's existing `taskProfile` remains the sole source of Duration and
Capability selection. WorkGoal metadata is context, not permission.

## Storage, recovery, and privacy

- Store goal directories below `<storageRoot>/work-goals/`, separate from
  `<storageRoot>/tasks/` and `queue.json`.
- Use 0700 directories, 0600 journal/snapshot files, `O_NOFOLLOW`, regular
  file and UUID checks, an exclusive project-registry lock for active-goal
  uniqueness plus a per-goal writer lock, append fsync, and snapshot
  temp-write/fsync/rename/directory-fsync, matching TaskStore/TaskQueue
  conventions. Goal creation, archive, and budget reservation serialize with
  the registry/goal locks in a fixed order to avoid duplicate active goals and
  lock-order deadlocks.
- The active-goal pointer is a small atomic host-owned manifest. On mismatch,
  TaskStore binding and the goal journal are authoritative; never infer active
  status from an unvalidated pointer alone.
- On restart, load and validate the active goal before accepting linked task
  continuations, reconcile each reservation/link, preserve any `execution_uncertain`
  Task state, and do not auto-run a paused/queued Task.
- A linked Task's optional `workGoalBinding` is part of its durable initial
  `task_profile_selected` payload, so TaskStore replay can validate the
  binding without consulting a mutable in-memory host object. The Goal journal
  remains the authority for reservation state; reconciliation is append-only.
- A project root stores goals locally. No cloud sync, cross-device sync, or
  provider token accounting is claimed. Goal objective and progress may be
  included in continuation Task context only as host-authored goal metadata;
  browser content and planner output cannot amend it.

## Invariants

1. One project storage root has at most one nonterminal Work Goal.
2. Every linked Task has exactly one validated Work Goal binding at one exact
   Goal version, and every Goal link resolves back to that Task.
3. Task profile routing and all execution authority remain in the existing
   TaskHost/TaskController shared core.
4. The sum of outstanding Goal reservations never exceeds configured aggregate
   limits, including under concurrent Task creation and crash recovery.
5. Missing/corrupt evidence, usage, link, reservation, or journal data never
   causes a more permissive state or frees budget implicitly.
6. Completion is impossible while any required criterion lacks current,
   validated evidence or explicit user verification.
7. An unchanged blocker cannot cause an infinite silent continuation loop;
   the third same-fingerprint no-progress attempt durably records `blocked`.
8. The durable objective survives Task completion, Host restart, UI close, and
   planner context replacement without relying on a model transcript.

## Verification required before implementation can be called complete

- Contract tests: exact schemas, versions, lifecycle transitions, selectors,
  aggregate limits, and unknown-field rejection.
- Store tests: durable replay, torn final line, symlink/unsafe path rejection,
  writer conflicts, snapshot/journal mismatch, and crash injection after every
  cross-store reservation step.
- Reconciliation tests: reservation idempotency, missing task store, mismatched
  goal/version binding, terminal/paused/uncertain Tasks, and parallel
  reservations that race at the remaining-budget boundary.
- Host integration: create Goal → route and link Tasks → pause/restart → add a
  continuation Task under the same Goal → verify criteria → complete → archive
  → start a new Goal. Confirm every Task still passes the existing policy,
  approval, evidence, provenance, resource, and profile gates.
- Adversarial completion probes: fabricated model success, foreign task event
  reference, evidence from an earlier Goal version, missing evidence, duplicate
  completion, and stale amendment/verification race must all fail closed.
- Run the complete `apps/computer-browser` test suite, crash/restart integration
  tests, and current security review before shipping.

## Design self-review

- Scope is one active project Goal, not one Goal per task or an unbounded
  autonomous loop; paused/blocked Goals still occupy that slot.
- Project-scoped task creation inherits the active Goal by default; explicit
  standalone work remains a host-owned exception, not a caller-supplied Goal
  binding.
- The task↔goal binding and every reservation transition have durable,
  replayable records on both sides; uncertainty retains capacity rather than
  accidentally increasing it.
- Only linked top-level Tasks count against this Goal in v1; child work stays
  under parent-owned ResourceAdmission and is not misrepresented as an
  aggregate child-work cap.
- Reconciliation reads only sequence-validated durable terminal checkpoints;
  progress evidence must be a same-version, same-criterion verified evidence
  event, and continuation origin is host-derived.
- Completion and user verification are host-owned; planner claims and stale
  evidence cannot complete a Goal.
- Token limits and aggregate child-work limits are explicitly not claimed in
  v1 because current authoritative usage data is insufficient.
- No implementation code or renderer work is included in this design stage.

## Non-goals for v1

- An unbounded autonomous goal planner that keeps creating Tasks without a
  user/scheduler/workflow continuation signal.
- Cross-project, cloud, or multi-device goal sync.
- Model-generated goal amendments or model-authoritative completion.
- Token budget enforcement until the selected provider exposes validated
  usage metadata through the planner contract.
- Making Research or Computer-use available merely because a Work Goal asks
  for them; the capability registry and adapters remain authoritative.
- Changing the UI as part of the backend design. The API should make a later
  Goal panel possible, but a renderer design is a separate review.
