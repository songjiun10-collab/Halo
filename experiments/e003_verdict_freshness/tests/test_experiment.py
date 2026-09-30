import pytest

from experiments.e003_verdict_freshness.experiment import run


def test_no_delay_no_expiry():
    out, meta = run(seed=0, delay_steps=0, volatility=0.05, n=20_000)
    assert meta["approval_expiry_rate"] == 0
    assert meta["fixed_window_verdict_age"] == 0
    assert meta["fixed_window_revalidation_count"] == 0
    assert out["cached_verdict"]["containment_failure_rate"] == 0


def test_use_time_revalidation_control():
    out, _ = run(seed=1, delay_steps=16, volatility=0.05, n=20_000)
    assert out["use_time_revalidation"]["containment_failure_rate"] == 0
    assert out["use_time_revalidation"]["false_block_rate"] == 0


def test_zero_freshness_window_revalidates_every_step():
    out, meta = run(
        seed=2,
        delay_steps=8,
        volatility=0.05,
        n=20_000,
        freshness_window=0,
    )
    assert meta["fixed_window_verdict_age"] == 0
    assert meta["fixed_window_revalidation_count"] == 8
    assert out["fixed_window_revalidation"] == out["use_time_revalidation"]


def test_fixed_window_revalidates_without_becoming_use_time_oracle():
    out, meta = run(
        seed=3,
        delay_steps=4,
        volatility=0.05,
        n=100_000,
        freshness_window=2,
    )
    assert meta["fixed_window_revalidation_count"] == 1
    assert meta["fixed_window_verdict_age"] == 1
    assert out["fixed_window_revalidation"]["containment_failure_rate"] > 0


def test_verdict_is_reused_while_within_bound():
    out, meta = run(
        seed=4,
        delay_steps=2,
        volatility=0.05,
        n=20_000,
        freshness_window=2,
    )
    assert meta["fixed_window_revalidation_count"] == 0
    assert meta["fixed_window_verdict_age"] == 2
    assert out["fixed_window_revalidation"] == out["cached_verdict"]


def test_progressive_refresh_does_not_alias_at_full_volatility():
    """Regression for the parity/aliasing bug: a floor of 1 on the adaptive
    window used to force one step of reuse even when volatility=1.0 made the
    state flip every step. Because the periodic refresh schedule then landed
    on the same phase as the state's own 2-step oscillation, every odd
    delay_steps used a verdict that was deterministically the *opposite* of
    truth (worst observed ~54% containment failure). The window must be
    allowed to reach 0 (revalidate every step) so this cannot alias."""
    out, meta = run(seed=5, delay_steps=3, volatility=1.0, n=50_000, freshness_window=2)
    assert meta["adaptive_window_size"] == 0
    assert out["progressive_refresh"]["containment_failure_rate"] == 0
    assert out["progressive_refresh"] == out["use_time_revalidation"]


def test_zero_freshness_window_also_bounds_progressive_refresh():
    """An explicit freshness_window=0 must disable progressive reuse too,
    not just the fixed-window comparison group. The old floor of 1 silently
    overrode this and always cached for one step regardless of the setting."""
    out, meta = run(
        seed=6,
        delay_steps=8,
        volatility=0.05,
        n=20_000,
        freshness_window=0,
    )
    assert meta["progressive_revalidation_count"] == 8
    assert out["progressive_refresh"] == out["use_time_revalidation"]


def test_progressive_refresh_reuse_tradeoff_is_preserved():
    """The fix must not zero out the *intended* reuse window: when volatility
    genuinely warrants window=1 (not floor-forced), progressive_refresh still
    trades some staleness risk for fewer checks, same as before the fix."""
    out, meta = run(seed=7, delay_steps=3, volatility=0.5, n=100_000, freshness_window=2)
    assert meta["adaptive_window_size"] == 1
    assert out["progressive_refresh"]["containment_failure_rate"] > 0


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"delay_steps": -1}, "delay_steps"),
        ({"volatility": -0.01}, "volatility"),
        ({"volatility": 1.01}, "volatility"),
        ({"n": 0}, "n"),
        ({"freshness_window": -1}, "freshness_window"),
    ],
)
def test_rejects_invalid_parameters(kwargs, message):
    params = dict(seed=0, delay_steps=0, volatility=0.01, n=100)
    params.update(kwargs)
    with pytest.raises(ValueError, match=message):
        run(**params)
