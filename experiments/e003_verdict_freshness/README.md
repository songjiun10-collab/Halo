# E003 — Verdict Freshness / Stale-State Enforcement

## Prior-work check

This is a replication/extension-style sanity test, **not a novelty claim**. Closest prior work includes *Approved Too Late: Verdict Staleness in LLM-Guarded Self-Adaptive Systems* (2026), *Stateful Governance for Concurrent Agentic Systems* (2026), and *Policy-Invisible Violations in LLM-Based Agents* (2026).

## Question

How fast does containment degrade when an approval is correct at check time but policy-relevant state changes before use?

## Sweep

- delay: 0, 1, 2, 4, 8, 16 synthetic steps
- per-step state volatility: 0.5%, 1%, 2%, 5%
- 30 seeds
- 100,000 synthetic actions per cell

## Protocols

- `cached_verdict`: authorize once, execute later
- `use_time_revalidation`: re-check against use-time state
- `freshness_bounded`: cached approval is valid for at most two synthetic steps, then revalidate

## Main result at 2% volatility

| Delay | Cached failure | Freshness-bounded | Use-time revalidation |
| ---: | ---: | ---: | ---: |
| 0 | 0.000% | 0.000% | 0.000% |
| 1 | 3.740% | 3.740% | 0.000% |
| 2 | 7.120% | 7.120% | 0.000% |
| 4 | 12.893% | 0.000% | 0.000% |
| 8 | 21.671% | 0.000% | 0.000% |
| 16 | 32.537% | 0.000% | 0.000% |

At delay 8 and 2% volatility, **9.678% of check-time approvals had expired before use**.

## Scope

This is a synthetic policy/state experiment. Revalidation is perfect by construction here, so its zero failure rate is a control, not an empirical claim about real enforcement systems.