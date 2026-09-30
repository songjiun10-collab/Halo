# Subagent Communication Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement durable, bounded parent-child agent messaging on HALO's existing TaskStore journals without granting message content authority over browser actions or policy.

**Architecture:** Keep TaskStore journals authoritative: the sender journal stores `message_sent`, and the receiver journal stores `message_turn_consumed`. Add a focused mailbox module for idempotent append, pending derivation, and serialized conversation quotas; integrate it with existing child coordinator/controller safe checkpoints and enforce role/direction in planner transport and host validation.

**Tech Stack:** Node.js, built-in `node:test`, existing Electron harness contracts, TaskStore and ChildAgentCoordinator.

**Spec:** `docs/superpowers/specs/2026-09-28-subagent-communication-protocol-design.md`

## Collaboration Boundary

- Claude: shared contracts, planner role gate, and controller/coordinator integration in the already-dirty existing runtime files. Preserve existing uncommitted work; do not replace or reformat unrelated sections.
- Codex: own the new `apps/computer-browser/main/harness/message-mailbox.js` and new `apps/computer-browser/test/message-mailbox.test.js`; avoid editing the files assigned to Claude.
- Before each Claude task, re-read the current target files and inspect their latest diff because the background-runtime work is simultaneously modifying those same files; preserve all existing behavior and edits not in this protocol scope.
- Sequence: agree and land the contract shape first; then Codex implements mailbox storage behavior while Claude works only on planner-stdio role validation; integrate controller/coordinator after those independent slices are reviewed.
- No commit, push, merge, or renderer work is included.

## Global Constraints

- V1 routes only between a parent task and its accepted child tasks; no sibling routing or nested delegation.
- Sender identity, recipient relationship, conversation ID, and parent goal version are host-derived/validated; message content is untrusted data.
- Use existing append-only TaskStore journals. Do not create a second authoritative mailbox database or mirror sender messages into the receiver journal.
- `message_sent` acceptance and `message_turn_consumed` observation are durable journal events; observation is recorded before proposal validation/handling or resulting browser dispatch.
- Per-sender idempotency lookup+append and per-conversation pending-quota check+append are serialized. The conversation quota lock spans opposite-direction sends and their durable append.
- Proposed bounds: 8 KiB UTF-8 message text; 4 admitted messages and 8 KiB serialized message context per planner turn; 50 pending per parent-child conversation combined across directions; one unobserved parent-to-child steer per child; 3 steer messages per child per rolling 60 seconds.
- V1 has no message TTL or journal compaction. TaskStore capacity exhaustion is a fail-closed task-wide availability risk and must be surfaced, not hidden.
- Preserve all existing user/Claude changes in the dirty checkout. Do not commit or push.

## Review Focus

- Opposite-direction concurrent sends must not exceed the shared 50-message pending cap: test with both senders racing at count 49 and assert exactly one accepted append.
- A base planner packet near the 64 KiB cap must reduce available message admission to remaining capacity (up to 8 KiB), and zero remaining capacity must leave messages pending rather than pause the task with `context_error`.
- Same idempotency key with changed recipient/content must fail without a second append; a same-payload retry after restart returns the original ID.
- Crash/failure after planner response but before durable `message_turn_consumed` must not process the generated proposal and must leave messages eligible for redelivery.
- A child attempting `steer`, sibling routing, or stale-goal delivery must be rejected before recipient state changes.
- A stalled unobserved steer must remain visibly pending; only the independent stop/takeover recovery path may end the child, and stopping must not mark the steer observed.

---

### Task 1: Add strict message event and proposal contracts (Claude)

**Files:**
- Modify: `apps/computer-browser/shared/harness-contracts.js`
- Test: `apps/computer-browser/test/task-store.test.js`
- Test: `apps/computer-browser/test/planner-stdio.test.js`

**Interfaces:**
- Add `message_sent` and `message_turn_consumed` to `EVENT_TYPES`; add `send_message` to `PROPOSAL_KINDS`.
- Validate exact envelope fields from spec §7, bounded message text and handoff/reference fields, `consumedMessageIds`, and proposal field `recipientTaskId`/`messageKind`/`idempotencyKey` plus applicable content fields.
- Keep TaskStore event wrapper (`seq`, `eventId`, `taskId`, `goalVersion`, `at`) unchanged.

- [x] Add tests for valid message event shapes, unknown fields/kinds, 8 KiB UTF-8 text boundary and over-limit rejection, duplicate/invalid consumed IDs, and valid/invalid `send_message` proposals.
- [x] Run the new tests and verify they fail because the event/proposal kinds and validators are missing.
- [x] Implement minimal contract constants and validators without changing existing event semantics.
- [x] Run focused contract-bearing suites: `node --test apps/computer-browser/test/task-store.test.js apps/computer-browser/test/planner-stdio.test.js`.

### Task 2: Implement journal-backed mailbox (Codex)

**Files:**
- Create: `apps/computer-browser/main/harness/message-mailbox.js`
- Create: `apps/computer-browser/test/message-mailbox.test.js`

**Interfaces:**
- `new MessageMailbox({ getTaskStore, getConversationTaskIds, now })`; `getTaskStore(taskId)` returns an already-open TaskStore; `getConversationTaskIds(conversationId)` returns the host-verified parent/child IDs.
- `send(messageEnvelope) -> { messageId, duplicate }`; the caller supplies only a host-validated, relationship-bound envelope.
- `listPending({ senderTaskId, recipientTaskId }) -> MessageEnvelope[]`; derive sender `message_sent` minus recipient `message_turn_consumed` IDs.
- `recordConsumed(recipientTaskId, consumedMessageIds, observedAtPlannerCall?) -> durable event`; append exactly one event for a non-empty admitted batch.
- No independent authoritative state: rebuild idempotency and pending indices from journal events after construction/restart. Any in-memory cache is disposable.

- [x] Create two real TaskStores in a temp root and write failing tests for durable send/read/pending derivation and durable consumption.
- [x] Add tests for same-key same-payload retry, conflicting reuse, restart reconstruction, failed append behavior, and one atomic consumed-ID batch.
- [x] Add opposite-direction concurrent sends at 49 pending messages; assert the conversation-scoped lock admits only one and rejects the other with `queue_full`.
- [x] Run `node --test apps/computer-browser/test/message-mailbox.test.js` and verify the new API fails first.
- [x] Implement sender-serialized idempotency and conversation-serialized quota-check-plus-append; ensure lock release on all errors and no mirrored receiver event.
- [x] Run the mailbox tests and `node --test apps/computer-browser/test/task-store.test.js`.

### Task 3: Enforce planner role and direction rules (Claude)

**Files:**
- Modify: `apps/computer-browser/main/harness/planner-stdio.js`
- Test: `apps/computer-browser/test/planner-stdio.test.js`

**Interfaces:**
- Parent and child planners may produce `send_message` only through validated proposals.
- Child planners cannot produce `steer`; no planner may target a sibling or unrelated task. Host coordinator remains the final relationship authority.

- [x] Add failing tests for a child `steer` and malformed/unknown message proposal kind; assert the planner transport rejects them before downstream dispatch. Recipient relationship and stale-goal checks belong to the coordinator in Task 4 because stdio has no authoritative task-relationship view.
- [x] Run the focused tests and confirm expected failures.
- [x] Add the narrow role gate while preserving existing `child_plan` and action gates.
- [x] Run `node --test apps/computer-browser/test/planner-stdio.test.js`.

### Task 4: Integrate safe-checkpoint delivery and host authorization (Claude)

**Files:**
- Modify: `apps/computer-browser/main/harness/child-agent-coordinator.js`
- Modify: `apps/computer-browser/main/harness/task-controller.js`
- Modify: `apps/computer-browser/main/harness/context-builder.js`
- Modify: `apps/computer-browser/main/harness/task-host.js` only if required for trusted callback wiring
- Test: `apps/computer-browser/test/child-agent-coordinator.test.js`
- Test: `apps/computer-browser/test/task-controller.test.js`
- Test: `apps/computer-browser/test/context-builder.test.js`
- Test: `apps/computer-browser/test/task-host.test.js`

**Interfaces:**
- `ChildAgentCoordinator` authenticates parent-child relationships and host-derives envelope fields before delegating journal operations to `MessageMailbox`.
- `TaskController` includes typed `pendingMessages` in planner context at a safe checkpoint, calls `recordConsumed` immediately after a successful planner response, and handles no proposal from that turn if the durable append fails.
- Message proposals are handled as host messaging, never as browser actions. Existing stop/takeover path stays independent.

- [x] Add tests for parent-to-child and child-to-parent only, sibling/unrelated/stale relationship rejection, steer rate and pending-steer caps, deterministic 4-message/8 KiB admission, no in-flight mutation, and redelivery after failed consumption append. Added concurrent steer quota and symmetric stale-goal regressions during handoff.
- [x] Extend `context-builder.test.js` to prove `pendingMessages` is a typed, bounded context field and ordinary action/evidence context is preserved when the field is absent.
- [x] Add a near-64-KiB base-context boundary test proving the 8-KiB message budget is reduced to packet headroom and zero headroom admits no messages without causing a context error.
- [x] Add a barrier test proving a message-bearing planner proposal is not processed if `message_turn_consumed` append/fsync fails.
- [x] Add a test that stopping a stalled child does not mark its steer consumed; also cover stop arriving after the planner response reaches the durable acknowledgement boundary.
- [x] Run new tests and verify expected failures before implementation.
- [x] Wire coordinator authentication, safe-checkpoint context admission, durable consumption-before-proposal handling, and `send_message` handling; fail closed on TaskStore capacity errors. Parent goal amendments and message acceptance share a host-owned lock to close the stale-check/append race.
- [x] Run `node --test apps/computer-browser/test/child-agent-coordinator.test.js apps/computer-browser/test/task-controller.test.js apps/computer-browser/test/context-builder.test.js apps/computer-browser/test/task-host.test.js`.

### Task 5: Full regression and review

**Files:**
- No planned source changes unless a verified regression is found; fix only in the owning task/files.

- [x] Run focused combined coverage: `node --test apps/computer-browser/test/task-store.test.js apps/computer-browser/test/message-mailbox.test.js apps/computer-browser/test/planner-stdio.test.js apps/computer-browser/test/child-agent-coordinator.test.js apps/computer-browser/test/task-controller.test.js apps/computer-browser/test/context-builder.test.js apps/computer-browser/test/task-host.test.js` (222/222).
- [x] Run the full app suite. Parallel default runs intermittently reported one failure; serialized `node --test --test-concurrency=1` passed 580/580.
- [x] Run `git diff --check` and inspect the protocol-owned diff, preserving unrelated dirty changes.
- [x] Report test counts, any pre-existing failures, residual limits, and files changed. No commit or push.
