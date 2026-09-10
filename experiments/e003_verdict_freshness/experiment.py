from __future__ import annotations
import numpy as np


def run(seed: int, delay_steps: int, volatility: float, n: int = 100_000, freshness_window: int = 2):
    rng = np.random.default_rng(seed)
    sensitive = rng.random(n) < 0.30
    writable = rng.random(n) < 0.70
    is_write = rng.random(n) < 0.55

    def policy_allow(s, w):
        return (~is_write) | ((~s) & w)

    allow_at_check = policy_allow(sensitive, writable)
    s, w = sensitive.copy(), writable.copy()
    for _ in range(delay_steps):
        s = np.logical_xor(s, rng.random(n) < volatility)
        w = np.logical_xor(w, rng.random(n) < volatility)

    allow_at_use = policy_allow(s, w)
    cached_allow = allow_at_check
    revalidate_allow = allow_at_use
    freshness_allow = cached_allow if delay_steps <= freshness_window else allow_at_use

    unsafe_now = ~allow_at_use
    safe_now = allow_at_use
    out = {}
    for name, decision in {
        "cached_verdict": cached_allow,
        "use_time_revalidation": revalidate_allow,
        "freshness_bounded": freshness_allow,
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
    return out, {"approval_expiry_rate": float(expiry.sum() / max(int(approved.sum()), 1))}
