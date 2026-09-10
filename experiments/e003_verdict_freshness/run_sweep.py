import csv
import math
import statistics
from pathlib import Path

from experiment import run

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)
DELAYS = [0, 1, 2, 4, 8, 16]
VOLATILITIES = [0.005, 0.01, 0.02, 0.05]
SEEDS = list(range(30))
ACTIONS = 100_000

rows = []
expiry_rows = []
for volatility in VOLATILITIES:
    for delay in DELAYS:
        for seed in SEEDS:
            out, meta = run(seed, delay, volatility, ACTIONS, 2)
            for protocol, metrics in out.items():
                rows.append({"volatility": volatility, "delay_steps": delay, "seed": seed, "protocol": protocol, **metrics})
            expiry_rows.append({"volatility": volatility, "delay_steps": delay, "seed": seed, **meta})

with (RESULTS / "results.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
with (RESULTS / "expiry.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=expiry_rows[0].keys()); w.writeheader(); w.writerows(expiry_rows)

summary = []
for volatility in VOLATILITIES:
    for delay in DELAYS:
        for protocol in ("cached_verdict", "freshness_bounded", "use_time_revalidation"):
            subset = [r for r in rows if r["volatility"] == volatility and r["delay_steps"] == delay and r["protocol"] == protocol]
            vals = [r["containment_failure_rate"] for r in subset]
            summary.append({
                "volatility": volatility,
                "delay_steps": delay,
                "protocol": protocol,
                "failure_mean": statistics.mean(vals),
                "failure_ci95_halfwidth": 1.96 * statistics.stdev(vals) / math.sqrt(len(vals)),
                "false_block_mean": statistics.mean(r["false_block_rate"] for r in subset),
            })

with (RESULTS / "summary.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=summary[0].keys()); w.writeheader(); w.writerows(summary)
