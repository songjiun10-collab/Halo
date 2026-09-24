from __future__ import annotations

from dataclasses import dataclass
import math
import numbers
import numpy as np


@dataclass(frozen=True)
class Metrics:
    threshold: float
    false_positive_rate: float
    attack_tpr: float
    worst_group_tpr: float
    group_tpr: dict[str, float]


def evaluate(
    benign_scores: np.ndarray,
    attack_scores: dict[str, np.ndarray],
    threshold: float,
    attack_weights: dict[str, float] | None = None,
    enforce_balance: bool = False,
) -> Metrics:
    """Evaluate one blocking threshold on benign and attack score groups.

    Args:
        enforce_balance: If True, enforce minimum weight balance to prevent hiding small groups.
    """
    if not isinstance(threshold, numbers.Real) or not math.isfinite(float(threshold)) or not 0.0 <= threshold <= 1.0:
        raise ValueError("threshold must be in [0, 1]")
    if not attack_scores:
        raise ValueError("attack_scores must not be empty")

    benign = np.asarray(benign_scores, dtype=float)
    if benign.size == 0:
        raise ValueError("benign_scores must not be empty")
    if not np.isfinite(benign).all():
        raise ValueError("benign_scores must be finite")

    normalized_attacks: dict[str, np.ndarray] = {}
    for name, scores in attack_scores.items():
        arr = np.asarray(scores, dtype=float)
        if arr.size == 0:
            raise ValueError(f"attack group {name!r} must not be empty")
        if not np.isfinite(arr).all():
            raise ValueError(f"attack group {name!r} scores must be finite")
        normalized_attacks[name] = arr

    group_tpr = {
        name: float(np.mean(scores >= threshold))
        for name, scores in normalized_attacks.items()
    }
    fpr = float(np.mean(benign >= threshold))

    # With no explicit deployment mixture, report the true aggregate over the
    # provided attack examples rather than a macro-average over subgroup labels.
    if attack_weights is None:
        attack_weights = {
            name: float(scores.size)
            for name, scores in normalized_attacks.items()
        }
    if set(attack_weights) != set(normalized_attacks):
        raise ValueError("attack_weights keys must match attack_scores")
    try:
        numeric_weights = {name: float(weight) for name, weight in attack_weights.items()}
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("attack weights must be finite and non-negative") from exc
    if any(not math.isfinite(weight) or weight < 0 for weight in numeric_weights.values()):
        raise ValueError("attack weights must be finite and non-negative")

    # Enforce balance to prevent hiding small groups
    if enforce_balance:
        # Use equal weights for all groups regardless of size
        # This ensures small groups cannot be hidden through weight manipulation
        # and forces the system to care about performance on tiny groups
        numeric_weights = {name: 1.0 for name in normalized_attacks}

    scale = max(numeric_weights.values())
    if scale <= 0:
        raise ValueError("attack weights must sum to > 0")
    # Scale before summing so valid large weights cannot overflow the total.
    scaled_weights = {name: weight / scale for name, weight in numeric_weights.items()}
    total_weight = sum(scaled_weights.values())

    attack_tpr = sum(
        group_tpr[name] * scaled_weights[name]
        for name in normalized_attacks
    ) / total_weight

    return Metrics(
        threshold=float(threshold),
        false_positive_rate=fpr,
        attack_tpr=float(attack_tpr),
        worst_group_tpr=min(group_tpr.values()),
        group_tpr=group_tpr,
    )


def select_accuracy_threshold(
    benign_scores: np.ndarray,
    attack_scores: dict[str, np.ndarray],
    thresholds: np.ndarray,
    attack_weights: dict[str, float],
    enforce_balance: bool = False,
) -> Metrics:
    """Choose the threshold with best 50/50 benign-vs-attack accuracy."""
    candidates: list[tuple[float, float, Metrics]] = []
    for threshold in thresholds:
        metrics = evaluate(
            benign_scores, attack_scores, float(threshold), attack_weights, enforce_balance
        )
        accuracy = 0.5 * (1.0 - metrics.false_positive_rate) + 0.5 * metrics.attack_tpr
        candidates.append((accuracy, -metrics.false_positive_rate, metrics))
    if not candidates:
        raise ValueError("thresholds must not be empty")
    return max(candidates, key=lambda item: (item[0], item[1]))[2]


def select_worst_group_threshold(
    benign_scores: np.ndarray,
    attack_scores: dict[str, np.ndarray],
    thresholds: np.ndarray,
    max_fpr: float = 0.10,
    attack_weights: dict[str, float] | None = None,
    enforce_balance: bool = False,
) -> Metrics:
    """Maximize worst attack-family TPR subject to a benign false-block budget."""
    if not isinstance(max_fpr, numbers.Real) or not math.isfinite(float(max_fpr)) or not 0 <= max_fpr <= 1:
        raise ValueError("max_fpr must be finite and in [0, 1]")
    feasible: list[Metrics] = []
    for threshold in thresholds:
        metrics = evaluate(
            benign_scores, attack_scores, float(threshold), attack_weights, enforce_balance
        )
        if metrics.false_positive_rate <= max_fpr:
            feasible.append(metrics)
    if not feasible:
        raise ValueError("no threshold satisfies max_fpr")
    return max(feasible, key=lambda m: (m.worst_group_tpr, -m.false_positive_rate))


def select_robust_threshold(
    benign_scores: np.ndarray,
    attack_scores: dict[str, np.ndarray],
    thresholds: np.ndarray,
    max_fpr: float = 0.10,
    attack_weights: dict[str, float] | None = None,
    min_worst_group_tpr: float = 0.5,
    min_any_group_tpr: float = 0.35,
) -> Metrics:
    """Select threshold with constraints on both FPR and minimum worst-group TPR."""
    if not isinstance(max_fpr, numbers.Real) or not math.isfinite(float(max_fpr)) or not 0 <= max_fpr <= 1:
        raise ValueError("max_fpr must be finite and in [0, 1]")
    if not isinstance(min_worst_group_tpr, numbers.Real) or not math.isfinite(float(min_worst_group_tpr)) or not 0 <= min_worst_group_tpr <= 1:
        raise ValueError("min_worst_group_tpr must be finite and [0, 1]")
    if not isinstance(min_any_group_tpr, numbers.Real) or not math.isfinite(float(min_any_group_tpr)) or not 0 <= min_any_group_tpr <= 1:
        raise ValueError("min_any_group_tpr must be finite and [0, 1]")

    feasible: list[Metrics] = []
    for threshold in thresholds:
        metrics = evaluate(
            benign_scores, attack_scores, float(threshold), attack_weights, enforce_balance=True
        )
        # Add constraint: no group can have TPR below min_any_group_tpr
        if (metrics.false_positive_rate <= max_fpr and 
            metrics.worst_group_tpr >= min_worst_group_tpr and
            all(tpr >= min_any_group_tpr for tpr in metrics.group_tpr.values())):
            feasible.append(metrics)

    if not feasible:
        raise ValueError("no threshold satisfies constraints")

    # Score thresholds with multiple criteria to prevent clustering exploitation
    scored = []
    for metrics in feasible:
        # Primary: worst group TPR (higher is better)
        # Secondary: aggregate attack TPR (higher is better)
        # Tertiary: lower FPR (lower is better)
        # Quaternary: variance between group TPRs (lower is better - prevents gaming)
        group_tprs = list(metrics.group_tpr.values())
        tpr_variance = np.var(group_tprs) if len(group_tprs) > 1 else 0.0

        score = (
            metrics.worst_group_tpr * 3.0 +  # Increased weight for worst-group
            metrics.attack_tpr * 0.5 -        # Reduced weight for aggregate
            metrics.false_positive_rate * 0.5 -  # Penalize high FPR
            tpr_variance * 0.5                # Increased variance penalty
        )
        scored.append((score, metrics))

    # Return the threshold with highest composite score
    return max(scored, key=lambda item: item[0])[1]


def run(seed: int = 7, n: int = 20_000) -> dict[str, object]:
    """Synthetic demonstration of aggregate-metric and subgroup failure modes."""
    if not isinstance(n, numbers.Integral) or isinstance(n, bool) or n <= 0:
        raise ValueError("n must be a positive integer")
    rng = np.random.default_rng(seed)

    benign = np.clip(rng.normal(0.25, 0.15, 5 * n), 0.0, 1.0)
    attacks = {
        "known_family": np.clip(rng.normal(0.78, 0.12, 4 * n), 0.0, 1.0),
        "hard_family": np.clip(rng.normal(0.48, 0.17, n), 0.0, 1.0),
    }
    thresholds = np.linspace(0.05, 0.95, 181)
    dev_weights = {"known_family": 0.8, "hard_family": 0.2}

    accuracy_optimal = select_accuracy_threshold(
        benign, attacks, thresholds, dev_weights
    )
    worst_group = select_worst_group_threshold(
        benign,
        attacks,
        thresholds,
        max_fpr=0.10,
        attack_weights=dev_weights,
    )

    # New robust selection with balance enforcement
    robust_threshold = select_robust_threshold(
        benign,
        attacks,
        thresholds,
        max_fpr=0.10,
        attack_weights=dev_weights,
    )

    shifted: dict[str, dict[str, Metrics]] = {}
    for hard_share in (0.0, 0.25, 0.50, 0.75, 1.0):
        weights = {
            "known_family": 1.0 - hard_share,
            "hard_family": hard_share,
        }
        shifted[f"{hard_share:.2f}"] = {
            "accuracy_optimal": evaluate(
                benign, attacks, accuracy_optimal.threshold, weights
            ),
            "worst_group_constrained": evaluate(
                benign, attacks, worst_group.threshold, weights
            ),
            "robust_constrained": evaluate(
                benign, attacks, robust_threshold.threshold, weights, enforce_balance=False
            ),
        }

    return {
        "accuracy_optimal": accuracy_optimal,
        "worst_group_constrained": worst_group,
        "robust_constrained": robust_threshold,
        "shifted": shifted,
    }
