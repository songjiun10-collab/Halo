# Multi-Agent Background Browser Runtime Design

**Date:** 2026-09-28
**Status:** Draft for user review
**Scope:** Local browser-agent orchestration and background runtime. No runtime implementation is authorized by this document alone.

## Goal

Allow a parent HALO task to divide a browser goal into independently bounded
child-agent tasks, run the requested number concurrently when the user-selected
resource policy permits, and continue operating while the app UI is hidden or
closed. Every agent owns exactly one browser view; no two agents may control
the same tab or `WebContentsView`. The HALO host remains responsible for task
state, policy, evidence verification, memory admission, recovery, and user
controls.

The default memory policy remains budgeted and measured. The user may explicitly
disable HALO's memory ceiling after seeing a warning; for a parent run using
that override, this disables both admission blocking and HALO's automatic
memory-pressure pause decisions. Monitoring and warnings remain active. The
parent's requested agent count is honored subject to ordinary operating-system
resource availability. Disabling the HALO ceiling is not represented as a
guarantee that the machine will remain responsive or avoid OS memory pressure.

## User-approved requirements

- The parent agent chooses how many child agents it needs and proposes their
  bounded assignments; the user does not enter the count and it is not a fixed
  product concurrency constant.
- One agent owns one dedicated browser view and one independent journal. A
  shared tab is not a supported concurrency mode.
- Background work continues both while the window is hidden and after the UI
  has detached/quit.
- Work, browser state, configuration, credentials, and custom memory remain
  local. Existing provider behavior still applies: task context sent to a
  configured remote model leaves the machine.
- Default memory admission is budgeted. The user can explicitly disable that
  HALO-level limit after a warning.
- Existing host-owned goals, approval invalidation, provenance decisions,
  durable journals, and `execution_uncertain` semantics remain authoritative.

## Current checkout context

- `TaskHost` attaches one `TaskStore`, `TaskController`, `BrowserAdapter`, and
  planner per top-level task; each task already has its own browser surface.
- `TaskQueue` persists top-level FIFO ordering. Child work must not leak into
  top-level enqueue, listing, or saved-task recovery APIs.
- `AgentViewportHost` currently constructs hidden fixed-size browser surfaces
  per task. The visible and agent surfaces for a task share a task session
  partition; they are separate views, not the same tab.
- `MemoryMonitor` samples the app process tree and registered workers. Current
  task concurrency/admission is not a sufficient authority for an unbounded
  number of child agents; one central admission/reservation authority is
  required.
- Existing phase documents cover task queue/permissions/local stores and the
  fixed agent viewport. This design extends those boundaries rather than
  replacing them.

## Architecture decision

Use a local background runtime service as the durable owner of `TaskHost`,
agent orchestration, browser surfaces, and journals. The Electron UI is a
client that attaches/detaches over a private local IPC endpoint. The service is
started and supervised as a per-user macOS LaunchAgent so UI quit does not
terminate accepted background work. Closing/minimizing the window merely
detaches or hides the client; it does not stop the service. A separate explicit
Stop/Cancel action is required to stop work. The UI must show whether the
service is connected, running, waiting for approval, or unavailable.

The service owns one parent coordinator and N child-agent records. Each child
has a separate `TaskController`, child-scoped `TaskStore` journal, planner
worker, and `WebContentsView`/`BrowserAdapter`. The child browser view is never
reassigned to another agent. The parent has no shared execution tab. The
parent's browser surface, if any, is also not used as a child surface.

The parent planner emits a typed `child_plan` proposal, separate from browser
actions. It contains `requestedAgentCount` and exactly that many assignments
of bounded subgoal plus exact entry URL. The host validates the complete
proposal and rejects mixed child-plan/browser-action turns, stale parent goal
versions, invalid counts, malformed origins, or unsupported capabilities
before creating any child store or process. Child planners cannot emit
`child_plan` proposals.

Children are stored under the parent's durable namespace and referenced from
the parent journal by child ID and parent goal version. They are not top-level
queue entries and cannot be independently resumed via public task APIs. A
child receives a bounded subgoal, parent goal version, host-selected policy,
and only the capabilities needed for that assignment. It cannot edit the
parent goal, checkpoint the parent, mint approvals, or expand its own child
tree in the initial version.

## Agent-to-browser and concurrency contract

1. There is a strict one-to-one mapping: one child agent ID maps to one
   `WebContentsView`, one `BrowserAdapter`, one planner worker, one child
   journal, and one lifecycle record.
2. No browser view, tab, mutable page context, or controller is shared by two
   agents. Each view has a stable agent viewport and host-generated identity.
3. Each assignment contains one exact HTTP(S) entry URL and its normalized
   origin. The trusted host performs the initial navigation to that URL before
   starting the child planner and rejects a redirect that leaves the assigned
   origin. Sibling agents may run concurrently only when their assigned
   normalized origins are distinct. If origins overlap, the host serializes
   those assignments; the parent cannot override this consistency guard.
4. The initial child policy is read-only after host bootstrap: `observe` and
   `scroll` only. Child actions cannot navigate, click, type, submit, download,
   autofill, or approve.
   Any later expansion requires a separate design for action-level approval
   tokens bound to child ID, goal version, document epoch, action, and expiry.
5. All child views for one parent task use the same host-selected session
   partition as that parent task's existing browser surfaces, preserving that
   task's login state while maintaining separate `WebContentsView`s. The child
   cannot choose a partition. Shared cookies, storage, service workers, SSO
   effects, and site-level rate limits are residual cross-agent coupling and
   must be disclosed. HALO must not claim that separate views imply separate
   browser storage. A later isolated-profile mode is out of scope.
6. Child results are untrusted proposals. The parent reads child journal events
   and evidence directly, requires a durable terminal checkpoint and at least
   one valid evidence record for a claimed finding, then performs its own
   synthesis. A child self-reported summary alone cannot complete the parent.

## Resource policy and requested agent count

The parent planner supplies a positive integer `requestedAgentCount`; the host
validates it and records it with the task. It does not silently rewrite the
request. The scheduler may admit fewer agents at one time under the default
budgeted policy, and continues admitting from the parent plan as resources
become available. Agents without an admitted slot remain durable queued child
records and do not construct a browser or planner process.

At child-plan creation the host snapshots the selected `memoryPolicy` together
with parent task ID, requested count, parent goal version, and timestamp in the
parent journal; the plan actor is `parent_agent`. The memory-policy preference
itself can be changed only through the trusted UI after explicit warning
confirmation, and that change is separately recorded as a user action.
Changing the host default affects new plans only; it does not change an
existing parent run's policy. The child-plan record links that user-confirmed
memory-policy audit event to the parent task and parent-proposed count, so the
recorded choice has both user confirmation and run scope. The UI displays
proposed/active count but does not set it.

Two host resource modes are required:

- **Budgeted (default):** one global serialized admission authority accounts
  for top-level tasks, child agents, browser renderers, and planner process
  trees. Admission requires fresh, complete measurements and benchmark-derived
  reservations. Missing/stale measurements or unknown per-agent reserve cause
  queued/sequential execution, not speculative spawn. Child admission cannot
  race top-level admission against the same memory sample.
- **User override:** before disabling the HALO ceiling for a parent run, the UI
  explains that HALO will neither delay/serialize that run to stay under its
  configured memory budget nor automatically pause it at HALO's memory
  pressure thresholds. OS-level memory pressure, slowdown, or process
  termination may result. The explicit choice is recorded durably with actor,
  timestamp, parent-task scope, and requested count. Monitoring and warning
  telemetry remain on. The choice is captured for that parent run; changing
  the host default affects new runs and does not retroactively change an
  already-running run's memory policy.

The unrestricted mode does not mean infinite or malformed process creation:
counts must be positive bounded integers accepted by the host schema, system
spawn failures are surfaced, and every created process/view must be tracked and
disposed. The accepted maximum input value is to be selected from load and
resource testing in the implementation plan, not guessed here.

## Background service lifecycle

### Attach and detach

- The UI discovers/starts the per-user service and authenticates to a private
  local IPC endpoint protected by a private directory/socket, peer-UID checks,
  and an unguessable per-install capability. Page content and renderer input
  cannot select the endpoint path, service command line, or capability.
- Detaching or quitting the UI leaves accepted work and the service alive.
  A UI reconnect reconstructs visible state from host snapshots and durable
  journals; it does not re-submit a task.
- The service has separate explicit operations for `detachClient`, `stopTask`,
  and `stopService`. UI window close maps to detach, not stop.
- Service install/update/uninstall is local and user-scoped. UI must disclose
  whether the LaunchAgent is installed and provide a clear stop/uninstall
  control. Do not add a privileged system daemon.

### Service crash, reboot, and recovery

- A service crash or machine reboot does not authorize replay. On next launch,
  the host reconciles parent/child journals and leaves in-flight browser actions
  in `execution_uncertain` or recovered-paused state as required by existing
  semantics.
- No child is automatically relaunched if its last action may have dispatched,
  its journal is corrupt/missing, its partition/view identity cannot be
  established, or its result/evidence is incomplete. The parent pauses and
  requests an explicit user recovery decision.
- A cleanly queued child with no constructed browser/planner may be admitted
  after service restart once the parent is explicitly resumed under current
  settings.
- Terminal child states remain terminal and are never rerun by reconciliation.
- Approvals and in-memory credentials are not persisted across service
  restarts. Credential vault data stays encrypted at rest; child processes do
  not receive vault keys or plaintext beyond an explicitly authorized,
  separately reviewed host autofill path (autofill is out of this feature's
  child read-only scope).

### Background throttling and focus

- Service-owned browser surfaces never focus or activate the user's UI. The
  hidden app window/client may detach without destroying active views.
- Background throttling behavior must be measured in real Electron. If a
  throttled renderer cannot safely satisfy an observation deadline, the task
  waits or reports a typed timeout; HALO does not steal foreground focus to
  speed it up.
- Popups, downloads, permissions, external protocols, and certificate errors
  remain fail-closed and produce host events.

## Evidence and parent completion

Each child journal records parent ID, parent goal version, child ID, assigned
origin, policy mode, creation time, admission/memory-mode decision, browser
surface identity, observations/evidence references, state transitions, and
terminal reason. It must not duplicate credentials, secret memory, full page
contents, or unbounded screenshots.

Parent completion requires all assigned children to be terminal or explicitly
cancelled/skipped, parent-side verification of child evidence references, and
a durable synthesis event. A denied, failed, or uncertain child is not silently
treated as a successful finding. Parent cancellation drains admitted children,
records which completed/uncertain, then releases browser and worker resources.

## Interfaces and data model (proposed)

- `PlannerProposal` is a discriminated union: `actions` carries the existing
  action proposal shape; `child_plan` carries the parent goal version, count,
  and assignments. A child planner may return only `actions`.
- `ChildAgentCoordinator.acceptParentPlan(parentTaskId, proposal)` validates
  and persists the fixed plan; each assignment has a bounded subgoal, exact
  HTTP(S) entry URL, and derived normalized origin. No child creates another
  child in this version.
- `TaskHost.listChildren(parentTaskId)` returns safe summaries only. Existing
  top-level `listTasks()` continues to exclude children.
- A host-owned `ChildAgentCoordinator` owns plan state and child lifecycle. It
  calls a single global `ResourceAdmission` lease API before constructing a
  child browser or planner and releases the lease only after teardown.
- `BackgroundRuntimeService` owns TaskHost and service lifetime; UI IPC offers
  attach/detach, snapshots/events, explicit task/service stop, and recovery
  decisions. Renderer cannot spawn processes or choose browser partitions.
- Versioned settings add `memoryPolicy: "budgeted" | "user_override"`. The
  override is explicit, durable, auditable, and never inferred from task text.

Names are conceptual; exact module names and schema migrations belong in the
implementation plan after this spec is approved.

## Failure behavior

- Invalid count, duplicate child IDs, malformed entry URLs/origins, a redirect
  outside the assigned origin, parent-goal changes,
  or stale parent goal version reject plan creation before any browser or
  planner is created. Overlapping valid origins are accepted into the plan but
  serialized by the host rather than run concurrently.
- Budgeted-mode stale/incomplete telemetry queues work; it does not fail the
  parent or spawn without a lease.
- User override does not suppress OS spawn errors, process crashes, renderer
  crashes, disk errors, journal integrity failures, or safety-policy denials.
- IPC disconnect detaches UI only. It is not a task cancellation signal.
- LaunchAgent unavailable means background-after-quit is unavailable; the UI
  must not claim continuation and must require the user to choose either keep
  the app/service running or stop the task.
- Parent/child journal disagreement, duplicate ownership, or unknown agent
  identity pauses affected work fail-closed and records a stable error code.

## Test and measurement requirements

- Unit: parent/child journal linkage, goal-version binding, child hidden from
  top-level queue/list/recovery, one agent-to-one-view mapping, same-tab sharing
  rejection, unique views with the parent's selected session partition,
  host-only initial navigation and redirect-origin refusal, distinct-origin
  admission, same-origin serialization, read-only policy enforcement at both
  controller and adapter boundaries, evidence
  verification, parent completion/cancel/drain, and terminal child retention.
- Resource: prove a single serialized admission ledger prevents races between
  top-level tasks and child agents; budgeted stale/missing/unknown measurements
  never spawn; override admits above HALO's configured budget but still records
  usage and handles OS/process failures.
- Electron: run at least 1, 2, and a higher requested child count on local
  fixture origins; measure aggregate Electron plus planner process-tree RSS,
  renderer count, start latency, p50/p95 observation latency, and teardown.
  Report sampling cadence and peak limitations; do not call sampled RSS a hard
  instantaneous bound.
- Lifecycle: real macOS test hides window, detaches/quits UI, reconnects,
  explicitly stops service, kills the service at safe and in-flight points,
  reboots/restarts recovery fixtures, and verifies no automatic uncertain
  action replay.
- IPC/security: socket permissions, peer UID/capability checks, hostile page
  cannot attach/control service, repeated UI attach does not duplicate tasks,
  and service endpoint symlink/path replacement is rejected.
- Regression: existing queue, TaskHost, TaskController, TaskStore,
  AgentViewportHost, permission, memory, local memory/vault, IPC, and full app
  suites pass. Real service-install tests must be opt-in and use a disposable
  per-user LaunchAgent label.

## Non-goals

- Shared-tab access by multiple agents.
- Child-generated actions outside `observe`/`scroll`, action approvals, writes,
  purchases, messages, credential autofill, downloads, or arbitrary scripts.
- Nested subagents, dynamic DAG re-planning, or child-to-child delegation.
- Cross-device/cloud execution, remote service access, or privileged daemon.
- Automatic task retry after uncertain dispatch, automatic child recreation,
  or claim of exactly-once browser actions.
- Semantic memory changes, browser sync, or full feature parity with Aside.

## Open decisions for implementation planning

1. Pick the maximum accepted numeric request count based on Electron load tests;
   user override removes the HALO memory admission ceiling, not input
   validation.
2. Verify macOS LaunchAgent packaging/signing and Electron service process
   behavior in the target app distribution before committing to installation
   mechanics.
3. Specify the exact local IPC authentication and service upgrade protocol,
   reusing existing trusted host patterns where possible.
4. Benchmark whether origin-level serialization is enough for shared-session
   safety; if not, further restrict parallel assignments or design isolated
   profile support separately.
