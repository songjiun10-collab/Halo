# HALO authority / delegation / information-flow hardening

This follow-up layer extends the Core/Enforcement reference monitor without using benchmark outcomes or jailbreak signatures. It assumes the model/agent may already be compromised and focuses on preventing compromised reasoning from acquiring or propagating authority.

## Prior work checked first

- *Capability Gates Are Not Authorization: Confused-Deputy Failures in LLM Agent Frameworks* (arXiv:2606.28679): tool exposure is not equivalent to deterministic per-call authorization over concrete values.
- *AgentFlow: A Flow-Centric Policy Language and Framework for Securing LLM Agent Systems* (arXiv:2608.22868): runtime policies should constrain labeled data flows, task-scoped capabilities, and authority crossing delegation boundaries.
- *SPA: Securing Persistent LLM Agents Across Queries with Plan-First Information-Flow Control* (arXiv:2608.27234): integrity/confidentiality labels should survive planning, execution, and cross-query state reuse.
- *Securing LLM-Agent Long-Term Memory Against Poisoning: Non-Malleable, Origin-Bound Authority with Machine-Checked Guarantees* (arXiv:2606.24322): authority must remain bound to non-malleable origin information; summarization, trusted-tool echo, and manufactured corroboration can otherwise launder untrusted memory origins.

These papers motivate the structure below; they are not evidence that this implementation is secure.

## Added invariants

### `delegation_chain_invariant()`

Authenticated runtime telemetry supplies a root subject/scope and a delegation chain. Every hop must:

- name the previous delegate as its delegator;
- use non-empty operation/resource scopes;
- keep both scopes as subsets of the previous hop;
- stay within a bounded delegation depth.

The final delegate must equal `Action.subject`, and the concrete operation/resource must be inside the final narrowed scope. A delegate can therefore receive less authority but cannot amplify its parent authority.

### `attribute_authorization_invariant()`

Tool availability alone does not authorize arbitrary concrete arguments. Trusted telemetry may constrain top-level `Action.attributes` through:

- `exact` values;
- `allowed` value sets;
- `numeric_min`;
- `numeric_max`.

Missing attributes, malformed constraints, booleans presented as numeric values, and out-of-range values fail closed.

### `origin_bound_authority_invariant()`

For each security-sensitive control field, trusted instrumentation provides both `roots` and `current` provenance. Both must stay within the configured trusted-origin set.

This intentionally prevents origin laundering: content that began as external data or persistent memory cannot become control authority merely because a later summary, tool echo, retrieval, or plan is represented as trusted-looking content.

### `information_flow_invariant()`

Trusted telemetry supplies labels carried by data participating in an action and an allow-map from concrete sink/resource to labels permitted at that sink. All observed labels must be allowed for `Action.resource`; a missing sink policy fails closed.

This is deliberately small and deterministic. It is not a full taint-tracking runtime; trusted instrumentation is responsible for assigning/preserving labels across data transformations.

## Trust assumptions

The invariants only have meaning if delegation records, authority lineage, attribute constraints, and information-flow labels are produced by trusted runtime instrumentation and authenticated by HALO telemetry. Model text, tool output, retrieved content, peer-agent messages, and persistent memory cannot self-assert trusted labels or widen scopes.

The protected tool/resource must remain reachable only through the HALO enforcement point. These invariants do not create OS/process isolation and do not undo side effects after execution.

## Test strategy

Tests cover both direct invariant evaluation and the end-to-end `HALOEnforcer.pre()` path. Negative cases include privilege amplification, broken delegation identity chains, concrete-value overreach, origin laundering, and secret-labeled data flowing to a sink whose trusted policy allows only public data.
