//! Shared blind spots in synthetic monitor ensembles.
use super::e001::{
    count, extend, mean_ci, number, prepare_output, probability, probability_grid, ratio, seed,
    seeds, validate_object, write_csv, write_json, write_svg,
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use rand_distr::StandardNormal;
use serde_json::{json, Value};
use std::path::Path;

const NAMES: [&str; 8] = [
    "single_m1",
    "algorithm_diverse",
    "evidence_diverse",
    "max_pool",
    "weighted_max",
    "hybrid_evidence",
    "adaptive_evidence",
    "conservative_max",
];

pub(super) fn quantile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = (sorted.len() - 1) as f64 * q;
    let lo = index.floor() as usize;
    let hi = index.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo as f64)
}

fn pool(x: [f64; 4]) -> [f64; 8] {
    // Scale before summation to avoid overflowing a finite arithmetic mean.
    let scale = x[..3].iter().map(|v| v.abs()).fold(0., f64::max);
    let avg = if scale == 0. {
        0.
    } else {
        ((x[0] / scale + x[1] / scale + x[2] / scale) / 3.) * scale
    };
    let evidence = avg.max(x[3]);
    let max = x.into_iter().fold(f64::NEG_INFINITY, f64::max);
    [
        x[0],
        avg,
        evidence,
        max,
        0.6 * max + 0.4 * evidence,
        0.3 * avg + 0.7 * max,
        evidence.max(max * 0.8),
        max * 0.95,
    ]
}
fn scores(rng: &mut StdRng, mean: [f64; 4], n: usize) -> Vec<[f64; 4]> {
    (0..n)
        .map(|_| {
            let shared = rng.sample::<f64, _>(StandardNormal) * 0.2;
            mean.map(|m| m + shared + rng.sample::<f64, _>(StandardNormal))
        })
        .collect()
}
fn correlation(x: &[[f64; 4]], a: usize, b: usize) -> f64 {
    if x.len() < 2 {
        return f64::NAN;
    }
    let ma = x.iter().map(|v| v[a]).sum::<f64>() / x.len() as f64;
    let mb = x.iter().map(|v| v[b]).sum::<f64>() / x.len() as f64;
    let cov = x.iter().map(|v| (v[a] - ma) * (v[b] - mb)).sum::<f64>();
    let va = x.iter().map(|v| (v[a] - ma).powi(2)).sum::<f64>();
    let vb = x.iter().map(|v| (v[b] - mb).powi(2)).sum::<f64>();
    cov / (va * vb).sqrt()
}

pub fn execute(config: &Value) -> Result<Value, String> {
    validate_object(config)?;
    let fpr = probability(config, "target_fpr", 0.1)?;
    if let Some(op) = config.get("operation") {
        let rows = config["scores"]
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or("scores must be nonempty rows")?;
        let rows: Result<Vec<[f64; 8]>, String> = rows
            .iter()
            .map(|row| {
                let row = row
                    .as_array()
                    .filter(|r| r.len() == 4)
                    .ok_or("each score row needs four values")?;
                let mut a = [0.; 4];
                for (i, v) in row.iter().enumerate() {
                    a[i] = v
                        .as_f64()
                        .filter(|x| x.is_finite())
                        .ok_or("scores must be finite")?;
                }
                Ok(pool(a))
            })
            .collect();
        let rows = rows?;
        let mut out = json!({});
        for (i, name) in NAMES.iter().enumerate() {
            let vals: Vec<_> = rows.iter().map(|r| r[i]).collect();
            out[*name] = match op.as_str() {
                Some("protocol_scores") => json!(vals),
                Some("calibrate_thresholds") => json!(quantile(&vals, 1. - fpr)),
                _ => return Err("unknown operation".into()),
            };
        }
        return Ok(out);
    }
    let h = probability(config, "hidden_fraction", 0.)?;
    let nb = count(config, "n_benign", 30000)?;
    let na = count(config, "n_attack", 30000)?;
    let mut rng = StdRng::seed_from_u64(seed(config)?);
    let benign = scores(&mut rng, [0.; 4], nb);
    let hidden = (na as f64 * h).round_ties_even() as usize;
    let known_count = na - hidden;
    let mut known = Vec::new();
    for (i, m) in [
        [3.2, 1.1, 1., 0.3],
        [1., 3.2, 1.1, 0.3],
        [1.1, 1., 3.2, 0.3],
    ]
    .into_iter()
    .enumerate()
    {
        known.extend(scores(
            &mut rng,
            m,
            known_count / 3 + usize::from(i < known_count % 3),
        ));
    }
    let hidden_scores = scores(&mut rng, [0.05, 0.05, 0.05, 3.4], hidden);
    let b: Vec<_> = benign.into_iter().map(pool).collect();
    let k: Vec<_> = known.iter().copied().map(pool).collect();
    let hs: Vec<_> = hidden_scores.into_iter().map(pool).collect();
    let mut out = json!({});
    for (i, name) in NAMES.iter().enumerate() {
        let t = quantile(&b.iter().map(|v| v[i]).collect::<Vec<_>>(), 1. - fpr);
        let kp = k.iter().filter(|v| v[i] >= t).count();
        let hp = hs.iter().filter(|v| v[i] >= t).count();
        out[*name] = json!({"threshold":t,"fpr":ratio(b.iter().filter(|v|v[i]>=t).count(),nb),"tpr":ratio(kp+hp,na),"known_tpr":ratio(kp,k.len()),"hidden_tpr":ratio(hp,hs.len())});
    }
    let c: Vec<_> = [
        correlation(&known, 0, 1),
        correlation(&known, 0, 2),
        correlation(&known, 1, 2),
    ]
    .into_iter()
    .filter(|v| v.is_finite())
    .collect();
    Ok(json!({"results":out,"diagnostics":{"known_attack_mean_pairwise_corr":mean_ci(&c).0}}))
}

pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    validate_object(config)?;
    let levels = probability_grid(
        config,
        &["hidden_fractions", "hidden_fraction"],
        &[0., 0.1, 0.25, 0.5, 0.75, 1.],
    )?;
    let all_seeds = seeds(config, 30)?;
    let mut base = config.clone();
    if config.get("n").is_some() {
        let n = count(config, "n", 30000)?;
        if config.get("n_benign").is_none() {
            base["n_benign"] = json!(n);
        }
        if config.get("n_attack").is_none() {
            base["n_attack"] = json!(n);
        }
    }
    let mut rows = Vec::new();
    let mut summary = Vec::new();
    for h in levels {
        for seed in &all_seeds {
            let mut c = base.clone();
            c["seed"] = json!(seed);
            c["hidden_fraction"] = json!(h);
            let result = execute(&c)?;
            for name in NAMES {
                rows.push(extend(
                    extend(
                        json!({"hidden_fraction":h,"seed":seed,"protocol":name}),
                        &result["results"][name],
                    ),
                    &result["diagnostics"],
                ));
            }
        }
        for name in ["single_m1", "algorithm_diverse", "evidence_diverse"] {
            let selected: Vec<_> = rows
                .iter()
                .filter(|r| number(r, "hidden_fraction") == h && r["protocol"] == name)
                .collect();
            let values = |key| selected.iter().map(|r| number(r, key)).collect::<Vec<_>>();
            let (avg, ci) = mean_ci(&values("tpr"));
            let finite_mean = |key| {
                mean_ci(
                    &values(key)
                        .into_iter()
                        .filter(|x| x.is_finite())
                        .collect::<Vec<_>>(),
                )
                .0
            };
            summary.push(json!({"hidden_fraction":h,"protocol":name,"tpr_mean":avg,"tpr_ci95_halfwidth":ci,"fpr_mean":mean_ci(&values("fpr")).0,"known_tpr_mean":finite_mean("known_tpr"),"hidden_tpr_mean":finite_mean("hidden_tpr")}));
        }
    }
    prepare_output(output)?;
    write_csv(
        &output.join("results.csv"),
        &[
            "hidden_fraction",
            "seed",
            "protocol",
            "threshold",
            "fpr",
            "tpr",
            "known_tpr",
            "hidden_tpr",
            "known_attack_mean_pairwise_corr",
        ],
        &rows,
    )?;
    write_csv(
        &output.join("summary.csv"),
        &[
            "hidden_fraction",
            "protocol",
            "tpr_mean",
            "tpr_ci95_halfwidth",
            "fpr_mean",
            "known_tpr_mean",
            "hidden_tpr_mean",
        ],
        &summary,
    )?;
    let series = ["single_m1", "algorithm_diverse", "evidence_diverse"]
        .iter()
        .map(|n| {
            (
                n.to_string(),
                summary
                    .iter()
                    .filter(|r| r["protocol"] == *n)
                    .map(|r| (number(r, "hidden_fraction"), number(r, "tpr_mean") * 100.))
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    write_svg(
        &output.join("blind_spot_curve.svg"),
        "HALO E002 — Shared blind spots",
        "Hidden attack fraction",
        "True positive rate (%)",
        &series,
    )?;
    write_json(&output.join("experiment_config.json"), &base)?;
    Ok(json!({"experiment":"e002","rows":rows.len(),"summary_rows":summary.len(),"output":output}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn audit_large_finite_scores_remain_finite() {
        let result =
            execute(&json!({"operation":"protocol_scores", "scores":[[1e308,1e308,1e308,1e308]]}))
                .unwrap();
        for (name, values) in result.as_object().unwrap() {
            assert!(
                values[0].as_f64().is_some_and(f64::is_finite),
                "finite input produced nonfinite output in {name}: {}",
                values[0]
            );
        }
    }

    #[test]
    fn extreme_mean_preserves_sign_and_cancellation() {
        for sign in [-1., 1.] {
            let x = f64::MAX * sign;
            assert_eq!(pool([x, x, x, x])[1], x);
        }
        let mean = pool([f64::MAX, -f64::MAX, 3., 0.])[1];
        assert!((mean - 1.).abs() < 1e-14);
    }

    #[test]
    fn every_protocol_respects_empirical_false_positive_calibration() {
        let result = execute(
            &json!({"seed": 1, "hidden_fraction": 0.5, "n_benign": 10000, "n_attack": 10000}),
        )
        .unwrap();
        let rows = result["results"].as_object().unwrap();
        assert_eq!(rows.len(), 8);
        for metrics in rows.values() {
            assert!((metrics["fpr"].as_f64().unwrap() - 0.1).abs() < 0.001);
        }
    }

    #[test]
    fn hidden_family_defeats_algorithm_diversity_but_independent_evidence_detects_it() {
        let result = execute(
            &json!({"seed": 2, "hidden_fraction": 1, "n_benign": 10000, "n_attack": 10000}),
        )
        .unwrap();
        assert!(
            result["results"]["algorithm_diverse"]["tpr"]
                .as_f64()
                .unwrap()
                < 0.2
        );
        assert!(
            result["results"]["evidence_diverse"]["tpr"]
                .as_f64()
                .unwrap()
                > 0.9
        );
        for metrics in result["results"].as_object().unwrap().values() {
            assert!(metrics["known_tpr"].is_null());
        }
        assert!(result["diagnostics"]["known_attack_mean_pairwise_corr"].is_null());
    }

    #[test]
    fn ensemble_outperforms_single_monitor_on_known_families() {
        let config = json!({"seed": 3, "hidden_fraction": 0, "n_benign": 10000, "n_attack": 10000});
        let result = execute(&config).unwrap();
        assert_eq!(result, execute(&config).unwrap());
        assert!(
            result["results"]["algorithm_diverse"]["tpr"]
                .as_f64()
                .unwrap()
                > result["results"]["single_m1"]["tpr"].as_f64().unwrap()
        );
        for metrics in result["results"].as_object().unwrap().values() {
            assert!(metrics["hidden_tpr"].is_null());
        }
    }

    #[test]
    fn validates_populations_and_probability_inputs() {
        for config in [
            json!({"hidden_fraction": -0.1}),
            json!({"hidden_fraction": 1.1}),
            json!({"target_fpr": "bad"}),
            json!({"target_fpr": 1.1}),
            json!({"n_attack": 0}),
            json!({"n_benign": true}),
            json!({"n_attack": 1.5}),
        ] {
            assert!(execute(&config).is_err(), "accepted {config}");
        }
    }

    #[test]
    fn sweep_keeps_all_raw_protocols_and_original_summary_selection() {
        let output = tempfile::tempdir().unwrap();
        let report = sweep(&json!({"seeds": 1, "n": 30}), output.path()).unwrap();
        assert_eq!(report["rows"], 48);
        assert_eq!(report["summary_rows"], 18);
        assert_eq!(
            csv::Reader::from_path(output.path().join("results.csv"))
                .unwrap()
                .records()
                .count(),
            48
        );
        let mut summary = csv::Reader::from_path(output.path().join("summary.csv")).unwrap();
        let headers = summary.headers().unwrap().clone();
        let hidden_index = headers
            .iter()
            .position(|name| name == "hidden_fraction")
            .unwrap();
        let known_index = headers
            .iter()
            .position(|name| name == "known_tpr_mean")
            .unwrap();
        let rows: Vec<_> = summary.records().map(Result::unwrap).collect();
        assert_eq!(rows.len(), 18);
        assert!(rows
            .iter()
            .filter(|r| r[hidden_index].parse::<f64>().unwrap() == 1.0)
            .all(|r| r[known_index].parse::<f64>().unwrap().is_nan()));
        assert!(
            std::fs::read_to_string(output.path().join("blind_spot_curve.svg"))
                .unwrap()
                .contains("<svg")
        );
    }
}
