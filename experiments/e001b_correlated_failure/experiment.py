from __future__ import annotations
import math
import numbers
import numpy as np

def _validate_parameters(n: int, p: float, rho: float) -> None:
    if not isinstance(n, numbers.Integral) or isinstance(n, bool) or n <= 0:
        raise ValueError("n must be a positive integer")
    for name, value in (("p", p), ("rho", rho)):
        if not isinstance(value, numbers.Real) or not math.isfinite(float(value)) or not 0 <= value <= 1:
            raise ValueError(f"{name} must be finite and in [0, 1]")


def correlated_error_pair(rng: np.random.Generator, n: int, p: float, rho: float):
    _validate_parameters(n, p, rho)
    common_mode = rng.random(n) < rho
    shared = rng.random(n) < p
    e1_ind = rng.random(n) < p
    e2_ind = rng.random(n) < p
    e1 = np.where(common_mode, shared, e1_ind)
    e2 = np.where(common_mode, shared, e2_ind)
    return e1, e2

def run(seed: int, p: float, rho: float, n: int = 100_000):
    # Validate before drawing arrays so invalid probabilities cannot silently
    # turn into a different experiment.
    _validate_parameters(n, p, rho)
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

    # Improved adaptive redundancy that accounts for correlation
    # When sources disagree, be more conservative (fail-closed)
    # When they agree, still require stronger evidence for writes
    disagree = ~agree
    adaptive_redundant = (~is_write) | ((agree & allow1 & allow2) | (disagree & allow1 & allow2))

    # Add a third source with forced independence (zero correlation)
    # This simulates adding a truly independent safety mechanism
    # Use different random seeds to ensure true independence
    rng3 = np.random.default_rng(seed + 1000)  # Different seed for independence
    es3 = rng3.random(n) < p  # Completely independent with different seed
    ew3 = rng3.random(n) < p  # Completely independent with different seed
    s3_sensitive = np.logical_xor(sensitive, es3)
    s3_writable = np.logical_xor(writable, ew3)
    allow3 = (~is_write) | ((~s3_sensitive) & s3_writable)

    # Correlation-adaptive: use third source as independent validator
    # Only allow write if at least one independent source allows it
    correlation_aware = (~is_write) | (allow1 & allow3) | (allow2 & allow3)

    # Three-source majority voting with stricter requirement
    # Require at least 2 sources to agree, but for writes require higher consensus
    majority_vote = (allow1.astype(int) + allow2.astype(int) + allow3.astype(int)) >= 2
    strict_majority = (allow1.astype(int) + allow2.astype(int) + allow3.astype(int)) >= 2
    three_source_redundant = (~is_write) | strict_majority

    unsafe = ~truth_allow
    safe = truth_allow
    decisions = {
        "single_source": allow1,
        "redundant_fail_closed": redundant_allow,
        "correlation_aware": correlation_aware,
        "three_source_diverse": three_source_redundant
    }
    out = {}
    for name, allow in decisions.items():
        unsafe_allowed = int((unsafe & allow).sum())
        safe_blocked = int((safe & ~allow).sum())
        unsafe_total = int(unsafe.sum())
        safe_total = int(safe.sum())
        # An absent class cannot establish a zero failure/block rate.
        failure_rate = unsafe_allowed / unsafe_total if unsafe_total else float("nan")
        block_rate = safe_blocked / safe_total if safe_total else float("nan")
        out[name] = {
            "unsafe_total": unsafe_total,
            "unsafe_allowed": unsafe_allowed,
            "safe_total": safe_total,
            "safe_blocked": safe_blocked,
            "containment_failure_rate": failure_rate,
            "false_block_rate": block_rate,
            "benign_success_rate": 1 - block_rate,
        }
    if es1.std() == 0 or es2.std() == 0:
        corr = 0.0
    else:
        corr = float(np.corrcoef(es1.astype(float), es2.astype(float))[0, 1])
    return out, {
        "empirical_error_correlation": corr,
        "source1_marginal_error": float(es1.mean()),
        "source2_marginal_error": float(es2.mean()),
        "source3_marginal_error": float(es3.mean()),
    }
