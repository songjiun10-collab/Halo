import numpy as np
import pytest

from experiments.e001_trusted_base.experiment import run as run_e001
from experiments.e001b_correlated_failure.experiment import run as run_e001b
from experiments.e002_shared_blind_spots.experiment import evaluate as evaluate_e002
from experiments.e003_verdict_freshness.experiment import run as run_e003
from experiments.e004_robust_evaluation.experiment import evaluate, run as run_e004, select_worst_group_threshold


@pytest.mark.parametrize("corruption", [-0.01, 1.01, np.nan, np.inf])
def test_e001_rejects_invalid_corruption(corruption):
    with pytest.raises(ValueError, match="corruption"):
        run_e001(corruption=corruption, n=10)


@pytest.mark.parametrize("p,rho", [(-0.1, 0.5), (0.5, 1.1), (np.nan, 0.5)])
def test_e001b_rejects_invalid_probabilities(p, rho):
    with pytest.raises(ValueError, match="(p|rho)"):
        run_e001b(seed=0, p=p, rho=rho, n=10)


@pytest.mark.parametrize("hidden_fraction", [-0.1, 1.1, np.nan])
def test_e002_rejects_invalid_hidden_fraction(hidden_fraction):
    with pytest.raises(ValueError, match="hidden_fraction"):
        evaluate_e002(seed=0, hidden_fraction=hidden_fraction, n_benign=10, n_attack=10)


@pytest.mark.parametrize("max_fpr", [-0.1, 1.1, np.nan])
def test_e004_rejects_invalid_fpr_budget(max_fpr):
    with pytest.raises(ValueError, match="max_fpr"):
        select_worst_group_threshold(
            np.array([0.1]), {"a": np.array([0.9])}, np.array([0.5]), max_fpr=max_fpr
        )


def test_e004_rejects_non_numeric_weight_as_value_error():
    with pytest.raises(ValueError, match="weights"):
        evaluate(np.array([0.1]), {"a": np.array([0.9])}, 0.5, {"a": "bad"})


def test_e003_rejects_non_integer_delay():
    with pytest.raises(ValueError, match="delay_steps"):
        run_e003(seed=0, delay_steps=1.5, volatility=0.1, n=10)


def test_e004_rejects_non_positive_sample_count():
    with pytest.raises(ValueError, match="n"):
        run_e004(n=0)
