import math

import pytest

from experiments.e001_trusted_base.experiment import run as run_e001
from experiments.e001b_correlated_failure.experiment import run as run_e001b
from experiments.e003_verdict_freshness.experiment import run as run_e003


@pytest.mark.parametrize("seed", range(10))
@pytest.mark.parametrize("experiment", ["e001", "e001b", "e003"])
def test_single_sample_reports_absent_class_as_undefined(experiment, seed):
    if experiment == "e001":
        out = run_e001(seed=seed, corruption=0, n=1)
    elif experiment == "e001b":
        out, _ = run_e001b(seed=seed, p=0, rho=0, n=1)
    else:
        out, _ = run_e003(seed=seed, delay_steps=0, volatility=0, n=1)

    for metrics in out.values():
        failure = metrics["containment_failure_rate"]
        blocked = metrics["false_block_rate"]
        success = metrics["benign_success_rate"]
        # A single sample represents exactly one class. The other rate is
        # undefined, not evidence of perfect safety or usefulness.
        assert math.isnan(failure) != math.isnan(blocked)
        if math.isnan(blocked):
            assert math.isnan(success)
            assert 0 <= failure <= 1
        else:
            assert 0 <= blocked <= 1
            assert success == 1 - blocked
