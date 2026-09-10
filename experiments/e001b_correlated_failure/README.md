# E001-B — Correlated Trusted-Base Failure

## Question

If two safety metadata sources have the same individual error rate, how much does containment depend on the **independence** of those errors?

## Manipulation

- marginal per-source metadata error `p`: 1%, 5%, 10%, 20%
- cross-source error correlation `rho`: 0, 0.25, 0.5, 0.75, 1.0
- seeds: 30
- synthetic actions per seed/cell: 100,000

`rho=0` means independent errors; `rho=1` means fully common-mode errors in this construction.

## Protocols

- `single_source`: deterministic policy using one metadata source.
- `redundant_fail_closed`: two sources; disagreement blocks writes.

## Main result at p=5%

| rho | Single source failure | Redundant failure | Redundant false block |
| ---: | ---: | ---: | ---: |
| 0.00 | 3.950% | **0.187%** | 6.949% |
| 0.25 | 3.962% | **1.093%** | 6.140% |
| 0.50 | 3.965% | **2.014%** | 5.310% |
| 0.75 | 3.952% | **2.958%** | 4.488% |
| 1.00 | 3.955% | **3.955%** | 3.645% |

The target correlation sanity check at `p=.05, rho=.75` measured `0.749`.

## Scope

This isolates one common-cause-failure assumption in a synthetic environment. It is not evidence that HALO contains frontier or superintelligent systems.
