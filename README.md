# HALO

HALO is an experimental AI-safety research project investigating **model-agnostic containment**: how an external safety boundary behaves when the model it contains is treated as untrusted.

The project is intentionally empirical. Claims are limited to explicit threat models and measured assumptions; toy results are not evidence of frontier-model or superintelligence containment.

## Research workflow

1. Check the closest prior work first.
2. State the trusted assumptions and threat model.
3. Build the smallest experiment that can falsify the claim.
4. Record both safety and usefulness costs.
5. Stress the assumptions, especially common-mode failures.
6. Only then generalize the containment design.

## Current experiments

| Experiment | Question | Key result |
| --- | --- | --- |
| `E001` | How does containment degrade as trusted metadata becomes wrong? | Deterministic enforcement degraded with metadata corruption; redundant fail-closed evidence reduced containment failures but increased false blocks. |
| `E001-B` | Does redundancy still help when safety evidence fails in correlated ways? | At 5% marginal metadata error, redundant failure rate rose from **0.187% at ρ=0** to **3.955% at ρ=1**, eliminating the redundancy benefit. |

### E001-B headline

With each source held at the same 5% marginal error rate:

| Cross-source error correlation | Single source | Redundant fail-closed |
| ---: | ---: | ---: |
| 0.00 | 3.950% | **0.187%** |
| 0.25 | 3.962% | **1.093%** |
| 0.50 | 3.965% | **2.014%** |
| 0.75 | 3.952% | **2.958%** |
| 1.00 | 3.955% | **3.955%** |

This supports a narrow engineering lesson for the toy setting:

> Redundancy without failure independence is not redundancy.

It is **not** a general theorem about AI containment.

## Reproduce

Python 3.11+ is recommended.

```bash
python -m pip install -r requirements.txt

cd experiments/e001_trusted_base
python run_sweep.py
pytest -q

cd ../e001b_correlated_failure
python run_sweep.py
pytest -q
```

Generated CSVs and figures are committed under each experiment's `results/` directory so reported numbers can be inspected without rerunning the sweep.

## Safety scope

The current experiments use synthetic resources, synthetic policies, and simulated metadata corruption. They do not access external systems, credentials, networks, or real targets.

## Status

Early research prototype. No containment guarantee is claimed.
