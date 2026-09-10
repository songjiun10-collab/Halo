import csv, math, statistics
from pathlib import Path
from experiment import evaluate

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)

HIDDEN = [0.0, 0.10, 0.25, 0.50, 0.75, 1.0]
SEEDS = list(range(30))
ROWS = []

for h in HIDDEN:
    for seed in SEEDS:
        out, diag = evaluate(seed=seed, hidden_fraction=h)
        for protocol, metrics in out.items():
            ROWS.append({
                "hidden_fraction": h,
                "seed": seed,
                "protocol": protocol,
                **metrics,
                **diag,
            })

with (RESULTS / "results.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=ROWS[0].keys())
    w.writeheader()
    w.writerows(ROWS)

summary = []
for h in HIDDEN:
    for p in ("single_m1", "algorithm_diverse", "evidence_diverse"):
        subset = [r for r in ROWS if r["hidden_fraction"] == h and r["protocol"] == p]
        vals = [r["tpr"] for r in subset]
        summary.append({
            "hidden_fraction": h,
            "protocol": p,
            "tpr_mean": statistics.mean(vals),
            "tpr_ci95_halfwidth": 1.96 * statistics.stdev(vals) / math.sqrt(len(vals)),
            "fpr_mean": statistics.mean(r["fpr"] for r in subset),
            "known_tpr_mean": statistics.mean(r["known_tpr"] for r in subset if not math.isnan(r["known_tpr"])),
            "hidden_tpr_mean": statistics.mean(r["hidden_tpr"] for r in subset if not math.isnan(r["hidden_tpr"])) if h > 0 else float("nan"),
        })

with (RESULTS / "summary.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=summary[0].keys())
    w.writeheader()
    w.writerows(summary)
