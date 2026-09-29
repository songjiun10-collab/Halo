# HALO Harness v2 Design

## Status

Draft for user review (2026-09-29). Phase 1 (interface only, mapping
existing behavior to Middle) has been implemented; Phases 2-5 below are
not yet implemented.

## Problem

HALO currently uses broadly similar execution machinery for tasks with very different horizons.

A short, predictable browser task does not need the same planner cadence, context retention, durable recording, and recovery machinery as a task expected to run for hours. Applying long-horizon machinery universally wastes latency, tokens, memory, and durable I/O. Removing that machinery universally weakens recovery and long-running reliability.

The goal is therefore to provide three task-horizon execution profiles:

- **Short** — optimize bounded, predictable work for latency and low overhead.
- **Middle** — balance efficiency with task-level recovery for ordinary agent work.
- **Long** — optimize long-running work for durable state, context reconstruction, and recovery.

Harness profiles concern execution of **one task**. Multi-agent orchestration is a separate subsystem and is explicitly outside this design.

## Decision

Introduce a composable `HarnessProfile` selected per task:

```text
Task
  │
  ▼
Harness selection
  │
  ├── Short
  ├── Middle
  └── Long
        │
        ▼
     HALO Core
  policy / approval
  evidence / provenance
  resource admission
        │
        ▼
      Executor
```

A profile changes how much planning, context, durability, observation, and recovery a task receives.

It does **not** change execution authority.

> **Harness profiles change how a task is executed, not who is allowed to act.**

The existing host-owned authority boundary remains invariant across all profiles.

## Non-goals

This design does not define:

- multi-agent decomposition or coordination;
- parent/child agents;
- inter-agent communication;
- parallel task throughput;
- scheduling;
- resource admission policy;
- unattended approval;
- provider/model routing;
- new browser permissions.

Those systems may submit or operate tasks that use a harness profile, but they are not part of the harness.

---

# Core invariants

Every profile preserves:

> **Model proposes. Host remembers. Host verifies. Host executes.**

Specifically:

- the original goal remains host-owned;
- policy decisions remain host-owned;
- approval remains host-owned;
- execution authority remains host-owned;
- verified evidence is distinct from model claims;
- provenance survives profile transitions;
- stale proposals cannot execute;
- `execution_uncertain` is never automatically retried;
- resource admission cannot be bypassed by profile selection;
- a profile cannot grant itself additional permissions;
- side effects already executed are never replayed merely because the profile changes.

Short is therefore not a "less safe" harness, and Long is not a "more privileged" harness.

They purchase different amounts of execution machinery under the same authority boundary.

---

# Profile model

```text
HarnessProfile {
    id
    plannerPolicy
    contextPolicy
    observationPolicy
    batchingPolicy
    durabilityPolicy
    recoveryPolicy
    budgetPolicy
}
```

Capabilities such as Browser, Research, Routine, or Computer Use remain separate from horizon.

Avoid subclasses such as:

```text
ShortBrowserHarness
LongResearchHarness
MiddleRoutineHarness
```

Instead:

```text
Task
 ├─ capability
 └─ harnessProfile
```

The two are independently configured.

---

# Short Harness

## Purpose

Short is optimized for bounded tasks expected to complete quickly and whose immediate execution state is sufficient for progress.

Its primary objective is to minimize unnecessary control-plane work.

## Execution strategy

Prefer, in order:

```text
known deterministic operation
        ↓
saved routine / deterministic path
        ↓
stable-ref or structured action
        ↓
cheap observation / decision
        ↓
frontier planner only when necessary
```

The planner should not be invoked merely because another browser action occurred.

## Observation

Short prefers cheap representations:

1. existing valid stable references;
2. delta observation;
3. shallow accessibility/DOM representation;
4. progressively expanded observation;
5. full observation;
6. visual Computer Use fallback when necessary.

A document-epoch change invalidates references that cannot be proven valid.

## Planning

The planner produces **segments**, not necessarily individual actions.

Example:

```text
Planner
   │
   ▼
Segment
 ├─ focus search field
 ├─ type query
 ├─ submit
 └─ wait for expected state
   │
   ▼
Host verifies resulting state
```

Unexpected state terminates the segment and returns control to observation/planning.

## Batching

Short uses the most aggressive safe batching of the three profiles.

Actions may be combined only when intermediate results are not required to decide whether the following action remains valid.

A batch ends at:

- an approval boundary;
- an externally visible side effect requiring separate authority;
- navigation or document-epoch change where subsequent references depend on the new document;
- unexpected state;
- policy change;
- uncertainty requiring observation;
- an evidence boundary that must be durably established first.

Recent HALO measurements already show why this matters: reducing approval calls and journal synchronization through safe batching produced a large latency reduction, so Short treats action granularity as an explicit optimization target rather than assuming one action equals one durable execution cycle.

## Durability

Durability defaults to **semantic segment boundaries**, rather than unconditional full persistence after every low-risk action.

Critical authority/evidence events remain durable regardless of profile.

The optimization target is duplicate control-plane persistence, not removal of security-relevant records.

## Recovery

Short guarantees enough recovery information to determine whether the previous execution:

- completed;
- did not execute;
- or is uncertain.

It does not purchase expensive long-horizon context reconstruction unless escalated.

---

# Middle Harness

## Purpose

Middle is the general-purpose execution profile.

It targets tasks where the exact path is not known in advance but the task is still bounded enough that full long-horizon machinery is unnecessary.

Middle should initially be the safest candidate for the default `auto` selection.

## Planning

Middle uses bounded segment planning:

```text
Observe
   ↓
Plan next segment
   ↓
Host verifies proposal
   ↓
Execute bounded segment
   ↓
Checkpoint
   ↓
Verify progress
   ↓
Continue / replan
```

Planner cadence is adaptive rather than action-bound.

## Context

Maintain a bounded rolling context containing:

- immutable goal;
- current verified state;
- recent relevant observations;
- completed semantic segments;
- unresolved constraints;
- evidence references;
- remaining budget.

Older detail may be compacted while durable host truth remains authoritative.

## Observation

Middle prefers incremental observations but periodically obtains enough state to detect drift.

A delta must never silently become the sole source of truth after its base state becomes invalid.

## Batching

Middle batches predictable low-risk action sequences but uses smaller segments than Short.

When execution becomes state-dependent, it returns to observation rather than attempting to maximize batch length.

## Durability

Persist:

- authority transitions;
- approvals;
- important observations/evidence;
- semantic segment completion;
- checkpoints required for recovery;
- execution uncertainty.

Routine low-value events may still be coalesced where doing so preserves audit semantics.

## Recovery

Middle should recover an interrupted task from the latest trustworthy checkpoint without requiring replay from the original goal.

---

# Long Harness

## Purpose

Long is for tasks whose execution horizon makes model conversation state an unreliable source of memory.

The primary objective is durable continuation.

## Host-owned state

Long uses explicit durable state:

```text
Original Goal
     │
     ▼
   GoalSpec
     │
     ├───────────────┐
     ▼               │
Context Builder      │
     │               │
     ▼               │
   Planner           │
     │               │
     ▼               │
Host verifier ◄──────┘
     │
     ▼
 Executor
     │
     ▼
Event journal
     │
     └──────► next context reconstruction
```

Model conversation history is not authoritative memory.

Planner context is reconstructed from host-owned state.

## Context

Long may compact or discard old model turns.

It must preserve enough durable information to reconstruct:

- original goal and current goal version;
- verified completed work;
- unresolved work;
- evidence;
- constraints;
- execution uncertainty;
- budget consumption;
- relevant provenance.

## Planning

Planning occurs in bounded segments.

Long does not mean "call the planner constantly." Long-running execution makes planner-call discipline more important, not less.

## Durability

Long provides the strongest persistence profile.

Semantic checkpoints must support restart after process failure without relying on in-memory planner context.

Critical state is written before subsequent work depends on it.

## Recovery

On restart:

```text
durable GoalSpec
 + journal
 + verified evidence
 + execution state
          ↓
Context reconstruction
          ↓
Fresh observation where required
          ↓
Planner continuation
```

An in-flight action whose outcome cannot be established remains `execution_uncertain`.

Long must not turn crash recovery into action replay.

---

# Profile selection

Expose:

```text
harnessProfile:
    auto
    short
    middle
    long
```

Explicit user/host selection is allowed.

Models cannot directly raise their own execution profile or resource budget.

## Initial automatic selection

The first implementation should use deterministic host rules rather than another LLM classifier.

Examples:

```text
saved bounded routine
        → Short

small predictable browser operation
        → Short

ordinary unknown browser task
        → Middle

bounded research task
        → Middle

long-running/background research
        → Long

task requiring durable continuation
        → Long
```

These are routing defaults, not correctness rules.

Selection heuristics should later be calibrated from actual task traces.

---

# Escalation

A task may move upward:

```text
Short
  │
  │ repeated uncertainty /
  │ horizon exceeded /
  │ context insufficient
  ▼
Middle
  │
  │ durable continuation /
  │ context horizon exceeded
  ▼
Long
```

Escalation is a host operation.

Record:

```text
HARNESS_PROFILE_CHANGED
from
to
reason
goalVersion
checkpointId
timestamp
```

The new profile inherits durable host state but receives a fresh observation when existing execution state may be stale.

Already completed side effects are not replayed.

Automatic downgrade during an active segment is initially out of scope. A later implementation may permit downgrade only at a verified checkpoint.

---

# Budgets

Profiles are not defined only by wall-clock duration.

Each owns a configurable budget envelope over:

- planner calls;
- actions;
- context bytes/tokens;
- observation volume;
- runtime;
- journal volume;
- checkpoint cadence.

Conceptually:

| Property | Short | Middle | Long |
|---|---|---|---|
| Planner cadence | Minimal | Adaptive | Bounded segments |
| Context | Small | Rolling | Reconstructed |
| Observation | Incremental-first | Incremental + refresh | Verified/reconstructable |
| Batching | Aggressive-safe | Moderate | Selective |
| Durability | Semantic | Regular | Strong |
| Recovery | Execution-state | Task checkpoint | Full reconstruction |
| Typical horizon | Short | General | Long |

**Exact numeric limits are intentionally absent from the initial design.**

They should come from benchmark data rather than architectural guesses.

---

# Relationship to TaskHost

Harness does not own queueing or concurrency.

```text
TaskQueue
   │
ResourceAdmission
   │
Harness execution
   │
Policy / Approval
   │
Executor
```

`maxParallelTasks` remains a TaskHost throughput concern.

Memory admission remains a ResourceAdmission concern.

A Short task therefore receives **no entitlement to additional concurrency** merely because it is expected to be cheap.

Measured resource costs may later inform ResourceAdmission calibration, but that calibration remains outside Harness.

---

# Relationship to Scheduler

Scheduler determines **when** a task is submitted.

Harness determines **how** that task executes.

Neither receives authority from the other.

```text
Schedule occurrence
        ↓
      TaskHost
        ↓
  Harness selection
        ↓
     TaskQueue
        ↓
     Execution
```

A scheduled Short task follows exactly the same approval rules as a manually started Short task.

> **Scheduled does not mean pre-approved.**

---

# Explicit separation from Multi-Agent

Multi-Agent Runtime is not a Harness capability.

Harness contains no concepts of:

- parent agents;
- child agents;
- agent count;
- task decomposition;
- sibling communication;
- evidence fan-in;
- agent coordination.

A Multi-Agent subsystem may create ordinary HALO tasks, and those individual tasks may independently use Short, Middle, or Long.

For example:

```text
Multi-Agent Runtime
       │
       ├── task A → Short
       ├── task B → Short
       └── task C → Middle
```

That does **not** make Multi-Agent part of Harness.

Likewise, one single-agent task may use Long for hours without Multi-Agent existing at all.

This separation is required so that harness efficiency and multi-agent scaling can be measured independently.

---

# Benchmark

Use the same task corpus across profiles wherever the task is valid for all three.

Measure:

- task success;
- wall time;
- time to first useful action;
- planner calls;
- model input/output tokens;
- browser actions;
- observations and observation bytes;
- approval calls;
- journal operations;
- fsync count and time;
- peak/steady RSS;
- recovery success;
- evidence validity;
- profile escalation count and reason.

Report raw metrics rather than a single combined "Harness score."

## Workload classes

At minimum:

**Routine workload** — predictable repeated browser operations.

**Browser workload** — state-dependent navigation and interaction.

**Research workload** — multiple observations/sources with synthesis and evidence requirements.

Computer-use workloads can be added as their own capability benchmark without changing the duration profiles.

---

# Ablation

Short should receive explicit optimization ablations.

Start with current behavior and independently introduce:

```text
baseline
  + safe action batching
  + stable references
  + delta observation
  + progressive observation
  + cheap/reflex decision path
  + semantic durability
```

For every change, record which cost actually moved.

The goal is not merely:

> "Short is faster."

It is to determine **why**.

Similarly, Middle should measure the cost/value of periodic full observations and checkpoint frequency, while Long should measure context reconstruction and crash-recovery overhead.

---

# Verification

Before profile-specific optimization:

- all profiles preserve the same policy result for the same proposed action;
- no profile can bypass review;
- no profile can bypass ResourceAdmission;
- stale proposals fail identically;
- `execution_uncertain` is never automatically replayed;
- profile escalation preserves goal version and verified evidence;
- escalation cannot replay a completed side effect;
- Short batching terminates at every defined authority boundary;
- Middle recovers from its latest valid checkpoint;
- Long reconstructs context without original model conversation state;
- explicit `short|middle|long` selection works;
- invalid profile values fail closed;
- `auto` selection is deterministic for identical task metadata.

Then run profile benchmarks and the full regression suite.

---

# Rollout

**Phase 1 — Interface.** Introduce `HarnessProfile` without changing current execution semantics. Map existing behavior to Middle. *(Implemented 2026-09-29: see `docs/superpowers/plans/2026-09-29-harness-profiles-v2-phase1.md`.)*

**Phase 2 — Short.** Add safe batching, reduced planner cadence, incremental observation, and semantic durability. Benchmark each optimization independently. *(Partially implemented 2026-09-29: see `docs/superpowers/plans/2026-09-29-harness-profiles-v2-phase2.md`. Safe batching, planner cadence, and semantic durability shipped as one mechanism — a profile-aware proposal batch-width cap — with a benchmarked -33% planner calls / -50% approvals / -50% durable writes on a fixed 6-action workload. Incremental observation is deliberately deferred: it needs its own design doc before touching `BrowserAdapter.execute()`'s return contract, per that plan's Task 4 note.)*

**Phase 3 — Long.** Move the existing long-horizon machinery behind the Long profile and verify restart/context reconstruction.

**Phase 4 — Auto selection.** Add deterministic host routing and escalation only after the three explicit profiles have stable measurements.

**Phase 5 — Calibration.** Set actual budgets and thresholds from collected traces.

---

## Final architecture boundary

```text
Scheduler          = WHEN does work enter?
TaskQueue          = WHAT waits next?
Throughput         = HOW MANY may run?
ResourceAdmission  = CAN another one fit?
Harness            = HOW does one task progress?
Policy             = MAY this action happen?
Evidence           = DID the required thing happen?
Multi-Agent        = HOW are multiple agent tasks coordinated?
```

Short/Middle/Long are responsible only for *how one task executes*; Multi-Agent
is fully separate. This separation matters for benchmarking later: "Short got
faster," "concurrent task count went up," and "more agents were used" must
stay independent variables, or it becomes impossible to attribute why HALO
got faster.
