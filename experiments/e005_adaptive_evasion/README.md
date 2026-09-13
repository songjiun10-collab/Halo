# E005 — Adaptive Evasion via Binary Verdict Feedback

## Question

Can an untrusted model that receives only an allow/block verdict escalate its
evasion of a monitor over repeated queries — and does simply *re-randomising*
the monitor stop it?

## Setup

The adversary controls two coordinates of generated content:

- `harm` — the true unsafe signal (the thing the policy wants to block).
- `look` — a benign-looking correlate the monitor can also read.

The monitor computes a linear score `w0 * harm + (1 - w0) * look`, calibrated
every round to a 10% false-positive rate on benign content, and blocks content
whose score exceeds the threshold.

The adversary is a black-box population optimiser. Each round it proposes a
population of content, observes only "allowed" or "blocked", keeps the allowed
content with the highest intrinsic harm, mutates it (pushing harm up), and
resamples. It can therefore route harm behind the benign-looking correlate —
but it never sees the monitor's weights.

Two arms, identical except for one thing:

- `static`: one monitor projection drawn once, held fixed.
- `moving`: the projection re-randomised every round from the *same interval*.

## Headline result

200 seeds, 30 rounds each:

| Arm | Mean escalation | Escalation std |
| --- | ---: | ---: |
| static | ~0.18 | ~0.07 |
| moving | ~0.14 | ~0.18 |

Static escalation is reliably positive and tightly concentrated; the adversary
learns the fixed blind direction. The moving target does **not** reliably reduce
mean escalation — it only modestly lowers it while *inflating outcome variance*
about three-fold, because re-randomisation re-rolls the adversary's alignment
every round. Individual runs of the moving arm swing from negative to strongly
positive escalation.

## Interpretation

This is a synthetic counterexample to a common but untested intuition: that
simply moving a monitor around ("moving target") is a reliable containment fix.
It is not a result about any specific production monitor, and it is not a
frontier-model containment claim.