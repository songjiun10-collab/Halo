from __future__ import annotations
import numpy as np

def correlated_error_pair(rng: np.random.Generator, n: int, p: float, rho: float):
    common_mode = rng.random(n) < rho
    shared = rng.random(n) < p
    e1_ind = rng.random(n) < p
    e2_ind = rng.random(n) < p
    e1 = np.where(common_mode, shared, e1_ind)
    e2 = np.where(common_mode, shared, e2_ind)
    return e1, e2

def run(seed: int, p: float, rho: float, n: int = 100_000):
    rng = np.random.default_rng(seed)
    sensitive = rng.random(n) < 0.30
    writable = rng.random(n) < 0.70
    is_write = rng.random(n) < 0.55
    truth_allow = (~is_write) | ((~sensitive) & writable)
    es1, es2 = correlated_error_pair(rng, n, p, rho)
    ew1, ew2 = correlated_error_pair(rng, n, p, rho)
    s1_sensitive = np.logical_xor(sensitive, es1)
    s2_sensitive = np.logical_xor(sensitive, es2)
    s1_writable = np.logical_xor(writable, ew1)
    s2_writable = np.logical_xor(writable, ew2)
    allow1 = (~is_write) | ((~s1_sensitive) & s1_writable)
    allow2 = (~is_write) | ((~s2_sensitive) & s2_writable)
    agree = (s1_sensitive == s2_sensitive) & (s1_writable == s2_writable)
    redundant_allow = (~is_write) | (agree & allow1 & allow2)
    unsafe = ~truth_allow
    safe = truth_allow
    decisions = {"single_source": allow1, "redundant_fail_closed": redundant_allow}
    out = {}
    for name, allow in decisions.items():
        unsafe_allowed = int((unsafe & allow).sum())
        safe_blocked = int((safe & ~allow).sum())
        unsafe_total = int(unsafe.sum())
        safe_total = int(safe.sum())
        out[name] = {
            "unsafe_total": unsafe_total,
            "unsafe_allowed": unsafe_allowed,
            "safe_total": safe_total,
            "safe_blocked": safe_blocked,
            "containment_failure_rate": unsafe_allowed / unsafe_total,
            "false_block_rate": safe_blocked / safe_total,
            "benign_success_rate": 1 - safe_blocked / safe_total,
        }
    if es1.std() == 0 or es2.std() == 0:
        corr = 0.0
    else:
        corr = float(np.corrcoef(es1.astype(float), es2.astype(float))[0, 1])
    return out, {
        "empirical_error_correlation": corr,
        "source1_marginal_error": float(es1.mean()),
        "source2_marginal_error": float(es2.mean()),
    }
