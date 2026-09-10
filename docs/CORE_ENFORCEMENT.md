# HALO Core / Enforcement v0

This slice implements a small, model-agnostic reference-monitor core. It does **not** depend on benchmark outcomes or jailbreak-specific signatures.

## Trust boundary

The model/agent is untrusted. HALO, its policy configuration, telemetry authentication keys, audit authentication key, protected-tool adapter, and the runtime that assigns provenance/session identifiers are trusted. Production deployment must make bypass of the HALO enforcement point impossible; this Python library cannot create process isolation by itself.

## Enforcement path

`PRE -> zero or more LIVE checkpoints -> POST`

Each checkpoint is processed in this order:

1. verify telemetry authenticity, action binding, non-reused runtime session, issuance freshness, sequence, and hash-chain continuity;
2. evaluate hard invariants;
3. evaluate ordered policy rules with deny-overrides and default deny;
4. append the decision to an authenticated append-only hash chain;
5. return ALLOW only if all prior steps completed successfully.

Unknown telemetry sources, malformed/tampered/replayed/stale telemetry, invariant exceptions, policy exceptions, unmatched policy, invalid lifecycle transitions, action mutation, resource/descriptor mutation, and audit unavailability all fail closed.

## Immutable authorization inputs

`Action` attributes and authenticated telemetry payloads are recursively snapshotted into immutable JSON-like structures. This prevents a caller from changing nested values after authorization or between telemetry verification and policy/invariant evaluation.

Canonical serialization rejects non-string mapping keys rather than coercing them. This keeps the authenticated representation injective with respect to mapping key types and avoids collisions such as a string key and a numerically typed key normalizing to the same text.

## Provenance, capability, and resource binding

`control_provenance_invariant()` keeps security-sensitive `subject`, `operation`, and `resource` control fields restricted to configured trusted origins. The default trusted set is `runtime`, `user_intent`, and `trusted_plan`. Model output, tool output, external data, memory, retrieval output, MCP/tool descriptors, peer-agent messages, and perception-derived content remain untrusted control inputs by default.

`capability_scope_invariant()` separately constrains the authenticated subject, operation, and resource scope. Passing provenance checks therefore does not imply broad authority.

`resource_binding_invariant()` binds an approved SHA-256 resource/descriptor digest to the digest observed by trusted runtime instrumentation at enforcement time. A changed or malformed binding fails closed. This covers approval-to-use mutation surfaces such as a tool descriptor changing after review.

Provenance labels, capability metadata, and observed resource digests must come from trusted instrumentation; HALO does not trust a model, tool, peer agent, or remote server to self-declare its own privilege.

## Telemetry session and freshness model

Every `TelemetryEnvelope` carries an authenticated `session_id` and `issued_at_ms`. `TelemetryVerifier` requires a configured session identifier and rejects envelopes from any other session, envelopes older than `max_age_ms`, and envelopes too far in the future.

The trusted runtime **must generate a fresh, non-reused session identifier for every verifier/process lifetime**. This is the restart replay defense: a valid envelope captured from a previous process lifetime cannot be accepted by the new verifier even though the in-memory sequence head was reset. If a deployment cannot guarantee non-reused sessions, it must instead provide durable trusted replay state before relying on this property.

Within one session, per-source sequence and digest chaining detect replay, gaps, reordering, and chain substitution. Concurrent producers sharing one source identity must serialize emission or use distinct source identities.

## Audit concurrency and durability

Audit records are canonical JSONL records with SHA-256 hash chaining and HMAC authentication. Appends take an OS-backed sidecar lock, re-verify/refresh the current head while that lock is held, then append and `fsync()` before returning. This prevents separate `HashChainAuditLog` instances/processes that opened the same path from independently appending conflicting sequence numbers.

The audit file alone is still not deletion-proof or rollback-proof if an attacker controls the filesystem and can replace the entire file with an older valid prefix. Production deployments should periodically export or anchor the audit head to a separately trusted sink.

## Why these choices

- **Complete mediation:** Saltzer & Schroeder argue every access to every object should be checked, and warn against blindly caching authority decisions. PRE/LIVE/POST make mediation explicit over an action lifecycle.
- **PDP/PEP separation:** NIST SP 800-207 separates policy decisions from enforcement at the protected resource boundary. `PolicyEngine` is the decision component; `HALOEnforcer` is the enforcement point.
- **Authenticated, fresh telemetry:** enforcement cannot be stronger than the evidence it consumes. HMAC-SHA256 authenticates envelopes; session binding, timestamp bounds, sequence numbers, and digest chaining constrain replay and staleness under the stated trusted-runtime assumptions.
- **Fail closed:** uncertainty or malformed evidence is not converted into permission. Even verifier exceptions are converted to DENY at the public enforcement path.
- **Strict policy effects:** `PolicyRule.effect` must be an actual `Verdict`; dynamically loaded strings cannot silently fall through into an allow path.
- **Tamper-evident audit:** each JSONL record is canonically serialized, hash chained, HMAC authenticated, cross-instance serialized, and flushed before ALLOW is returned.
- **Control/data separation:** content can remain usable as data while being denied authority over security-sensitive control fields.
- **Approval/use binding:** mutable tools or resources are re-bound to an authenticated digest rather than trusting an earlier description indefinitely.

## Non-guarantees

HMAC integrity assumes keys remain outside the untrusted model/agent boundary. Session replay resistance assumes session identifiers are generated by trusted runtime code and never reused across process lifetimes. Provenance and resource-binding guarantees assume trusted instrumentation labels and hashes the real data/tool/resource seen at the protected boundary.

`POST` cannot retroactively prevent side effects that already occurred. Irreversible effects therefore need PRE and, for long-running actions, LIVE mediation before the effect boundary.

A Python object being immutable does not create OS/process isolation. The protected tool/resource must remain unreachable except through the HALO enforcement point.

## Prior work checked before implementation

- Saltzer & Schroeder, *The Protection of Information in Computer Systems* (1975): complete mediation, least privilege, open design.
- NIST SP 800-207, *Zero Trust Architecture* (2020): policy decision point / policy enforcement point separation and per-request authorization.
- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging* (USENIX Security 2009): authenticated history structures and scaling limits of simple hash chains.
- Prompt-injection and agent-security literature summarized in `PAPER_ATTACK_COVERAGE.md`, including control/data separation, persistent-memory poisoning, RAG poisoning, tool/MCP poisoning, multi-agent propagation, and multimodal/perception injection.
- Recent model-agnostic agent runtime/audit architectures are used as architectural references, not evidence that HALO itself is secure.

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

A protected adapter should construct an immutable `Action`, obtain telemetry from a trusted source bound to the current non-reused runtime session, call `pre()`, and execute nothing unless the decision is ALLOW. Long-running actions should call `live()` at relevant effect boundaries. Completion/failure state should be passed through `post()` for final policy/invariant evaluation and audit.

For mutable tool/resource definitions, trusted runtime instrumentation should hash the approved descriptor and the descriptor actually observed at the effect boundary and provide both through authenticated telemetry for `resource_binding_invariant()`.

The protected tool/resource must not remain directly reachable from the untrusted model, otherwise complete mediation is not satisfied.
