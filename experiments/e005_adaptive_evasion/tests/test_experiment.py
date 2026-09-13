import math

import numpy as np
import pytest

from experiments.e005_adaptive_evasion.experiment import run


def _multi_seed(defense, seeds=30, **kw):
    return [run(seed=s, defense=defense, rounds=30, population=4000, **kw) for s in range(seeds)]


def test_static_monitor_escalates_reliably():
    outs = _multi_seed("static")
    escalations = [o["escalation"] for o in outs]
    # Escalation is positive in essentially every seed, tightly concentrated.
    assert all(e > 0.0 for e in escalations)
    assert np.mean(escalations) > 0.10


def test_moving_target_does_not_reliably_reduce_mean_escalation():
    static = [o["escalation"] for o in _multi_seed("static")]
    moving = [o["escalation"] for o in _multi_seed("moving")]
    # Marginal mean change only; certainly not a robust halving of escalation.
    assert np.mean(moving) > np.mean(static) * 0.5


def test_moving_target_inflates_outcome_variance():
    static = [o["escalation"] for o in _multi_seed("static")]
    moving = [o["escalation"] for o in _multi_seed("moving")]
    assert np.std(moving) > 1.5 * np.std(static)


def test_false_block_rate_respects_calibration_budget():
    out = run(seed=2, defense="static", rounds=30, population=4000, target_fpr=0.10)
    assert 0.095 <= out["mean_false_block_rate"] <= 0.105


def test_containment_failure_is_probability():
    out = run(seed=3, defense="moving", rounds=20, population=3000)
    for v in out["containment_failure_by_round"]:
        assert 0.0 <= v <= 1.0


@pytest.mark.parametrize("bad", [-0.01, 1.01, np.nan, np.inf])
def test_rejects_invalid_target_fpr(bad):
    with pytest.raises(ValueError, match="target_fpr"):
        run(seed=0, target_fpr=bad)


@pytest.mark.parametrize("bad", [0, -1, 2.5])
def test_rejects_invalid_rounds(bad):
    with pytest.raises(ValueError, match="rounds"):
        run(seed=0, rounds=bad)


def test_rejects_inverted_weight_interval():
    with pytest.raises(ValueError, match="w0_lo"):
        run(seed=0, w0_lo=0.9, w0_hi=0.1)


def test_rejects_unknown_defense():
    with pytest.raises(ValueError, match="defense"):
        run(seed=0, defense="banana")


def test_containment_failure_well_formed_when_no_unsafe():
    out = run(seed=4, defense="static", rounds=5, population=2000)
    vals = out["containment_failure_by_round"]
    assert all((math.isnan(v) or 0.0 <= v <= 1.0) for v in vals)