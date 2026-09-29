# Sequential Task Queue and Local Agent Controls Backend Design

**Date:** 2026-09-28  
**Status:** Draft for user review  
**Scope:** Backend only. Renderer settings UI is explicitly deferred.

## Goal

Add a Symphony-inspired FIFO orchestrator for user-requested browser tasks,
host-owned permission modes and planner effort controls, a local password
vault, and user-managed custom memory. HALO remains the execution and safety
authority. User intent is that credentials and custom memory are stored
locally. Custom memory is automatically included in every planner task
context; when a remote planner (including the existing Claude CLI bridge) is
selected, that context and memory are sent to its provider. Password-vault
values are never included in planner context, browser observations, journal
events, diagnostic logs, or custom memory.

## Sequential User Task Queue (Symphony-Inspired)

Use the orchestration pattern from OpenAI Symphony, not its coding-agent
runtime: Symphony polls issue trackers and runs coding agents in per-issue
workspaces, while HALO receives explicit user browser tasks and already owns
durable task state, browser isolation, approvals, and recovery. No Symphony
Elixir service, issue tracker, Codex app-server, Git workspace lifecycle hook,
or coding-agent filesystem capability is introduced.

TaskHost owns a durable FIFO queue. A newly submitted request is persisted as
a queued task; queued work does not construct a BrowserAdapter or planner until
the scheduler admits it. Sequential execution remains the default; the
scheduler must additionally support parallel work with a bounded active-task
limit. Parallel admission is resource-aware under the user's selected
1,000,000,000-byte hard cap: it requires a fresh (<=7.5s), fully measurable
aggregate process sample plus a conservative per-task reservation established
by a real Electron parallel benchmark. If the sample is stale, incomplete, or
the reservation is unknown, the scheduler queues rather than admits another
task. This reduces the chance of exceeding the cap but the 5-second process
sampling cadence cannot mathematically prevent instantaneous memory spikes;
that limitation must remain explicit. Queue order and active task identities
survive app restart and are reconciled against TaskStore checkpoints/journals
on startup. Active tasks resume only through existing explicit recovery paths;
`execution_uncertain` blocks that task from resuming.

The queue advances automatically only after a task reaches `completed` or
`stopped`. This is a closed allowlist: every other state, including current or
future paused/recovery reasons, blocks later tasks so FIFO order and user intent remain intact. The trusted
host API may explicitly skip a blocked task; skipping is durable and auditable
and never marks the task complete. Queue actions do not amend a task's immutable
original request. In sequential mode concurrency is fixed at one. Parallel
mode admits at most two active tasks only when a fresh (<=7.5s), fully
measurable process sample plus a benchmark-derived browser reserve and 125% of
the planner process-tree high-water remains strictly below the 1GB cap. If any
required measurement is missing, the queue remains sequential. The Electron
probe measures two complete visible+hidden browser surfaces, but excludes
planner and approver workers; a separately measured planner process-tree
high-water contributes to the admission reserve. Polling cannot guarantee a
hard instantaneous cap between samples.

Queue state is a separate, versioned local manifest written atomically with
strict file permissions and symlink refusal. Per-task GoalSpec, action journal,
approval decisions, and recovery semantics remain in TaskStore; queue state
only records ordered task IDs and ordering/skip events. TaskStore checkpoints
remain authoritative for whether a task is terminal or requires recovery; a
cached queue head may never override them. On startup, missing/corrupt task
references or disagreement between queue order and task checkpoints stop
dispatch and surface an error instead of silently dropping or reordering work.
Admission/advance is serialized by a single in-flight lock and must use the
existing `_trackAttachment`/`_attach()` lifecycle so `close()` drains it. A
queued task cannot be attached through `resumeSavedTask()` until it has been
admitted; recovery must preserve FIFO order. Durable skip and queue ordering
must share a crash-consistent write boundary, preferably a task-journal audit
event paired with the queue manifest transition, or a replayable append log.

## Permission Modes

Permission mode is a host setting and is never read from a page, planner
proposal, or task amendment. The host defaults to `browse` unless an explicit
local setting selects another mode.

| Mode | Browser actions | Approval behavior |
|---|---|---|
| `observe` | observe, scroll | Read-only; all other actions are denied before browser dispatch |
| `browse` | observe, scroll, navigate, follow_link | Existing independent approver remains in the path |
| `interact` | `browse` plus click and type | Click/type always enter the human approval queue even if the policy approver says allow; submit is denied |
| `full` | all supported page actions, including submit_form | Explicit host opt-in bypasses per-action review for supported actions |

`download` remains unsupported in every mode. Full mode does not bypass
Electron sandboxing, origin/protocol validation, popup/permission denial,
credential isolation, or navigation safety checks. Mode changes are made only
through a trusted host API and invalidate any queued approval before taking
effect. New installs default to `browse`; a persisted `full` mode is an
explicit user choice and is never inferred from task text.

## Browser Action Contract

Action targets remain host-assigned `elementId`s from the latest bounded
observation; arbitrary selectors, page-provided scripts, and model-supplied
URLs are rejected. `click` re-resolves the target in the current document and
only operates on an eligible visible interactive element. `type` re-resolves
the element and only accepts visible text/search/email/telephone/textarea
controls; password, file, hidden, and unsupported input types are rejected.
`submit_form` targets a current form's observed submit control and uses
`requestSubmit`, preserving browser validity checks. Every non-navigation
action requires a matching `documentEpoch`; stale actions fail closed.

`interact` actions are always queued for human approval. `full` skips the
approver only because the host explicitly selected that mode. Action payloads
and approval summaries must not log typed text; journal events retain action
type/status and bounded non-secret metadata only. A site can still inspect
values that are inserted into its own DOM; HALO cannot prevent the destination
site from reading a value after autofill or submission.

## Planner Effort

The local host setting has the provider-supported levels `low`, `medium`,
`high`, `xhigh`, and `max`, defaulting to `medium`. The Claude Code bridge maps
the validated host setting to the fixed `claude --effort <level>` argument.
The level is not accepted from page content or planner output. Other planner
providers receive a normalized context metadata value only if their adapter
explicitly supports it; unsupported providers ignore the setting rather than
receiving arbitrary CLI arguments. This changes inference effort, not policy
authority or action permissions.

## Local Password Vault

Vault data is encrypted at rest with Electron `safeStorage` (backed by the
operating-system credential store where supported), under a private app-data
directory and atomic file replacement. If `safeStorage` is unavailable or
reports insecure storage, vault writes and autofill fail closed; no plaintext
fallback is permitted. Records are keyed by a normalized HTTPS origin and
include username/password plus optional non-secret labels. Exact-origin match
is required; no suffix/wildcard matching. Vault APIs are main-process-only and
never expose password values to renderer, planner, journal, or logs. An
explicit trusted-host autofill request targets an observed form; no automatic
submit follows. User approval is required before filling. Credentials remain
exposed to the destination page's own JavaScript after insertion, which is an
unavoidable property of browser autofill and must be disclosed.

## Custom Memory

Memory entries are user-authored/edited/deleted records with bounded text,
optional exact-origin scope, and stable IDs. Storage is local, encrypted at
rest using the same fail-closed protection as the vault. Memory is included in
each newly built planner context, ordered deterministically and capped by a
fixed byte budget; overflow is reported rather than silently truncating in a
way that changes meaning. Memory remains data, never policy or authority.
Planner prompts identify it as user memory and still treat page-derived text
as untrusted. Since user requested automatic inclusion, memory is also sent to
the configured remote provider along with task context. Vault records and
secrets are structurally separate and cannot be queried through memory APIs.

## Backend Interfaces and Storage

- Add a `TaskQueue` coordinator inside `TaskHost` that persists
  enqueue, head activation, completion/stop advancement, explicit skip, and
  restart reconciliation; queue entries own only task IDs and state, never
  copied credentials or duplicate task prompts.
- Add a pure `permission-policy` module for enum validation and action/mode
  classification; inject the selected mode into `TaskHost` and
  `TaskController` from host configuration.
- Add trusted IPC/preload method surfaces for reading/updating the mode and
  effort and execution-mode settings, plus vault CRUD/autofill and
  custom-memory CRUD.
- Persist host settings and local records under the Electron app-data root;
  use strict schema/version validation, `0700` directories, `0600` files,
  atomic write+fsync+rename, and no symlink following.
- Keep settings UI out of this phase; the backend API will be ready for a
  later renderer task.

## Failure and Migration Behavior

Invalid setting values, malformed encrypted files, unsupported encryption,
origin mismatch, stale document epochs, and unknown actions fail closed with
stable error codes. Existing tasks retain current permission behavior by
loading the host default `browse`; no old task journal schema migration is
required. If decrypted vault/memory data cannot be validated, preserve the
file and refuse access rather than rewriting or discarding it.

## Tests

- Queue FIFO under concurrent submissions, zero browser/planner construction
  for queued tasks, bounded active-task admission, closed-allowlist
  blocked advancement, durable explicit skip, restart/reconciliation,
  fail-closed corrupt or missing task references, serialized advance, close
  during advance, rejection of unadmitted resume, parallel failure isolation,
  and memory-cap admission under missing/stale measurements.
- Permission-mode matrix for every action, including direct adapter bypass,
  forced human review for `interact`, and approver bypass only for explicit
  `full` mode.
- Click/type/submit validation with stale element/document, disallowed input
  types, malformed arguments, and prove no arbitrary script/selector path.
- Planner effort allowlist/default/invalid cases and exact CLI argument
  placement; no effort flag injection from context.
- Vault encryption round-trip using an injected cipher, fail-closed when
  unavailable, exact-origin isolation, no secret in IPC response/log/context,
  and autofill never submitting.
- Memory CRUD/scope/order/budget behavior, at-rest encryption, automatic
  context inclusion, and proof vault values cannot enter memory/context.
- Existing controller, store, IPC, provider, browser-adapter, and full app
  suites; local Electron smoke with fixture pages only.

## Explicit Non-Goals

No settings UI, password import/browser sync, automatic password capture,
automatic form submission after autofill, downloads, cookie extraction,
arbitrary DOM scripting, or external benchmark runs are included in this
backend phase.
