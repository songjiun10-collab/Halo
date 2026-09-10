# HALO Breaker — schema / normalization gaps

This benchmark attacks HALO's **own normalized event schema and policy boundary**, not any external system. It contains no jailbreak payloads, credentials, real targets, exploit strings, or executable attack procedures.

## Prior-work motivation

SLEIGHT-Bench shows that monitor failures often come from missing state, authorization confusion, omission, and assumptions rather than obvious malicious strings. Policy-Invisible Violations / PhantomPolicy similarly emphasizes that correct enforcement can depend on policy-relevant entity attributes, contextual state, and session history that are absent or inconsistently represented at decision time.

## Breaker → builder → breaker result

The initial breaker pass against the earlier `safety-cases` core allowed **9/9 harmful schema-gap cases** and returned `REVIEW` for one benign dependency-control sequence.

After the first builder hardening in `7278272e`, **6/9** harmful cases still returned `ALLOW`.

After the second generalized hardening in `92469c3b`, the same breaker fixture set falls to **4/9 harmful cases returning `ALLOW`**. Two more gaps are closed without changing the breaker fixtures:

- unknown/invalid normalized scope values now surface as policy-critical telemetry uncertainty;
- inconsistent or invalid data-classification metadata now surfaces as policy-critical telemetry uncertainty.

The four remaining allowed families are:

1. external-write action aliases that arrive without a normalized effect classification;
2. privilege-changing action aliases outside the closed action-name set;
3. approvals not bound to the approved target/scope/state tuple;
4. missing required-precondition / negative-event invariants.

The benign dependency-control sequence still returns `REVIEW`, so the trace-global provenance coupling false positive remains open.

## Builder-facing generalized fixes

Do **not** patch literal case names. Generalize around:

- canonical effect capabilities instead of raw action-string allow/deny sets;
- approval tokens bound to action identity, target identity/scope, policy version and state version;
- provenance dependency graphs rather than a trace-global sticky flag;
- negative / required-event invariants for omissions.

Already-closed generalized classes should remain covered by regression tests:

- invalid/missing policy-critical scope and provenance metadata fail closed;
- cross-field data classification disagreements fail closed;
- classified external writes require destination telemetry and independent approval;
- artifact-digest obligations are presence-based rather than truthiness-based.

The 9→6→4 reduction is a tiny abstract regression result, not a containment proof or frontier-model claim. The useful signal is that generalized builder changes close previously hidden structural gaps while the breaker fixture set stays fixed.
