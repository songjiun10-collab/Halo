# HALO Routine Execution v1

## Status

Revised draft for user review after the independent Claude architecture
review. Implementation has not started.

## Intent and scope

Add locally stored, reusable browser-workflow definitions that the user starts
manually. A routine is a bounded sequence of declarative browser steps, not a
second privileged executor. Every run remains an ordinary HALO task: it gets
its own durable TaskStore journal and TaskController, obtains normal resource
admission before browser/planner resources are created, and passes every
proposed action through the existing permission and approval policy.

Automatic schedules, background recurrence, cross-device sync, arbitrary
JavaScript, shell commands, and model-authored routine mutation are out of v1.
Credentials are not embedded in routines. Credential filling remains a
separate user-controlled vault operation.

The routine mode is needed for a meaningful planner-versus-routine benchmark.
The existing fixed-route Electron baseline is only a browser-only proxy and
does not exercise the same task, approval, or persistence path.

## Data model

`RoutineDefinition` is a versioned local record with:

- `routineId`, `revision`, `name`, and bounded `description`;
- an explicit exact-origin allowlist containing normalized HTTP(S) origins
  (scheme, host, and port);
- an ordered non-empty list of typed steps;
- creation/update timestamps and a content digest for corruption detection.

V1 step kinds are limited to `navigate`, `follow_link`, and `scroll`, with
exactly one browser action proposed per TaskController turn. `assert_text` is
deferred until its durable completion semantics are defined. Link selection
is by bounded exact accessible name and optional expected href; the host
resolves that against the current observation and produces the current
`elementId`. Zero or multiple matching links pauses the run with an explicit
`routine_step_unresolved` reason; it never guesses. Navigation, current page,
and resolved link targets must remain within the routine's declared origins.
RoutineRunner enforces that allowlist before proposing an action as a
defense-in-depth check; BrowserAdapter/TaskController policy remains the
authoritative execution boundary. Unknown step kinds, unknown fields,
oversized strings/lists, invalid URLs, and unsupported origins fail closed.
There is no free-form code or shell field. A serialized definition is capped
at 64 KiB, a routine has at most 64 steps, URLs at 2048 characters, and
accessible names at 256 characters.

Routine revisions are immutable. Editing creates a new revision file using
exclusive create; an atomic replace may update only the small current-revision
index, never an existing revision file. Existing TaskStore records retain the
`routineId` and exact revision/digest used for that run so later edits cannot
rewrite task history. Deleting a routine tombstones it from new-run listings
but retains its immutable revision files for active/recoverable runs; prior
task journals and recovery inputs are not cascaded away.

## Execution boundary

`RoutineStore` owns local CRUD and revision validation. `RoutineRunner` reads a
specific immutable revision and implements the existing planner-proposal
provider contract for the TaskController loop. It may inspect the current
bounded observation to resolve an accessible link, but it has no direct
BrowserAdapter reference and cannot execute browser actions itself.

Starting a routine asks TaskHost to create an ordinary task with host-authored
goal/criteria and a routine-run metadata reference. The TaskHost selects the
routine proposal provider for this one task while preserving normal browser
construction, shared memory admission, journaling, checkpoint/recovery,
permission modes, approval, stop/takeover, and process teardown. The host
records a durable `routine_step_advanced` event containing the pinned routine
ID, revision, step index, and step digest only after that step's action outcome
has been accepted. The same cursor is compacted in the normal task checkpoint;
on recovery, TaskStore's streaming journal replay produces a bounded
routine-recovery summary separate from its 10-event model-context ring. It
retains only the checkpoint cursor, monotonic advancement state, and at most
one in-flight routine action/outcome binding; it never materializes the full
journal or returns an unbounded tail. Missing, duplicate, out-of-order, or
digest-mismatched advancement records fail closed. A routine action with a
successful durable outcome but no matching advancement is treated as
incomplete/uncertain and is never replayed. RoutineRunner does not derive a
cursor by counting heterogeneous browser events. Each accepted step is
advanced and checkpointed before another routine proposal is requested. If action policy
returns deny/quarantine without dispatch, TaskController durably records a
`routine_step_denied` event and pauses with `routine_step_denied` instead of
asking the runner to retry the same step until its planner-call budget is
exhausted. Approval-required actions continue through the ordinary approval
queue. Any failed or ambiguous dispatched action remains subject to existing
`execution_uncertain` semantics and is never blindly replayed after restart.

The routine definition is data, not authority. Page content, link labels,
routine descriptions, and prior run evidence are untrusted inputs. The host
retains the existing origin checks, action policy, approval requirements, and
user takeover path. An approved routine does not imply approval of its future
side effects.

## Persistence and API surface

Routine files live under the existing local application data root, separate
from task journals and the credential vault. Writes use restrictive file
permissions, atomic replace, symlink rejection, schema validation, and bounded
record sizes consistent with the existing local stores.

The trusted main process exposes a fixed allowlist for `listRoutines`,
`getRoutine`, `saveRoutine`, `deleteRoutine`, and `runRoutine` through the
existing `registerIpc` harness allowlist and `isTrustedSender` check; no new
renderer IPC trust boundary is introduced. Saving occurs only through an
explicit user save action and creates a new immutable revision. The renderer
cannot choose storage paths, invoke arbitrary methods, or provide a planner
worker command. `runRoutine` accepts only a routine ID and revision; all
definition content is loaded and validated by the host. Starting a routine
never pre-approves its future actions.

## Planner-versus-routine benchmark

Use a deterministic local fixture and two modes that share the same Electron
build, BrowserAdapter, TaskController, TaskStore durability, approval policy,
memory monitor/admission, viewport, and success criteria:

1. Routine mode executes a fixed validated RoutineDefinition through
   RoutineRunner.
2. Planner mode uses the existing scripted planner worker to derive the same
   actions from observations. This is a protocol/orchestration comparison, not
   a language-model-quality evaluation.

Run paired iterations with warm/cold labels and randomized mode order. Report
completion rate, p50/p95 wall time, browser action and planner-call counts,
approval decisions, durable-store time, sampled peak RSS and sample cadence,
planner process startup/warm-up separately, unmeasurable processes, and
cleanup status. Do not compare planner model
quality without an explicitly selected model and a larger task set. Do not
claim a hard memory ceiling from polling-only RSS samples.

The current one-shot 100-page result remains a historical motivation only:
the browser-only fixed-route baseline was 0.461 s and the complete deterministic
harness was 2.201 s (4.77x in that run), with sampled peaks 489 MB and 591 MB.
Those paths are not feature-equivalent and must not be presented as a
planner-versus-routine result.

## Failure and recovery semantics

- Invalid or corrupt routine definitions are rejected before any task or
  browser resource is created.
- Deleting a routine prevents new runs but preserves pinned revisions and does
  not mutate or delete prior task journals.
- A run pins its revision at creation; later edits/deletes do not affect it.
- Pause, takeover, stop, memory emergency, service detach, and process restart
  retain existing TaskHost semantics.
- A run found after restart must not resume an in-memory step cursor as
  authority. The runner reconstructs the next safe step from durable task
  checkpoint plus post-checkpoint `routine_step_advanced` events and the pinned
  routine revision; if the last action is uncertain, it remains paused for
  explicit recovery rather than replaying it.
- If the pinned routine revision is missing or its digest differs, recovery
  fails closed and leaves the task available for diagnosis.
- A policy-denied or quarantined step durably pauses the run; it is not
  silently skipped or retried.
- A changed page with no unique accessible-name link match durably pauses the
  run; it is not resolved by fuzzy or model-based matching.

## Independent review findings incorporated

Claude independently confirmed the proposal-provider fit and benchmark framing,
and identified the durable-cursor, denied-step retry, link ambiguity, explicit
origin enforcement, trusted IPC reuse, immutable-revision wording, and planner
warm-up reporting gaps. The current draft incorporates those changes. Before
implementation, the user should confirm this reduced v1 boundary and whether
the remaining completion/recovery semantics are sufficient.
