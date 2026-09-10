# E004 — Robust Evaluation Under Subgroup Shift

## Prior-work check

This is a replication/extension-style sanity test, **not a novelty claim**. See `PRIOR_WORK.md` for StrongREJECT, JailbreakBench, and Adversarial Prompt Evaluation.

## Question

Can a strong aggregate attack-detection score hide a weak attack subgroup, and what benign false-positive cost appears when threshold selection explicitly protects the worst subgroup?

## Setup

Synthetic monitor scores only; there are no real jailbreak prompts or harmful payloads in this experiment.

- benign examples: 100,000
- known-family attacks: 80,000
- hard-family attacks: 20,000
- development attack mix: 80% known / 20% hard
- threshold sweep: 0.05 to 0.95 in 0.005 increments
- fixed seed: 7

Two selection rules are compared:

- `accuracy_optimal`: maximize a 50/50 benign-vs-attack accuracy objective on the development mix
- `worst_group_constrained`: maximize the minimum per-family TPR while requiring benign FPR <= 10%

## Main result

| Selector | Threshold | Benign FPR | Aggregate attack TPR | Known-family TPR | Hard-family TPR |
| --- | ---: | ---: | ---: | ---: | ---: |
| Accuracy-optimal | 0.495 | **5.058%** | 88.579% | 99.140% | **46.335%** |
| Worst-group constrained | 0.445 | 9.645% | **91.406%** | 99.743% | **58.060%** |

The aggregate development score hides a much weaker subgroup: 88.6% overall attack TPR coexists with only 46.3% TPR on the hard family.

The worst-group rule improves the hard family by 11.7 percentage points, but benign false positives rise from 5.1% to 9.6%. This is the intended trade-off: HALO should report safety and usefulness costs together rather than declaring a threshold "better" from one number.

## Distribution-shift stress

The thresholds are frozen, then only the share of the hard attack family changes.

| Hard-family share | Accuracy-optimal attack TPR | Worst-group constrained attack TPR |
| ---: | ---: | ---: |
| 0% | 99.140% | 99.743% |
| 25% | 85.939% | 89.322% |
| 50% | 72.738% | 78.901% |
| 75% | 59.536% | 68.481% |
| 100% | 46.335% | 58.060% |

This synthetic counterexample shows why a single aggregate score is insufficient when attack-family prevalence can shift.

## Reproduce

```bash
python run_sweep.py
pytest -q
```

`run_sweep.py` regenerates `results/summary.json`.

## Scope

This experiment does **not** evaluate a real guardrail, a real model, or a real jailbreak corpus. It isolates evaluation behavior using synthetic score distributions. Its purpose is to define reporting invariants that can later be applied to HALO's real regression corpus: benign FPR, per-family TPR, worst-family TPR, aggregate TPR, and fixed-threshold distribution-shift stress.
