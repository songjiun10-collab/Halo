//! Correlated metadata failure and independent validators.
use super::e001::{
    count, deterministic, extend, mean_ci, number, prepare_output, probability, probability_grid,
    seed, seeds, validate_object, write_csv, write_json, write_svg, Counts,
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Map, Value};
use std::path::Path;

const PROTOCOLS: [&str; 4] = [
    "single_source",
    "redundant_fail_closed",
    "correlation_aware",
    "three_source_diverse",
];
const METRICS: [&str; 3] = [
    "containment_failure_rate",
    "false_block_rate",
    "benign_success_rate",
];

/// JSON representation of Python's (results, diagnostics) return value.
pub fn execute(config: &Value) -> Result<Value, String> {
    validate_object(config)?;
    Ok(run(
        seed(config)?,
        probability(config, "p", 0.05)?,
        probability(config, "rho", 0.0)?,
        count(config, "n", 100_000)?,
    ))
}

fn correlated_error_pair(rng: &mut StdRng, p: f64, rho: f64) -> (bool, bool) {
    let common = rng.gen::<f64>() < rho;
    let shared = rng.gen::<f64>() < p;
    let first = rng.gen::<f64>() < p;
    let second = rng.gen::<f64>() < p;
    if common {
        (shared, shared)
    } else {
        (first, second)
    }
}

fn run(seed: u64, p: f64, rho: f64, n: usize) -> Value {
    let mut rng = StdRng::seed_from_u64(seed);
    // A separate stream preserves the original independent-validator construction.
    let mut rng3 = StdRng::seed_from_u64(seed.wrapping_add(1000));
    let mut stats = [Counts::default(); 4];
    let (mut source1_errors, mut source2_errors, mut source3_errors, mut joint_errors) =
        (0_usize, 0_usize, 0_usize, 0_usize);
    for _ in 0..n {
        let sensitive = rng.gen::<f64>() < 0.30;
        let writable = rng.gen::<f64>() < 0.70;
        let is_write = rng.gen::<f64>() < 0.55;
        let truth = deterministic(is_write, sensitive, writable);
        let (es1, es2) = correlated_error_pair(&mut rng, p, rho);
        let (ew1, ew2) = correlated_error_pair(&mut rng, p, rho);
        let es3 = rng3.gen::<f64>() < p;
        let ew3 = rng3.gen::<f64>() < p;
        let s1 = (sensitive ^ es1, writable ^ ew1);
        let s2 = (sensitive ^ es2, writable ^ ew2);
        let allow1 = deterministic(is_write, s1.0, s1.1);
        let allow2 = deterministic(is_write, s2.0, s2.1);
        let allow3 = deterministic(is_write, sensitive ^ es3, writable ^ ew3);
        let decisions = [
            allow1,
            !is_write || (s1 == s2 && allow1 && allow2),
            !is_write || (allow3 && (allow1 || allow2)),
            !is_write || (u8::from(allow1) + u8::from(allow2) + u8::from(allow3) >= 2),
        ];
        for (counts, allow) in stats.iter_mut().zip(decisions) {
            counts.observe(truth, allow);
        }
        source1_errors += usize::from(es1);
        source2_errors += usize::from(es2);
        source3_errors += usize::from(es3);
        joint_errors += usize::from(es1 && es2);
    }
    let p1 = source1_errors as f64 / n as f64;
    let p2 = source2_errors as f64 / n as f64;
    let correlation =
        if source1_errors == 0 || source2_errors == 0 || source1_errors == n || source2_errors == n
        {
            0.0
        } else {
            ((joint_errors as f64 / n as f64 - p1 * p2)
                / (p1 * (1.0 - p1) * p2 * (1.0 - p2)).sqrt())
            .clamp(-1.0, 1.0)
        };
    let results: Map<String, Value> = PROTOCOLS
        .iter()
        .zip(stats)
        .map(|(name, s)| ((*name).to_owned(), s.metrics(true)))
        .collect();
    json!({"results": results, "diagnostics": {"empirical_error_correlation": correlation, "source1_marginal_error": p1, "source2_marginal_error": p2, "source3_marginal_error": source3_errors as f64 / n as f64}})
}

/// Retains the original 4 x 5 grid, 30 seeds and all three metrics per protocol.
pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    validate_object(config)?;
    let ps = probability_grid(config, &["ps", "p"], &[0.01, 0.05, 0.10, 0.20])?;
    let rhos = probability_grid(config, &["rhos", "rho"], &[0.00, 0.25, 0.50, 0.75, 1.00])?;
    let seeds = seeds(config, 30)?;
    let n = count(config, "n", 100_000)?;
    let mut rows = Vec::new();
    let mut checks = Vec::new();
    let mut summary = Vec::new();
    for &p in &ps {
        for &rho in &rhos {
            let mut values: Vec<Vec<Vec<f64>>> = (0..PROTOCOLS.len())
                .map(|_| (0..METRICS.len()).map(|_| Vec::new()).collect())
                .collect();
            for &seed in &seeds {
                let result = run(seed, p, rho, n);
                for (i, protocol) in PROTOCOLS.iter().enumerate() {
                    let metrics = &result["results"][*protocol];
                    for (j, metric) in METRICS.iter().enumerate() {
                        values[i][j].push(number(metrics, metric));
                    }
                    rows.push(extend(
                        json!({"p": p, "rho": rho, "seed": seed, "protocol": protocol}),
                        metrics,
                    ));
                }
                checks.push(extend(
                    json!({"p": p, "rho": rho, "seed": seed}),
                    &result["diagnostics"],
                ));
            }
            for (i, protocol) in PROTOCOLS.iter().enumerate() {
                for (j, metric) in METRICS.iter().enumerate() {
                    let (mean, ci) = mean_ci(&values[i][j]);
                    summary.push(json!({"p": p, "rho": rho, "protocol": protocol, "metric": metric, "mean": mean, "ci95_halfwidth": ci, "n_seeds": seeds.len()}));
                }
            }
        }
    }
    let mut compact = Vec::new();
    for &rho in &rhos {
        for protocol in PROTOCOLS {
            let matching = |metric| {
                summary.iter().find(|row| {
                    number(row, "p") == 0.05
                        && number(row, "rho") == rho
                        && row["protocol"] == protocol
                        && row["metric"] == metric
                })
            };
            if let (Some(failure), Some(blocked)) = (
                matching("containment_failure_rate"),
                matching("false_block_rate"),
            ) {
                compact.push(json!({"rho": rho, "protocol": protocol, "containment_failure_rate": failure["mean"], "false_block_rate": blocked["mean"]}));
            }
        }
    }
    prepare_output(output)?;
    write_csv(
        &output.join("results.csv"),
        &[
            "p",
            "rho",
            "seed",
            "protocol",
            "unsafe_total",
            "unsafe_allowed",
            "safe_total",
            "safe_blocked",
            "containment_failure_rate",
            "false_block_rate",
            "benign_success_rate",
        ],
        &rows,
    )?;
    write_csv(
        &output.join("correlation_checks.csv"),
        &[
            "p",
            "rho",
            "seed",
            "empirical_error_correlation",
            "source1_marginal_error",
            "source2_marginal_error",
            "source3_marginal_error",
        ],
        &checks,
    )?;
    write_csv(
        &output.join("summary.csv"),
        &[
            "p",
            "rho",
            "protocol",
            "metric",
            "mean",
            "ci95_halfwidth",
            "n_seeds",
        ],
        &summary,
    )?;
    write_csv(
        &output.join("compact_p05.csv"),
        &[
            "rho",
            "protocol",
            "containment_failure_rate",
            "false_block_rate",
        ],
        &compact,
    )?;
    let points = |protocol: &str, metric: &str| {
        summary
            .iter()
            .filter(|row| {
                number(row, "p") == 0.05 && row["protocol"] == protocol && row["metric"] == metric
            })
            .map(|row| (number(row, "rho"), number(row, "mean") * 100.0))
            .collect::<Vec<_>>()
    };
    write_svg(
        &output.join("failure_vs_correlation_p05.svg"),
        "HALO E001-B — 5% marginal metadata error",
        "Cross-source error correlation (rho)",
        "Containment failure rate (%)",
        &[
            (
                "single_source".to_owned(),
                points("single_source", "containment_failure_rate"),
            ),
            (
                "redundant_fail_closed".to_owned(),
                points("redundant_fail_closed", "containment_failure_rate"),
            ),
        ],
    )?;
    write_svg(
        &output.join("tradeoff_p05.svg"),
        "HALO E001-B — Safety/usefulness tradeoff at 5% error",
        "Cross-source error correlation (rho)",
        "Rate (%)",
        &[
            (
                "containment failure".to_owned(),
                points("redundant_fail_closed", "containment_failure_rate"),
            ),
            (
                "false block".to_owned(),
                points("redundant_fail_closed", "false_block_rate"),
            ),
        ],
    )?;
    let resolved = json!({"p": ps, "rho": rhos, "seeds": seeds, "actions_per_seed": n, "correlation_construction": "rho-mixture of shared Bernoulli(p) and independent Bernoulli(p)", "rng": "rand 0.8 StdRng; not NumPy bit-identical"});
    write_json(&output.join("experiment_config.json"), &resolved)?;
    Ok(
        json!({"experiment": "e001b", "output": output, "rows": rows.len(), "summary_rows": summary.len(), "files": ["results.csv", "correlation_checks.csv", "summary.csv", "experiment_config.json", "failure_vs_correlation_p05.svg", "tradeoff_p05.svg", "compact_p05.csv"], "config": resolved}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zero_error_gives_exact_decisions_in_all_four_protocols() {
        let result = execute(&json!({"seed": 0, "p": 0, "rho": 0, "n": 5000})).unwrap();
        assert_eq!(result["results"].as_object().unwrap().len(), 4);
        for metrics in result["results"].as_object().unwrap().values() {
            assert_eq!(metrics["containment_failure_rate"], 0.0);
            assert_eq!(metrics["false_block_rate"], 0.0);
            assert_eq!(
                metrics["safe_total"].as_u64().unwrap() + metrics["unsafe_total"].as_u64().unwrap(),
                5000
            );
        }
        assert_eq!(result["diagnostics"]["empirical_error_correlation"], 0.0);
    }

    #[test]
    fn generated_errors_preserve_marginals_and_requested_correlation() {
        let result = execute(&json!({"seed": 123, "p": 0.1, "rho": 0.75, "n": 200000})).unwrap();
        let diag = &result["diagnostics"];
        for source in [
            "source1_marginal_error",
            "source2_marginal_error",
            "source3_marginal_error",
        ] {
            assert!((diag[source].as_f64().unwrap() - 0.1).abs() < 0.003);
        }
        assert!((diag["empirical_error_correlation"].as_f64().unwrap() - 0.75).abs() < 0.02);
    }

    #[test]
    fn complete_correlation_collapses_two_sources_but_independence_helps() {
        let config = json!({"seed": 9, "p": 0.1, "rho": 1, "n": 20000});
        let result = execute(&config).unwrap();
        assert_eq!(result, execute(&config).unwrap());
        let rows = &result["results"];
        assert_eq!(rows["single_source"], rows["redundant_fail_closed"]);
        assert_eq!(rows["single_source"], rows["three_source_diverse"]);
        assert!(
            rows["correlation_aware"]["unsafe_allowed"]
                .as_u64()
                .unwrap()
                < rows["single_source"]["unsafe_allowed"].as_u64().unwrap()
        );
    }

    #[test]
    fn rejects_invalid_inputs_and_preserves_missing_class() {
        for config in [
            json!({"p": -0.1}),
            json!({"rho": 1.1}),
            json!({"rho": null}),
            json!({"n": 0}),
            json!({"n": true}),
            json!({"seed": -1}),
        ] {
            assert!(execute(&config).is_err(), "accepted {config}");
        }
        for seed in 0..10 {
            let result = execute(&json!({"seed": seed, "n": 1})).unwrap();
            for metrics in result["results"].as_object().unwrap().values() {
                assert_ne!(
                    metrics["containment_failure_rate"].is_null(),
                    metrics["false_block_rate"].is_null()
                );
            }
        }
    }

    #[test]
    fn sweep_writes_all_protocols_metrics_and_correlation_checks() {
        let output = tempfile::tempdir().unwrap();
        let report = sweep(&json!({"seeds": 1, "n": 20}), output.path()).unwrap();
        assert_eq!(report["rows"], 80);
        assert_eq!(report["summary_rows"], 240);
        for (file, expected) in [
            ("results.csv", 80),
            ("summary.csv", 240),
            ("correlation_checks.csv", 20),
            ("compact_p05.csv", 20),
        ] {
            assert_eq!(
                csv::Reader::from_path(output.path().join(file))
                    .unwrap()
                    .records()
                    .count(),
                expected
            );
        }
        for file in ["failure_vs_correlation_p05.svg", "tradeoff_p05.svg"] {
            assert!(std::fs::read_to_string(output.path().join(file))
                .unwrap()
                .contains("<svg"));
        }
    }
}
