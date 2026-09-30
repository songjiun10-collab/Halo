# HALO Read-Only Action Batching Design

Status: approved design (2026-09-29), implementation in `apps/computer-browser`.

## Problem

After the per-step cursor checkpoint was removed, the dominant remaining per-action cost is the durable
`action_started` fsync (about 3.75 ms journal append plus fsync per action; the checkpoint path was about 4.4 ms).
A proposal with several actions still pays one durable `action_started` (and, for routines, one durable
`routine_step_advanced`) per action, because `_dispatchActionsBatch` treats every action independently.
Batching today saves only planner round trips, and routine mode has none.

## Decision

Relax recovery guarantees **only for read-only actions** (`observe`, `scroll`). Everything else (`navigate`,
`follow_link`, `click`, `type`, `submit_form`) keeps its current per-action policy, approval, and durability.

Read-only actions have no external side effect, so replaying one after a crash is harmless. That is why they may
share one durable write. Non-read-only batches are unchanged.

## Scope

In scope:

- A read-only batch path in `TaskController._dispatchActionsBatch`.
- Optional read-only batching in `RoutineRunner.next()` (up to 3 consecutive `scroll` steps).
- Benchmark fixture and factor to measure the effect.

Out of scope: batching `navigate`/`follow_link`, raising `MAX_ACTIONS_PER_PROPOSAL` (stays 3), changing the approver
protocol, changing recovery replay code (the consecutive-advancement support already exists).

## Design

### 1. Batch eligibility

A proposal takes the batch path when it has at least 2 actions and every action type is read-only
(`isReadOnlyAction`, exported from `main/harness/permission-policy.js`). Otherwise the existing per-action path runs
unchanged. If policy denies any action in an eligible proposal, the whole proposal falls back to the existing path,
so per-action deny/skip semantics are not reinvented.

### 2. One approval per distinct action type

The approver judges an action type, an origin, and provenance, none of which differ between read-only actions of the
same type on the same page. The batch therefore asks the approver once per **distinct action type** (at most two:
`observe`, `scroll`), using an unchanged descriptor for the first action of that type. The approver protocol does not
change, and every action type in a batch is still independently judged.

Combined decision, most severe first: `deny`/`quarantine` over `review` over `allow`.

- Any `deny`/`quarantine`: the whole batch is denied. Routines call `_denyRoutineStep` (the cursor is unchanged, so
  the denial binds to the first step of the batch). Planner tasks dispatch nothing and return to planning.
- Any `review`: one queue item holds the whole batch (`actions`), and `approve()` dispatches the whole batch. `deny()`
  drops it. The existing 60 s expiry and epoch binding apply to the batch as one unit.
- Otherwise `allow`.
- Approver errors keep the existing `approver_error` pause; a stop that happens while awaiting approval still wins.

### 3. Durability inside a batch

Per action the order is unchanged: `action_started`, execute, `action_outcome`, then for routines
`routine_step_advanced`, then evidence. Only durability differs:

| Record | Non-last action | Last action |
| --- | --- | --- |
| `action_started` | non-durable | **durable** (flushes everything before it) |
| `action_outcome`, `evidence_recorded` | non-durable | non-durable (as today) |
| `routine_step_advanced` | non-durable | **durable** |
| `routine_step_failed` / pause / stop | durable (unchanged) | durable (unchanged) |

One fsync makes all earlier written bytes durable, so a batch of k actions costs 1 durable write (planner) or 2
(routine) instead of k or 2k.

Per-action checks stay per action: `maxActions` budget, memory pressure, and staleness (`_stopHappenedSince`). A batch
that ends early (failure, pause, stop) exits through a durable append or a checkpoint, both of which flush earlier
non-durable records.

### 4. Recovery

No recovery code changes. Any journal prefix is one of:

- Cut before the batch: the batch's read-only actions are simply re-proposed or replayed. Harmless.
- Cut mid-batch with a complete advancement prefix: consecutive `routine_step_advanced` records recover to the right
  cursor (already supported and digest-checked by `TaskHost`).
- Cut with an open `action_started` and no outcome: `execution_uncertain`, the same fail-closed result as today.

### 5. RoutineRunner

`new RoutineRunner({ definition, cursor, batchReadOnlySteps })`. When `batchReadOnlySteps` is true and the current
step is `scroll`, `next()` proposes up to 3 consecutive `scroll` steps as one `actions` proposal; any other step kind
still yields one action. The controller binds each action to `getCurrentStep()` and advances the cursor after each
success, so per-step `routine_step_advanced` records (and their digests) are unchanged. Default is `false` in the
runner; `TaskHost` enables it unless `routineReadOnlyBatching: false` is passed.

### 6. Verification

TDD, with tests before implementation:

- Controller: read-only batch has one durable `action_started` (only the last), a mixed batch takes the individual
  path unchanged, whole-batch review queues one item and `approve()` runs every action, whole-batch deny dispatches
  nothing, and a routine batch that fails mid-batch pauses without running the remaining actions.
- Approver called once per distinct action type.
- Routine: consecutive scrolls batch (max 3), and non-scroll steps stay single; per-step advancement records remain;
  recovery of a mid-batch crash resumes at the correct cursor.
- Benchmark: a fixture with k scrolls per page and a batching on/off factor for both modes on the same paired
  schedule; report durable-write counts and run time.

## Limitations

- Only helps read-only-heavy workloads. Navigation-heavy runs are unchanged.
- After a power loss, up to one batch of read-only actions may be replayed; scroll position is not idempotent, so a
  replay can scroll further than intended. The observation taken after recovery is authoritative.
- One approval covers each action type in a batch, so the approver cannot distinguish a batch's first scroll from its
  third. This is acceptable only because read-only actions of one type are indistinguishable to the approver.
