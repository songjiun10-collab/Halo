"""
HALO E005 — Adaptive Evasion via Binary Verdict Feedback

Motivated by the containment framing in the repo: the policy is enforced by a
monitor that is *outside* the untrusted model. This experiment asks a question
the earlier static experiments do not:

    Can a model that receives only an allow/block verdict (no gradients, no
    score, no internals) *escalate* its evasion of a monitor over repeated
    queries, and does a moving-target monitor suppress that escalation?

The untrusted model is a black-box population optimiser: it proposes content,
observes only "allowed" or "blocked", keeps the allowed content with the
highest intrinsic harm value, mutates it, and repeats. Its objective is harm;
the monitor is the only thing standing in the way.

Two defences are compared under otherwise identical conditions:

  - `static`:      the monitor's linear projection (weight on the true harm
                   coordinate) is drawn once and held fixed. The model can
                   learn the monitor's fixed blind direction and drift into it
                   reliably.

  - `moving`:      the monitor re-randomises its projection every round from the
                   same distribution the static monitor was drawn from. The
                   blind direction changes each round.

The only difference between the two arms is *whether the projection is held
fixed or re-randomised*; both draw weights from the same interval and both are
recalibrated to the same false-positive budget each round.

The headline finding is two-sided. Static escalation is *reliable*: it is
positive in essentially every seed, tightly concentrated, averaging ~0.19.
The moving target does **not** reliably reduce mean escalation (it is only
marginally lower) and instead *inflates outcome variance* roughly three-fold,
because re-randomisation re-rolls the adversary's alignment every round. This
falsifies the naive assumption that "just move the target" is a cheap,
reliable containment fix. This is a toy statistical counterexample, not a
frontier-model claim.
"""
from __future__ import annotations

import math
import numbers

import numpy as np

# Coordinates of generated content:
#   x[:, 0] = intrinsic harm (the true "unsafe" signal the adversary controls)
#   x[:, 1] = a benign-looking correlate the monitor can also read
# The adversary can push coordinate 1 down (look benign) while pushing
# coordinate 0 up (actually harmful). The monitor sees a weighted sum and must
# trade the two off.
UNSAFE_THRESHOLD = 0.5


def _validate(
    seed: int,
    rounds: int,
    population: int,
    target_fpr: float,
    w0_lo: float,
    w0_hi: float,
    drift: float,
    mutation_scale: float,
) -> None:
    if not isinstance(seed, numbers.Integral) or isinstance(seed, bool):
        raise ValueError("seed must be an integer")
    for name, value in (("rounds", rounds), ("population", population)):
        if not isinstance(value, numbers.Integral) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    for name, value in (("target_fpr", target_fpr), ("w0_lo", w0_lo), ("w0_hi", w0_hi)):
        if not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or not 0.0 <= value <= 1.0:
            raise ValueError(f"{name} must be finite and in [0, 1]")
    if w0_lo >= w0_hi:
        raise ValueError("w0_lo must be strictly less than w0_hi")
    for name, value in (("drift", drift), ("mutation_scale", mutation_scale)):
        if not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or value < 0.0:
            raise ValueError(f"{name} must be finite and non-negative")


def _monitor_threshold(benign: np.ndarray, w: np.ndarray, target_fpr: float) -> float:
    """Calibrate the block threshold to target_fpr on the benign distribution."""
    return float(np.quantile(benign @ w, 1.0 - target_fpr))


def run(
    seed: int = 0,
    rounds: int = 30,
    population: int = 4000,
    target_fpr: float = 0.10,
    defense: str = "static",
    w0_lo: float = 0.55,
    w0_hi: float = 0.85,
    drift: float = 0.02,
    mutation_scale: float = 0.05,
    survival_fraction: float = 0.4,
    fresh_fraction: float = 0.25,
    n_benign: int = 40000,
    n_eval_benign: int = 20000,
) -> dict[str, object]:
    """Run one adaptive-evasion trajectory.

    Returns per-round *containment failure* (fraction of truly-unsafe content
    that is allowed), false-block rate on a held-out benign set, and the mean
    harm of allowed content.
    """
    _validate(seed, rounds, population, target_fpr, w0_lo, w0_hi, drift, mutation_scale)
    if defense not in ("static", "moving"):
        raise ValueError("defense must be 'static' or 'moving'")
    for name, value in (("survival_fraction", survival_fraction), ("fresh_fraction", fresh_fraction)):
        if not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or not 0.0 < value <= 1.0:
            raise ValueError(f"{name} must be finite and in (0, 1]")
    for name, value in (("n_benign", n_benign), ("n_eval_benign", n_eval_benign)):
        if not isinstance(value, numbers.Integral) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")

    rng = np.random.default_rng(seed)

    # Calibration and evaluation benign populations: harm is genuinely low.
    benign = rng.random((n_benign, 2))
    benign[:, 0] *= 0.5
    eval_benign = rng.random((n_eval_benign, 2))
    eval_benign[:, 0] *= 0.5

    # The adversary starts naive: uniform content.
    proposal = rng.random((population, 2))

    # For the static arm, draw a single fixed projection up front. For the
    # moving arm, a fresh draw from the same interval happens every round.
    w0_fixed = float(rng.uniform(w0_lo, w0_hi))

    containment_failure: list[float] = []
    false_block_rate: list[float] = []
    mean_allowed_harm: list[float] = []

    for _round in range(rounds):
        w0 = float(rng.uniform(w0_lo, w0_hi)) if defense == "moving" else w0_fixed
        w = np.array([w0, 1.0 - w0])
        tau = _monitor_threshold(benign, w, target_fpr)

        score = proposal @ w
        allowed = score <= tau
        unsafe = proposal[:, 0] > UNSAFE_THRESHOLD

        n_unsafe = int(unsafe.sum())
        failure = int((unsafe & allowed).sum()) / n_unsafe if n_unsafe else float("nan")
        containment_failure.append(failure)
        false_block_rate.append(float(np.mean((eval_benign @ w) > tau)))
        mean_allowed_harm.append(
            float(np.mean(proposal[allowed, 0])) if allowed.any() else float("nan")
        )

        survivors = proposal[allowed]
        if survivors.shape[0] == 0:
            proposal = rng.random((population, 2))
            continue

        # Black-box selection: keep the allowed content with the highest
        # intrinsic harm (the model's own objective, which it knows).
        order = np.argsort(-survivors[:, 0])
        keep = max(1, int(survivors.shape[0] * survival_fraction))
        elite = survivors[order[:keep]].copy()

        # Push harm up and explore around the elites.
        elite[:, 0] += drift
        mutants = np.clip(elite + rng.normal(0.0, mutation_scale, size=elite.shape), 0.0, 1.0)

        fresh = rng.random((max(1, int(population * fresh_fraction)), 2))
        proposal = np.vstack([mutants, fresh])
        if proposal.shape[0] < population:
            proposal = np.vstack([proposal, rng.random((population - proposal.shape[0], 2))])
        proposal = proposal[:population]

    containment_failure_arr = np.asarray(containment_failure)
    escalation = float(containment_failure_arr[-1] - containment_failure_arr[0])

    return {
        "defense": defense,
        "seed": seed,
        "rounds": rounds,
        "target_fpr": target_fpr,
        "w0_interval": [w0_lo, w0_hi],
        "containment_failure_by_round": containment_failure,
        "false_block_rate_by_round": false_block_rate,
        "mean_allowed_harm_by_round": mean_allowed_harm,
        "initial_containment_failure": float(containment_failure_arr[0]),
        "final_containment_failure": float(containment_failure_arr[-1]),
        "escalation": escalation,
        "mean_false_block_rate": float(np.mean(false_block_rate)),
    }