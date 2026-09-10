from __future__ import annotations

import numpy as np


def run(
    seed: int,
    delay_steps: int,
    volatility: float,
    n: int = 100_000,
    freshness_window: int = 2,
):
    """Simulate stale authorization decisions under policy-relevant state drift.

    ``freshness_window`` is the maximum age, in synthetic steps, for which a
    cached verdict may be reused. Once reusing it would exceed that age, the
    verdict is refreshed against the then-current state. This intentionally
    differs from perfect use-time revalidation: the refreshed verdict can
    become stale again before the action is finally used.
    """
    if delay_steps < 0:
        raise ValueError("delay_steps must be >= 0")
    if not 0 <= volatility <= 1:
        raise ValueError("volatility must be in [0, 1]")
    if n <= 0:
        raise ValueError("n must be > 0")
    if freshness_window < 0:
        raise ValueError("freshness_window must be >= 0")

    rng = np.random.default_rng(seed)
    sensitive = rng.random(n) < 0.30
    writable = rng.random(n) < 0.70
    is_write = rng.random(n) < 0.55

    def policy_allow(s, w):
        return (~is_write) | ((~s) & w)

    allow_at_check = policy_allow(sensitive, writable)
    s, w = sensitive.copy(), writable.copy()

    fixed_window_allow = allow_at_check.copy()
    fixed_window_last_check_step = 0
    fixed_window_revalidations = 0

    for step in range(1, delay_steps + 1):
        s = np.logical_xor(s, rng.random(n) < volatility)
        w = np.logical_xor(w, rng.random(n) < volatility)

        # A verdict checked at step t can be reused while age <= window.
        # Refresh only when the next use would make it older than the bound.
        if step - fixed_window_last_check_step > freshness_window:
            fixed_window_allow = policy_allow(s, w).copy()
            fixed_window_last_check_step = step
            fixed_window_revalidations += 1

    allow_at_use = policy_allow(s, w)
    cached_allow = allow_at_check
    revalidate_allow = allow_at_use

    unsafe_now = ~allow_at_use
    safe_now = allow_at_use
    out = {}
    for name, decision in {
        "cached_verdict": cached_allow,
        "use_time_revalidation": revalidate_allow,
        "fixed_window_revalidation": fixed_window_allow,
    }.items():
        unsafe_allowed = int((unsafe_now & decision).sum())
        safe_blocked = int((safe_now & ~decision).sum())
        unsafe_total = int(unsafe_now.sum())
        safe_total = int(safe_now.sum())
        out[name] = {
            "containment_failure_rate": unsafe_allowed / unsafe_total,
            "false_block_rate": safe_blocked / safe_total,
            "benign_success_rate": 1 - safe_blocked / safe_total,
        }

    approved = allow_at_check
    expiry = approved & (~allow_at_use)
    return out, {
        "approval_expiry_rate": float(expiry.sum() / max(int(approved.sum()), 1)),
        "fixed_window_verdict_age": delay_steps - fixed_window_last_check_step,
        "fixed_window_revalidation_count": fixed_window_revalidations,
    }
