import sys
sys.path.insert(0, '/Users/songjiun/Halo')
import numpy as np
from experiments.e001_trusted_base.experiment import run as r1e
from experiments.e004_robust_evaluation.experiment import select_worst_group_threshold, select_robust_threshold, evaluate as e4e
from experiments.e005_adaptive_evasion.experiment import run as r5
from experiments.e001b_correlated_failure.experiment import run as r1b
from experiments.e003_verdict_freshness.experiment import run as r3

print("=== E001: corruption 스윕 (실패율 + 오탐차단) ===")
print(f"{'corruption':>10s} {'model_fail':>10s} {'model_blk':>10s} {'det_fail':>10s} {'det_blk':>10s} {'halo_fail':>10s} {'halo_blk':>10s}")
for c in [0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]:
    out = r1e(seed=42, corruption=c, n=100000)
    print(f"{c:>10.2f} {out['model_monitor']['containment_failure_rate']:>10.4f} {out['model_monitor']['false_block_rate']:>10.4f} "
          f"{out['deterministic']['containment_failure_rate']:>10.4f} {out['deterministic']['false_block_rate']:>10.4f} "
          f"{out['halo_redundant']['containment_failure_rate']:>10.4f} {out['halo_redundant']['false_block_rate']:>10.4f}")

print("\n=== E001: model_monitor 다수 seed (corruption=0에서 이미 실패?) ===")
fails = [r1e(seed=s, corruption=0.0, n=100000)['model_monitor']['containment_failure_rate'] for s in range(20)]
print(f"  corruption=0: mean={np.mean(fails):.4f} max={max(fails):.4f}")

print("\n=== E004: worst_group 선택기 직접 공격 ===")
rng = np.random.default_rng(7)
ben = np.clip(rng.normal(0.25, 0.15, 20000), 0, 1)
thresholds = np.linspace(0.05, 0.95, 181)

print("\n-- a. FPR 예산 고갈 (고분산 benign) --")
ben_hi = np.concatenate([rng.normal(0.25, 0.15, 18000), rng.normal(0.9, 0.02, 2000)]).clip(0,1)
known = np.clip(rng.normal(0.78, 0.12, 20000), 0, 1)
hard = np.clip(rng.normal(0.48, 0.17, 5000), 0, 1)
wg = select_worst_group_threshold(ben_hi, {"known": known, "hard": hard}, thresholds, max_fpr=0.10, attack_weights={"known":0.8,"hard":0.2})
print(f"  worst_group 선택: threshold={wg.threshold:.3f} agg={wg.attack_tpr:.3f} worst={wg.worst_group_tpr:.3f} fpr={wg.false_positive_rate:.4f}")

print("\n-- b. tiny 그룹 vs 거대 그룹 (enforce_balance=False 시) --")
tiny = np.clip(rng.normal(0.42, 0.005, 5), 0, 1)
huge = np.clip(rng.normal(0.80, 0.10, 50000), 0, 1)
wg2 = select_worst_group_threshold(ben, {"tiny": tiny, "huge": huge}, thresholds, max_fpr=0.10, attack_weights={"tiny":0.001,"huge":0.999})
print(f"  worst_group 선택: threshold={wg2.threshold:.3f} worst={wg2.worst_group_tpr:.3f} groups={ {k:round(v,3) for k,v in wg2.group_tpr.items()} }")

print("\n=== E005: 블라인드 모니터 (w0<0.5) + 극단 설정 ===")
for wlo, whi in [(0.5, 0.85), (0.05, 0.3), (0.0, 0.2), (0.0, 1.0)]:
    st = r5(seed=42, defense='static', w0_lo=wlo, w0_hi=whi)
    mv = r5(seed=42, defense='moving', w0_lo=wlo, w0_hi=whi)
    print(f"  w0∈[{wlo},{whi}]: static esc={st['escalation']:.4f} max_fail={max(st['containment_failure_by_round']):.4f} | "
          f"moving esc={mv['escalation']:.4f} max_fail={max(mv['containment_failure_by_round']):.4f}")

print("\n=== E005: target_fpr=1.0 (전부 허용) ===")
r = r5(seed=42, defense='static', target_fpr=1.0)
print(f"  target_fpr=1.0: final_failure={r['containment_failure_by_round'][-1]:.4f} false_block={np.mean(r['false_block_rate_by_round']):.4f}")

print("\n=== 입력 검증 우회 (타입 주입) ===")
print("  E001B numpy int64 n:", end=" ")
try:
    o,_ = r1b(seed=42, p=0.05, rho=1.0, n=np.int64(1000))
    print("통과 (안전)", f"fail={o['correlation_aware']['containment_failure_rate']:.4f}")
except ValueError as e:
    print(f"거부: {e}")
print("  E001B numpy float p:", end=" ")
try:
    o,_ = r1b(seed=42, p=np.float64(0.05), rho=1.0, n=1000)
    print("통과", f"fail={o['correlation_aware']['containment_failure_rate']:.4f}")
except ValueError as e:
    print(f"거부: {e}")
print("  E003 numpy int delay:", end=" ")
try:
    o,_ = r3(seed=42, delay_steps=np.int64(20), volatility=0.5, n=1000, freshness_window=3)
    print("통과")
except ValueError as e:
    print(f"거부: {e}")
print("  E001 str seed:", end=" ")
try:
    out = r1e(seed="hello", corruption=0.1, n=1000)
    print("통과 (seed 타입 미검증)")
except Exception as e:
    print(f"거부: {e}")