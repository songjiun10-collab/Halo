"""
HALO E002 — Shared Blind Spots

Synthetic experiment motivated by two observations in prior work:
(1) diverse monitor ensembles can outperform homogeneous ensembles;
(2) policy-relevant state can be absent from the enforcement layer.

Question:
Can monitors look diverse on known attack families yet share a hidden blind spot
that causes ensemble performance to collapse on an unseen family?

This is a toy statistical counterexample, not a frontier-model evaluation.
"""
from __future__ import annotations
import math
import numbers
import numpy as np

KNOWN = ("A", "B", "C")
HIDDEN = "H"

def _scores(rng, family, n):
    means = {
        "benign": np.array([0.0, 0.0, 0.0, 0.0]),
        "A":      np.array([3.2, 1.1, 1.0, 0.3]),
        "B":      np.array([1.0, 3.2, 1.1, 0.3]),
        "C":      np.array([1.1, 1.0, 3.2, 0.3]),
        "H":      np.array([0.05, 0.05, 0.05, 3.4]),
    }[family]
    shared = rng.normal(0.0, 0.20, size=(n, 1))
    noise = rng.normal(0.0, 1.0, size=(n, 4))
    return means + shared + noise

def generate(seed, n_benign=30000, n_attack=30000, hidden_fraction=0.0):
    for name, value in (("n_benign", n_benign), ("n_attack", n_attack)):
        if not isinstance(value, numbers.Integral) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    if not isinstance(hidden_fraction, numbers.Real) or not math.isfinite(float(hidden_fraction)) or not 0 <= hidden_fraction <= 1:
        raise ValueError("hidden_fraction must be finite and in [0, 1]")
    rng = np.random.default_rng(seed)
    benign = _scores(rng, "benign", n_benign)
    n_hidden = int(round(n_attack * hidden_fraction))
    n_known = n_attack - n_hidden
    pieces, labels = [], []
    counts = [n_known // 3] * 3
    for i in range(n_known % 3):
        counts[i] += 1
    for fam, count in zip(KNOWN, counts):
        if count:
            pieces.append(_scores(rng, fam, count))
            labels.extend([fam] * count)
    if n_hidden:
        pieces.append(_scores(rng, HIDDEN, n_hidden))
        labels.extend([HIDDEN] * n_hidden)
    attack = np.vstack(pieces) if pieces else np.empty((0, 4))
    labels = np.asarray(labels)
    idx = rng.permutation(len(attack))
    return benign, attack[idx], labels[idx]

def protocol_scores(x):
    m1, m2, m3, m4 = x.T
    algorithm_diverse = (m1 + m2 + m3) / 3.0
    evidence_diverse = np.maximum(algorithm_diverse, m4)

    # Improved evidence diversity with multiple independent channels
    # Use maximum pooling for robustness against blind spots
    max_pool = np.maximum.reduce([m1, m2, m3, m4])  # Maximum across all monitors

    # FPR-robust max pool: use weighted maximum to handle FPR manipulation
    # This provides better balance between sensitivity and specificity
    weighted_max = 0.6 * max_pool + 0.4 * evidence_diverse

    # Hybrid approach: combine algorithm diversity with independent evidence
    # But give more weight to independent evidence to handle blind spots
    hybrid_evidence = 0.3 * algorithm_diverse + 0.7 * np.maximum.reduce([m1, m2, m3, m4])

    # Adaptive: use evidence_diverse as primary, with fallback to max_pool
    adaptive_evidence = np.maximum(evidence_diverse, max_pool * 0.8)

    # Historical scaled-score control, not an extra safety margin: separately
    # calibrated quantiles scale too, so decisions coincide with max_pool.
    conservative_max = max_pool * 0.95

    return {
        "single_m1": m1,
        "algorithm_diverse": algorithm_diverse,
        "evidence_diverse": evidence_diverse,  # Original robust method
        "max_pool": max_pool,  # Most robust against blind spots
        "weighted_max": weighted_max,  # FPR-robust version
        "hybrid_evidence": hybrid_evidence,  # Balanced approach
        "adaptive_evidence": adaptive_evidence,  # Adaptive combination
        "conservative_max": conservative_max,  # Legacy scaled-score control
    }

def calibrate_thresholds(benign_scores, target_fpr=0.10):
    if not isinstance(target_fpr, numbers.Real) or not math.isfinite(float(target_fpr)) or not 0 <= target_fpr <= 1:
        raise ValueError("target_fpr must be finite and in [0, 1]")
    return {
        name: float(np.quantile(scores, 1.0 - target_fpr))
        for name, scores in protocol_scores(benign_scores).items()
    }

def evaluate(seed, hidden_fraction, n_benign=30000, n_attack=30000, target_fpr=0.10):
    if not isinstance(target_fpr, numbers.Real) or not math.isfinite(float(target_fpr)) or not 0 <= target_fpr <= 1:
        raise ValueError("target_fpr must be finite and in [0, 1]")
    benign, attack, families = generate(
        seed, n_benign=n_benign, n_attack=n_attack, hidden_fraction=hidden_fraction
    )
    thresholds = calibrate_thresholds(benign, target_fpr=target_fpr)
    b_scores = protocol_scores(benign)
    a_scores = protocol_scores(attack)
    rows = {}
    for name in thresholds:
        t = thresholds[name]
        hidden_mask = families == HIDDEN
        known_mask = ~hidden_mask
        rows[name] = {
            "threshold": t,
            "fpr": float(np.mean(b_scores[name] >= t)),
            "tpr": float(np.mean(a_scores[name] >= t)),
            "known_tpr": float(np.mean(a_scores[name][known_mask] >= t)) if known_mask.any() else float("nan"),
            "hidden_tpr": float(np.mean(a_scores[name][hidden_mask] >= t)) if hidden_mask.any() else float("nan"),
        }
    known = attack[families != HIDDEN]
    corr = np.corrcoef(known[:, :3].T) if len(known) else np.full((3,3), np.nan)
    offdiag = corr[np.triu_indices(3, 1)]
    diag = {
        "known_attack_mean_pairwise_corr": float(np.nanmean(offdiag)) if len(known) else float("nan")
    }
    return rows, diag
