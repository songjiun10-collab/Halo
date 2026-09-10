import numpy as np
import pytest

from experiments.e004_robust_evaluation.experiment import (
    evaluate,
    run,
    select_worst_group_threshold,
)


def test_evaluate_reports_group_and_false_positive_rates():
    benign = np.array([0.1, 0.2, 0.9])
    attacks = {
        "a": np.array([0.8, 0.7]),
        "b": np.array([0.6, 0.2]),
    }

    metrics = evaluate(benign, attacks, threshold=0.5)

    assert metrics.false_positive_rate == pytest.approx(1 / 3)
    assert metrics.group_tpr["a"] == 1.0
    assert metrics.group_tpr["b"] == 0.5
    assert metrics.worst_group_tpr == 0.5


def test_default_aggregate_is_weighted_by_attack_example_count():
    benign = np.array([0.0])
    attacks = {
        "large_detected": np.ones(100),
        "small_missed": np.zeros(1),
    }

    metrics = evaluate(benign, attacks, threshold=0.5)

    assert metrics.attack_tpr == pytest.approx(100 / 101)
    assert metrics.worst_group_tpr == 0.0


def test_worst_group_selection_respects_false_positive_budget():
    benign = np.array([0.10, 0.20, 0.30, 0.40])
    attacks = {
        "easy": np.array([0.9, 0.8, 0.7]),
        "hard": np.array([0.65, 0.55, 0.45]),
    }

    metrics = select_worst_group_threshold(
        benign,
        attacks,
        thresholds=np.array([0.30, 0.40, 0.50]),
        max_fpr=0.25,
    )

    assert metrics.threshold == pytest.approx(0.40)
    assert metrics.false_positive_rate == pytest.approx(0.25)
    assert metrics.worst_group_tpr == 1.0


def test_synthetic_shift_exposes_aggregate_metric_blind_spot():
    result = run(seed=7, n=5_000)

    aggregate = result["accuracy_optimal"]
    constrained = result["worst_group_constrained"]

    assert aggregate.attack_tpr > 0.85
    assert aggregate.worst_group_tpr < 0.55
    assert constrained.worst_group_tpr > aggregate.worst_group_tpr
    assert constrained.false_positive_rate <= 0.10

    all_hard = result["shifted"]["1.00"]
    assert (
        all_hard["accuracy_optimal"].attack_tpr
        == pytest.approx(aggregate.group_tpr["hard_family"])
    )
