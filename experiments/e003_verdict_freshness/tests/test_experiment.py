from experiment import run


def test_no_delay_no_expiry():
    out, meta = run(seed=0, delay_steps=0, volatility=0.05, n=20_000)
    assert meta["approval_expiry_rate"] == 0
    assert out["cached_verdict"]["containment_failure_rate"] == 0


def test_use_time_revalidation_control():
    out, _ = run(seed=1, delay_steps=16, volatility=0.05, n=20_000)
    assert out["use_time_revalidation"]["containment_failure_rate"] == 0
