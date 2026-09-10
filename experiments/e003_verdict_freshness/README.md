# E003 — Verdict Freshness / Stale-State Enforcement

## Prior-work check

This is a replication/extension-style sanity test, **not a novelty claim**. Closest prior work includes *Approved Too Late: Verdict Staleness in LLM-Guarded Self-Adaptive Systems* (arXiv:2608.26306), *Stateful Governance for Concurrent Agentic Systems* (arXiv:2608.02764), and *Policy-Invisible Violations in LLM-Based Agents* (arXiv:2604.12177).

The fixed-window controller below is **not** an implementation of the Freshness-Bounded Shield from *Approved Too Late*. It is intentionally simpler: a TTL-like baseline that bounds cached-verdict age.

## Question

How fast does containment degrade when an approval is correct at check time but policy-relevant state changes before use?

## Sweep

- delay: 0, 1, 2, 4, 8, 16 synthetic steps
- per-step state volatility: 0.5%, 1%, 2%, 5%
- 30 seeds
- 100,000 synthetic actions per cell
- fixed freshness window: 2 synthetic steps

## Protocols

- `cached_verdict`: authorize once, execute later
- `use_time_revalidation`: re-check against use-time state; perfect oracle control in this synthetic model
- `fixed_window_revalidation`: reuse a cached verdict while its age is at most two steps; refresh when the next use would exceed that bound. The refreshed verdict can become stale again before final use.

## Main result at 2% volatility

| Delay | Cached failure | Fixed-window failure | Use-time revalidation |
| ---: | ---: | ---: | ---: |
| 0 | 0.000% | 0.000% | 0.000% |
| 1 | 3.740% | 3.740% | 0.000% |
| 2 | 7.120% | 7.120% | 0.000% |
| 4 | 12.893% | 3.272% | 0.000% |
| 8 | 21.671% | 5.656% | 0.000% |
| 16 | 32.537% | 2.326% | 0.000% |

At delay 8 and 2% volatility, **9.678% of check-time approvals had expired before use**. With a two-step fixed freshness window, the latest cached verdict is two steps old at use time after two intermediate revalidations, so containment failure remains non-zero rather than collapsing to the oracle control.

## Scope

This is a synthetic policy/state experiment. Use-time revalidation is perfect by construction here, so its zero failure rate is a control, not an empirical claim about real enforcement systems. The fixed-window baseline isolates the cost of bounded staleness; it does not model imperfect state observation, policy-evaluation errors, revalidation latency, or concurrent commits.
