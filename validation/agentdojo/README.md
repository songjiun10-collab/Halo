# HALO × AgentDojo validation protocol

This directory defines the external-validation contract for HALO. It deliberately keeps benchmark results separate from Core/Enforcement design so benchmark scores cannot tune the trusted computing base.

## Why AgentDojo

AgentDojo is a dynamic benchmark for tool-using LLM agents under prompt injection. It evaluates both legitimate user-task utility and attacker injection goals across realistic suites. Its runner supports custom defenses through module loading, making it suitable for a HALO adapter without modifying benchmark tasks.

## Primary comparisons

Run the same model, benchmark version, task set, attack set, and random/retry policy for:

1. `none` — undefended agent.
2. `agentdojo-native` — strongest applicable benchmark-native defense selected before observing HALO results.
3. `camel` — CaMeL when a reproducible configuration for the same benchmark/model is available.
4. `halo` — HALO enforcement adapter.

Do not tune HALO Core/Enforcement from benchmark outcomes. Changes motivated by benchmark failures belong in a separate experimental layer until justified by a general invariant and independent regression evidence.

## Required metrics

For every configuration record:

- benign user-task success rate (utility);
- injection/attack success rate;
- secure task completion: user task succeeds while attacker goal fails;
- HALO deny count and deny reason distribution;
- enforcement bypass count (a protected effect occurs without a committed HALO ALLOW);
- fail-closed count;
- p50 / p95 / p99 HALO enforcement overhead;
- total wall-clock runtime and model-call count when available.

Report exact numerators and denominators, not percentages alone.

## Integrity rules

- Pin AgentDojo version/commit and HALO commit.
- Persist the exact benchmark CLI/configuration and environment metadata.
- Store raw benchmark outputs unchanged; derive summaries into a separate artifact.
- Never copy attack payloads into HALO Core tests. Core regressions use sanitized structural trust transitions only.
- Benchmark adapters may observe benchmark objects but must not weaken HALO's trust boundary.
- Protected side effects must be reachable only through the HALO-mediated adapter during `halo` runs.
- A run is invalid if telemetry/authentication keys or trusted provenance labels are model-controlled.

## Acceptance gates

The first validation pass is evidence collection, not a ship claim. A later comparative claim requires all of:

1. zero observed enforcement bypasses in the measured run;
2. attack success lower than the undefended condition;
3. benign utility reported alongside security, with confidence intervals where sample size permits;
4. reproducible pinned commands/configuration;
5. no Core/Enforcement change selected after inspecting the held-out evaluation results.

## Planned split

Use a development subset only for adapter correctness and instrumentation. Freeze the adapter and HALO configuration before the held-out comparative run. The held-out results are read only after the freeze commit is recorded.
