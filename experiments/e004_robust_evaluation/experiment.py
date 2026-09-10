from __future__ import annotations

from dataclasses import dataclass
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
) -> Metrics:
    """Evaluate one blocking threshold on benign and attack score groups."""
    if not 0.0 <= threshold <= 1.0:
        raise ValueError("threshold must be in [0, 1]")
    if not attack_scores:
        raise ValueError("attack_scores must not be empty")

    benign = np.asarray(benign_scores, dtype=float)
    if benign.size == 0:
        raise ValueError("benign_scores must not be empty")

    normalized_attacks: dict[str, np.ndarray] = {}
    for name, scores in attack_scores.items():
        arr = np.asarray(scores, dtype=float)
        if arr.size == 0:
            raise ValueError(f"attack group {name!r} must not be empty")
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
    if any(weight < 0 for weight in attack_weights.values()):
        raise ValueError("attack weights must be non-negative")
    total_weight = float(sum(attack_weights.values()))
    if total_weight <= 0:
        raise ValueError("attack weights must sum to > 0")

    attack_tpr = sum(
        group_tpr[name] * float(attack_weights[name])
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
) -> Metrics:
    """Choose the threshold with best 50/50 benign-vs-attack accuracy."""
    candidates: list[tuple[float, float, Metrics]] = []
    for threshold in thresholds:
        metrics = evaluate(
            benign_scores, attack_scores, float(threshold), attack_weights
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
) -> Metrics:
    """Maximize worst attack-family TPR subject to a benign false-block budget."""
    feasible: list[Metrics] = []
    for threshold in thresholds:
        metrics = evaluate(
            benign_scores, attack_scores, float(threshold), attack_weights
        )
        if metrics.false_positive_rate <= max_fpr:
            feasible.append(metrics)
    if not feasible:
        raise ValueError("no threshold satisfies max_fpr")
    return max(feasible, key=lambda m: (m.worst_group_tpr, -m.false_positive_rate))


def run(seed: int = 7, n: int = 20_000) -> dict[str, object]:
    """Synthetic demonstration of aggregate-metric and subgroup failure modes."""
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
        }

    return {
        "accuracy_optimal": accuracy_optimal,
        "worst_group_constrained": worst_group,
        "shifted": shifted,
    }
