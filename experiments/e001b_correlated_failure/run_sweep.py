import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from experiment import run

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
RESULTS.mkdir(exist_ok=True)
PS = [0.01, 0.05, 0.10, 0.20]
RHOS = [0.00, 0.25, 0.50, 0.75, 1.00]
SEEDS = list(range(30))
ACTIONS = 100_000

rows = []
checks = []
for p in PS:
    for rho in RHOS:
        for seed in SEEDS:
            out, meta = run(seed=seed, p=p, rho=rho, n=ACTIONS)
            for protocol, metrics in out.items():
                rows.append({"p": p, "rho": rho, "seed": seed, "protocol": protocol, **metrics})
            checks.append({"p": p, "rho": rho, "seed": seed, **meta})

df = pd.DataFrame(rows)
checks_df = pd.DataFrame(checks)
df.to_csv(RESULTS / "results.csv", index=False)
checks_df.to_csv(RESULTS / "correlation_checks.csv", index=False)
agg = []
for (p, rho, protocol), group in df.groupby(["p", "rho", "protocol"]):
    for metric in ["containment_failure_rate", "false_block_rate", "benign_success_rate"]:
        vals = group[metric].to_numpy()
        agg.append({"p": p, "rho": rho, "protocol": protocol, "metric": metric, "mean": float(vals.mean()), "ci95_halfwidth": float(1.96 * vals.std(ddof=1) / math.sqrt(len(vals))), "n_seeds": len(vals)})
summary = pd.DataFrame(agg)
summary.to_csv(RESULTS / "summary.csv", index=False)
config = {"p": PS, "rho": RHOS, "seeds": SEEDS, "actions_per_seed": ACTIONS, "correlation_construction": "rho-mixture of shared Bernoulli(p) and independent Bernoulli(p)"}
(RESULTS / "experiment_config.json").write_text(json.dumps(config, indent=2))

p_focus = 0.05
for protocol in ["single_source", "redundant_fail_closed"]:
    subset = summary[(summary.p == p_focus) & (summary.protocol == protocol) & (summary.metric == "containment_failure_rate")].sort_values("rho")
    plt.plot(subset["rho"], subset["mean"] * 100, marker="o", label=protocol)
plt.xlabel("Cross-source error correlation (rho)")
plt.ylabel("Containment failure rate (%)")
plt.title("HALO E001-B — 5% marginal metadata error")
plt.legend()
plt.grid(True, alpha=0.25)
plt.tight_layout()
plt.savefig(RESULTS / "failure_vs_correlation_p05.png", dpi=180)
plt.close()

failure = summary[(summary.p == p_focus) & (summary.protocol == "redundant_fail_closed") & (summary.metric == "containment_failure_rate")].sort_values("rho")
blocks = summary[(summary.p == p_focus) & (summary.protocol == "redundant_fail_closed") & (summary.metric == "false_block_rate")].sort_values("rho")
plt.plot(failure["rho"], failure["mean"] * 100, marker="o", label="containment failure")
plt.plot(blocks["rho"], blocks["mean"] * 100, marker="o", label="false block")
plt.xlabel("Cross-source error correlation (rho)")
plt.ylabel("Rate (%)")
plt.title("HALO E001-B — Safety/usefulness tradeoff at 5% error")
plt.legend()
plt.grid(True, alpha=0.25)
plt.tight_layout()
plt.savefig(RESULTS / "tradeoff_p05.png", dpi=180)
plt.close()

compact = summary[(summary.p == p_focus) & summary.metric.isin(["containment_failure_rate", "false_block_rate"])].pivot_table(index=["rho", "protocol"], columns="metric", values="mean").reset_index()
compact.to_csv(RESULTS / "compact_p05.csv", index=False)
