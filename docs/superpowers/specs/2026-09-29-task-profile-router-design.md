# HALO Task Profile Classifier and Router

**Date:** 2026-09-29
**Status:** Architecture proposal for user review
**Scope:** Backend architecture; implementation requires a separately reviewed plan.

## Goal

Route each user task through a host-owned classifier/router that resolves a
duration profile and a capability profile, then executes through the existing
HALO shared safety core:

```text
TaskRequest
    ↓
Host Classifier / Router
    ↓
Resolved Task Profile (immutable for this task)
  ├─ Duration: Short | Middle | Long
  └─ Capability: Routine | Browser | Research | Computer-use | Multi-agent | ...
    ↓
Capability adapter (proposes work; does not execute around the host)
    ↓
Shared HALO Core
  ├─ TaskHost / TaskController lifecycle and resource admission
  ├─ policy and approval
  ├─ executor and action validation
  ├─ evidence, verification, and provenance
  └─ journal, checkpoint, recovery, and audit
```

The classifier chooses a bounded execution route; it is not an authorization
component. No capability profile may weaken the shared core's policy, approval,
provenance, verification, or recovery requirements.

## Current checkout facts

- `TaskHost.createTask()` reaches `_createNewTask()`, queue admission, and
  `_attach()`. `runRoutine()` currently chooses a `RoutineRunner` but creates
  an ordinary task through the same host path.
- `_attach()` chooses `RoutineRunner` or `makePlanner()` and constructs the
  shared `TaskController`. The controller owns proposal validation, action
  policy, approval, dispatch, evidence, checkpointing, and recovery semantics.
- `GoalSpec` already carries explicit `maxActions`, `maxPlannerCalls`, and
  `maxActiveMs` limits. Defaults are 1,000 actions, 500 planner calls, and
  four active hours; active time excludes paused/user-wait time.
- Permission mode, planner effort, and sequential/parallel execution settings
  exist as separate host settings. They are authority/policy controls, not
  task-classification outputs.
- A committed `HarnessProfile` abstraction now exists in
  `shared/harness-profile.js`. Current host selection maps saved routines to
  `short` and all other tasks to `middle`; Phase 2 adds wider safe batching and
  reuse of a batch's trailing observation for `short`. This is an execution-
  horizon profile, not a capability profile, and its current routine-based
  default is a transitional routing rule rather than proof that capability and
  duration are already independently classified.
- Current BrowserAdapter supports `observe`, `scroll`, `navigate`, and
  `follow_link`. `click`, `type`, `submit_form`, and `download` are rejected.
- Routine and multi-agent execution exist. A dedicated Research capability
  adapter and screenshot/coordinate computer-use adapter are not present in
  the current browser action contract. They must not be advertised as
  available until implemented and tested.
- No unified duration/capability profile resolver or durable record binding
  both selections currently exists. The working tree contains unrelated
  in-progress changes; implementation must preserve them.

## Selected approach

Use a deterministic, host-owned classifier in v1. Explicit trusted-user choices
and typed entry points (for example, `runRoutine(routineId, revision)`) take
precedence. A small versioned ruleset may classify unambiguous task intent;
ambiguous or unsupported requests ask the user instead of silently selecting a
more powerful capability. There is no model call in the v1 routing critical
path. A future model may provide a classification suggestion, but that result
is untrusted data and must pass the same host validation and user-intent checks.

This choice avoids adding a network/model round trip before every task, makes
routing reproducible, and keeps the user/host—not a model or page—the authority
for enabling sensitive capabilities. A classifier confidence score is
diagnostic only; it cannot authorize an otherwise unavailable capability.

## Request and resolved profile contracts

The trusted host accepts a task request containing the original user text and
optional explicit selections. Canonical wire IDs are lowercase: `short`,
`middle`, `long`, `routine`, `browser`, `research`, `computer_use`, and
`multi_agent`; user-facing labels may use title case. The duration decision runs first; capability
routing then uses the same trusted request plus the resolved duration. The
two result fields remain independently represented so selecting Routine or
Multi-agent cannot silently force Short or Long:

```text
TaskRequest = {
  goalInput,                         // existing raw TaskStore.create() input, pre-normalization
  requestedDurationProfile?: auto | short | middle | long,
  requestedCapabilityProfile?: CapabilityId,
  routineRef?: {routineId, revision} // host-validated pinned definition
}
```

No page content, planner proposal, tool output, or child-agent message may set
these fields. Existing callers without profile fields remain supported through
deterministic inference and conservative defaults.

Before queue admission or resource construction, the host resolves and
validates:

```text
ResolvedTaskProfile = {
  schemaVersion: 1,
  classifierVersion: string,
  duration: {id: short | middle | long, harnessProfileVersion, policySetId},
  capability: {
    id: routine | browser | research | computer_use | multi_agent,
    registryVersion,
    dependencies: [CapabilityId],
    adapters: [{capabilityId, adapterId, adapterVersion}]
  },
  parentBinding?: {parentTaskId, planId, parentGoalVersion},
  selection: {
    duration: {source, ruleId?},
    capability: {source, ruleId?}
  },
  createdAt: ISO timestamp
}
```

The profile is host-authored, schema-validated, and immutable for the task.
Its `selection` explains which trusted input or deterministic rule selected it;
it must not copy untrusted page/model text as an authoritative reason. Unknown
IDs, unsupported adapters, incompatible routine references, or limits outside
host bounds fail before resource admission.

## Duration profiles

Duration is the expected execution horizon and its associated harness strategy,
not a promise that the task will run for an exact wall-clock interval. Reuse
the existing `HarnessProfile` implementation as the duration-profile engine;
do not create a duplicate Short/Middle/Long enum or a combined
`ShortRoutineHarness`-style type. `HarnessProfile` already distinguishes
planner cadence, context, observation, batching, durability, recovery, and
budget policy. The Router adds capability selection alongside it.

| Duration profile | Execution strategy | Selection intent |
|---|---|---|
| Short | Minimal planner cadence, compact context, incremental-first observation, aggressive but authority-bounded batching, semantic durability, execution-state recovery | Bounded, predictable work. A validated saved routine is a deterministic Short candidate because its definition is bounded; an explicit trusted profile choice may override it. |
| Middle | Adaptive bounded segments, rolling context, periodic observation/checkpoint, task-checkpoint recovery | Default for ordinary or unknown-horizon work; preserve current general task behavior. |
| Long | Bounded planner segments, host-reconstructed context, strongest semantic durability, restart/context reconstruction | Long-running/background work or work requiring durable continuation. |

Exact numeric limits are intentionally not fixed in this architecture. The
existing `DEFAULT_LIMITS` (1,000 actions, 500 planner calls, four active hours)
remain the current GoalSpec defaults/legacy ceiling until profile-specific
limits are calibrated from comparable traces. The v2 profile design's Phase 5
owns that calibration. `maxActiveMs` retains current semantics: paused time
and user-wait time do not consume active time; wall-clock age is reported
separately. Explicit per-task limits can reduce a profile's current ceiling,
but neither classifier nor capability adapter can raise it. Any finalized
profile budget is persisted with the task and stays fixed across restart.

The current `selectHarnessProfile({isRoutine})` mapping is transitional. The
final Router resolves duration using horizon signals, including the bounded
routine metadata, and resolves capability independently. It must not infer
Short solely from a capability label when the task's validated scope indicates
a different horizon.

## Capability profiles and availability

The registry is a compile-time host allowlist, not a plugin loader. Each entry
declares an adapter, required host resources, supported proposal/action kinds,
and whether it is available. An unavailable capability is rejected with a
stable error; it never silently falls back to a semantically different route.

| Capability | v1 mapping | Availability and boundary |
|---|---|---|
| Routine | Existing pinned `RoutineRunner` proposal source | Available; still uses ordinary TaskController policy, approval, journal, evidence, and recovery. |
| Browser | Existing planner + BrowserAdapter | Available for observe/scroll/navigate/follow_link only; unsupported action kinds remain denied. |
| Research | Future bounded research adapter on the browser/source-observation path | Unavailable until source/evidence contracts and citation verification exist. |
| Computer-use | Future screenshot + host-mediated coordinate/action adapter | Unavailable until screenshot provenance, coordinate binding, action policy, and approval are implemented. |
| Multi-agent | Existing parent `child_plan` + `ChildAgentCoordinator` orchestration subsystem | Available only when host routing selects it and shared memory/resource admission succeeds. It is not part of `HarnessProfile`; every child is an ordinary HALO task that receives its own independently resolved duration and capability profiles. |

Capability is not permission. The selected capability describes which
proposal/observation mechanisms may be used. The current host permission mode
and action policy remain authoritative. A capability may narrow the allowed
surface but may never elevate `observe` to `interact`/`full`, bypass approval,
grant credentials, or mark evidence verified.

## Task-entry coverage

Every path that can mint or resume an executable task must use the same
profile contract:

| Entry path | Profile source and boundary |
|---|---|
| `TaskHost.createTask()` | Resolve from the raw user request and host-validated explicit selectors before `TaskStore.create()`. No profile selector is accepted from a planner or page. |
| `runRoutine()` and scheduled routine occurrences | Pin and validate the exact saved routine revision first; select Routine capability from the typed host entry point. A schedule trigger is audit/idempotency metadata, not a profile selector. Resolve duration independently under the same horizon rules. |
| `ChildAgentCoordinator.acceptParentPlan()` | Accept `child_plan` only when the parent has a host-resolved Multi-agent capability. Reject assignment-supplied profile fields. Each child receives Browser capability (scoped to its validated entry origin and the existing child action policy); resolve its duration on the host and do not allow a longer-horizon profile than the parent. Children cannot nest Multi-agent, claim Routine, or request Research/Computer-use. |
| Recovery / queued admission | Load the persisted profile and pinned adapters; do not reclassify a partially executed task. New marked tasks with a missing profile fail closed; historical tasks use only the legacy mapping. |

Child subgoals and URLs originate in planner proposals and remain untrusted.
They may be classifier input only for choosing a child duration no longer than
the already host-resolved parent horizon; they are never authority to
choose a capability, widen the action set, permission mode, origin, or profile
ceiling. The coordinator persists each child's profile in its child store
before the parent `child_plan_accepted` event can trigger admission. Failure
to create or persist any child profile rolls back the entire unaccepted plan;
no child browser or planner is constructed on that path.

## Routing rules and precedence

The pure resolver applies this ordered rule table; it does not call a model or
touch filesystem, browser, settings, or queue state:

| Priority | Trusted input / condition | Resolution |
|---:|---|---|
| 1 | Malformed fields, conflicting explicit selections, or invalid routine reference | Reject before admission with a stable typed error. |
| 2 | `runRoutine(routineId, revision)` after host loads and verifies the immutable definition | Routine capability, exact revision pinned; Browser is a required underlying capability. Duration is resolved independently from validated routine bounds and explicit duration intent. |
| 3 | Explicit trusted `requestedCapabilityProfile` and/or `requestedDurationProfile` | Honor if available, host-allowed, and within limits; Routine requires a matching validated `routineRef`; otherwise fail/clarify, never silently downgrade to a different meaning. |
| 4 | Unambiguous deterministic intent rule from the versioned bilingual rule table | Select only a registered, available capability; persist the matching stable `ruleId`. Research/Computer-use intent returns unavailable until that adapter exists. |
| 5 | No matching specific rule | Browser + Middle defaults. |

The initial lexical table is intentionally small and versioned. After Unicode
normalization and case-folding, the English whole-word and Korean phrase groups
are:

| Capability | English intent phrases | Korean intent phrases |
|---|---|---|
| Research | `research`, `find sources`, `cite sources`, `compare sources` | `조사해`, `출처 찾아`, `출처를 찾아`, `근거를 인용`, `자료 비교` |
| Computer-use | `computer use`, `use the mouse`, `use the keyboard`, `screenshot coordinates` | `컴퓨터 유즈`, `마우스로`, `키보드로`, `스크린샷 좌표`, `좌표 클릭` |
| Multi-agent | `parallel agents`, `sub-agents`, `delegate to agents` | `병렬 에이전트`, `서브 에이전트`, `에이전트에게 분담` |

An explicit routine invocation maps to the Routine capability. Exactly one
matching phrase group maps to its capability; no match maps to Browser.
Multiple groups require clarification. The deterministic English/Korean
ruleset is versioned and has positive, negative, normalization, overlap, and
ambiguity fixtures. A future semantic model classifier is out of the v1
critical path.

Duration rules are independent of capability: explicit trusted profile choice
wins; otherwise exact, versioned short/long intent hints select Short/Long;
all remaining tasks select Middle. In v1, normalized phrases `quick`, `brief`,
`short task`, `빠르게`, `간단히`, `짧게` select Short; `long-running`, `long
task`, `extended task`, `장기 작업`, `오래 걸리는 작업` select Long. Matching
is case-insensitive for English and exact normalized phrase matching for both
languages; no model-based paraphrase inference is performed. If both groups
match, ask for clarification. The initial hint dictionary is reviewed
configuration in this spec, not model-generated estimates. A validated
routine's declared bounds may inform horizon selection, but its Routine
capability alone never selects Short. Exact numeric profile budgets remain
unset until the v2 profile calibration phase; current GoalSpec limits are
authoritative in the interim.

Capability selection is a separate axis from duration selection. Routine and
Research can declare Browser as a dependency. Multi-agent routes to the
existing orchestration subsystem; it submits independently profiled child
tasks rather than changing the parent's duration or harness strategy. The
registry stores the dependency closure and pins every adapter version. Child
agents inherit host-resolved restricted task profiles; planner-authored
assignments cannot widen child duration, permission mode, origin scope, or
action set. Existing `child_plan` proposals are only accepted when host
routing and policy allow Multi-agent for that parent.

Routing is performed once before queue admission. Profile updates are not
accepted from planner output or page messages. A user-approved task amendment
may narrow the profile limits. Changing capability or raising limits requires
a host-controlled transition that invalidates pending approvals and records an
audit event; v1 does not expose either mutation. A future extension must
specify and test that transition before exposing it.

## Persistence, replay, and compatibility

Resolve the profile from the raw request and validated routine reference before
creating the task store. Extend the TaskStore creation path to accept a
host-validated initial profile record; after GoalSpec normalization, it writes
`goal_created` followed by `task_profile_selected` durably before returning the
store. The profile event copies the exact normalized effective limits, so the
router does not duplicate GoalSpec defaults. No task may enter the queue or
construct a browser/planner before both records are durable. The initial
checkpoint may cache the profile, but journal replay is authoritative. Add a
bounded typed journal event rather than overloading a generic note payload.
Validate enums, limits, versions, unknown fields, and event/task binding on
write and replay.

Mark new `goal_created` records as requiring a profile event. Replay requires
exactly one valid `task_profile_selected` immediately after `goal_created`
before any other event for a marked task; a missing, duplicate, or malformed
profile fails closed and cannot be queued or resumed. Historical
`goal_created` records without the marker use only the explicit legacy mapping
below. If the initial durable writes fail, creation returns an error and the
incomplete store remains non-runnable for diagnosis; it must never be
mistakenly admitted as a legacy task.

The new `task_profile_selected` event payload contains exactly
`profileSchemaVersion`, `classifierVersion`, optional `parentBinding` for
child tasks (`parentTaskId`, `planId`, and `parentGoalVersion`), `duration`
(`id`, pinned
`harnessProfileVersion`, `policySetId`, and `effectiveLimits` containing
`maxActions`, `maxPlannerCalls`, and `maxActiveMs`), `capability` (`id`,
`registryVersion`, sorted dependency IDs, and the sorted full adapter list
with each component's capability ID, adapter ID, and adapter version), and
`selection` with independently attributed `duration` and `capability` entries
(`source` plus optional stable `ruleId`). The `source` enum is exactly
`routine_entrypoint`, `explicit_user_choice`, `intent_rule`, `default`, or
`parent_plan_policy`. A child `parentBinding` must match the host-authored
parent `child_plan_accepted` event before the child can be admitted.
Independent attribution is required because an explicit duration choice can
compose with a capability selected by an intent rule. The task journal
envelope supplies task ID, goal version, sequence, event ID, and timestamp.
The resolver receives raw `goalInput` before GoalSpec normalization, so it can
distinguish omitted limits from user-provided limits. Until calibrated profile
budgets are committed, effective limits are the existing normalized GoalSpec
limits; the resolver must not invent preset values or raise those limits. Once
a versioned policy set supplies calibrated ceilings, effective limits are the
per-field minimum of that ceiling and any explicit lower user limits, while
requests above the host's maximum are rejected with
`duration_limit_exceeded`. The normalized GoalSpec stores the effective
limits so existing controller enforcement remains authoritative.

On recovery, the host loads the pinned duration/capability profile versions
and every adapter ID/version in the dependency closure. If any profile or
adapter is unknown, corrupted, unavailable, or
inconsistent with the routine pin, fail closed for diagnosis; never reroute a
partially executed task to a different capability. Existing pre-profile tasks
are handled by an explicit legacy mapping to their historical goal limits and
current planner/browser route, with no capability expansion. Migration must
not rewrite original requests, old journal events, or verified evidence.

Profile selection and changes are audit data only. They do not count as
evidence, approvals, or provenance verification. Evidence retains its current
host-verifier/user-confirmation authority and remains bound to task and goal
version.

## Failure behavior

- Invalid or ambiguous route: ask the user or return a typed unavailable/needs
  clarification result before queue admission; do not guess a stronger route.
- Profile write/fsync failure: do not admit or construct task resources.
- Unknown profile/adapter on recovery: pause/fail closed; do not fall back.
- Capability adapter failure: use existing typed pause/error semantics and
  preserve `execution_uncertain` when dispatch outcome is ambiguous.
- Resource admission denial: remain queued; do not construct browser, planner,
  or child resources prematurely.
- New or future capability: unavailable by default until a registry entry,
  policy mapping, provenance/evidence contract, and integration tests exist.

## Decomposition and implementation phases

This architecture spans independent adapters and should not be implemented as
one large plan. After approval of this architecture and its values, create
separate reviewed implementation plans in dependency order:

1. **Profile contract and router:** deterministic input precedence, strict
   profile registry, bounded classifier rules, typed profile journal event,
   legacy task mapping, and TaskHost integration.
2. **Duration enforcement:** profile-aware policy selection, validation,
   active-time accounting, amendment constraints, recovery, queue/admission
   interaction, and UI-facing reason codes. Numeric profile ceilings are
   introduced only after the v2 calibration phase provides evidence.
3. **Existing capability integration:** Routine, Browser, and Multi-agent
   registry routing; shared-core invariants and no-escalation tests.
4. **Research capability:** bounded source acquisition, source identity,
   untrusted content labeling, evidence references, and host verification.
5. **Computer-use capability:** screenshot provenance, task/document/viewport
   binding, coordinate action contract, permission matrix, human approval, and
   integration with the same executor/journal/recovery path.

Each phase must remain independently testable and must not claim the full
architecture is complete while a named capability is unavailable.

## Acceptance criteria

- Every new task has exactly one validated, durable duration/capability profile
  before any browser/planner resource is created.
- Classifier output is deterministic for the same versioned host inputs; every
  route is explainable by a stable source/rule ID.
- Model/page/child output cannot set, amend, or authorize profiles.
- Each selected duration profile applies its versioned execution strategy and
  existing host-enforced GoalSpec limits across checkpoint and recovery;
  calibrated profile ceilings may narrow, never raise, those limits. Paused
  and user-wait time do not count as active time.
- Routine, Browser, Research, Computer-use, and Multi-agent each either route
  to a verified adapter or fail explicitly unavailable; none bypasses shared
  policy/approval/evidence/provenance.
- Unknown/corrupt profile records fail closed and never trigger fallback
  execution.
- A newly-created task with a missing initial profile event cannot be
  reconciled into the runnable queue after a crash between creation writes.
- Existing unprofiled tasks recover through a documented legacy mapping with
  no replay or new permissions.
- Tests cover classifier precedence/ambiguity, profile persistence/replay,
  policy/limit enforcement, unsupported capability rejection, adapter
  isolation, no-escalation, and all creation routes (`createTask`, routine and
  scheduled routine, accepted child plan, queued admission, and recovery), plus
  the existing full TaskHost/TaskController regression suites.
- Integration benchmarks report classification overhead separately and verify
  it does not add an external model call to the v1 task-start path.

## Non-goals

Dynamic third-party plugins, model-authoritative routing, automatic permission
elevation, provider/API-key selection by classifier, capability fallback after
partial execution, and claims of Research or Computer-use support before those
adapters meet their acceptance criteria.
