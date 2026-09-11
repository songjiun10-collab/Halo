# HALO external validation protocol

This document is frozen before held-out outcome inspection.

## Threat model

HALO is evaluated as an effect-boundary authority layer, not as a prompt classifier. The model and any untrusted tool/retrieval text may be compromised. Protected side effects must be reachable only through the HALO adapter.

## Primary comparison

Use the same AgentDojo version, task suites, model/version, attack configuration, seeds/repeats, and tool environment for every arm:

1. undefended agent;
2. applicable benchmark-native defense;
3. CaMeL when reproducible for the selected configuration;
4. HALO effect-boundary mediation.

No HALO Core or policy change may be made after held-out outcomes are inspected. Adapter bugs may be fixed only with a documented invalidation and full rerun of all affected arms.

## Primary metrics

Report exact numerators and denominators for:

- benign task success rate;
- attack success rate;
- secure task completion rate;
- HALO enforcement bypass count;
- fail-closed count;
- deny count;
- enforcement overhead p50/p95/p99.

A denied attack that also destroys the legitimate task is not counted as a clean win; security and utility are reported together.

## Effect-boundary invariant

The protected callable is owned by the adapter and invoked only after HALO PRE returns a committed ALLOW. A DENY must leave the callable unexecuted. Tool arguments are snapshotted into the HALO Action before authorization.

## Benchmark saturation caveat

AgentDojo is useful for comparability but is not sufficient evidence by itself. Bhagwatkar et al. (2025), *Indirect Prompt Injections: Are Firewalls All You Need, or Stronger Benchmarks?* reports that simple agent-tool firewalls can saturate several existing public benchmarks while still being bypassable in practice. Therefore a strong AgentDojo result must not be described as general prompt-injection security.

After the primary frozen comparison, run a separately labeled adaptive/stronger evaluation. Do not use those outcomes to tune the frozen primary result.

## Claim gate

Do not claim superiority over CaMeL, AgentDojo-native defenses, Anthropic, OpenAI, or any production safety stack unless the compared implementation and conditions are genuinely equivalent and reproducible. A zero observed ASR is reported as `0 / N observed`, never as proof of zero true risk.
