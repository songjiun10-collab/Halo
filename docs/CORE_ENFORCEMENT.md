# HALO Core / Enforcement v0

This slice implements a small, model-agnostic reference-monitor core. It does **not** depend on benchmark outcomes or jailbreak-specific signatures.

## Trust boundary

The model/agent is untrusted. HALO, policy configuration, telemetry/audit authentication keys, the protected-tool adapter, and trusted runtime instrumentation are trusted. Production deployment must make bypass of the HALO enforcement point impossible; this Python library does not create process isolation by itself.

## Enforcement path

`PRE -> zero or more LIVE checkpoints -> POST`

Each mediated checkpoint:

1. verifies telemetry authenticity, full-action binding, session/freshness, sequence, and chain continuity;
2. evaluates hard invariants;
3. evaluates deny-overrides/default-deny policy;
4. commits the decision to the authenticated audit history;
5. returns ALLOW only after every required step succeeds.

Unknown, malformed, tampered, replayed, stale, misbound, or out-of-order evidence; invariant/policy errors; lifecycle races; action/resource mutation; capacity exhaustion; and audit failures all fail closed.

## Immutable and fully bound authorization inputs

`Action.attributes` and telemetry payloads are recursively snapshotted into immutable JSON-like values. Mapping keys must be strings and non-finite floats (`NaN`, `+/-inf`) are rejected before they can reach authorization hashing.

Every `TelemetryEnvelope` contains an authenticated SHA-256 digest of the **complete canonical `Action`**: action ID, subject, operation, resource, and attributes. Reusing valid telemetry with a different action that merely shares the same ID therefore fails before policy evaluation.

## Provenance, capability, and resource binding

`control_provenance_invariant()` restricts security-sensitive `subject`, `operation`, and `resource` control fields to configured trusted origins. The default trusted origins are `runtime`, `user_intent`, and `trusted_plan`. Model output, tool output, external data, memory, retrieval output, MCP/tool descriptors, peer-agent messages, and perception-derived content remain untrusted control inputs by default.

`capability_scope_invariant()` separately constrains the authenticated subject, operation, and resource scope.

`resource_binding_invariant()` compares decoded SHA-256 digest bytes for the approved and runtime-observed resource/tool descriptor, so equivalent upper/lowercase hexadecimal encodings compare correctly while real descriptor mutation fails closed.

Provenance labels, capabilities, and observed resource digests must come from trusted instrumentation; HALO does not trust a model, tool, peer agent, or remote server to self-declare privilege.

## Telemetry replay and freshness

Every envelope carries authenticated `session_id` and `issued_at_ms`. The verifier rejects wrong sessions, expired evidence, excessive future skew, gaps, reordering, replay, and chain substitution.

The trusted runtime **must generate a fresh, non-reused session identifier for every verifier/process lifetime**. If that cannot be guaranteed, durable trusted replay state is required instead.

Within a process, replay-state read/check/update is serialized so two concurrent copies of the same next envelope cannot both verify successfully.

## Lifecycle concurrency and bounded state

PRE reservation is atomic. A per-action lock is acquired before the state becomes visible, preventing concurrent PRE/LIVE/POST calls from observing a partially authorized lifecycle.

Only active actions stay in `_state`; completed or denied action IDs move to a bounded, expiring recent-ID set. `max_active_actions` is a hard fail-closed capacity rather than an eviction policy. Recent-ID retention is bounded by both capacity and TTL, preventing unbounded memory growth.

The permanent uniqueness guarantee therefore applies only while an action is active or retained in the recent-ID window. Replay protection beyond that window relies on authenticated session/sequence telemetry and deployment-level idempotency for external side effects.

## Audit commit protocol

Audit events are recursively snapshotted once before hashing and serialization. A caller cannot mutate nested metadata between the hash operation and the bytes written to disk.

The log uses:

- canonical JSONL records;
- SHA-256 hash chaining and HMAC authentication;
- an OS-backed cross-instance/process append lock;
- an HMAC-authenticated `.head` checkpoint containing committed count, head hash, and byte length.

The checkpoint is the **commit point**. An append writes and `fsync()`s the record first, then atomically replaces the authenticated checkpoint. If record durability or checkpoint commit fails, HALO truncates the log back to the previously committed byte length. On restart, bytes beyond the authenticated checkpoint are treated as an uncommitted tail and removed rather than promoted.

A non-empty audit file with no authenticated checkpoint fails closed. Steady-state appends use the authenticated checkpoint and are O(1) in history length; startup and explicit `verify_file()` still perform O(N) full-history verification.

This trades per-request full-history rescans for an authenticated committed head. Consequently, same-length retroactive modification of already committed historical bytes is detected by startup/explicit verification, not by every steady-state append. Production deployments should protect the log/checkpoint storage and export or anchor committed heads to a separately trusted/WORM sink.

The local log and checkpoint can still be rolled back together by an attacker who controls the filesystem. External head anchoring is required to detect whole-prefix rollback.

## Configuration validation

Hard invariants and policy rules require non-empty, typed phase sets. A malformed empty invariant phase set cannot silently disable a safety invariant. Policy effects must be actual `Verdict` values.

## Prior work checked before implementation

- Saltzer & Schroeder, *The Protection of Information in Computer Systems* (1975): complete mediation and least privilege.
- NIST SP 800-207, *Zero Trust Architecture* (2020): policy decision/enforcement separation and per-request authorization.
- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging* (USENIX Security 2009): authenticated history structures and limits of naive hash-chain verification.
- Prompt-injection and agent-security literature summarized in `PAPER_ATTACK_COVERAGE.md`, including control/data separation, persistent-memory poisoning, RAG poisoning, MCP/tool poisoning, multi-agent propagation, and multimodal/perception injection.
- Recent agent-runtime/audit architectures are treated as architectural references, not evidence that HALO itself is secure.

## Public API

- `Action`, `Phase`, `Verdict`, `EnforcementDecision`
- `Invariant`, `InvariantEngine`
- `PolicyRule`, `PolicyEngine`
- `TelemetryEnvelope`, `TelemetryVerifier`
- `Origin`, `CapabilityScope`
- `control_provenance_invariant`, `capability_scope_invariant`, `resource_binding_invariant`
- `HashChainAuditLog`
- `HALOEnforcer`

## Minimal integration shape

A trusted adapter constructs the immutable `Action`, produces telemetry over that exact action, calls `pre()`, and performs no protected side effect unless ALLOW is returned. Long-running actions call `live()` at meaningful effect boundaries, and completion/failure is passed through `post()`.

The protected tool/resource must not remain directly reachable from the untrusted model; otherwise complete mediation is not satisfied.
