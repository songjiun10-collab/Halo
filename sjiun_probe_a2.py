import sys
sys.path.insert(0, '/Users/songjiun/Halo')
import numpy as np
from experiments.e004_robust_evaluation.experiment import select_robust_threshold, select_accuracy_threshold
from experiments.e005_adaptive_evasion.experiment import run as r5

rng = np.random.default_rng(7)
ben = np.clip(rng.normal(0.25, 0.15, 20000), 0, 1)
known = np.clip(rng.normal(0.78, 0.12, 20000), 0, 1)
hard = np.clip(rng.normal(0.48, 0.17, 5000), 0, 1)
decoy = np.full(30000, 0.92)
thresholds = np.linspace(0.05, 0.95, 181)

print("=== E004 — variance-clamp 게임 ===")
mid_decoy = np.clip(rng.normal(0.5, 0.01, 20000), 0, 1)
a1 = select_robust_threshold(ben, {"known": known, "hard": hard, "d": decoy}, thresholds, max_fpr=0.10)
a2 = select_robust_threshold(ben, {"known": known, "hard": hard, "d": decoy, "mid": mid_decoy}, thresholds, max_fpr=0.10)
print(f"  decoy만:    threshold={a1.threshold:.3f} worst={a1.worst_group_tpr:.3f} fpr={a1.false_positive_rate:.4f}")
print(f"  +mid-decoy: threshold={a2.threshold:.3f} worst={a2.worst_group_tpr:.3f} fpr={a2.false_positive_rate:.4f}")

print("\n=== E004 — single-sample 그룹 ===")
res = select_robust_threshold(ben, {"known": known, "hard": hard, "solo": np.array([0.44])}, thresholds, max_fpr=0.10)
print(f"  solo=[0.44]: threshold={res.threshold:.3f} worst={res.worst_group_tpr:.3f} "
      f"groups={ {k: round(v,3) for k,v in res.group_tpr.items()} }")

print("\n=== E004 — accuracy-optimal (하드가 다수지만 저득점) ===")
a_opt = select_accuracy_threshold(ben, {"known": known, "hard": np.concatenate([hard]*10)},
                                  thresholds, {"known": 0.1, "hard": 0.9}, enforce_balance=False)
print(f"  accuracy-optimal: threshold={a_opt.threshold:.3f} agg={a_opt.attack_tpr:.3f} worst={a_opt.worst_group_tpr:.3f}")

print("\n=== E005 — config 스캔 최악 containment spike ===")
from experiments.e005_adaptive_evasion.experiment import run as r5
results = []
for seed in [1, 7, 42, 1337]:
    for kw in [dict(target_fpr=0.10), dict(target_fpr=0.10, survival_fraction=0.9, fresh_fraction=0.05),
               dict(target_fpr=0.10, drift=0.05, mutation_scale=0.01), dict(target_fpr=0.10, rounds=100),
               dict(target_fpr=0.10, survival_fraction=0.5, fresh_fraction=0.5)]:
        for d in ['static', 'moving']:
            r = r5(seed=seed, defense=d, **kw)
            results.append((max(r['containment_failure_by_round']), r['escalation'], d, seed, kw))
results.sort(reverse=True)
print("  top 8 (max containment failure):")
for mf, esc, d, seed, kw in results[:8]:
    print(f"    max_failure={mf:.4f} esc={esc:.4f} defense={d} seed={seed} {kw}")