import sys
sys.path.insert(0, '/Users/songjiun/Halo')
import numpy as np
from experiments.e001b_correlated_failure.experiment import run as r1
from experiments.e002_shared_blind_spots.experiment import evaluate
from experiments.e003_verdict_freshness.experiment import run as r3

print("=== A. E001B p=1.0 DoS (모든 write 차단) ===")
for p in [0.99, 0.999, 1.0]:
    out, _ = r1(seed=42, p=p, rho=1.0, n=100000)
    c, s = out['correlation_aware'], out['single_source']
    print(f"  p={p}: corr_aware fail={c['containment_failure_rate']:.4f} false_block={c['false_block_rate']:.4f} "
          f"benign_success={c['benign_success_rate']:.4f} | single fail={s['containment_failure_rate']:.4f}")

print("\n=== B. E001B 숨은 adaptive_redundant 경로 vs redundant_fail_closed ===")
import experiments.e001b_correlated_failure.experiment as m
for p, rho in [(0.5, 1.0), (0.6, 1.0), (0.7, 0.0), (0.05, 1.0)]:
    n = 100000
    rng = np.random.default_rng(42)
    sensitive = rng.random(n) < 0.30
    writable = rng.random(n) < 0.70
    is_write = rng.random(n) < 0.55
    truth_allow = (~is_write) | ((~sensitive) & writable)
    es1, es2 = m.correlated_error_pair(rng, n, p, rho)
    ew1, ew2 = m.correlated_error_pair(rng, n, p, rho)
    s1 = np.logical_xor(sensitive, es1); s2 = np.logical_xor(sensitive, es2)
    w1 = np.logical_xor(writable, ew1); w2 = np.logical_xor(writable, ew2)
    allow1 = (~is_write) | ((~s1) & w1); allow2 = (~is_write) | ((~s2) & w2)
    agree = (s1 == s2) & (w1 == w2)
    redundant = (~is_write) | (agree & allow1 & allow2)
    adaptive_redundant = (~is_write) | ((agree & allow1 & allow2) | (~agree & allow1 & allow2))
    unsafe = ~truth_allow
    fr = lambda a: float((unsafe & a).sum() / unsafe.sum())
    print(f"  p={p} rho={rho}: redundant_fail_closed={fr(redundant):.4f}  adaptive_redundant(은닉)={fr(adaptive_redundant):.4f}")

print("\n=== C. E002 캘리브레이션 노이즈: 작은 n_benign이 실제 FPR 폭주? ===")
for n_benign in [100, 500, 1000, 5000]:
    rows, _ = evaluate(seed=42, hidden_fraction=0.5, n_benign=n_benign, n_attack=5000, target_fpr=0.05)
    print(f"  n_benign={n_benign}: actual_fpr max_pool={rows['max_pool']['fpr']:.4f} "
          f"weighted={rows['weighted_max']['fpr']:.4f} evidence={rows['evidence_diverse']['fpr']:.4f}")

print("\n=== D. E003 adaptive_cached 전역 재검증 (n=3000, 그리드) ===")
bad = []
for seed in range(20):
    for vol in [0.0, 0.01, 0.05, 0.051, 0.2, 0.5, 0.8, 1.0]:
        for window in [0, 1, 3, 10]:
            for delay in [0, 1, 5, 20, 100, 199]:
                res, _ = r3(seed=seed, delay_steps=delay, volatility=vol, n=3000, freshness_window=window)
                a = res['adaptive_cached']['containment_failure_rate']
                if a > 0.0001:
                    bad.append((a, vol, window, delay, seed))
print(f"  adaptive_cached 비정상 case: {len(bad)} / 3840")
for b in bad[:5]:
    print(f"    failure={b[0]:.4f} vol={b[1]} window={b[2]} delay={b[3]} seed={b[4]}")

print("\n=== E. E003 fixed_window 최악 + window=0 edge ===")
worst_f = []
for seed in range(20):
    for window in [0, 1, 2, 3, 5]:
        for vol in [0.1, 0.3, 0.5, 0.8, 1.0]:
            for delay in [20, 100]:
                res, _ = r3(seed=seed, delay_steps=delay, volatility=vol, n=3000, freshness_window=window)
                worst_f.append((res['fixed_window_revalidation']['containment_failure_rate'], window, vol, delay, seed))
worst_f.sort(reverse=True)
print("  top 5:")
for f, window, vol, delay, seed in worst_f[:5]:
    print(f"    fixed={f:.4f} window={window} vol={vol} delay={delay} seed={seed}")

print("\n=== F. E003 최종 대조 (vol=0.5 window=3, delay 주변) ===")
for delay in [5, 6, 7, 99, 100, 101]:
    res, _ = r3(seed=42, delay_steps=delay, volatility=0.5, n=50000, freshness_window=3)
    print(f"  delay={delay}: adaptive={res['adaptive_cached']['containment_failure_rate']:.4f} "
          f"progressive={res['progressive_refresh']['containment_failure_rate']:.4f} "
          f"fixed={res['fixed_window_revalidation']['containment_failure_rate']:.4f}")