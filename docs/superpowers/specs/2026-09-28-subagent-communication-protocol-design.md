# HALO Subagent Communication Protocol — Design Draft

**Status:** User-approved for implementation
**Date:** 2026-09-28
**Scope:** Host-mediated communication between a parent task and its child agents in the computer-browser harness. This document defines a protocol; it does not authorize implementation or change the existing runtime.

## 1. Context and motivation

HALO already has a child-agent planning boundary: the parent proposes a bounded child plan, the host validates and persists accepted assignments, and child task stores are associated with the parent. The coordinator currently records plan acceptance and reconstructs parent-child mappings, but does not define a message mailbox or worker conversation protocol.

The design borrows a useful interaction shape from the public, unofficial Grok Bot 0.18.0 reconstruction: messages are queued and persisted, delivery wakes the recipient as a later turn, and messaging, steering, and stopping are distinct operations. This is a design reference, not a claim that the reconstruction is official Grok source or that its implementation should be copied. The important adaptation for HALO is to make the host the authority and durable record keeper.

Relevant HALO surfaces include [`child-agent-coordinator.js`](../../../apps/computer-browser/main/harness/child-agent-coordinator.js#L42), [`planner-stdio.js`](../../../apps/computer-browser/main/harness/planner-stdio.js#L167), and [`harness-contracts.js`](../../../apps/computer-browser/shared/harness-contracts.js#L1). The existing planner frame limit is 64 KiB; child assignments are already bounded by existing contracts. The protocol must not bypass or weaken those limits.

Reference implementation patterns reviewed:

- [Agent-to-agent message queue and delivery](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/extensions/transcript/agent-to-agent-messaging.ts#L52-L123)
- [Recipient framing and untrusted-message guidance](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/agents/agent-messaging.ts#L83-L117)
- [Separate status, steer, and stop controls](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/runner/tools/sand-subagent-management-tools.ts#L84-L141)
- [Bounded group-chat orchestration](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/extensions/transcript/group-chat-orchestrator.ts#L31-L75)
- [ECC memory vault design](https://github.com/affaan-m/ecc/blob/main/docs/design/ecc-memory-vault.md): portable, scoped, inspectable handoffs; memory as unreviewed context rather than policy; canonical project docs remain authoritative.
- [ECC unified-memory workflow](https://github.com/affaan-m/ecc/blob/main/.cursor/skills/unified-memory/SKILL.md): handoffs capture objective/current state/evidence/unresolved items/risks/next action; avoid raw transcripts and secrets.

## 2. Goals

1. Let a parent and its assigned children exchange progress, questions, constraints, and evidence references during long-running work.
2. Preserve a durable, inspectable record across process restart and renderer reload.
3. Keep all authority with the host: agents can communicate but cannot grant themselves capabilities or rewrite their goals.
4. Avoid browser-action races, accidental duplicate actions, unbounded agent chatter, and cross-child state leakage.
5. Make delivery and processing state explicit to the UI and tests.

## 3. Non-goals

- Sibling-to-sibling or arbitrary agent-to-agent messaging in v1.
- Shared browser tabs, views, cookies, or mutable browser sessions between children.
- Exactly-once delivery or exactly-once action execution.
- Allowing a child message to change policy, permissions, immutable goals, or approval decisions.
- Interrupting an in-flight browser dispatch to deliver ordinary message text.
- Building a general-purpose chat product, group-chat loop, or autonomous agent delegation marketplace.
- Claiming prompt-injection resistance merely because messages are labeled untrusted.

## 4. Actors and trust boundaries

- **Parent agent:** proposes and supervises bounded child assignments; consumes child reports as untrusted input.
- **Child agent:** works only within its host-accepted assignment and its own browser view; sends progress, questions, completion reports, and evidence references.
- **Host coordinator:** authenticates the parent-child relationship, assigns message IDs, enforces quotas and safe checkpoints, derives delivery state from journals, and emits sanitized state updates.
- **Renderer/UI:** displays allowlisted snapshots and invokes narrowly scoped host operations. It is not the source of truth and does not write journals or child stores directly.

Both directions cross an untrusted-model boundary. A sender identity is host-derived from the current task, not accepted from message payload fields. Text and referenced evidence remain untrusted even when delivery is authenticated.

**V1 process assumption:** the background-runtime service owns the parent and all accepted child controllers/stores in one process. Each TaskStore's writer lock therefore has one owner, while the host may read a related task journal. Moving children to separate processes is out of scope; that change requires revisiting writer ownership, idempotency serialization, and cross-process authorization.

## 5. V1 topology and operations

V1 uses host-mediated delivery backed by the sender's existing append-only TaskStore journal, restricted to the parent and children in one accepted plan:

```text
Parent agent ── send ──> Parent TaskStore journal ── host reads at safe checkpoint ──> Child agent
Parent agent <─ report ── Parent reads child TaskStore journal <─ Child TaskStore journal <─ Child agent
```

No direct child-to-child route is exposed. The protocol has separate operations with distinct semantics:

- `sendMessage`: host operation invoked by a planner-authored `send_message` proposal; appends a typed message to the authenticated sender's own journal. It does not stop an action or guarantee immediate attention. `steer` is a message `kind`, not a second operation/API; host validation restricts it to parent-to-child and the existing assignment scope. Both parent and child planners may propose messages, while the coordinator derives sender/recipient from its live task relationship and validates direction.
- `getAgentStatus`: read an allowlisted status snapshot and pending-message counts.
- `stopChild`: a host/user control, separate from model-authored message content. It closes admission for new child work and follows the existing safe-stop/drain semantics. A child cannot stop another child or its parent through a message.

Whether these become IPC methods, internal coordinator methods, or both is an implementation-plan decision. Any renderer-facing route must remain allowlisted and must not expose arbitrary journal writes.

## 6. Message envelope

Every persisted message has a host-owned envelope. Field names below are logical requirements, not a frozen API spelling:

| Field | Requirement |
|---|---|
| `messageId` | Host-minted stable unique identifier; used for deduplication and included in the same durable `message_sent` event as `idempotencyKey`. |
| `conversationId` | Host-derived identifier for the accepted parent-child task relationship. |
| `parentTaskId`, `childTaskId` | Host-derived linkage; direction determines sender and recipient. |
| `senderTaskId`, `recipientTaskId` | Must match the authenticated task context and relationship. |
| `parentGoalVersion` | Version under which the accepted child assignment was created. |
| `kind` | Bounded enum such as `progress`, `question`, `answer`, `steer`, `handoff`, or `evidence`. `steer` is permitted only parent-to-child and remains within the accepted assignment. |
| `idempotencyKey` | Sender-supplied opaque key, unique within `senderTaskId` for the lifetime of its journal; reused on retries of the same logical send. |
| `text` | Plain text for non-handoff messages; bounded to at most 8 KiB UTF-8 in v1. No executable markup or implicit tool call. |
| `handoff` | For `kind: "handoff"` only, a schema-validated bounded object with `objective`, `currentState`, `verifiedResults[]`, `unresolved[]`, `risks[]`, and `suggestedNextAction`; verified results reference evidence IDs. Do not duplicate the full handoff into `text`. |
| `evidenceRefs` | Optional bounded list of opaque host-resolvable references; never arbitrary filesystem paths or URLs with implicit fetch behavior. |
| `inReplyToMessageId` | Optional existing `messageId` when this message answers/resolves a specific message. |

Ordering and creation time come from the TaskStore journal event's host-assigned `seq` and `at`; do not duplicate them in sender payload. Delivery/observed state is derived from sender `message_sent` events and recipient `message_turn_consumed` events rather than stored as mutable message fields.

The serialized envelope must remain below the existing planner/IPC frame ceiling with room for framing and metadata. Reject malformed, unknown-critical, oversized, wrongly linked, or stale-version envelopes. Do not silently truncate a message after it has been accepted; return an explicit validation error instead.

## 7. Persistence, delivery, and acknowledgements

The existing TaskStore/task journal is the durable substrate. The sender appends exactly one host-validated `message_sent` event to its own journal; the receiver obtains pending messages by reading the related sender journal through the existing host-controlled related-task read path. Do not append a mirrored copy to the receiver journal merely to create an inbox. Pending state is derived as the sender's `message_sent.messageId` set minus the recipient's durable `message_turn_consumed.consumedMessageIds` set. A send is accepted only once the sender's journal append is durable.

**Proposed payload fields (subject to existing TaskStore event wrapping):** `message_sent` carries `messageId`, `conversationId`, `parentTaskId`, `childTaskId`, `senderTaskId`, `recipientTaskId`, `parentGoalVersion`, `kind`, `idempotencyKey`, and the bounded `text`/`handoff`/`evidenceRefs`/`inReplyToMessageId` fields that apply. TaskStore supplies event `seq` and `at`; do not duplicate them. `message_turn_consumed` carries one atomic `consumedMessageIds` array and may include `observedAtPlannerCall` from the existing planner-call counter for correlation. The `send_message` proposal carries `recipientTaskId`, `messageKind`, `idempotencyKey`, and applicable content/reference fields; the host derives sender, conversation, and goal version. Planner input exposes pending messages as a typed `pendingMessages: [...]` field, not an untyped prompt splice. These are logical payload fields, not a requirement to change the TaskStore's existing event wrapper.

The host enforces the mapping `(senderTaskId, idempotencyKey) → messageId` for the lifetime of the sender task journal. Reconstruct the mapping from `message_sent` events; do not maintain a second mutable mapping as another source of truth. The coordinator serializes the idempotency lookup-plus-append per sender within the V1 single-process owner so concurrent retries cannot both mint IDs. Separately, it serializes the conversation pending-quota check plus append under a conversation-scoped admission lock; this is required because parent and child sends use different sender locks but consume the same bidirectional pending quota. Hold the conversation lock through the durable sender append, then release it. A retry with the same key and same canonical payload returns the original `messageId`; reuse with a different recipient or payload is rejected as an idempotency conflict. The key lifetime matches journal retention; if a future retention policy prunes message events, it must preserve their idempotency tombstones for the same lifetime. A disposable in-memory lookup cache may accelerate reconstruction, but is never authoritative.

V1 guarantees **at-least-once delivery with idempotent deduplication**, not exactly-once delivery. A recipient records the host `messageId` before acting on message content. Replayed messages with an already-seen ID are not presented as new work. A restart resumes delivery from durable state without inventing a new ID. Message processing may be repeated after a crash; any external action still follows HALO's existing dispatch journal and uncertain-outcome rules.

Acknowledgements distinguish these stages:

1. **Accepted/queued:** the sender's `message_sent` event is durable. This does not mean the recipient was given the message.
2. **Delivered:** the host includes the message in a recipient planner request at a safe checkpoint. This can be derived from the planner request/turn record; there is no second durable inbox copy.
3. **Observed:** a durable recipient `message_turn_consumed` event contains the admitted message IDs in `consumedMessageIds`. This is the authoritative event; a transient runtime acknowledgement alone is insufficient. Append and fsync one compact event for each planner call that admits one or more messages, immediately after the planner response is received and before proposal validation/handling or any resulting browser action dispatch. Turns with no admitted messages need not write this event. A timeout/crash before the durable event leaves the messages unobserved and eligible for redelivery; this is at-least-once delivery. If the durable append fails, fail closed and do not handle that turn's proposal.
4. **Resolved:** the recipient optionally replies or marks a question/instruction addressed.

Status updates are event-driven from host state; the UI should not busy-poll. If the recipient is stopped or unavailable, the message remains pending until the assignment is canceled/stale or the bounded queue applies backpressure. V1 has no automatic message TTL or journal compaction; the proposed defaults below bound pending work while retaining accepted journal history.

## 8. Safe delivery and steering semantics

Normal messages are incorporated at a planner safe checkpoint, before selecting the next browser action. The host does not inject message text into an in-flight action or mutate a dispatched action's arguments. Messages enter the planner through a typed field in the existing request context. A new planner proposal kind `send_message` routes through host validation to `sendMessage`; it is not a direct browser action. Both parent and child controllers receive this narrow host callback, while coordinator relationship/direction validation prevents sibling routes, forged sender/recipient IDs, and child delegation. Pending messages are the sender's `message_sent.messageId` set minus the recipient journal's durable `message_turn_consumed.consumedMessageIds` set; there are no authoritative mutable delivered/observed inbox flags.

A queued message with `kind: "steer"` may ask the child to reprioritize, clarify, or narrow work only within the accepted assignment. Before the next action proposal, the host revalidates that the assignment remains active and that `parentGoalVersion`, allowed origin, browser-view ownership, and capabilities still match. A steer cannot expand any of these constraints. It follows the same message identity, queue, context-budget, and acknowledgement rules as other messages.

## 8.1 Context admission budget

Pending messages are not all injected into a planner turn. At each safe checkpoint, the host admits only a deterministic, ordered prefix of eligible messages subject to explicit per-turn count and UTF-8 byte budgets. The implementation must define both limits as finite constants and include envelope/context overhead in the byte calculation. Messages not admitted remain pending for later turns; priority must not allow starvation, and any priority policy must be bounded and deterministic.

**Proposed v1 defaults for review:** admit at most 4 messages per planner turn and at most 8 KiB of serialized message context per turn, whichever limit is reached first. The byte count includes the complete serialized envelopes and handoff fields, not just message text. Thus a single message near the 8 KiB text limit may consume the whole turn budget. Admission must also honor the existing 64 KiB total context-packet ceiling: in journal order, tentatively add each next message and measure the serialized full context packet; stop before the first candidate that exceeds either the 8 KiB message budget or total packet limit. If no pending message fits, admit none and leave all pending; do not turn a message-budget collision into `context_error` or pause the task. Messages not admitted remain pending and visible in queue status. They are never silently discarded or summarized into an instruction that loses provenance.

## 8.2 Handoff and resumable context

A `handoff` message is the bounded, structured summary for a child checkpoint, completion, or parent reassignment. It carries only the context needed to continue work:

- objective and accepted child assignment/version;
- current state and what has or has not completed;
- verified results with durable evidence references, separated from attempts or hypotheses;
- unresolved questions, blockers, and risks;
- one concrete suggested next action.

The host records the originating task, recipient, observation time, and evidence links in the message envelope. Raw transcripts, secrets, credentials, and unrestricted environment dumps are forbidden. A handoff is still untrusted agent-authored context; its suggested next action is not executable authority. The parent verifies important claims against durable task journal/evidence before acting on them.

Messages and handoffs are append-only records. Corrections are new messages linked to the prior message ID; they do not rewrite history. Handoff summaries support restart and transfer between compatible harnesses, but do not become a separate memory vault, task tracker, policy engine, or replacement for the canonical HALO task journal and governed project documentation. ECC Memory Vault itself is not a runtime dependency for this protocol.

If a stop/takeover arrives during a browser dispatch, use existing host-controlled drain/cancel behavior. If the external outcome cannot be established, record an uncertain outcome and require reconciliation; do not automatically retry a potentially non-idempotent action. This protocol does not redefine existing stop or dispatch semantics.

## 9. Authority and provenance rules

- A message is data, not a tool invocation. No content field can directly call a browser action, approve an action, alter policy, mint a capability, or edit a goal.
- The host derives role, sender, recipient, assignment linkage, sequence, and timestamps. Payload claims cannot override them.
- Parent-authored instructions to children are still subject to the accepted child assignment and host capability checks.
- Child-authored reports are untrusted provenance. The parent may use them as leads, but must validate material claims against the child journal/evidence references before treating them as established facts.
- Evidence resolution is host-mediated, authorization-checked, bounded, and read-only in v1. A child cannot use a reference to make the parent fetch arbitrary network content.
- Evidence references use the existing `Evidence.id` namespace and are immutable identifiers bound to an evidence digest and originating task/journal entry, not mutable paths. V1 has no evidence compaction or garbage collection, so references do not expire while the task journal/evidence record is retained. If evidence is unavailable because the task data is externally removed or a future retention feature is introduced, resolution must return explicit `unavailable` (never alias different content); defining expiry/GC mechanics is a separate future dependency, not a v1 feature.
- Messages do not cross task boundaries or survive a replan into a new goal version unless the host explicitly rebinds them under a separately specified migration rule. Default behavior on stale version is reject/quarantine, not reinterpret.

## 10. Resource bounds and loop prevention

V1 enforces bounded message size, bounded per-conversation pending count, bounded evidence references, and a bounded number of steer messages per child per time window. Proposed defaults for review are:

- At most 50 pending messages per parent-child conversation, both directions combined. Enforce this atomically with a conversation-scoped lock spanning pending-count check and durable append; a per-sender lock alone does not prevent simultaneous sends in opposite directions from exceeding the shared cap. A send that would exceed this is rejected as `queue_full`; already accepted records are preserved.
- At most one unobserved `steer` per child. A further steer is rejected as `pending_steer_exists`; it does not replace, merge with, or mark the earlier steer observed.
- At most 3 parent-to-child steer messages per child in any rolling 60-second window.
- At most 4 admitted messages and 8 KiB serialized message context per planner turn, as specified in §8.1.
- Message text at most 8 KiB UTF-8. Existing event/context/planner frame ceilings are 64 KiB.

There is no separate lifetime message-count cap or message TTL in v1. The existing TaskStore byte limit is a hard append ceiling, not journal rotation or eviction: because message events share that task's byte budget with action and recovery events, message traffic can exhaust storage and prevent unrelated task events from being persisted. Treat this as a cross-feature availability risk, surface the existing fail-closed storage error, and measure worst-case journal growth before enabling high-volume messaging. Do not claim that the byte limit is a safe retention policy. Validate proposed values against current store and planner limits before implementation. Constants must be explicit and queue-full behavior must be testable.

The host rejects recursive delegation and sibling routing in v1. The parent may not turn a child reply into an unbounded relay loop. The UI exposes pending, delivered, observed, and failed counts so a stalled queue is visible. Queue-full behavior is explicit rejection with a reason; silent drop is forbidden. Message previews are capped at 200 characters and must not include secrets or unrestricted evidence contents.

## 11. UI and observability contract

Expose a sanitized timeline with message ID (or short display form), direction, kind, host timestamp, delivery state, and bounded text preview. Status APIs return only task IDs already visible to the requesting parent, lifecycle state, queue counts, and relevant failure codes. Do not expose secrets, full environment variables, arbitrary file paths, or other children’s private browser state.

Log transitions such as `message_queued`, `message_delivered`, `message_observed`, `message_rejected`, `message_deduplicated`, `steer_queued`, and `child_stop_requested` with correlation IDs. Logs should record hashes/lengths rather than duplicate sensitive content where feasible. User-facing error codes must distinguish authorization failure, stale assignment, schema/size failure, queue full, stopped recipient, and persistence/reconciliation failure.

## 12. Failure behavior

- **Persistence fails before acceptance:** return failure; do not report queued.
- **Planner-turn journal append fails:** do not validate or handle the proposal generated from that message-bearing turn. Keep those messages unobserved and eligible for at-least-once redelivery; surface the task's persistence failure through existing fail-closed handling.
- **Duplicate send retry:** return the original acceptance/result for the idempotency key when the canonical payload matches; reject same-key/different-payload retries as an idempotency conflict.
- **Malformed or unauthorized route:** reject before touching recipient state.
- **Parent or child restart:** reconstruct mailbox state from durable journals and resume delivery without resuming browser actions implicitly.
- **Stale goal/assignment:** quarantine or reject; never deliver as an active instruction.
- **Queue saturation:** explicit backpressure/rejection; preserve already accepted records.
- **Stalled unobserved steer:** v1 does not replace, merge, or silently consume it. If a child cannot reach a safe planner checkpoint, the user/host can use the separate `stopChild` control as the recovery path; stopping does not imply that the steer was observed or acted on. The UI should show its age/state so the stall is diagnosable.
- **TaskStore capacity exhausted:** append fails under the store's hard byte ceiling. Fail closed using existing persistence-failure handling; this can block unrelated task events in that same journal, not only messaging, and requires operator-visible recovery rather than retrying indefinitely.
- **Crash during action after message observation:** message remains observed, while action outcome uses the existing dispatch recovery/uncertainty protocol.

## 13. Acceptance criteria for a future implementation plan

An implementation is not complete unless tests demonstrate:

1. Only an authenticated parent and its accepted child can exchange messages; siblings and unrelated tasks are rejected.
2. Message size, schema, queue, and rate bounds are enforced without truncation or silent loss.
3. Durable message acceptance and the sender-journal-reconstructed `(senderTaskId, idempotencyKey) → messageId` mapping survive restart; concurrent same-key sends within the single host process serialize, retries return the same ID, and key reuse with a different recipient or payload is rejected.
4. Duplicate delivery is deduplicated across restart and does not cause duplicate message processing.
5. Normal delivery and `steer` occur at safe planner boundaries, never by mutating in-flight browser dispatch; each turn respects count and byte budgets, and a durable `message_turn_consumed` event records admitted `consumedMessageIds` before proposal handling or any resulting browser action dispatch.
6. Stale goal versions and canceled assignments cannot deliver actionable instructions.
7. Child reports and evidence references do not confer authority; evidence resolution is bounded and host-authorized, references use the existing `Evidence.id` namespace, and unavailable evidence never aliases new content. V1 does not implement evidence GC/compaction.
8. Stop/takeover is separate from messaging and preserves uncertain external-action semantics.
9. UI events are sanitized, event-driven, and scoped to the requesting parent.
10. Independent browser-view ownership remains intact: one child does not operate another child’s view.

## 14. Open decisions for implementation planning

1. Exact IPC/internal method names and whether the planner receives messages as a typed observation field or a bounded system-context block. Preferred: a typed `pendingMessages` field.
2. Final bounded message-kind schema and required handoff fields, including whether a handoff is emitted automatically on child completion or only at explicit checkpoints.
3. Confirm proposed pending/rate/per-turn limits in §8.1 and §10 against current planner context and store limits. V1 has no automatic TTL/expiry; stale assignments are quarantined. The shared pending cap requires a conversation-scoped check-plus-append lock in addition to per-sender idempotency serialization.
4. Confirm the exact `send_message` proposal schema. Proposed fields are `recipientTaskId`, `messageKind`, `idempotencyKey`, optional `text`, `handoff`, `evidenceRefs`, and `inReplyToMessageId`; host derives sender, conversation, and goal version. `message_turn_consumed` may include optional correlation to the existing planner-call counter, but must not require a new request-ID subsystem.
5. Future evidence retention/GC behavior if separately designed; v1 references remain tied to retained `Evidence.id` records.
6. UI event names and exact redaction/display policy; preview cap proposed at 200 characters.

Resolve these decisions with the v1 defaults and explicit rulings recorded in the implementation plan/ledger, using current host/store code and failure-injection tests. The user authorized implementation of this protocol and approved its implementation plan; no implementation scope beyond this protocol is authorized.
