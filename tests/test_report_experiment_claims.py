import numpy as np

from experiments.e003_verdict_freshness.experiment import run
from experiments.e002_shared_blind_spots.experiment import generate, protocol_scores, calibrate_thresholds


def test_adaptive_reference_does_not_have_the_reported_stale_read_bypass():
    for volatility in (0.049, 0.05, 0.050001, 1.0):
        for delay in (0, 1, 5, 20):
            result, _ = run(seed=42, n=2000, volatility=volatility, delay_steps=delay)
            assert result["adaptive_cached"]["containment_failure_rate"] == 0.0
            assert result["use_time_revalidation"]["containment_failure_rate"] == 0.0


def test_scaled_max_is_a_calibrated_control_not_an_independent_defense():
    benign, attacks, _ = generate(1, n_benign=1000, n_attack=1000, hidden_fraction=0.5)
    thresholds = calibrate_thresholds(benign, 0.10)
    for inputs in (benign, attacks):
        scores = protocol_scores(inputs)
        np.testing.assert_array_equal(scores["max_pool"] >= thresholds["max_pool"],
                                      scores["conservative_max"] >= thresholds["conservative_max"])
