# Browser Computer-Use Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Keep implementation in this session; do not delegate.

**Goal:** Enable screenshot-grounded coordinate actions on HALO's isolated browser surface, with provenance validation and the existing approval/journal/execution-uncertainty boundary, using one Codex subscription CLI image-input route.

**Architecture:** `BrowserAdapter` captures a fresh image from the task-owned fixed viewport and binds it to the current observation, task, epoch, origin, and viewport. A private temporary attachment carries pixels only to the selected image-capable planner; the model returns typed proposals, while host validation and TaskController remain the only path to dispatch. No model receives an action-execution tool.

**Tech Stack:** Electron `WebContentsView` / `webContents.capturePage()` and `sendInputEvent()`, Node.js, existing JSONL planner worker protocol, Codex CLI `--image`, `node:test` with fake browser/CLI transports, Electron loopback integration fixture.

**Spec:** `docs/superpowers/specs/2026-10-03-subscription-computer-use-tiers-design.md` (implement only the CU core and Codex pilot from rollout steps 2-3; defer model/orchestration tier selectors and other providers).

## Global Constraints

- V1 is limited to the task's HALO-owned browser surface; it is not macOS-wide input control.
- Provider output and screenshot/page contents are untrusted observations, never authority.
- The model returns typed action proposals only; it receives no click, type, navigation, approval, shell, or arbitrary tool-execution capability.
- Coordinate proposals are host-validated against the exact fresh screenshot observation, task, agent, document epoch, origin, viewport, intent lock, and single-use binding.
- Existing permission, approval, goal-version, evidence, and durable journal rules remain authoritative; approval is bound to the action digest and observation identity.
- Dispatch timeout/lost result is `execution_uncertain`; it is journaled and never automatically retried.
- No raw screenshot is retained in the durable journal by default. Provider attachment files are private, short-lived, and deleted after the planner request settles.
- Provider credentials remain in the provider CLI's existing login path; HALO never reads/copies credential files and never silently falls back to API billing.
- Tests use fake transports only; no real Codex/Claude process or provider API in unit tests.
- Preserve all existing unrelated working-tree changes; inspect before editing overlapping files and stage only task-owned paths.

## Review Focus

- Screenshot captured for another task/agent, old epoch, changed origin, or resized viewport must be rejected before dispatch — cover in Tasks 1-3.
- Replayed or duplicated screenshot-bound coordinate proposals must not dispatch twice — cover in Tasks 1-3.
- Out-of-range, non-finite, malformed, or oversized coordinate/text/key payloads must fail closed — cover in Tasks 1-2.
- Timeout after an input event may have reached Chromium must become durable `execution_uncertain`, with no retry — cover in Task 3.
- Missing subscription login, quota/entitlement error, corrupt/missing image attachment, or unsupported provider must pause before action and must not switch to API-key billing — cover in Task 4.

---

### Task 1: Screenshot provenance and short-lived attachment

**Files:**
- Create: `apps/computer-browser/main/harness/computer-use-contract.js`
- Create: `apps/computer-browser/test/computer-use-contract.test.js`
- Modify: `apps/computer-browser/main/harness/browser-adapter.js`
- Modify: `apps/computer-browser/main/harness/agent-viewport-host.js`
- Modify: `apps/computer-browser/main/index.js`
- Test: `apps/computer-browser/test/browser-adapter.test.js`
- Test: `apps/computer-browser/test/agent-viewport-host.test.js`

**Interfaces:**
- Consumes: Existing `BrowserAdapter.observe()` result and the host-owned task/agent viewport.
- Produces: `AgentViewportHost.captureComputerUseObservation(taskId, observation) -> { binding, attachment }`; host ownership comes from the task's already-attached private viewport record, not caller-supplied model/renderer fields. `binding` has exact fields `{ observationId, taskId, agentId, documentEpoch, origin, capturedAt, viewport: { width, height }, digest }`; `taskId` is a task UUID, `agentId` is a host-validated agent UUID or `null` for a standalone task, and `observationId` preserves the existing non-empty host observation ID string (max 128 chars). `attachment` exposes only a private temporary `path` plus an idempotent `dispose()` to host code. Raw image bytes/path must not be added to the normal observation JSON or journal.

- [ ] **Step 1: Write failing fake-WebContents tests** for PNG capture binding to the current observation, epoch/origin/viewport, wrong observation or unregistered task rejection, and private attachment mode/cleanup.
- [ ] **Step 2: Run** `cd apps/computer-browser && node --test test/computer-use-contract.test.js test/browser-adapter.test.js test/agent-viewport-host.test.js`; expected: missing contract/capture APIs fail.
- [ ] **Step 3: Implement** strict schema/bounds helpers and host-only capture in the adapter/viewport owner. Use a per-capture directory mode `0700`, image file mode `0600`, create exclusively, and remove on dispose; reject navigation/epoch changes during capture.
- [ ] **Step 4: Re-run the same tests**; expected: all pass, normal DOM observation contract unchanged, and no raw screenshot bytes appear in returned public snapshots.
- [ ] **Step 5: Review and commit only these exact files** with `feat: capture provenance-bound browser screenshots`.

### Task 2: Single-use coordinate action contract and browser executor

**Files:**
- Modify: `apps/computer-browser/main/harness/computer-use-contract.js`
- Modify: `apps/computer-browser/main/harness/browser-adapter.js`
- Modify: `apps/computer-browser/main/harness/permission-policy.js`
- Modify: `apps/computer-browser/main/harness/action-gate.js`
- Modify: `apps/computer-browser/runtime-src/shared/harness-contracts.ts`
- Generated by project build only: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/computer-use-contract.test.js`
- Test: `apps/computer-browser/test/browser-adapter.test.js`
- Test: `apps/computer-browser/test/action-gate.test.js`

**Interfaces:**
- Consumes: Task 1 screenshot binding.
- Produces: Exact coordinate actions `{"type":"click_at","observationId":"<uuid>","x":0.0,"y":0.0}` and `{"type":"type_at","observationId":"<uuid>","x":0.0,"y":0.0,"text":"..."}`. `x` and `y` are finite normalized viewport fractions in `[0,1)`; type text is capped at 4,096 UTF-8 bytes. The binding is consumed before event dispatch. Coordinates are converted using the captured viewport only after equality with the current viewport and document epoch is proven.

- [ ] **Step 1: Write failing tests** for valid click/type coordinate conversion, exact action field sets, bounds/non-finite/oversize rejection, wrong observation/task/agent/origin/epoch/viewport, and replay rejection.
- [ ] **Step 2: Run the three focused test files**; expected: new action types and validation are absent.
- [ ] **Step 3: Implement** the host validator, permission/action target handling, and browser-only Electron input path (`sendInputEvent` for click, host click plus text insertion for `type_at`); update the TS contract source and regenerate its JS output. TaskController's proposal description and approval path are covered by Task 3. Do not add keypress, download, upload, navigation, or desktop-control primitives in this v1.
- [ ] **Step 4: Re-run** the focused tests and existing browser interaction suite; expected: invalid/stale/replayed actions have zero input events and all DOM regressions remain green.
- [ ] **Step 5: Review and commit only these exact files** with `feat: add screenshot-bound browser coordinate actions`.

### Task 3: TaskController proposal, approval, journaling, and uncertainty path

**Files:**
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/progress.js`
- Modify: `apps/computer-browser/main/harness/context-builder.js`
- Modify: `apps/computer-browser/main/harness/providers/claude-code-bridge.js` (prompt contract only)
- Test: `apps/computer-browser/test/task-controller-interactions.test.js`
- Test: `apps/computer-browser/test/task-controller.test.js`
- Test: `apps/computer-browser/test/progress.test.js`

**Interfaces:**
- Consumes: Task 1 binding/attachment and Task 2 action contract.
- Produces: For computer-use task profiles only, one fresh visual capture per planner turn; context includes provenance metadata but never a filesystem path or image bytes. `planner.next(context, { signal, attachments: [{ kind: "image", id, path }] })` carries a separate host-only attachment argument; workers pass it only to their provider adapter. Proposal shapes match Task 2. All coordinate proposals use `_dispatchActionsBatch` and existing policy/review queue; no fast-path bypass. A timeout or lost dispatch follows existing uncertain-action journaling and recovery semantics.

- [ ] **Step 1: Write failing controller tests** proving a coordinate proposal is queued/reviewed under current policy, approval binds to the visual observation/action digest, stale screenshot is rejected, timeout journals uncertainty, and a malicious page instruction cannot approve its own action.
- [ ] **Step 2: Run** `cd apps/computer-browser && node --test test/task-controller-interactions.test.js test/task-controller.test.js test/progress.test.js`; expected: new action proposal validation/dispatch fails.
- [ ] **Step 3: Implement** capability-gated visual capture and typed planner prompt actions; pass the attachment out-of-band to the planner, exclude attachment paths from serialized context, and charge the existing action/planner-call budgets.
- [ ] **Step 4: Re-run the focused tests** plus `test/task-controller-lease.test.js`; expected: existing policy/lease behavior unchanged, stale/replayed actions never reach the browser executor, and no uncertainty auto-retry.
- [ ] **Step 5: Review and commit only these exact files** with `feat: route computer-use proposals through HALO approval`.

### Task 4: Codex subscription CLI image-input pilot

**Files:**
- Modify: `apps/computer-browser/main/harness/planner-stdio.js`
- Modify: `apps/computer-browser/main/harness/providers/claude-code-worker.js`
- Modify: `apps/computer-browser/main/harness/providers/codex-planner-bridge.js`
- Modify: `apps/computer-browser/main/harness/providers/codex-planner-worker.js`
- Test: `apps/computer-browser/test/planner-stdio.test.js`
- Test: `apps/computer-browser/test/claude-code-worker.test.js`
- Test: `apps/computer-browser/test/codex-planner.test.js`

**Interfaces:**
- Consumes: Task 3 host-only attachment argument.
- Produces: A narrowly validated per-request attachment envelope accepted only by the Codex planner worker; Codex CLI receives it through `--image <private temp PNG>` while all existing shell/browser/computer-use/MCP/plugin features remain disabled. Claude and other planners reject/omit unsupported attachments with a typed `computer_use_provider_unavailable` error. Attachment path is never interpolated into model prompt text and no provider/API-key fallback is attempted.

- [ ] **Step 1: Write fake-spawn tests** asserting `--image` receives only the registered private attachment path, image arguments cannot come from model/context JSON, providers without image support fail closed, and attachment errors do not produce proposals.
- [ ] **Step 2: Run** `cd apps/computer-browser && node --test test/planner-stdio.test.js test/claude-code-worker.test.js test/codex-planner.test.js`; expected: attachment protocol and args assertions fail.
- [ ] **Step 3: Implement** a separate bounded attachment field on the JSONL worker request and strict validation at each process boundary; Codex uses existing authenticated CLI only.
- [ ] **Step 4: Re-run the focused tests** and verify every planner flag in the existing disable list remains present.
- [ ] **Step 5: Review and commit only these exact files** with `feat: attach browser screenshots to Codex subscription turns`.

### Task 5: Capability availability and Electron loopback integration

**Files:**
- Modify: `apps/computer-browser/runtime-src/shared/capability-registry.ts`
- Generated by project build only: `apps/computer-browser/shared/capability-registry.js`
- Modify: `apps/computer-browser/contracts/BROWSER-INTERACTIONS.md`
- Modify: `apps/computer-browser/main/harness/providers/README.ko.md`
- Create: `apps/computer-browser/integration/computer-use-electron.js`
- Test: `apps/computer-browser/test/capability-registry.test.js`
- Test: `apps/computer-browser/test/runtime-contract-conformance.test.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: `computer_use` becomes available only with adapters whose screenshot provenance, proposal validation, approval path, and Codex image-input conformance are all wired. Integration fixture proves loopback page → capture → fake visual proposal → approval → exactly one browser event → fresh observation. No live external site or real model invocation.

- [ ] **Step 1: Write failing registry/conformance tests** for unavailable-before-wiring and available-only-when-all-CU guards hold, plus a loopback interaction test proving replay/stale epoch never dispatches.
- [ ] **Step 2: Run** `cd apps/computer-browser && node --test test/capability-registry.test.js test/runtime-contract-conformance.test.js`; expected: CU remains unavailable until adapters are registered.
- [ ] **Step 3: Implement** capability registry metadata from TypeScript source, regenerate the runtime JS through the existing build script, and document supported coordinate actions and exact limits.
- [ ] **Step 4: Run all focused CU/controller/bridge tests**, then `./node_modules/.bin/electron integration/computer-use-electron.js`; expected: all tests pass and Electron reports one approved event only.
- [ ] **Step 5: Run the full `node --test` suite only after the focused suite is green**, report failures attributable to pre-existing dirty changes separately, then commit only these exact files with `feat: enable guarded browser computer use`.

## Deferred

- Model tier 1-5 registry and renderer selector.
- Orchestration tier 1-5, adaptive discussion/review behavior, and resource scaling.
- Claude dedicated screenshot-MCP bridge; first prove a strict private read-only tool allowlist and image transport independently before enabling it.
- Gemini subscription-backed route; remain unavailable until official login/entitlement/image-input and terms are verified.
- macOS-wide controls, keyboard primitives, upload/download, credential entry, purchases, and arbitrary desktop access.
