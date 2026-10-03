# HALO Agent Persistent Browser Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a named HALO Agent explicitly reuse its browser session across tasks while preserving host-owned identity, durable task binding, and existing approval boundaries.

**Architecture:** AgentStore owns the default-off preference. AgentService passes the validated owner only through its private create-task callback; TaskHost persists that binding in `task_profile_selected` before attaching browser views. Both visible and hidden browser views use `persist:halo-agent-${agentId}` only for that validated binding; generic and team/child tasks retain their current partitions. Revocation blocks new binds and stops active bound tasks without deleting profile data.

**Tech Stack:** Electron `WebContentsView` sessions, Node.js, HALO runtime TypeScript contracts with generated shared JavaScript, `node:test`, React/TypeScript UI.

**Spec:** `docs/superpowers/specs/2026-10-02-agent-persistent-browser-profiles-design.md`

## Global Constraints

- Existing and new Agents default to disabled.
- Renderer-supplied selectors cannot name or override the profile owner.
- Persist the selected Agent ID in the task journal before browser construction.
- Missing, archived, or disabled owners fail closed during start or recovery.
- Only host-validated UUIDs may form `persist:halo-agent-${agentId}`.
- Team parent and child tasks stay on current ephemeral task/parent partitions.
- Persistence does not bypass browser action approval or capability checks.
- Disabling prevents new use and stops active bound tasks; profile bytes are retained.
- No OpenDots code, API, data structures, service layout, or UI is copied or ported.

## Review Focus

- Malformed/legacy Agent preference values → AgentStore validation and migration tests.
- Renderer attempts to spoof profile ownership → TaskHost public-selector rejection test.
- Crash/restart with disabled or missing owner → TaskStore recovery/TaskHost fail-closed test.
- Team/child or ordinary task sharing → partition-selection regression tests.
- Stop/dispose failure during revocation → revocation remains unavailable and reports failure.

---

### Task 1: Agent preference and host-only owner binding

**Files:**
- Modify: `apps/computer-browser/main/harness/agent-store.js`
- Modify: `apps/computer-browser/main/harness/agent-service.js`
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Test: `apps/computer-browser/test/agent-store.test.js`
- Test: `apps/computer-browser/test/agent-service.test.js`
- Test: `apps/computer-browser/test/task-host-agents.test.js`

**Interfaces:**
- Agent records and inputs gain `persistentBrowser: boolean`, defaulting to `false` when absent.
- AgentService invokes its injected callback as `createTask(goalInput, selectors, { agentId })` only for a direct Agent start whose current AgentStore record is active and opted in. Team starts retain the existing two-argument call.
- TaskHost public `createTask(goalInput, selectors)` remains closed to an `agentId` selector; internal AgentService owner binding is handled by a distinct private path.

- [x] Add tests for default-off legacy records, boolean-only input, duplicate default-off, direct Agent owner callback, team non-binding, and renderer spoof rejection.
- [x] Run focused tests and observe expected missing-field/binding failures.
- [x] Implement the preference validation and internal owner handoff with no renderer-controlled owner field.
- [x] Run `node --test test/agent-store.test.js test/agent-service.test.js test/task-host-agents.test.js` from `apps/computer-browser`.

### Task 2: Durable journal binding and recovery validation

**Files:**
- Modify: `apps/computer-browser/runtime-src/shared/task-profile-contracts.ts`
- Regenerate: `apps/computer-browser/shared/task-profile-contracts.js` using the repository runtime build command.
- Modify: `apps/computer-browser/main/harness/task-store.js`
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Test: `apps/computer-browser/test/task-profile-contracts.test.js`
- Test: `apps/computer-browser/test/task-store.test.js`
- Test: `apps/computer-browser/test/task-host-recovered-queue.test.js`

**Interfaces:**
- Selected task profile may contain optional exact field `agentBrowserProfile: { agentId: string }`, where `agentId` is a UUID.
- `TaskStore.create(goalInput, { ..., agentBrowserProfileBinding })` writes the binding in the initial `task_profile_selected` payload before task attachment; load/replay preserves the validated field.
- TaskHost recovery checks the journal-bound owner against current AgentStore state and refuses/stops if absent, archived, or no longer opted in.

- [x] Add contract, journal ordering, replay, and disabled/missing-owner recovery tests.
- [x] Run focused tests and confirm they fail for absent contract/binding behavior.
- [x] Implement the TS contract, regenerate its JS cohort, and persist/revalidate the owner binding.
- [x] Run `node --test test/task-profile-contracts.test.js test/task-store.test.js test/task-host-recovered-queue.test.js` from `apps/computer-browser`.

### Task 3: HALO-owned persistent partition routing

**Files:**
- Modify: `apps/computer-browser/main/harness/agent-viewport-host.js`
- Modify: `apps/computer-browser/main/index.js`
- Test: `apps/computer-browser/test/agent-viewport-host.test.js`
- Test: `apps/computer-browser/test/main-entrypoint-lifecycle.test.js`

**Interfaces:**
- `AgentViewportHost.ensure(taskId, { agentId } = {})` uses the default task partition when absent and `persist:halo-agent-${agentId}` only for a validated UUID binding.
- The visible task view reads the same journal-derived binding used by the hidden viewport; generic tasks keep `halo-task-${taskId}`.
- `ensureChild(parentTaskId, childId, ...)` remains unchanged and uses the parent's existing task partition.

- [x] Add tests for matching visible/hidden partitions, separate ephemeral ordinary-task partitions, invalid owner rejection, and unchanged child partitioning.
- [x] Run focused tests and confirm the persistent-routing assertions fail before implementation.
- [x] Route only validated journal bindings to Electron's `persist:` partition; preserve all existing hardening and cleanup behavior.
- [x] Run `node --test test/agent-viewport-host.test.js test/main-entrypoint-lifecycle.test.js` from `apps/computer-browser`.

### Task 4: Revocation and Agent settings UI

**Files:**
- Modify: `apps/computer-browser/main/harness/task-host.js`
- Modify: `frontend/src/agent/AgentSettings.tsx`
- Modify: `frontend/src/agent/AgentDetail.tsx`
- Modify: `frontend/src/agent/agent-api.ts`
- Test: `apps/computer-browser/test/task-host-agents.test.js`
- Test: `frontend/test/agent-ui.test.mjs` or a focused new settings test beside it.

**Interfaces:**
- Saving an opted-out or archived Agent first makes the profile unavailable for new tasks, then stops/disposes active tasks whose durable binding names that Agent. A stop/dispose failure is surfaced and does not report completed revocation.
- The profile data is not deleted.
- Agent settings expose a default-off `persistentBrowser` switch with explicit enable confirmation and a short explanation of cross-task cookie/site-storage retention on this device.

- [x] Add revocation success/failure, active-start race, disabled-owner queue, and UI payload/confirmation tests.
- [x] Run new revocation tests red before implementing profile teardown.
- [x] Implement host-serialized revocation using active task journal bindings and add the HALO-native setting without changing the already-dirty `AgentHome.tsx`/`SidebarAgents.tsx` files.
- [x] Run focused frontend tests and `npm run build` from `frontend`.

### Task 5: Integrated acceptance

**Files:**
- Test only where needed: existing focused test files above.

- [x] Run `npm test` from `apps/computer-browser` → 1507 passed, 0 failed.
- [x] Run full frontend `npm test` and `npm run build`. Build passed; frontend tests: 98 passed, 1 failed because the pre-existing missing `frontend/src/session/profile-import.ts` is imported by `test/profile-import.test.mjs`.
- [x] Inspect `git diff --check`, source diff, and working-tree status; preserve the existing UI/runtime changes and make no commit or push.
- [x] Report scope limits: profile data persists locally; this is not profile purge, OS-level credential protection, or sandboxing.
