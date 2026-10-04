# HALO Subscription-backed Computer Use and Tiering

Date: 2026-10-03
Status: Design for review
Scope: HALO Browser, browser-tab computer use only

## Goal

Add screenshot-grounded computer-use actions to HALO Browser, let users select
supported models through subscription-authenticated provider clients where
available, and define separate model and orchestration tiers. This is not
macOS-wide input control. It is a browser-surface capability governed by the
existing host-owned task, policy, approval, journal, and recovery boundaries.

The work must not require a provider API key when an official subscription
client path can perform the model inference. API-key/API billing is a separate
explicit provider option, not an implicit fallback. Provider login or model
entitlement must be checked by the provider client; HALO must never read or
copy provider credential files into its own process.

## Current checkout evidence

- `shared/capability-registry.js` marks `computer_use` unavailable because
  screenshot provenance and coordinate-action verification do not exist.
- The browser interaction contract supports fresh-observation DOM actions, but
  excludes coordinate actions and downloads.
- The Claude Code bridge uses the user's logged-in CLI subscription when
  available, disables all tools, and explicitly refuses coordinate CUA.
- The Codex CLI bridge disables its native computer-use tool. Codex CLI does
  accept initial image attachments with `codex exec --image`; subscription
  OAuth use in an external app is documented only for eligible/authorized
  ChatGPT-plan Responses requests.
- Claude Code supports plan-backed CLI use. For screenshot input in this
  bridge, the intended v1 path is one HALO-owned, read-only screenshot MCP tool;
  no page action tool is exposed to the model. Arbitrary MCP servers remain
  disabled.
- Gemini API computer use is documented as an API path. A Google AI consumer
  subscription is not treated as Gemini API entitlement. A subscription-backed
  Gemini CLI route remains inactive until official account/auth, image-input,
  terms, and model entitlement are verified.
- This checkout has extensive unrelated uncommitted changes. Implementation
  must preserve them, avoid broad formatting/build output changes, and inspect
  ownership/diffs before editing overlapping files.

## Decisions

### 1. Execution and trust boundary

V1 is limited to the task's HALO-owned browser surface. The model receives a
host-captured screenshot tied to a host observation ID, task ID, agent ID,
document epoch, URL origin, capture time, and viewport dimensions. Screenshot
pixels and all visible page text are untrusted observations, never authority.

The model returns typed action proposals only. It does not receive a tool that
can click, type, navigate, submit, download, or approve. A host-owned action
validator binds a proposal to the exact screenshot observation and checks:

- current task/agent ownership and document epoch;
- current origin and intent lock;
- normalized coordinate range and captured viewport size;
- allowed action shape, key/button allowlists, and payload bounds;
- screenshot freshness and single-use observation binding.

The proposal then enters TaskController's existing permission and approval
pipeline. Existing policy modes remain in force; this design does not grant
additional authority. Every consequential action remains subject to current
policy/approval rules. Approval is bound to the action digest, task, agent,
goal version, document epoch, observation ID, and expiry. A timeout or lost
dispatch result becomes `execution_uncertain`; it is journaled and never
automatically retried. Download, file upload, OS-wide input, and arbitrary
desktop control are excluded.

### 2. Subscription-backed provider transports

All transports produce the same HALO proposal contract; provider tool calls
never directly execute browser actions.

- **Codex subscription route:** use the existing authenticated Codex client
  path and attach the host screenshot using the CLI's image-input option.
  Keep shell, browser, computer-use, MCP, and other Codex tools disabled. Where
  ChatGPT-plan OAuth through app-server is used, require the official consent,
  app eligibility, and successful request entitlement; do not assume every
  model or tool request is eligible.
- **Claude Code subscription route:** use the existing logged-in Claude Code
  CLI through a new dedicated CUA bridge, not by loosening the existing
  planner bridge. The dedicated bridge may allow exactly one private,
  HALO-owned, read-only screenshot MCP provider and no user-configured MCP
  server, plugin, hook, shell, file, or action-execution tool. Because the
  existing bridge's `--safe-mode` disables MCP, do not reuse that flag profile;
  instead use a fixed isolated config plus the CLI's strict MCP allowlist, and
  verify that only the screenshot tool is available. If this exact allowlist
  cannot be enforced or image content cannot be delivered through the tool,
  mark the route unavailable rather than weaken its restrictions.
- **Other providers:** register only after an official subscription-backed
  image-input route, account entitlement, and tool isolation are verified.
  Gemini API usage is never represented as included in a Google AI consumer
  subscription. API credentials or API billing require a separate explicit
  opt-in and must not be an automatic fallback.

No credential is logged, returned to the renderer, or passed between agent
processes. A subscription client can consume the user's provider allowance;
the UI must name the selected provider/model and disclose that screenshots and
task context are sent to that provider before first use.

### 3. Model tiers (Tier 1 is highest capability)

These are routing bands, not a cross-vendor benchmark ranking. Only models
whose client can pass a live entitlement check and image/proposal conformance
test are selectable. Unsupported rows remain visible as unavailable or are
hidden until their provider path is verified; never silently substitute a
different model.

| Tier | Candidate models | Intended workload |
| --- | --- | --- |
| 1 | GPT-6 Astra; Claude Opus 5.5 | Ambiguous, long, high-complexity visual workflows |
| 2 | GPT-6.1 Sol; Claude Sonnet 5.5 | General multi-step computer-use tasks |
| 3 | Gemini 3.8 Flash | Computer-use-oriented balanced candidate; subscription route unverified |
| 4 | GPT-6 Luna | Focused, repeated, cost-sensitive tasks |
| 5 | Gemini 3.5 Flash-Lite | Simple, low-latency tasks; subscription route unverified |

Provider selection and model tier are separate from orchestration tier. A
user-selected model is pinned to a new task at creation; a running task does
not silently switch model after a quota/entitlement failure. Any future
fallback requires explicit user configuration and a journal event.

### 4. Orchestration tiers (Tier 1 is most intensive)

| Tier | Host orchestration behavior |
| --- | --- |
| 1 | Decompose; dispatch independent tasks in parallel within resource admission; reconcile conflicts; cross-check evidence; verify completion |
| 2 | Selective independent parallel dispatch; synthesize and verify results |
| 3 | Bounded decomposition; mostly sequential or resource-limited parallel work; verify completion |
| 4 | One primary agent with a short plan and checkpoint review |
| 5 | One primary agent executes directly; no decomposition; verify final result |

Requested concurrency remains a parent proposal; host resource admission may
queue or serialize work. Agent/browser/journal isolation and child capability
constraints remain unchanged. Orchestration tier does not grant capability.

### 5. Adaptive discussion

Discussion/review intensity is selected by the orchestrator from observable
signals such as conflicting agent results, missing evidence, repeated action
failure, low confidence signals available to the host, and task impact. The
orchestrator may request another read-only review or ask the parent to
reconcile results. It cannot approve actions, widen capability, alter user
intent, or override policy. Stop escalation when required evidence is
consistent or when the bounded review budget is exhausted; then report
remaining uncertainty to the user.

### 6. Performance and speed controls

The primary speed control is model selection within its supported tier. A
separate provider reasoning/effort setting may be shown only where the
subscription client officially supports it. HALO may adapt observation
resolution and avoid redundant captures only when a fresh screenshot remains
bound to every coordinate proposal. It may not gain speed by skipping
approval, stale-state checks, journal durability, or required post-action
verification. No vendor-specific "fast mode" is implied by a tier label.

## Rollout and implementation sequence

1. **Baseline and compatibility:** preserve the dirty checkout; map exact
   provider auth modes, model entitlements, image transport, and disabled
   features. Add fake-client contract tests before wiring production paths.
2. **CU core, no live model calls:** implement screenshot identity/freshness,
   typed coordinate proposals, host validation, approval binding, uncertainty
   handling, and browser-only executor. Enable no provider until adversarial
   tests pass.
3. **Subscription adapter pilot:** first wire the authenticated Codex CLI
   subscription path with its image-input option, using fake transports in
   tests. Add the dedicated Claude Code bridge with its private read-only
   screenshot MCP only after the strict tool allowlist and image-delivery
   contract is demonstrated. No real model/API calls in unit tests.
4. **Tiers 1–5:** add supported provider/model registry entries and UI selector
   with explicit unavailable state. Keep Gemini candidates inactive until a
   subscription-backed path is verified. Persist model/tier selection in the
   task's immutable launch profile.
5. **Orchestration tiers and adaptive discussion:** translate tier to bounded
   decomposition/review policy while leaving agent counts to parent proposal
   plus memory/resource admission. Test disagreement, resource denial,
   cancellation, and exhausted review budget.
6. **Evaluation and release gate:** compare DOM-only and CU paths on the same
   browser-only task set. Report task success, unsafe/stale dispatches,
   approval counts, uncertain executions, p50/p95 latency, model calls/tokens,
   provider allowance/cost where available, and peak process-tree RSS. Include
   prompt-injection, stale screenshot, coordinate-boundary, crash/reconnect,
   and long-soak cases. No public-beta claim until provider and macOS
   integration runs pass.

## Failure and privacy behavior

- Missing login, quota, entitlement, or supported model: stop before screenshot
  transmission and present a typed actionable error. No API-key fallback.
- Screenshot/tool transport failure: keep the task paused or failed closed; do
  not act on an older observation.
- Malformed, out-of-range, stale, or replayed proposal: reject and journal the
  reason; do not attempt to repair coordinates automatically.
- Provider output, website text, screenshot content, and subagent messages are
  untrusted. They cannot amend the goal or grant authority.
- User can stop the task; task cleanup releases the browser surface and any
  screenshot temporary data. Evidence retention follows the existing task
  journal policy; no extra raw-screenshot retention by default.

## Verification gates

- Contract/unit tests with fake subscription clients and fake screenshot
  transports; no real Claude/Codex process or provider API in tests.
- Adversarial tests: screenshot from another task/agent, stale epoch, changed
  viewport, click outside bounds, replay, duplicate approval, provider failure
  after dispatch, and page prompt injection.
- Electron loopback integration tests for capture → proposal → policy/approval
  → execution → fresh observation and durable result.
- Provider smoke tests require explicit user initiation and use a harmless
  local loopback page only. Report account/quota conditions and screenshots
  sent to the provider.
- Full test suite and renderer tests pass; benchmark and resource runs disclose
  environment, sample size, and limits.

## Non-goals

- macOS-wide or other-app computer control.
- Automatic credential entry, file upload, download, purchase, or form
  submission without the existing HALO authority/approval rules.
- Making the provider's native computer-use tool an authority boundary.
- Treating subscription authentication as unlimited or zero-cost usage.
- Claiming cross-provider tier order without HALO-specific measurements.
