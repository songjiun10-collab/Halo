# Multi-Agent Background Browser Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent HALO task run a chosen number of isolated browser agents concurrently under a user-selectable memory policy, while a local macOS runtime continues after the UI detaches or quits.

**Architecture:** Add one host-owned child coordinator and one globally serialized resource-admission ledger; every child gets its own `TaskController`, nested `TaskStore`, planner worker, and `WebContentsView`. Move long-lived task ownership to a per-user LaunchAgent service, with the Electron UI attaching through authenticated local IPC. Child permissions remain observe/scroll-only, same-origin siblings serialize, and parent completion is based on parent-verified durable evidence.

**Tech Stack:** Electron 44.4.5, Node.js built-in `node:test`, Unix domain sockets, macOS per-user LaunchAgent, existing `TaskHost`/`TaskStore`/`TaskController`/`MemoryMonitor`, React renderer.

**Spec:** `docs/superpowers/specs/2026-09-28-multi-agent-background-runtime-design.md`

## Collaboration Boundary

- Claude owns the runtime/service side: Tasks 1-5, including main-process
  lifecycle, LaunchAgent, host IPC, and runtime/security integration tests.
- Codex owns the renderer side: Task 6, including preload-facing UI state and
  frontend controls, using the fixed contracts from Tasks 2-5.
- Codex owns the final end-to-end benchmark/report harness in Task 7 after the
  runtime contract is stable; Claude reviews the runtime/security evidence.
- No two contributors edit the same files concurrently. Changes to shared
  interfaces are agreed first; the integrator preserves unrelated dirty-tree
  changes and runs the full suite.

## Global Constraints

- One agent ID owns exactly one `WebContentsView`, `BrowserAdapter`, planner worker, journal, and lifecycle record.
- No two agents share a tab, view, controller, or mutable page context.
- Child policy is exactly `observe` and `scroll`; all other child browser actions are denied before dispatch.
- Concurrent siblings must have distinct normalized origins; same-origin assignments are queued/serialized.
- Child records stay under the parent namespace and remain absent from top-level queue/list/recovery APIs.
- The parent validates child journals/evidence itself; a child summary is never authority.
- Budgeted memory admission is the default and uses one serialized lease authority across top-level and child work.
- The user may explicitly disable HALO's admission ceiling and memory-pressure auto-pause behavior for a parent run after a warning; telemetry/warnings remain active and OS memory pressure is not prevented.
- A hidden/closed UI is a client detach, not task cancellation; only explicit stop/cancel stops accepted work.
- Service crash/reboot never automatically replays an action whose dispatch outcome may be uncertain.
- No remote service, privileged daemon, nested child agents, child write actions, or new model-provider dependency.
- Preserve unrelated existing modifications and untracked artifacts; do not commit or push as part of this plan without a separate explicit request.

## Review Focus

- Corrupt or missing parent/child journal links: `test/child-agent-coordinator.test.js` must prove the parent pauses and no child is reconstructed from a self-report.
- Parent goal amended while children are queued: `test/child-agent-coordinator.test.js` must prove stale goal-version assignments are rejected before browser/planner creation.
- Same-origin or origin-normalization edge cases (default ports, case, trailing dot, punycode): `test/child-agent-coordinator.test.js` must prove they serialize as one origin.
- Stale/incomplete memory sample versus concurrent top-level and child admission: `test/resource-admission.test.js` must prove there is no double admission and budgeted mode fails closed.
- UI disconnect/reconnect racing task submission or user override changes: `test/background-runtime-ipc.test.js` must prove reconnect is idempotent and does not duplicate work or implicitly change the recorded memory mode.

---

### Task 1: Confirm the macOS background-process launch path

**Files:**
- Create: `apps/computer-browser/integration/background-runtime-launchagent-smoke.js`
- Test: `apps/computer-browser/test/background-runtime-launchagent.test.js`
- Create: `apps/computer-browser/main/harness/launch-agent-manager.js`

**Interfaces:**
- Consumes: current Electron app entry `main/index.js`, current app-data path, and Node's `child_process`/filesystem APIs.
- Produces: a tested macOS LaunchAgent invocation contract: executable path, argument array, user LaunchAgent label, and clean bootout behavior. The smoke launches only a disposable Node fixture; real Electron service mode is tested in Task 7. No persistent LaunchAgent installation in unit tests.

- [ ] **Step 1: Write a failing launch-contract test** that constructs the service invocation from an injected app path and asserts a stable per-user label, exact executable/arguments, no shell string, and no inherited UI-only task arguments.
- [ ] **Step 2: Run the test to verify it fails** with the launch contract unavailable.

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='LaunchAgent invocation'`

  Expected: FAIL because the service invocation resolver does not exist.
- [ ] **Step 3: Add `resolveBackgroundServiceInvocation({ executablePath, appPath, userId })`** in a small `main/harness/launch-agent-manager.js` module; do not install a LaunchAgent from this resolver.
- [ ] **Step 4: Add an opt-in macOS smoke script** that bootstraps a uniquely named LaunchAgent running a disposable Node fixture, confirms its ready marker/process identity, then boots it out and removes only its uniquely created plist/temporary directory.
- [ ] **Step 5: Run the unit test and macOS fixture smoke**; if launchd cannot start/stop the fixture under the user's LaunchAgent domain, stop before implementing service persistence and revise the spec/plan.

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='LaunchAgent invocation'`

  Run: `node apps/computer-browser/integration/background-runtime-launchagent-smoke.js`

  Expected: unit test PASS; on macOS, launchd starts the fixture, it reports ready, and bootout stops it cleanly. Smoke is not run on non-macOS CI.

### Task 2: Add one serialized resource-admission authority

**Files:**
- Create: `apps/computer-browser/main/harness/resource-admission.js`
- Modify: `apps/computer-browser/main/harness/memory-monitor.js`
- Modify: `apps/computer-browser/main/harness/host-settings.js`
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Test: `apps/computer-browser/test/resource-admission.test.js`
- Test: `apps/computer-browser/test/memory-monitor.test.js`
- Test: `apps/computer-browser/test/host-settings.test.js`
- Test: `apps/computer-browser/test/task-host.test.js`

**Interfaces:**
- Consumes: `MemoryMonitor.sample()`/`canAdmitTask()` and existing host settings.
- Produces: `ResourceAdmission.acquire({ ownerId, reserveBytes, maxAgeMs, parentPolicy }) -> Promise<{ admitted:true, leaseId, ownerId, reservedBytes } | { admitted:false, reason }>`; `.release(leaseId) -> Promise<void>`; `.getSnapshot() -> { mode, leases, sampledAt }`. `parentPolicy` is immutable `{ mode, parentTaskId, requestedAgentCount }`; settings add `memoryPolicy: "budgeted" | "user_override"`, default `budgeted`.

- [ ] **Step 1: Write failing tests** for serialized simultaneous acquire calls, lease idempotency/rejection on duplicate owner, release after teardown failure, stale/incomplete sample denial, and override admission with telemetry retained and both admission/pause gates bypassed only for a parent policy snapshot. Add a host-settings update test proving `memoryPolicy` changes are recorded with trusted actor/time before they become the default for new runs.
- [ ] **Step 2: Run the focused tests to verify they fail.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='resource admission|memory policy'`

  Expected: FAIL because `ResourceAdmission` and `memoryPolicy` do not exist.
- [ ] **Step 3: Implement `ResourceAdmission`** with one promise-serialized ledger covering every top-level task and child; reserve capacity before any browser/planner construction and release only after resource teardown. Budgeted acquisition requires a fresh complete sample and measured reserve; `parentPolicy.mode === "user_override"` bypasses admission denial, but not lease tracking or process monitoring.
- [ ] **Step 4: Extend `HostSettingsStore` schema to version 2** with `memoryPolicy`, validating exact fields and preserving fail-closed corrupt/unknown-field behavior. Migration from version 1 must add `memoryPolicy:"budgeted"` atomically without changing other settings. Have trusted `TaskHost.updateHostSettings()` append a durable audit record containing event ID, actor, timestamp, and selected mode; existing active parent runs retain their captured setting.
- [ ] **Step 5: Wire top-level `TaskHost` admission through the shared ledger** without changing FIFO ordering. Keep the selected override durable/auditable; never derive it from task text.
- [ ] **Step 6: Run focused tests and existing queue/memory/settings tests.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='resource admission|memory policy|TaskQueue|MemoryMonitor|HostSettings'`

  Expected: PASS; two concurrent admission callers cannot spend the same sampled headroom twice; unknown/stale measurements deny only in budgeted mode.

### Task 3: Add child journal roots and host-owned child plan records

**Files:**
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Modify: `apps/computer-browser/shared/harness-contracts.js`
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/main/harness/planner-stdio.js`
- Create: `apps/computer-browser/main/harness/child-agent-coordinator.js`
- Test: `apps/computer-browser/test/planner-stdio.test.js`
- Test: `apps/computer-browser/test/task-store.test.js`
- Create: `apps/computer-browser/test/child-agent-coordinator.test.js`
- Test: `apps/computer-browser/test/task-host.test.js`

**Interfaces:**
- Consumes: `TaskStore` immutable goals/events/checkpoints, `TaskHost` lazy attachment, and `ResourceAdmission` from Task 2.
- Produces: a `PlannerProposal` discriminated union with existing `{ kind:"actions", actions }` and parent-only `{ kind:"child_plan", parentGoalVersion, requestedAgentCount, assignments:[{ subgoal, entryUrl }] }`; `ChildAgentCoordinator.acceptParentPlan(parentTaskId, proposal) -> { planId, childIds, state }`; `.listChildren(parentTaskId) -> safe summaries`; `.cancelPlan(parentTaskId, reason) -> durable result`; `TaskHost.listChildren(parentTaskId)` delegates to the coordinator.

- [ ] **Step 1: Write failing tests** for the planner union (including rejecting `child_plan` from child planners and rejecting mixed child-plan/action turns), nested child storage, child IDs absent from top-level scans/list/queue/resume, strict parent/goal-version linkage, invalid count/entry-URL rejection, same-origin serialization, distinct-origin concurrency eligibility, and no eager child browser/planner construction.
- [ ] **Step 2: Run the tests to verify they fail.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='child plan|child store|child list'`

  Expected: FAIL because child-plan APIs and records do not exist.
- [ ] **Step 3: Add a child-store factory** that creates each child's TaskStore under `<parent task directory>/children/<childId>` while retaining existing UUID validation, lock semantics, private permissions, and symlink refusal.
- [ ] **Step 4: Implement `ChildAgentCoordinator.acceptParentPlan()`**: parent planner supplies a positive requested count equal to assignments length; each assignment has a bounded subgoal and exact HTTP(S) `entryUrl`; derive the normalized origin from that URL; parent goal version must still match; same-origin siblings remain queued behind one another. Each child receives its own UUID GoalSpec at version 1 whose original request is the bounded subgoal; parent ID/version are recorded as host-authored child-link journal metadata, not accepted from planner output.
- [ ] **Step 5: Persist parent-child links, captured memory policy, parent-proposed count, actor `parent_agent`, timestamp, and lifecycle events** in the parent journal before any worker/view is constructed. For `user_override`, link the parent run record to the trusted user settings-audit event that confirmed it. Freeze the policy snapshot for the parent run. Keep child records out of top-level APIs and reject public `resumeSavedTask(childId)`.
- [ ] **Step 6: Run focused child-store/coordinator/TaskHost tests.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='child plan|child store|child list|TaskHost'`

  Expected: PASS; corrupt or stale parent/child references block dispatch and do not silently drop or recreate children.

### Task 4: Enforce one-agent/one-view, read-only child policy, and evidence fan-in

**Files:**
- Modify: `apps/computer-browser/main/harness/child-agent-coordinator.js`
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/browser-adapter.js`
- Modify: `apps/computer-browser/main/harness/agent-viewport-host.js`
- Modify: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/agent-viewport-host.test.js`
- Test: `apps/computer-browser/test/browser-adapter.test.js`
- Test: `apps/computer-browser/test/task-controller.test.js`
- Test: `apps/computer-browser/test/child-agent-coordinator.test.js`

**Interfaces:**
- Consumes: validated child assignments and admitted resource leases.
- Produces: `TaskController` accepts `onChildPlan(proposal) -> Promise<verifiedChildEvidence>` only for parent controllers; child controllers reject delegation. `ChildAgentCoordinator.startChild(childId)` and `.verifyChildResult(parentTaskId, childId)` are host-owned. Each child attachment receives literal `permissionMode:"observe"`; its browser factory constructs a unique view/adapter using child ID and the parent's host-selected session partition.

- [x] **Step 1: Write failing tests** that count view/adapter/planner instances per agent, attempt all disallowed actions through both controller and direct adapter calls after bootstrap, try to share a view ID, verify unique views use the parent session partition, reject redirects outside the assigned origin, and submit a fabricated child summary without durable evidence.
- [x] **Step 2: Run the tests to verify they fail.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='one view per child|child read only|child evidence'`

  Expected: FAIL because child execution/policy/fan-in paths do not exist.
- [x] **Step 3: Start child controllers only after resource lease acquisition**; create each unique BrowserAdapter/WebContentsView with the parent's session partition, perform one trusted initial navigation to its assigned `entryUrl`, block `will-redirect` outside its normalized origin, and only then start its planner. Assert no two live agents map to one `webContents.id`.
- [x] **Step 4: Enforce `observe`/`scroll` after bootstrap at both TaskController and BrowserAdapter** so a malicious planner or direct host bug cannot dispatch navigation, click, type, submit, autofill, or download for a child. Pass the host-captured parent memory policy to child controllers; only `user_override` bypasses HALO's automatic memory-pressure pause path, while monitoring events continue to be recorded.
- [x] **Step 5: Implement parent evidence verification** by reading the child store's durable event/evidence references, validating parent goal version and terminal checkpoint, and appending a parent synthesis event only after validation.
- [x] **Step 6: Test child cancellation/drain and resource release** for completion, failure, renderer crash, and controller teardown error.
- [x] **Step 7: Run focused browser/controller/coordinator suites.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='one view per child|child read only|child evidence|BrowserAdapter|TaskController'`

  Expected: PASS; no cross-agent view reuse, no disallowed browser dispatch, and a self-report cannot complete the parent.

  **Result:** PASS (41/41 matched tests). Full regression: `npm --prefix apps/computer-browser test` → 470/470 passing (462 baseline + 8 new: 6 in `child-agent-coordinator.test.js` covering per-child view/adapter/planner uniqueness, read-only enforcement, evidence fan-in fabrication/no-checkpoint/genuine-acceptance rejection, and cancel-drain origin-serialization; 2 in `task-controller.test.js` covering the `onChildPlan` hook's parent-only delegation and its structural absence for any controller not wired with one). Two real production bugs were found and fixed while writing these tests: `ChildAgentCoordinator._attachChild()` called `controller.start()` on a store that `TaskStore.loadChild()` always reloads as `"recovered"` (never `"idle"`), which would have made every child fail to start; and `TaskStore.readEvents()` silently ignored its `parentTaskId` option, which would have made `verifyChildResult()`'s evidence cross-check against a child's own journal never actually read anything. Both are fixed in `child-agent-coordinator.js` and `task-store.js` respectively.

### Task 5: Extract a service-owned runtime lifecycle

**Files:**
- Create: `apps/computer-browser/main/harness/background-runtime-service.js`
- Create: `apps/computer-browser/main/harness/background-runtime-ipc.js`
- Create: `apps/computer-browser/main/harness/background-runtime-client.js`
- Modify: `apps/computer-browser/main/harness/launch-agent-manager.js`
- Modify: `apps/computer-browser/main/index.js`
- Modify: `apps/computer-browser/main/ipc.js`
- Modify: `apps/computer-browser/preload/index.js`
- Create: `apps/computer-browser/test/background-runtime-ipc.test.js`
- Create: `apps/computer-browser/test/background-runtime-service.test.js`
- Test: `apps/computer-browser/test/trusted-sender.test.js`

**Interfaces:**
- Consumes: configured `TaskHost`, `ChildAgentCoordinator`, `MemoryMonitor`, storage root, and approver client.
- Produces: internal service methods `start()`, `attachClient()`, `detachClient(clientId)`, `acceptParentPlan(parentTaskId, proposal)`, `listChildren(parentTaskId)`, `setMemoryPolicy(choice)`, `stopTask(taskId, reason)`, `stopService(reason)`, `getSnapshot()`, and `onEvent(listener)`. `acceptParentPlan` is callable only from the parent TaskController in the service process and is never an IPC/preload method. UI IPC uses 4-byte big-endian length-prefixed JSON capped at 65,536 bytes and exposes only its fixed allowlist; it must not expose raw socket path selection, shell, filesystem, partition selection, or arbitrary method names to the renderer.

- [ ] **Step 1: Write failing service tests** for hidden service startup, attach/detach without task shutdown, explicit stop semantics, duplicate attach idempotency, service stop draining, and task state reconstruction from durable stores.
- [ ] **Step 2: Write failing IPC tests** for private endpoint permissions, symlink rejection, invalid/missing capability, oversized/malformed frame rejection, and renderer/page inability to choose paths or invoke unlisted operations.
- [ ] **Step 3: Run tests to verify they fail.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='background runtime|service IPC'`

  Expected: FAIL because no runtime service/client exists.
- [ ] **Step 4: Implement the service/client transport** over a private Unix domain socket under a 0700 user-data directory, with 0600 socket/capability files, strict message schemas, 4-byte big-endian JSON frames capped at 65,536 bytes, peer-UID validation, and no symlink-following path setup. Keep the random capability in trusted main-process memory and require it during client attach.
- [ ] **Step 5: Split `main/index.js` startup into UI-client and `--halo-background-service` modes.** In service mode hide the Dock icon, create no user-facing window, own TaskHost/ChildAgentCoordinator/MemoryMonitor/approver resources, and keep only the hidden browser container windows required by WebContentsView.
- [ ] **Step 6: Add LaunchAgent install/start/stop/update/remove operations** behind trusted main-process controls; generated plist must use argument arrays, a stable app-bundle/executable path, a validated user-specific label, and explicit user action. Unit tests use temporary paths and never touch a real user's LaunchAgents directory.
- [ ] **Step 7: Make normal UI window close detach only; make app Quit present an explicit detach-and-continue versus stop choice.** A service-start failure must never be presented as continued background execution.
- [ ] **Step 8: Run service, IPC, trusted-sender, and app startup/shutdown tests.**

  Run: `npm --prefix apps/computer-browser test -- --test-name-pattern='background runtime|service IPC|trusted sender'`

  Expected: PASS; detaching UI leaves the service/task alive, while explicit task/service stop drains and releases resources.

### Task 6: Add renderer controls for child plans and background service

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/session/session.ts`
- Modify: `frontend/src/session/api.ts`
- Create: `frontend/src/session/background-runtime.ts`
- Create: `frontend/src/session/child-agents.ts`
- Modify: `frontend/src/components/HaloChat.tsx`
- Modify: `frontend/src/components/HaloSheet.tsx`
- Modify: `frontend/src/components/Toolbar.tsx`
- Modify: `frontend/src/styles/app.css`
- Test: `frontend/test/session.test.mjs`
- Create: `frontend/test/background-runtime.test.mjs`
- Create: `frontend/test/child-agents.test.mjs`

**Interfaces:**
- Consumes: typed service snapshots/events, child summaries, host setting `memoryPolicy`, and the allowlisted preload APIs implemented in Task 5.
- Produces: UI actions to explicitly select the default budgeted/user-override policy with a warning confirmation, inspect parent-proposed/active child counts and per-child status/evidence, detach/reconnect, explicitly stop a task/service, and choose a recovery action. UI never creates processes or browser views directly and does not choose the child count.

- [ ] **Step 1: Add failing renderer/session tests** for override warning/confirmation, service disconnected/running/waiting states, attach idempotency, per-agent status list/count, and explicit stop versus detach semantics. The UI must not submit or edit `requestedAgentCount`.
- [ ] **Step 2: Run tests to verify they fail.**

  Run: `npm --prefix frontend test -- --test-name-pattern='background runtime|child agents'`

  Expected: FAIL because the renderer contract and controls do not exist.
- [ ] **Step 3: Add TypeScript declarations** in `frontend/src/session/api.ts` for the allowlisted preload methods implemented in Task 5; do not change preload or main IPC files in this task.
- [ ] **Step 4: Add renderer session state and UI** displaying parent-proposed and active child counts, one status row per agent, current service connection state, and evidence/recovery summaries. The `user_override` warning must say that HALO admission and automatic memory-pressure pauses are disabled for that parent run, while monitoring remains active and OS memory pressure may terminate the app. Require a separate confirmation; do not present override as a performance recommendation. The UI may change the default memory policy but may not set the parent's agent count.
- [ ] **Step 5: Run targeted renderer tests and `npm --prefix frontend run build`.**

  Expected: PASS; reconnect does not resubmit requests and no secret/capability is included in UI state.

### Task 7: Verify service persistence, concurrency, memory modes, and recovery end to end

**Files:**
- Create: `apps/computer-browser/integration/multi-agent-background-electron.js`
- Create: `apps/computer-browser/integration/multi-agent-background-memory.js`
- Create: `apps/computer-browser/test/multi-agent-background-integration.test.js`
- Create: `docs/superpowers/reports/2026-09-28-multi-agent-background-benchmark.md`

**Interfaces:**
- Consumes: full service, child, admission, IPC, and renderer APIs from Tasks 1-6.
- Produces: repeatable local evidence for one, two, and higher-count child runs; real macOS UI detach/quit/reconnect; crash/recovery behavior; process-tree measurement coverage; and a benchmark-derived documented maximum accepted count.

- [ ] **Step 1: Add a local fixture journey** with at least three distinct origins and repeated same-origin assignments; assert each child has a unique view ID, journals are nested, distinct origins overlap in time, same-origin tasks do not, and the parent verifies all results.
- [ ] **Step 2: Measure real Electron plus planner process-tree memory** at requested counts 1, 2, 4, and 8 under budgeted mode. Record p50/p95 startup and observation latency, aggregate sampled RSS peak, sample cadence, unmeasurable processes, renderer count, and teardown results.
- [ ] **Step 3: Choose and encode the maximum accepted requested count** from the real test results, including a higher explicit user override run. Never describe sampled RSS as a hard instantaneous memory bound.
- [ ] **Step 4: Add restart probes** for clean queued children, terminal children, corrupt child journal, missing view identity, safe pre-dispatch crash, and crash after dispatch-start; assert no uncertain action is automatically repeated.
- [ ] **Step 5: Run the disposable macOS LaunchAgent journey**: start service, submit parent with multiple agents, hide and quit UI, reconnect, inspect progress, explicitly stop, and verify plist/socket/process cleanup. Do not run this test against a persistent production label.
- [ ] **Step 6: Write the measured results** to the benchmark report, including the chosen accepted-count maximum and why. If evidence requires a change to an approved safety invariant, stop and request review of a spec amendment before continuing.
- [ ] **Step 7: Run full regression suite and static checks.**

  Run: `npm --prefix apps/computer-browser test`

  Run: `npm --prefix frontend test`

  Run: `npm --prefix frontend run build`

  Run: `git diff --check`

  Expected: all suites pass; integration report clearly distinguishes unit tests, real Electron results, macOS service coverage, and any environment-dependent cases not run.

### Task 8: Security and integration review

**Files:**
- Review: all files changed by Tasks 1-7
- Test: all focused and full suites from Task 7

**Interfaces:**
- Consumes: completed implementation and benchmark evidence.
- Produces: review findings for authorization boundaries, process/socket lifecycle, stale approval invalidation, evidence verification, user override auditability, and dirty-worktree scope; fixes only validated in-scope defects.

- [ ] **Step 1: Review every service IPC method and browser action boundary** for renderer/page-controlled paths, identifiers, capabilities, origin, policy mode, and resource count.
- [ ] **Step 2: Re-run adversarial tests** for shared view attempts, stale parent goal versions, origin normalization, symlink replacement, duplicate IPC attach, memory-lease races, and service crash after dispatch-start.
- [ ] **Step 3: Confirm all unrelated pre-existing modified/untracked files are preserved** and list the final changed paths without staging or committing them.
- [ ] **Step 4: Report implemented behavior, exact test commands/results, memory measurements, macOS-only gaps, and remaining explicit limitations.**
