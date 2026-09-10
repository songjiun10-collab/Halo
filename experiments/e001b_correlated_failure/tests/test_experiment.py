import numpy as np

from experiments.e001b_correlated_failure.experiment import correlated_error_pair, run


def test_marginal_and_correlation():
    rng = np.random.default_rng(123)
    e1, e2 = correlated_error_pair(rng, 1_000_000, 0.1, 0.75)
    assert abs(e1.mean() - 0.1) < 0.003
    assert abs(e2.mean() - 0.1) < 0.003
    corr = np.corrcoef(e1.astype(float), e2.astype(float))[0, 1]
    assert abs(corr - 0.75) < 0.02


def test_zero_error():
    out, _ = run(0, 0.0, 0.0, 100_000)
    assert out["single_source"]["containment_failure_rate"] == 0
    assert out["redundant_fail_closed"]["containment_failure_rate"] == 0
