import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from experiment import evaluate

def test_fpr_calibration():
    out, _ = evaluate(seed=1, hidden_fraction=0.5, n_benign=20000, n_attack=20000)
    for metrics in out.values():
        assert 0.095 <= metrics["fpr"] <= 0.105

def test_hidden_family_is_shared_blind_spot():
    out, _ = evaluate(seed=2, hidden_fraction=1.0, n_benign=30000, n_attack=30000)
    assert out["algorithm_diverse"]["tpr"] < 0.20
    assert out["evidence_diverse"]["tpr"] > 0.90

def test_algorithm_ensemble_works_on_known_families():
    out, _ = evaluate(seed=3, hidden_fraction=0.0, n_benign=30000, n_attack=30000)
    assert out["algorithm_diverse"]["tpr"] > out["single_m1"]["tpr"]
