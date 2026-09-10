# E002 — Shared Blind Spots

## Question

Can monitors appear diverse on known attack families yet share a missing-evidence
blind spot that makes the ensemble fail on an unseen family?

## Setup

Three synthetic monitors specialize on different known attack families (`A/B/C`).
They therefore have complementary behavior on the validation distribution.

All three, however, lack the evidence required to recognize a held-out family `H`.
A fourth monitor receives an independent evidence channel that is informative for `H`.

Protocols:

- `single_m1`: one specialist monitor.
- `algorithm_diverse`: average of the three algorithmically diverse monitors.
- `evidence_diverse`: the algorithmic ensemble plus the independent evidence channel,
  combined fail-closed style.

Every protocol is independently calibrated to a 10% false-positive rate on benign data.

We then sweep the fraction of attacks belonging to held-out family `H` from 0% to 100%.

## Interpretation

This is a synthetic counterexample to a strong interpretation of monitor diversity:
low correlation or complementary performance on *observed* attack families does not
establish independence from an unobserved shared blind spot.

It does not show that any existing monitor ensemble has this failure mode, and it is
not a frontier-model containment result.
