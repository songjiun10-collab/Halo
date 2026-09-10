import csv
import math
import statistics
from pathlib import Path

import matplotlib.pyplot as plt

from experiment import run

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)
CORRUPTIONS = [0, 0.01, 0.02, 0.05, 0.10, 0.20]
SEEDS = list(range(20))
ACTIONS = 20_000
PROTOCOLS = ["model_monitor", "deterministic", "halo_redundant"]

rows = []
for corruption in CORRUPTIONS:
    for seed in SEEDS:
        result = run(seed=seed, corruption=corruption, n=ACTIONS)
        for protocol, metrics in result.items():
            rows.append({"corruption": corruption, "seed": seed, "protocol": protocol, **metrics})

with (RESULTS / "results.csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)

summary = []
for corruption in CORRUPTIONS:
    for protocol in PROTOCOLS:
        failure = [r["containment_failure_rate"] for r in rows if r["corruption"] == corruption and r["protocol"] == protocol]
        false_block = [r["false_block_rate"] for r in rows if r["corruption"] == corruption and r["protocol"] == protocol]
        mean = statistics.mean(failure)
        ci = 1.96 * statistics.stdev(failure) / math.sqrt(len(failure))
        summary.append({"corruption": corruption, "protocol": protocol, "failure_mean": mean, "failure_ci95_halfwidth": ci, "false_block_mean": statistics.mean(false_block)})

with (RESULTS / "summary.csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=summary[0].keys())
    writer.writeheader()
    writer.writerows(summary)

for protocol in PROTOCOLS:
    subset = [x for x in summary if x["protocol"] == protocol]
    plt.plot([x["corruption"] * 100 for x in subset], [x["failure_mean"] * 100 for x in subset], marker="o", label=protocol)
plt.xlabel("Trusted metadata corruption (%)")
plt.ylabel("Containment failure rate (%)")
plt.title("HALO E001 — Trusted-Base Degradation")
plt.legend()
plt.grid(True, alpha=0.25)
plt.tight_layout()
plt.savefig(RESULTS / "degradation_curve.png", dpi=180)
