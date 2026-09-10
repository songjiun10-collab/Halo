# E001 — Trusted-Base Degradation

## Question

How does an external enforcement boundary degrade as policy-relevant trusted metadata becomes incorrect?

## Protocols

- `model_monitor`: deliberately imperfect model-like baseline.
- `deterministic`: deterministic invariant using one metadata observation.
- `halo_redundant`: two independently corrupted observations; disagreement fails closed.

## Sweep

- corruption: 0%, 1%, 2%, 5%, 10%, 20%
- seeds: 20
- synthetic actions per seed/cell: 20,000

## Metrics

- containment failure rate: unsafe actions incorrectly allowed
- false block rate: safe actions incorrectly blocked
- benign success rate

## Scope

This is a toy sensitivity test of trusted metadata quality, not a frontier-model containment result.
