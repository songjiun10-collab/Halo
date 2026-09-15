import csv
import math
import statistics
from pathlib import Path

from experiment import run

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)

DEFENSES = ("static", "moving")
SEEDS = list(range(30))
ROWS = []

for defense in DEFENSES:
    for seed in SEEDS:
        out = run(seed=seed, defense=defense, rounds=30, population=4000)
        ROWS.append({
            "defense": defense,
            "seed": seed,
            "initial_containment_failure": out["initial_containment_failure"],
            "final_containment_failure": out["final_containment_failure"],
            "escalation": out["escalation"],
            "mean_false_block_rate": out["mean_false_block_rate"],
        })

with (RESULTS / "results.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=ROWS[0].keys())
    w.writeheader()
    w.writerows(ROWS)

summary = []
for defense in DEFENSES:
    subset = [r for r in ROWS if r["defense"] == defense]
    esc = [r["escalation"] for r in subset]
    summary.append({
        "defense": defense,
        "escalation_mean": statistics.mean(esc),
        "escalation_std": statistics.stdev(esc),
        "escalation_ci95_halfwidth": 1.96 * statistics.stdev(esc) / math.sqrt(len(esc)),
        "final_containment_failure_mean": statistics.mean(r["final_containment_failure"] for r in subset),
        "false_block_rate_mean": statistics.mean(r["mean_false_block_rate"] for r in subset),
    })

with (RESULTS / "summary.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=summary[0].keys())
    w.writeheader()
    w.writerows(summary)