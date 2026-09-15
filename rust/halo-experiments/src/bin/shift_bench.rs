//! WILDS/RobustBench-inspired synthetic evaluation of HALO's real E002 pooling.
use halo_experiments::e002;
use halo_experiments::shield::{Decision, Shield};
use rand::{rngs::StdRng, Rng, SeedableRng};
use rand_distr::StandardNormal;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

const DOMAINS: [&str; 6] = [
    "clean",
    "correlated",
    "heavy_tail",
    "sensor_loss",
    "offset",
    "compound",
];
const GROUPS: [&str; 4] = ["known_a", "known_b", "known_c", "unseen_evidence"];

fn generate(
    seed: u64,
    n: usize,
    family: Option<usize>,
    domain: &str,
    severity: f64,
) -> Vec<[f64; 4]> {
    let mut rng = StdRng::seed_from_u64(seed);
    // Fixed draws from an independent stream keep baseline samples and
    // corruption masks paired across domains and severity levels.
    let mut corruption_rng = StdRng::seed_from_u64(seed ^ 0xD1B54A32D192ED03);
    (0..n)
        .map(|_| {
            let shared = rng.sample::<f64, _>(StandardNormal);
            let mut row = [0.; 4];
            for (i, x) in row.iter_mut().enumerate() {
                let noise = rng.sample::<f64, _>(StandardNormal);
                let tail_mask = corruption_rng.gen::<f64>();
                let tail_noise = corruption_rng.sample::<f64, _>(StandardNormal);
                *x = noise + 0.2 * shared + if family == Some(i) { 3.4 } else { 0. };
                if domain == "correlated" || domain == "compound" {
                    *x = (1. - severity * 0.8) * noise
                        + (0.2 + severity * 1.6) * shared
                        + if family == Some(i) { 3.4 } else { 0. };
                }
                if (domain == "heavy_tail" || domain == "compound") && tail_mask < 0.1 * severity {
                    *x += tail_noise * 8. * severity;
                }
                if domain == "offset" || domain == "compound" {
                    *x += severity;
                }
            }
            let loss_mask = corruption_rng.gen::<f64>();
            if (domain == "sensor_loss" || domain == "compound") && loss_mask < severity {
                row[3] = 0.;
            }
            row
        })
        .collect()
}

fn pooled(rows: &[[f64; 4]]) -> Result<BTreeMap<String, Vec<f64>>, String> {
    let out = e002::execute(&json!({"operation":"protocol_scores", "scores":rows}))?;
    serde_json::from_value(out).map_err(|e| e.to_string())
}

// With >= decisions, move strictly above the greatest disallowed order statistic.
// This enforces the finite calibration budget even with ties or a zero budget.
fn threshold(values: &[f64], fpr: f64) -> f64 {
    let mut sorted = values.to_vec();
    let allowed = (fpr * sorted.len() as f64).floor() as usize;
    let index = sorted.len() - allowed - 1;
    let (_, threshold, _) = sorted.select_nth_unstable_by(index, f64::total_cmp);
    threshold.next_up()
}

fn count(values: &[f64], tau: f64) -> usize {
    values.iter().filter(|&&x| x >= tau).count()
}

fn interval(k: usize, n: usize) -> [f64; 2] {
    let p = k as f64 / n as f64;
    let z2 = 1.96_f64.powi(2);
    let denom = 1. + z2 / n as f64;
    let center = (p + z2 / (2. * n as f64)) / denom;
    let radius = 1.96 * ((p * (1. - p) + z2 / (4. * n as f64)) / n as f64).sqrt() / denom;
    [(center - radius).max(0.), (center + radius).min(1.)]
}

fn run(n: usize, seeds: usize) -> Result<Value, String> {
    let mut reports = Vec::new();
    let mut shield_reports = Vec::new();
    let mut checks = 0;
    for seed in 0..seeds {
        // Disjoint seed namespaces: calibration, benign test, each attack family.
        let base = seed as u64 * 10000;
        let calibration_raw = generate(base, n, None, "clean", 0.);
        let calibration = pooled(&calibration_raw)?;
        for domain in DOMAINS {
            for severity in if domain == "clean" {
                vec![0.]
            } else {
                vec![0.25, 0.5, 1.]
            } {
                // Same underlying seeds pair severity comparisons; no threshold retuning.
                let benign_raw = generate(base + 1, n, None, domain, severity);
                let benign = pooled(&benign_raw)?;
                let attack_raw: Vec<_> = (0..4)
                    .map(|g| generate(base + 2 + g as u64, n, Some(g), domain, severity))
                    .collect();
                let attacks: Vec<_> = (0..4)
                    .map(|g| pooled(&attack_raw[g]))
                    .collect::<Result<_, _>>()?;
                // An explicit additional resource: separately verified benign
                // monitoring data, never evaluation labels or attack samples.
                let refresh_raw = generate(base + 100, n, None, domain, severity);
                let complete: Vec<_> = refresh_raw
                    .into_iter()
                    .filter(|r| !((domain == "sensor_loss" || domain == "compound") && r[3] == 0.))
                    .collect();
                for budget in [0.0001, 0.01, 0.1] {
                    for mode in [
                        "frozen_centered",
                        "trusted_refresh_centered",
                        "frozen_hybrid",
                    ] {
                        let cal = if mode != "trusted_refresh_centered" {
                            &calibration_raw
                        } else {
                            &complete
                        };
                        let shield = if cal.is_empty() {
                            None
                        } else {
                            Some(if mode == "frozen_hybrid" {
                                Shield::calibrate_hybrid(cal, budget)?
                            } else {
                                Shield::calibrate(cal, budget)?
                            })
                        };
                        let evaluate = |rows: &[[f64; 4]]| {
                            let mut counts = [0_usize; 3];
                            for row in rows {
                                let mut evidence = row.map(Some);
                                // The simulator writes exact zero for a dropped
                                // fourth sensor. Production callers must supply
                                // explicit validity metadata, never infer it from zero.
                                if (domain == "sensor_loss" || domain == "compound") && row[3] == 0.
                                {
                                    evidence[3] = None;
                                }
                                let d = shield
                                    .as_ref()
                                    .map(|s| s.decide(evidence))
                                    .unwrap_or(Decision::Revalidate);
                                counts[match d {
                                    Decision::Allow => 0,
                                    Decision::Block => 1,
                                    Decision::Revalidate => 2,
                                }] += 1;
                            }
                            json!({"allow":counts[0],"block":counts[1],"revalidate":counts[2],"total":rows.len()})
                        };
                        shield_reports.push(json!({"seed":seed,"domain":domain,"severity":severity,"target_fpr":budget,
                            "mode":mode,"calibration_rows":cal.len(),"benign":evaluate(&benign_raw),
                            "attacks":attack_raw.iter().map(|r|evaluate(r)).collect::<Vec<_>>()}));
                    }
                    for (name, cal) in &calibration {
                        let tau = threshold(cal, budget);
                        if count(cal, tau) as f64 > (budget * n as f64).floor() {
                            return Err("calibration budget violated".into());
                        }
                        let fp = count(&benign[name], tau);
                        let mut groups = BTreeMap::new();
                        let mut worst = 1_f64;
                        let mut macro_tpr = 0.;
                        for (g, a) in attacks.iter().enumerate() {
                            let tp = count(&a[name], tau);
                            let tpr = tp as f64 / n as f64;
                            worst = worst.min(tpr);
                            macro_tpr += tpr / 4.;
                            groups.insert(GROUPS[g], json!({"detected":tp,"total":n,"tpr":tpr,"wilson95":interval(tp,n)}));
                        }
                        // A rare blind spot can disappear in a prevalence-weighted average.
                        let known = (0..3)
                            .map(|g| count(&attacks[g][name], tau) as f64 / n as f64)
                            .sum::<f64>()
                            / 3.;
                        let unseen = count(&attacks[3][name], tau) as f64 / n as f64;
                        let fpr = fp as f64 / n as f64;
                        let prevalence_precision = |prior: f64| {
                            let numerator = prior * macro_tpr;
                            let denominator = numerator + (1. - prior) * fpr;
                            if denominator == 0. {
                                Value::Null
                            } else {
                                json!(numerator / denominator)
                            }
                        };
                        reports.push(json!({"seed":seed,"domain":domain,"severity":severity,"protocol":name,
                            "target_fpr":budget,"threshold":tau,"calibration_false_positives":count(cal,tau),
                            "benign_false_positives":fp,"benign_total":n,"heldout_fpr":fpr,"fpr_wilson95":interval(fp,n),
                            "groups":groups,"macro_tpr":macro_tpr,"worst_group_tpr":worst,
                            "tpr_at_unseen_prevalence_001":known*0.999+unseen*0.001,
                            "tpr_at_unseen_prevalence_090":known*0.1+unseen*0.9,
                            "precision_at_attack_prior_0001":prevalence_precision(0.001),
                            "precision_at_attack_prior_001":prevalence_precision(0.01),
                            "empirical_fpr_exceeds_budget":fpr>budget}));
                        checks += 1;
                    }
                }
            }
        }
    }
    // Worst observed domain per protocol/seed/budget, never average away a failure.
    let mut worst = BTreeMap::<String, f64>::new();
    for row in &reports {
        let key = format!(
            "{}/{}/{}",
            row["seed"],
            row["protocol"].as_str().unwrap(),
            row["target_fpr"]
        );
        worst
            .entry(key)
            .and_modify(|x| *x = x.min(row["worst_group_tpr"].as_f64().unwrap()))
            .or_insert(row["worst_group_tpr"].as_f64().unwrap());
    }
    let fpr_violations = reports
        .iter()
        .filter(|row| row["empirical_fpr_exceeds_budget"] == true)
        .count();
    let max_heldout_fpr = reports
        .iter()
        .filter_map(|row| row["heldout_fpr"].as_f64())
        .fold(0.0, f64::max);
    Ok(
        json!({"version":2,"benchmark":"halo-shift-v2","n_per_group":n,"seeds":seeds,
        "sources":["https://wilds.stanford.edu/datasets/","https://robustbench.github.io/"],
        "scope":"Original synthetic adaptation, not official WILDS/RobustBench scores or OS containment evaluation.",
        "threshold_rule":"Frozen clean calibration; >= comparator; floor(n*fpr) empirical budget; ties excluded conservatively",
        "interval_scope":"Pointwise Wilson 95%; no simultaneous coverage across conditions",
        "checks":checks,"fpr_violation_count":fpr_violations,"max_heldout_fpr":max_heldout_fpr,
        "shield_scope":"Centered scores; explicit revalidation is not detection. Trusted refresh requires separate verified benign data.",
        "shield_rows":shield_reports,"worst_observed_group_tpr":worst,"rows":reports}),
    )
}

fn main() {
    let result = (|| -> Result<(), String> {
        let mut n = 10000_usize;
        let mut seeds = 5_usize;
        let mut output = PathBuf::from("rust/results/shift-bench.json");
        let mut fail_on_fpr = false;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--n" => {
                    n = args
                        .next()
                        .ok_or("--n requires a value")?
                        .parse()
                        .map_err(|_| "invalid n")?
                }
                "--seeds" => {
                    seeds = args
                        .next()
                        .ok_or("--seeds requires a value")?
                        .parse()
                        .map_err(|_| "invalid seeds")?
                }
                "--output" => output = args.next().ok_or("--output requires a value")?.into(),
                "--fail-on-fpr" => fail_on_fpr = true,
                _ => return Err(format!("unknown option {arg}")),
            }
        }
        if !(100..=1000000).contains(&n) || !(1..=100).contains(&seeds) {
            return Err("n must be 100..1000000; seeds 1..100".into());
        }
        let report = run(n, seeds)?;
        if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
            .map_err(|e| e.to_string())?;
        println!(
            "{}",
            json!({"output":output,"checks":report["checks"],"rows":report["rows"].as_array().unwrap().len()})
        );
        if fail_on_fpr && report["fpr_violation_count"].as_u64().unwrap_or(0) > 0 {
            return Err("held-out FPR exceeded target; see fpr_violation_count".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_zero_severity_preserves_clean_samples() {
        let clean = generate(42, 100, None, "clean", 0.0);
        for domain in DOMAINS {
            assert_eq!(
                generate(42, 100, None, domain, 0.0),
                clean,
                "zero severity must preserve samples: {domain}"
            );
        }
    }

    #[test]
    fn audit_sensor_loss_preserves_other_channels() {
        let clean = generate(42, 100, None, "clean", 0.0);
        let lost = generate(42, 100, None, "sensor_loss", 1.0);
        for (index, (before, after)) in clean.iter().zip(&lost).enumerate() {
            assert_eq!(
                &before[..3],
                &after[..3],
                "unaffected channels changed at sample {index}"
            );
            assert_eq!(after[3], 0.0);
        }
    }

    #[test]
    fn corruption_draws_remain_paired_across_severities() {
        let clean = generate(42, 1000, None, "clean", 0.0);
        let low = generate(42, 1000, None, "heavy_tail", 0.25);
        let high = generate(42, 1000, None, "heavy_tail", 1.0);
        let mut changed = 0;
        for i in 0..clean.len() {
            for j in 0..4 {
                let delta = low[i][j] - clean[i][j];
                if delta != 0. {
                    changed += 1;
                    assert!((high[i][j] - clean[i][j] - 4. * delta).abs() < 1e-12);
                }
            }
        }
        assert!(changed > 0);
    }
    #[test]
    fn ties_and_zero_budget_do_not_leak_false_positives() {
        for values in [vec![1.; 100], (0..100).map(|i| i as f64).collect()] {
            for fpr in [0., 0.0001, 0.01, 0.1] {
                assert!(count(&values, threshold(&values, fpr)) as f64 <= (100. * fpr).floor());
            }
        }
    }
    #[test]
    fn zero_observations_of_failure_still_have_uncertainty() {
        assert!(interval(0, 100)[1] > 0.03);
        assert!(interval(100, 100)[0] < 0.97);
    }
    #[test]
    fn domains_do_not_retune_thresholds_and_cover_all_groups() {
        let out = run(100, 1).unwrap();
        let rows = out["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 16 * 3 * 8);
        let mut thresholds = BTreeMap::new();
        for row in rows {
            let key = format!("{}:{}", row["protocol"], row["target_fpr"]);
            if let Some(t) = thresholds.insert(key, row["threshold"].clone()) {
                assert_eq!(t, row["threshold"]);
            }
            assert_eq!(row["groups"].as_object().unwrap().len(), 4);
        }
    }
}
