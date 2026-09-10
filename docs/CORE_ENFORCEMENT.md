# HALO Core / Enforcement v0

This slice implements a small, model-agnostic reference-monitor core. It does **not** depend on benchmark outcomes or jailbreak-specific signatures.

## Trust boundary

The model/agent is untrusted. HALO, its policy configuration, telemetry authentication keys, audit authentication key, and protected-tool adapter are trusted. Production deployment must make bypass of the HALO enforcement point impossible; this Python library cannot create process isolation by itself.

## Enforcement path

`PRE -> zero or more LIVE checkpoints -> POST`

Each checkpoint is processed in this order:

1. verify telemetry authenticity, action binding, sequence, and hash-chain continuity;
2. evaluate hard invariants;
3. evaluate ordered policy rules with deny-overrides and default deny;
4. append the decision to an authenticated append-only hash chain;
5. return ALLOW only if all prior steps completed successfully.

Unknown telemetry sources, malformed/tampered/replayed telemetry, invariant exceptions, policy exceptions, unmatched policy, invalid lifecycle transitions, action mutation, and audit unavailability all fail closed.

## Why these choices

- **Complete mediation:** Saltzer & Schroeder argue every access to every object should be checked, and warn against blindly caching authority decisions. PRE/LIVE/POST make mediation explicit over an action lifecycle.
- **PDP/PEP separation:** NIST SP 800-207 separates policy decisions from enforcement at the protected resource boundary. `PolicyEngine` is the decision component; `HALOEnforcer` is the enforcement point.
- **Authenticated telemetry:** enforcement cannot be stronger than the evidence it consumes. The current envelope uses HMAC-SHA256 plus a per-source sequence/hash chain to detect modification, replay, reordering, and source substitution under the stated key-trust assumption.
- **Fail closed:** uncertainty is not converted into permission.
- **Tamper-evident audit:** each JSONL record is canonically serialized, hash chained, and HMAC authenticated.

## Non-guarantees

The audit file alone is not deletion-proof or rollback-proof if an attacker controls the filesystem and can replace the entire file with an older valid prefix. Production deployments should periodically export or anchor the audit head to a separately trusted sink. HMAC integrity also assumes the keys remain outside the untrusted model/agent boundary.

`POST` cannot retroactively prevent side effects that already occurred. Irreversible effects therefore need PRE and, for long-running actions, LIVE mediation before the effect boundary.

The current telemetry verifier deliberately requires one contiguous sequence per trusted source. Concurrent producers sharing one source identity must serialize emission or use distinct source identities.

## Prior work checked before implementation

- Saltzer & Schroeder, *The Protection of Information in Computer Systems* (1975): complete mediation, least privilege, open design.
- NIST SP 800-207, *Zero Trust Architecture* (2020): policy decision point / policy enforcement point separation and per-request authorization.
- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging* (USENIX Security 2009): authenticated history structures and scaling limits of simple hash chains.
- *An Organization-Scoped LLM Agent Runtime Architecture for Regulated Cybersecurity Operations* (2026): typed security context, enforcement at component/tool boundaries, and append-only audit for model-agnostic agent runtimes.
- *Agent Flight Recorder* (2026): structured action records and tamper-evident audit trails for tool-using agents.

The last two are recent preprints and are architectural references, not evidence that HALO itself is secure.

## Public API

- `Action`, `Phase`, `Verdict`, `EnforcementDecision`
- `Invariant`, `InvariantEngine`
- `PolicyRule`, `PolicyEngine`
- `TelemetryEnvelope`, `TelemetryVerifier`
- `HashChainAuditLog`
- `HALOEnforcer`

## Minimal integration shape

A protected adapter should construct an immutable `Action`, obtain telemetry from a trusted source, call `pre()`, and execute nothing unless the decision is ALLOW. Long-running actions should call `live()` at relevant effect boundaries. Completion/failure state should be passed through `post()` for final policy/invariant evaluation and audit.

The protected tool/resource must not remain directly reachable from the untrusted model, otherwise complete mediation is not satisfied.
