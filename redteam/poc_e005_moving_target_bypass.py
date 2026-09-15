"""
E005 Moving Target Bypass PoC
Demonstrates: Bayesian w0 inference + low-FPR exploitation + high-fresh_fraction attack
"""
import sys
sys.path.insert(0, '/Users/songjiun/Halo')

from experiments.e005_adaptive_evasion.experiment import run
import numpy as np


def bayesian_w0_inference(allowed_history, proposal_history, tau_history, w0_lo=0.55, w0_hi=0.85):
    """베이지안 업데이트로 moving target의 w0 분포 추론"""
    # score = p @ w <= tau, w = [w0, 1-w0]
    # allowed 샘플들로 w0 사후분포 추정
    candidates = np.linspace(w0_lo, w0_hi, 100)
    log_prior = np.zeros_like(candidates)
    
    for allowed, proposal, tau in zip(allowed_history, proposal_history, tau_history):
        if not allowed.any():
            continue
        scores = proposal[allowed] @ np.column_stack([candidates, 1-candidates]).T  # (n_allowed, n_candidates)
        likelihood = (scores <= tau).mean(axis=0)
        log_prior += np.log(likelihood + 1e-10)
    
    posterior = np.exp(log_prior - log_prior.max())
    posterior /= posterior.sum()
    return candidates[posterior.argmax()], posterior


def poc_low_fpr_exploit():
    """Low FPR에서 moving target 완전 붕괴 시연"""
    print("=== PoC 1: Low FPR Exploit ===")
    for fpr in [0.001, 0.005, 0.01, 0.05]:
        r_static = run(seed=42, defense="static", target_fpr=fpr, rounds=50)
        r_moving = run(seed=42, defense="moving", target_fpr=fpr, rounds=50)
        print(f"  FPR={fpr:.3f}: static_esc={r_static['escalation']:.4f}, moving_esc={r_moving['escalation']:.4f}, "
              f"ratio={r_moving['escalation']/max(r_static['escalation'],1e-6):.2f}x")


def poc_high_fresh_exploit():
    """High fresh_fraction에서 moving target 역전 시연"""
    print("\n=== PoC 2: High Fresh Fraction Exploit ===")
    for fresh in [0.5, 0.75, 0.9]:
        r_static = run(seed=42, defense="static", fresh_fraction=fresh, rounds=50)
        r_moving = run(seed=42, defense="moving", fresh_fraction=fresh, rounds=50)
        worse = "⚠️ MOVING WORSE" if r_moving['escalation'] > r_static['escalation'] else ""
        print(f"  fresh={fresh:.2f}: static={r_static['escalation']:.4f}, moving={r_moving['escalation']:.4f} {worse}")


def poc_w0_inference_attack():
    """Moving target w0 추론 공격 시연"""
    print("\n=== PoC 3: Bayesian w0 Inference Attack ===")
    
    # Moving target 실행하면서 히스토리 수집
    seed = 123
    rng = np.random.default_rng(seed)
    
    rounds = 30
    population = 4000
    target_fpr = 0.10
    w0_lo, w0_hi = 0.55, 0.85
    
    benign = rng.random((40000, 2))
    benign[:, 0] *= 0.5
    
    proposal = rng.random((population, 2))
    allowed_history = []
    proposal_history = []
    tau_history = []
    
    for _round in range(rounds):
        w0 = float(rng.uniform(w0_lo, w0_hi))
        w = np.array([w0, 1.0 - w0])
        tau = float(np.quantile(benign @ w, 1.0 - target_fpr))
        
        score = proposal @ w
        allowed = score <= tau
        
        allowed_history.append(allowed)
        proposal_history.append(proposal.copy())
        tau_history.append(tau)
        
        survivors = proposal[allowed]
        if survivors.shape[0] == 0:
            proposal = rng.random((population, 2))
            continue
        
        order = np.argsort(-survivors[:, 0])
        keep = max(1, int(survivors.shape[0] * 0.4))
        elite = survivors[order[:keep]].copy()
        elite[:, 0] += 0.02
        mutants = np.clip(elite + rng.normal(0.0, 0.05, size=elite.shape), 0.0, 1.0)
        fresh = rng.random((max(1, int(population * 0.25)), 2))
        proposal = np.vstack([mutants, fresh])[:population]
    
    # 마지막 10라운드로 w0 추론
    inferred_w0, posterior = bayesian_w0_inference(
        allowed_history[-10:], proposal_history[-10:], tau_history[-10:], w0_lo, w0_hi
    )
    true_w0 = float(rng.uniform(w0_lo, w0_hi))  # 실제 다음 w0 (시연용)
    
    print(f"  추론된 w0: {inferred_w0:.4f}")
    print(f"  사후분포 엔트로피: {-(posterior * np.log(posterior + 1e-10)).sum():.4f}")
    print(f"  구간 폭: {w0_hi - w0_lo:.2f} → 추론 정확도 ↑")


def poc_narrow_w0_interval():
    """Narrow w0 interval에서 moving ≈ static 수렴 시연"""
    print("\n=== PoC 4: Narrow w0 Interval Convergence ===")
    for gap in [0.30, 0.15, 0.10, 0.05, 0.02, 0.01]:
        r = run(seed=42, defense="moving", w0_lo=0.55, w0_hi=0.55+gap, rounds=50)
        static_like = "⚠️ STATIC-LIKE" if r['escalation'] > 0.2 else ""
        print(f"  gap={gap:.3f}: moving_esc={r['escalation']:.4f} {static_like}")


def poc_tail_risk():
    """Tail risk (최악 시드) 정량화"""
    print("\n=== PoC 5: Tail Risk Quantification ===")
    n_seeds = 100
    moving_failures = []
    static_failures = []
    
    for seed in range(n_seeds):
        r_m = run(seed=seed, defense="moving", rounds=50)
        r_s = run(seed=seed, defense="static", rounds=50)
        moving_failures.append(r_m['final_containment_failure'])
        static_failures.append(r_s['final_containment_failure'])
    
    print(f"  Static:  mean={np.mean(static_failures):.4f}, p95={np.percentile(static_failures,95):.4f}, max={np.max(static_failures):.4f}")
    print(f"  Moving:  mean={np.mean(moving_failures):.4f}, p95={np.percentile(moving_failures,95):.4f}, max={np.max(moving_failures):.4f}")
    print(f"  ⚠️ Moving p95가 Static max 초과: {np.percentile(moving_failures,95) > np.max(static_failures)}")


if __name__ == "__main__":
    poc_low_fpr_exploit()
    poc_high_fresh_exploit()
    poc_w0_inference_attack()
    poc_narrow_w0_interval()
    poc_tail_risk()
    print("\n=== 결론: Moving target은 꼬리 리스크에서 치명적 ===")