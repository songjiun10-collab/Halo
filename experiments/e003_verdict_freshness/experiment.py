from __future__ import annotations

import math
import numbers
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
    if not isinstance(delay_steps, numbers.Integral) or isinstance(delay_steps, bool) or delay_steps < 0:
        raise ValueError("delay_steps must be a non-negative integer")
    if not isinstance(volatility, numbers.Real) or not math.isfinite(float(volatility)) or not 0 <= volatility <= 1:
        raise ValueError("volatility must be finite and in [0, 1]")
    if not isinstance(n, numbers.Integral) or isinstance(n, bool) or n <= 0:
        raise ValueError("n must be a positive integer")
    if not isinstance(freshness_window, numbers.Integral) or isinstance(freshness_window, bool) or freshness_window < 0:
        raise ValueError("freshness_window must be a non-negative integer")

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

    # Adaptive window based on volatility - smaller window for higher volatility
    adaptive_window = max(1, freshness_window - int(volatility * 10))

    # Progressive refresh with adaptive window
    progressive_allow = allow_at_check.copy()
    progressive_last_check = 0
    progressive_revalidations = 0

    for step in range(1, delay_steps + 1):
        s = np.logical_xor(s, rng.random(n) < volatility)
        w = np.logical_xor(w, rng.random(n) < volatility)

        # A verdict checked at step t can be reused while age <= window.
        # Refresh only when the next use would make it older than the bound.
        if step - fixed_window_last_check_step > freshness_window:
            fixed_window_allow = policy_allow(s, w).copy()
            fixed_window_last_check_step = step
            fixed_window_revalidations += 1

        # Progressive refresh with adaptive window based on volatility
        if step - progressive_last_check > adaptive_window:
            progressive_allow = policy_allow(s, w).copy()
            progressive_last_check = step
            progressive_revalidations += 1

    allow_at_use = policy_allow(s, w)
    cached_allow = allow_at_check
    revalidate_allow = allow_at_use

    # Improved adaptive caching with volatility awareness
    # Adaptive threshold based on volatility level
    adaptive_cached = allow_at_check.copy()
    if volatility > 0.1:
        # Low to high volatility: use use-time revalidation for writes
        adaptive_cached = np.where(is_write, allow_at_use, allow_at_check)
    if volatility > 0.5:
        # Very high volatility: use use-time revalidation for all operations
        adaptive_cached = allow_at_use

    unsafe_now = ~allow_at_use
    safe_now = allow_at_use
    out = {}
    for name, decision in {
        "cached_verdict": cached_allow,  # Original vulnerable approach
        "use_time_revalidation": revalidate_allow,  # Perfect but expensive
        "fixed_window_revalidation": fixed_window_allow,  # Window-based
        "adaptive_cached": adaptive_cached,  # Volatility-aware
        "progressive_refresh": progressive_allow,  # Adaptive window
    }.items():
        unsafe_allowed = int((unsafe_now & decision).sum())
        safe_blocked = int((safe_now & ~decision).sum())
        unsafe_total = int(unsafe_now.sum())
        safe_total = int(safe_now.sum())
        # An absent class cannot establish a zero failure/block rate.
        failure_rate = unsafe_allowed / unsafe_total if unsafe_total else float("nan")
        block_rate = safe_blocked / safe_total if safe_total else float("nan")
        out[name] = {
            "containment_failure_rate": failure_rate,
            "false_block_rate": block_rate,
            "benign_success_rate": 1 - block_rate,
        }

    approved = allow_at_check
    expiry = approved & (~allow_at_use)
    return out, {
        "approval_expiry_rate": float(expiry.sum() / max(int(approved.sum()), 1)),
        "fixed_window_verdict_age": delay_steps - fixed_window_last_check_step,
        "fixed_window_revalidation_count": fixed_window_revalidations,
        "progressive_revalidation_count": progressive_revalidations,
        "adaptive_window_size": adaptive_window,
        "volatility_level": volatility,
    }
