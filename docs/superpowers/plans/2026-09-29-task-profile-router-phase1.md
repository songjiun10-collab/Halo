# HALO Task Profile Contract and Router — Phase 1 Implementation Plan

> **For the implementation session:** After this plan is approved, use either `superpowers:subagent-driven-development` or `superpowers:executing-plans`, according to the user's chosen execution method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve and durably bind one host-owned duration/capability profile to every newly-created executable task before it enters the queue or constructs browser/planner resources.

**Architecture:** A pure deterministic router consumes the raw user request, trusted selectors, and validated typed-entry metadata. TaskStore persists the validated result immediately after `goal_created` and replays it as authoritative; TaskHost, routines, scheduled runs, and child admission all consume that same record. Existing policy, approval, evidence, provenance, resource-admission, and child permission boundaries remain authoritative.

**Tech Stack:** Node.js CommonJS, Electron main process, `node:test`, existing TaskHost/TaskStore/TaskController/ChildAgentCoordinator.

**Spec:** `docs/superpowers/specs/2026-09-29-task-profile-router-design.md`

## Global Constraints

- Canonical wire IDs are lowercase: `short`, `middle`, `long`, `routine`, `browser`, `research`, `computer_use`, and `multi_agent`.
- The v1 router is deterministic and performs no model or network call.
- Resolve from host-trusted request data before queue admission; never accept profile selectors from page content, planner proposals, or child assignments.
- Persist exactly one validated profile before any browser/planner construction; a profile write/replay failure is fail-closed.
- Profiles select execution/capability adapters only; they never elevate permissions, bypass approval, grant credentials, or self-verify evidence.
- Research and Computer-use remain explicitly unavailable in this phase; never silently route either to Browser.
- Multi-agent remains an orchestration capability; children are separately profiled Browser tasks, cannot nest, and cannot select a longer horizon than their parent.
- Historical journal records without the new profile-required marker retain their documented legacy mapping and existing evidence/journal bytes are not rewritten.
- Preserve unrelated working-tree changes; all tests use disposable task stores and local fixtures.

## Review Focus

- Two explicit duration/capability selectors that conflict must fail before creating a task directory or resources; test in `test/task-profile-router.test.js` and `test/task-host.test.js`.
- Overlapping English/Korean intent phrases must request clarification instead of selecting a broader capability; test in `test/task-profile-router.test.js`.
- Crash or write failure after marked `goal_created` but before `task_profile_selected` must make that task unrecoverable for execution, never classify it as legacy; test in `test/task-store.test.js`.
- A child plan from a parent without resolved `multi_agent`, or bound to a stale parent goal version, must create no child resources; test in `test/child-agent-coordinator.test.js` and `test/task-controller.test.js`.
- Pre-profile root and child stores must retain their legacy mapping after recovery without new permission or capability; test in `test/task-store.test.js` and `test/task-host.test.js`.

---

### Task 1: Strict profile contracts and versioned capability registry

**Files:**
- Create: `apps/computer-browser/shared/task-profile-contracts.js`
- Create: `apps/computer-browser/shared/capability-registry.js`
- Modify: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/task-profile-contracts.test.js`
- Test: `apps/computer-browser/test/capability-registry.test.js`
- Test: `apps/computer-browser/test/harness-contracts.test.js`

**Interfaces:**
- Consumes: `validateHarnessProfile()` from `shared/harness-profile.js`; existing journal envelope and GoalSpec limits from `shared/harness-contracts.js`.
- Produces: `validateResolvedTaskProfile(value)`, `validateTaskProfileSelectedPayload(value)`, `validateProfileRequiredGoalCreatedPayload(value)`, `CAPABILITY_IDS`, `CAPABILITY_REGISTRY_VERSION`, and `getCapabilityProfile(id)`.
- Capability records expose `{id, available, dependencies, adapters}`; adapter records are `{capabilityId, adapterId, adapterVersion}` sorted by capability ID then adapter ID.
- Register `routine` (`routine-runner`, version `1`), `browser` (`planner-browser`, version `1`), and `multi_agent` (`child-agent-coordinator`, version `1`) as available; register `research` and `computer_use` as unavailable with stable reason codes.

- [ ] **Step 1: Write failing strict-contract tests**

Test exact accepted duration/capability/source enums, sorted adapter/dependency lists, required profile fields, optional child `parentBinding`, effective-limit bounds, unknown-field rejection, and invalid/mismatched child binding shape.

- [ ] **Step 2: Run tests and verify the new contract exports are missing**

Run: `node --test test/task-profile-contracts.test.js test/capability-registry.test.js`
Expected: FAIL because the contract and registry modules do not yet exist.

- [ ] **Step 3: Implement pure profile contracts and registry**

Use the existing `short|middle|long` validator rather than defining a second duration enum. Keep registry data static and closed; unavailable capabilities must return stable `capability_unavailable` metadata and must not resolve to another adapter.

- [ ] **Step 4: Add the typed journal event**

Add `task_profile_selected` to `EVENT_TYPES`; validate its exact payload through `validateTaskProfileSelectedPayload()`. Extend `goal_created` payload validation with optional `profileRequired: true` while preserving historical `{goalVersion}` payloads.

- [ ] **Step 5: Run focused contract tests**

Run: `node --test test/task-profile-contracts.test.js test/capability-registry.test.js test/harness-contracts.test.js`
Expected: PASS, including old journal fixtures.

### Task 2: Deterministic pure classifier/router

**Files:**
- Create: `apps/computer-browser/shared/task-profile-router.js`
- Test: `apps/computer-browser/test/task-profile-router.test.js`

**Interfaces:**
- Consumes: profile contracts and the static capability registry from Task 1.
- Produces: `resolveTaskProfile({goalInput, requestedDurationProfile = "auto", requestedCapabilityProfile = null, routineMetadata = null, parentProfile = null, parentBinding = null}) -> ResolvedTaskProfile` and `TaskProfileRouterError(code, message)`. Child binding is a separate host-authored input because a parent profile alone cannot identify the coordinator-minted plan ID or pinned parent goal version.
- The resolver has no filesystem, Electron, settings, browser, queue, model, or network dependencies. Its output contains `schemaVersion`, `classifierVersion`, duration ID/version/policy-set ID, capability dependency closure and sorted adapters, per-axis source/rule attribution, and optional parent binding.
- Use `task-profile-router-v1` as the initial classifier version. Use exact versioned phrases and precedence from the approved spec; `auto` is not an explicit profile choice.

- [ ] **Step 1: Write failing precedence and classification tests**

Cover explicit trusted choices, typed routine entry, exact English/Korean phrases, Unicode normalization, default Browser+Middle, unavailable Research/Computer-use, ambiguous overlaps, contradictory selectors, malformed selector values, child Browser pinning, and parent-horizon restriction.

- [ ] **Step 2: Run tests and verify resolver is absent**

Run: `node --test test/task-profile-router.test.js`
Expected: FAIL because `task-profile-router.js` does not exist.

- [ ] **Step 3: Implement phrase normalization and rule matching**

Apply Unicode normalization and case-folding once. Match English whole words and Korean normalized phrases exactly as listed in the spec. Return a clarification error when multiple capability groups or both Short and Long hint groups match.

- [ ] **Step 4: Implement independent-axis precedence and adapter-closure resolution**

Apply malformed/conflicting selector validation first. Resolve capability in this order: validated routine entrypoint → explicit trusted capability → one unambiguous capability-intent rule → Browser default. Resolve duration separately: explicit trusted duration wins (including for a bounded routine) → validated routine horizon policy or one unambiguous duration-hint group → Middle default. Thus a typed routine selects Routine capability but does not force Short when the user explicitly selected another horizon. A generic task cannot select Routine without the typed, host-validated routine reference. Apply the parent horizon restriction only to child duration; child capability is fixed to Browser by host policy.

- [ ] **Step 5: Run router tests and verify deterministic output**

Run: `node --test test/task-profile-router.test.js test/capability-registry.test.js`
Expected: PASS; identical normalized inputs produce deep-equal profiles and stable rule IDs.

### Task 3: Durable initial profile record and fail-closed replay

**Files:**
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Modify: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/task-store.test.js`

**Interfaces:**
- Consumes: `ResolvedTaskProfile` and validators from Tasks 1–2.
- Produces: `TaskStore.create(goalInput, {storageRoot, resolvedProfile})`, `TaskStore.createChild(goalInput, {storageRoot, parentTaskId, childId, resolvedProfile})`, and `store.taskProfile` for profile-required stores.
- `resolvedProfile` is host-created. `TaskStore` copies `maxActions`, `maxPlannerCalls`, and `maxActiveMs` from its own normalized GoalSpec into the persisted profile event; callers cannot override those effective values.

- [ ] **Step 1: Write failing creation and replay tests**

Assert that a new profile-required store writes `goal_created(profileRequired: true)` followed immediately by exactly one durable `task_profile_selected`, returns that validated profile, and replays the same profile. Cover root and child stores, missing event, duplicate event, wrong event order, corrupt adapter version, mismatched task/goal binding, and legacy journal without the marker.

- [ ] **Step 2: Run focused tests and verify the new paths fail**

Run: `node --test test/task-store.test.js`
Expected: FAIL on profile event creation/replay assertions while legacy tests remain meaningful.

- [ ] **Step 3: Persist the profile in the shared create path**

Extend `createStoreInDir()` to receive the validated profile, normalize GoalSpec once, append marked `goal_created`, then append `task_profile_selected` with the exact normalized limits before returning the store. Route both root and child creation through this path.

- [ ] **Step 4: Enforce event order in replay**

Extend `streamJournalReplay()`/`loadStoreFromDir()` to accept exactly one immediate profile event for marked records, reject missing/duplicate/malformed records with a stable storage/profile error, expose the validated profile on loaded stores, and leave unmarked historical journals on the legacy path.

- [ ] **Step 5: Test write failure and partial creation recovery**

Inject an append/fsync failure after marked `goal_created`; verify creation rejects and reopening cannot load the record as a runnable legacy task. Verify existing journal fixtures still replay byte-for-byte without migration writes.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/task-store.test.js`
Expected: PASS, including all prior TaskStore tests.

### Task 4: TaskHost routing for user, routine, and scheduled tasks

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `apps/computer-browser/main/ipc.js` only if passing the optional trusted profile selection requires an argument-forwarding change
- Modify: `apps/computer-browser/preload/index.js` only if the call surface must explicitly expose the optional argument
- Test: `apps/computer-browser/test/task-host.test.js`
- Test: `apps/computer-browser/test/harness-ipc.test.js`
- Test: `apps/computer-browser/test/scheduler.test.js`

**Interfaces:**
- Consumes: `resolveTaskProfile()`, profile-aware TaskStore creation, and the existing TaskHost factories.
- Produces: additive `TaskHost.createTask(goalInput, {requestedDurationProfile, requestedCapabilityProfile} = {})`; existing one-argument callers remain valid. Generic `createTask()` cannot claim Routine; only `runRoutine(routineId, revision, {trigger, requestedDurationProfile = "auto"} = {})` can supply its host-validated pinned routine metadata. `getTaskDetail()` adds `taskProfile` while retaining `harnessProfile` for existing consumers.
- `_attach(store, routine, taskProfile)` must consume a validated stored profile; it must not select a profile after browser/planner construction.

- [ ] **Step 1: Write failing ordering and routing tests**

Use recording `makeBrowser`/`makePlanner` factories. Assert classifier runs before TaskStore creation, profile is durable before queue admission, and profile selection is complete before either factory runs. Cover default Browser+Middle, explicit selectors, typed Routine, unavailable capability, and legacy recovery mapping.

- [ ] **Step 2: Run TaskHost tests and verify the ordering assertions fail**

Run: `node --test test/task-host.test.js test/harness-ipc.test.js`
Expected: FAIL because TaskHost does not yet resolve or expose a full profile.

- [ ] **Step 3: Route new top-level tasks before storage/resource creation**

Resolve from untouched `goalInput.originalRequest` and separate trusted selector options, pass the profile to `TaskStore.create()`, and ensure any selector or persistence error occurs before queue insertion and resource construction.

- [ ] **Step 4: Route routine and scheduled occurrences through the same resolver**

Extend `runRoutine(routineId, revision, {trigger, requestedDurationProfile = "auto"} = {})`; validate/pin the immutable routine revision before routing; select capability `routine`; let an explicit trusted horizon override the routine's inferred horizon. Keep scheduler trigger fields as idempotency/audit metadata only; scheduled execution must continue through `runRoutine()` and must not forward a profile selector from schedule data.

- [ ] **Step 5: Load profile before constructing resources on attach/recovery**

Pass the store's validated `taskProfile.duration.id` to TaskController as `harnessProfile`, select only adapters recorded in the profile, preserve the legacy mapping for old unmarked records, and include `taskProfile` in active and inactive task detail responses.

- [ ] **Step 6: Verify trusted IPC propagation and run focused suites**

Assert `halo:createTask` forwards the optional selector only for `isTrustedSender`; untrusted senders remain rejected. Run:
`node --test test/task-host.test.js test/harness-ipc.test.js test/scheduler.test.js test/task-store.test.js`
Expected: PASS, including no resource creation on routing/persistence errors.

### Task 5: Multi-agent parent gate and independently profiled children

**Files:**
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/child-agent-coordinator.js`
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Test: `apps/computer-browser/test/task-controller.test.js`
- Test: `apps/computer-browser/test/child-agent-coordinator.test.js`

**Interfaces:**
- Consumes: parent `store.taskProfile`, `resolveTaskProfile()`, `TaskStore.createChild()`, and the existing host-authored `child_plan_accepted` record.
- Produces: child store profile with `{parentTaskId, planId, parentGoalVersion}` binding; child capability is host-fixed `browser`; child duration is host-selected and cannot exceed the parent's horizon.

- [ ] **Step 1: Write failing parent authorization and child binding tests**

Assert non-Multi-agent parent `child_plan` is rejected before child store creation; Multi-agent parent accepts only validated assignments; assignment-supplied profile fields are rejected; child profiles bind the minted plan and parent goal version; stale/corrupt/missing binding constructs no browser or planner.

- [ ] **Step 2: Run focused tests and verify the security assertions fail**

Run: `node --test test/task-controller.test.js test/child-agent-coordinator.test.js`
Expected: FAIL because child-plan admission is not currently profile-gated and child stores have no profile binding.

- [ ] **Step 3: Gate `child_plan` on the parent's durable Multi-agent capability**

Reject before `acceptParentPlan()` creates child stores unless the parent's validated profile is `multi_agent`; keep ResourceAdmission and same-origin serialization as separate gates.

- [ ] **Step 4: Resolve/persist every child profile before parent plan acceptance**

For each planner-authored assignment, fix capability to `browser`, derive parent binding from host-minted IDs/version, resolve duration with the parent horizon as an upper bound, and persist the profile through `TaskStore.createChild()`. If any child profile or the parent journal append fails, execute existing full child-directory rollback.

- [ ] **Step 5: Validate the child profile before resource construction**

In `_attachChild()`, load/replay and match `parentBinding` against the host-authored parent plan before `_makeChildBrowser`, `userNavigate`, or `_makePlanner`. Pass the stored duration profile to TaskController while preserving literal child permission mode `observe` and the existing origin/action restrictions.

- [ ] **Step 6: Run child, controller, and TaskHost regression tests**

Run: `node --test test/task-controller.test.js test/child-agent-coordinator.test.js test/task-host.test.js test/task-store.test.js`
Expected: PASS; current supported child workflows remain intact only for explicitly routed Multi-agent parents.

### Task 6: Full Phase 1 verification and handoff evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-task-profile-router-design.md` only if implementation evidence changes an availability claim
- Modify: `apps/computer-browser/integration/README.routine-vs-planner-benchmark.md` only to record measured classifier overhead
- Modify: `apps/computer-browser/integration/routine-vs-planner-benchmark.js` to time one real resolver call per benchmark iteration and pass its result into TaskStore
- Test: full `apps/computer-browser` suite

**Interfaces:**
- Consumes: all contracts and routes from Tasks 1–5.
- Produces: verified Phase 1 evidence: exact task-profile event/replay behavior, no extra model round trip, root/routine/scheduled/child route coverage, and explicit unavailability for Research/Computer-use.

- [ ] **Step 1: Run focused router, TaskStore, TaskHost, coordinator, and IPC tests**

Run from `apps/computer-browser`:
`node --test test/task-profile-contracts.test.js test/capability-registry.test.js test/task-profile-router.test.js test/task-store.test.js test/task-host.test.js test/task-controller.test.js test/child-agent-coordinator.test.js test/harness-ipc.test.js test/scheduler.test.js`
Expected: PASS.

- [ ] **Step 2: Run the complete package test suite**

Run: `npm test`
Expected: all previously passing tests remain passing. If pre-existing failures appear, reproduce them against the untouched base revision before attributing them to this work; do not call Phase 1 green until classified.

- [ ] **Step 3: Measure router overhead without model/network calls**

In `routine-vs-planner-benchmark.js`, resolve each iteration's same fixed `goalInput` once before TaskStore creation; time only `resolveTaskProfile()` into a separate `profile_resolution` stage and pass that result to the store. Emit p50/p95 for that stage separately from journal append/fsync, checkpoint, approval callback, and browser spans. Assert the resolver has no model/network dependency and confirm paired outcomes remain identical. Document that this reports local deterministic classification cost, not an online model-classification latency or full TaskHost admission benchmark.

- [ ] **Step 4: Audit final diff and report evidence**

Run: `git diff --check` and inspect `git status --short`; preserve unrelated user changes and report only Phase 1 paths/evidence. Do not commit unless the user separately asks.

## Follow-on plan order

This plan implements the first executable slice of the approved architecture; it does not claim the whole objective is complete. After Phase 1 review/implementation, write and review separate plans for: (2) Long/profile-aware duration strategy and trace-based calibration; (3) deeper Routine/Browser/Multi-agent adapter isolation and shared-core no-escalation proof; (4) bounded Research acquisition/evidence; (5) Computer-use screenshot provenance, coordinate binding, approval, and recovery. Research and Computer-use stay unavailable until their own plans and acceptance tests are complete.
