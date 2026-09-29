# Local Browser Backend Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable ordered/parallel user-task scheduling, four permission modes, planner effort controls, and local encrypted vault/memory services to HALO's browser backend.

**Architecture:** TaskHost owns durable scheduling and resource admission; TaskController and BrowserAdapter enforce permission decisions at both proposal and execution boundaries. Local settings and encrypted user data live in main-process-only stores; custom memory is injected as explicitly untrusted planner context, while credentials can only reach an approved autofill callback.

**Tech Stack:** Electron 44, Node.js built-ins, `node:test`, Electron `safeStorage`.

**Spec:** `docs/superpowers/specs/2026-09-28-local-agent-controls-design.md`

## Global Constraints

- Keep a 1,000,000,000-byte hard memory ceiling; parallel admission requires a fresh, fully measurable process sample plus a benchmark-derived per-task reserve; otherwise queue.
- Default permission mode is `browse`; `full` requires an explicit trusted host setting.
- Credentials and custom memory are stored locally; vault values never enter renderer/planner/journal/logs.
- Custom memory is automatically included in planner context and explicitly labeled untrusted.
- Every task remains independently isolated, recoverable, and subject to HALO's durable action journal.
- Do not build settings UI in this backend phase; do not commit or push without a direct request.

## Review Focus

- Queue recovery versus TaskStore checkpoints: test any mismatch as fail-closed and never silently reorder work.
- Parallel admission with stale/unmeasurable memory samples: test that scheduling does not exceed the selected cap.
- `full` mode bypass: prove only the trusted host setting can select it, never page/planner/task text.
- Password autofill: prove exact-origin binding, explicit approval, and no secret in any public response/context/log.
- Memory injection: prove exact-origin scoping, bounded stable ordering, untrusted labeling, and fail-closed overflow.

---

### Task 1: Durable task scheduler (Claude-owned)

**Files:** Create `apps/computer-browser/main/harness/task-queue.js`; modify `task-host.js`; test `test/task-host.test.js` and `test/task-queue.test.js`.

**Interfaces:** `TaskHost` remains the public owner. Queue persistence stores task IDs and ordering/audit events only. Queued tasks must not construct BrowserAdapter/planner until admitted. Parallel execution is enabled only when the latest aggregate sample is <=7.5s old, fully measurable, and `currentBytes + reserveBytes < 1_000_000_000`.

- [x] Add failing FIFO, no-resource-construction, restart reconciliation, and closed-allowlist state tests.
- [x] Add duplicate-admission protection, close-during-attach coverage from existing host tests, and trusted durable skip.
- [x] Implement serialized durable admission and route queued attaches through `_trackAttachment`/`_attach`.
- [x] Advance only after completed/stopped; paused and approval states retain their slot. Recovered tasks fail closed pending explicit FIFO resume.
- [x] Add a real Electron two-task visible+hidden surface measurement; standalone surface probe observed baseline 148,209,664 bytes, peak 738,525,184 bytes, and 590,315,520-byte total increment (50ms sampling, 66 samples, no unmeasurable processes). Its 370MB per-task reserve is conservatively rounded up; TaskHost additionally reserves 125% of planner process-tree high-water.
- [x] Run queue and TaskHost focused tests.

### Task 2: Permission policy and host settings (Codex-owned)

**Files:** Create `main/harness/permission-policy.js`, `main/harness/host-settings.js`; tests `test/permission-policy.test.js`, `test/host-settings.test.js`; integrate only after agreeing on main/IPC ownership.

**Interfaces:** `evaluateActionPolicy(mode, action)` returns `{allowed,outcome,approval,reason}`. `HostSettingsStore.load()` and `.update(patch)` persist versioned `{version,executionMode,permissionMode,plannerEffort}`. `MemoryMonitor.canAdmitTask({reserveBytes,maxAgeMs})` denies stale/incomplete/over-budget samples.

- [x] Write failing four-mode policy matrix and invalid-enum tests.
- [x] Write failing persistence/default/symlink/mode tests.
- [x] Implement policy matrix and private atomic settings persistence.
- [x] Add persisted `executionMode` (`sequential` default or `parallel`) after user selected resource-aware 1GiB admission.
- [x] Persist and inject permission mode, planner-effort label, and execution mode into TaskHost/TaskController; expose settings through trusted IPC.
- [x] Prove `full` bypasses the approver only at the host dispatch boundary and `interact` queues click/type for human review.
- [x] Claude Code provider maps only host-supplied low/medium/high/xhigh/max values to its `--effort` argument; unsupported values reject before spawn.
- [x] Add independent BrowserAdapter authorization (direct adapter calls are policy-guarded).
- [x] Run focused tests and full app suite.

### Task 3: Local encrypted user memory (Codex-owned)

**Files:** Create `main/harness/local-memory-store.js`; modify `main/harness/context-builder.js` and `task-controller.js`; tests `test/local-memory-store.test.js`, `test/context-builder.test.js`, `test/task-controller.test.js`.

**Interfaces:** `LocalMemoryStore.put/list/remove/forContext(url)` stores bounded entries locally; `forContext` returns deterministic exact-origin/global entries and fails on overflow. `buildContext(..., customMemory)` emits `userMemory: {authority:"untrusted_user_memory",entries}`.

- [x] Add failing encrypted-at-rest, origin, budget, CRUD, and no-encryption tests.
- [x] Implement encrypted memory store with private atomic writes and fail-closed encryption.
- [x] Add failing context tests and inject selected memories on every planner turn; context errors pause before planner invocation.
- [x] Wire store construction into TaskHost and include bounded origin-matched memories on every planner turn.
- [x] Run focused tests and full app suite.

### Task 4: Local credential vault (coordinated runtime boundary)

**Files:** Create `main/harness/local-credential-vault.js`; runtime autofill integration belongs to the BrowserAdapter/main owner; tests `test/local-credential-vault.test.js` plus adapter/integration tests.

**Interfaces:** `LocalCredentialVault.put/list/remove/fill` returns metadata only. `fill` requires an explicit approval flag, exact origin, and a trusted main-process callback; passwords are never returned to renderer or planner.

- [x] Add failing tests for encrypted storage, metadata-only listing, approval, origin mismatch, and unsupported encryption.
- [x] Implement encrypted vault records and constrained fill callback.
- [x] Add bounded visible login-field resolution and safe autofill in BrowserAdapter with no auto-submit.
- [x] Wire encrypted metadata-only credential CRUD through trusted main-process IPC without returning password values.
- [x] Autofill is exposed only through trusted IPC on a user-controlled task and exact current origin; the journal records credential ID/origin without secrets.
- [x] Run focused unit tests and a real-Electron user-controlled HTTPS autofill run through TaskHost and the local vault; the filled values reached only the fixture page and neither appeared in the journal.

### Task 5: Integrated verification

**Files:** Existing Electron integration tests and new scheduler/permission/vault/memory integration tests.

- [x] Run full `npm test` after the latest parallel integration additions (388 passed, 0 failed).
- [x] Run a real-Electron TaskHost parallel-admission journey with two visible+hidden browser task surfaces, two actual JSONL planner workers, and the Python approver. Both tasks obtained human approval and dispatched successfully; all processes were measurable; the maximum of two samples around second-task admission/actions was 679,395,328 bytes (<1GB). This is a point-sampled integration check, not a continuous peak bound. Admission uses the fresh aggregate sample plus 370MB browser reserve and 125% planner high-water.
- [x] Run real-Electron tests for queue restart, permission mode, and credential autofill end-to-end; the test also verifies automatic untrusted-memory injection and that queue listing performs recovery without eager browser construction.
- [x] Inspect scoped final diff and run `git diff --check`; preserve unrelated dirty renderer/long-horizon work.
- [x] Report verified behavior and explicitly list anything still unimplemented; do not imply UI is ready.

### Security review follow-up

- [x] Tighten credential vault and BrowserAdapter autofill to HTTPS-only, matching the design contract; add regressions proving HTTP storage and direct autofill are refused.
- [x] On fresh TaskHost startup, have `listTasks()` initialize and reconcile the durable FIFO manifest; regression covers restart ordering and no eager browser construction.
