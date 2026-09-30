import numpy as np
import pytest

from experiments.e004_robust_evaluation.experiment import run, select_robust_threshold


def test_robust_selector_rejects_infeasible_detection_floor():
    with pytest.raises(ValueError, match="no threshold satisfies constraints"):
        select_robust_threshold(
            np.array([0.1, 0.3]), {"easy": np.array([0.9]), "hard": np.array([0.2])},
            np.array([0.2, 0.4, 0.8]), max_fpr=0,
            min_worst_group_tpr=0.8, min_any_group_tpr=0.9)


def test_robust_selector_honors_both_detection_floors():
    metrics = select_robust_threshold(
        np.array([0.1]), {"easy": np.array([0.9]), "hard": np.array([0.8])},
        np.array([0.5, 1.0]), max_fpr=0,
        min_worst_group_tpr=0.8, min_any_group_tpr=0.9)
    assert metrics.false_positive_rate == 0
    assert metrics.worst_group_tpr == 1


def test_shifted_robust_aggregate_uses_requested_mixture():
    result = run(seed=7, n=1000)
    for share, row in result["shifted"].items():
        metric = row["robust_constrained"]
        hard_share = float(share)
        expected = ((1 - hard_share) * metric.group_tpr["known_family"]
                    + hard_share * metric.group_tpr["hard_family"])
        assert metric.attack_tpr == pytest.approx(expected, abs=1e-12)
