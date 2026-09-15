//! Binary-verdict adaptive evasion, ported from the Python experiment.
//! Python experiment.py SHA-256: 9c346d7f01a3d0573da6e042339b2ec66dc76151351c24d9588255eaeec71719
//! Python run_sweep.py SHA-256: dbd5447da8c165afb4a8a1c011bb9720ef3ca346781f715948703456bdc30385

use super::e001::{
    count, mean_ci, number, prepare_output, probability, ratio, seed, seeds, validate_object,
    write_csv, write_json,
};
use super::e002::quantile;
use rand::{rngs::StdRng, Rng, SeedableRng};
use rand_distr::StandardNormal;
use serde_json::{json, Value};
use std::path::Path;

fn nonnegative(config: &Value, key: &str, default: f64) -> Result<f64, String> {
    match config.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("{key} must be finite and nonnegative")),
    }
}
fn population(rng: &mut StdRng, n: usize, benign: bool) -> Vec<[f64; 2]> {
    (0..n)
        .map(|_| [rng.gen::<f64>() * if benign { 0.5 } else { 1. }, rng.gen()])
        .collect()
}

pub fn execute(config: &Value) -> Result<Value, String> {
    validate_object(config)?;
    let seed = seed(config)?;
    let rounds = count(config, "rounds", 30)?;
    let size = count(config, "population", 4000)?;
    let fpr = probability(config, "target_fpr", 0.1)?;
    let lo = probability(config, "w0_lo", 0.55)?;
    let hi = probability(config, "w0_hi", 0.85)?;
    if lo >= hi {
        return Err("w0_lo must be smaller than w0_hi".into());
    }
    let drift = nonnegative(config, "drift", 0.02)?;
    let scale = nonnegative(config, "mutation_scale", 0.05)?;
    let survival = probability(config, "survival_fraction", 0.4)?;
    let fresh = probability(config, "fresh_fraction", 0.25)?;
    if survival == 0. || fresh == 0. {
        return Err("fractions must be positive".into());
    }
    let nb = count(config, "n_benign", 40000)?;
    let ne = count(config, "n_eval_benign", 20000)?;
    let defense = match config.get("defense") {
        None => "static",
        Some(v) => v.as_str().ok_or("defense must be static or moving")?,
    };
    if defense != "static" && defense != "moving" {
        return Err("defense must be static or moving".into());
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let benign = population(&mut rng, nb, true);
    let eval = population(&mut rng, ne, true);
    let mut proposal = population(&mut rng, size, false);
    let fixed = rng.gen_range(lo..hi);
    let mut failures = Vec::new();
    let mut blocks = Vec::new();
    let mut harms = Vec::new();
    for _ in 0..rounds {
        let w = if defense == "moving" {
            rng.gen_range(lo..hi)
        } else {
            fixed
        };
        let score = |x: &[f64; 2]| x[0] * w + x[1] * (1. - w);
        let tau = quantile(&benign.iter().map(score).collect::<Vec<_>>(), 1. - fpr);
        let unsafe_n = proposal.iter().filter(|x| x[0] > 0.5).count();
        let escaped = proposal
            .iter()
            .filter(|x| x[0] > 0.5 && score(x) <= tau)
            .count();
        let mut survivors: Vec<_> = proposal
            .iter()
            .copied()
            .filter(|x| score(x) <= tau)
            .collect();
        failures.push(ratio(escaped, unsafe_n));
        blocks.push(ratio(eval.iter().filter(|x| score(x) > tau).count(), ne));
        harms.push(if survivors.is_empty() {
            f64::NAN
        } else {
            survivors.iter().map(|x| x[0]).sum::<f64>() / survivors.len() as f64
        });
        if survivors.is_empty() {
            proposal = population(&mut rng, size, false);
            continue;
        }
        survivors.sort_unstable_by(|a, b| b[0].total_cmp(&a[0]));
        let keep = ((survivors.len() as f64 * survival) as usize).max(1);
        survivors.truncate(keep);
        for x in &mut survivors {
            x[0] += drift;
            for v in x {
                *v = (*v + rng.sample::<f64, _>(StandardNormal) * scale).clamp(0., 1.);
            }
        }
        survivors.extend(population(
            &mut rng,
            ((size as f64 * fresh) as usize).max(1),
            false,
        ));
        if survivors.len() < size {
            survivors.extend(population(&mut rng, size - survivors.len(), false));
        }
        survivors.truncate(size);
        proposal = survivors;
    }
    Ok(
        json!({"defense":defense,"seed":seed,"rounds":rounds,"target_fpr":fpr,"w0_interval":[lo,hi],"initial_containment_failure":failures[0],"final_containment_failure":failures[rounds-1],"escalation":failures[rounds-1]-failures[0],"mean_false_block_rate":mean_ci(&blocks).0,"containment_failure_by_round":failures,"false_block_rate_by_round":blocks,"mean_allowed_harm_by_round":harms}),
    )
}

pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    validate_object(config)?;
    let all_seeds = seeds(config, 30)?;
    let mut rows = Vec::new();
    let mut summary = Vec::new();
    let mut trajectories = Vec::new();
    for defense in ["static", "moving"] {
        for seed in &all_seeds {
            let mut c = config.clone();
            c["seed"] = json!(seed);
            c["defense"] = json!(defense);
            let r = execute(&c)?;
            rows.push(json!({"defense":defense,"seed":seed,"initial_containment_failure":r["initial_containment_failure"],"final_containment_failure":r["final_containment_failure"],"escalation":r["escalation"],"mean_false_block_rate":r["mean_false_block_rate"]}));
            trajectories.push(r);
        }
        let group: Vec<_> = rows.iter().filter(|r| r["defense"] == defense).collect();
        let values = |key| group.iter().map(|r| number(r, key)).collect::<Vec<_>>();
        let (avg, ci) = mean_ci(&values("escalation"));
        let std = ci * (all_seeds.len() as f64).sqrt() / 1.96;
        summary.push(json!({"defense":defense,"escalation_mean":avg,"escalation_std":std,"escalation_ci95_halfwidth":ci,"final_containment_failure_mean":mean_ci(&values("final_containment_failure")).0,"false_block_rate_mean":mean_ci(&values("mean_false_block_rate")).0}));
    }
    prepare_output(output)?;
    write_csv(
        &output.join("results.csv"),
        &[
            "defense",
            "seed",
            "initial_containment_failure",
            "final_containment_failure",
            "escalation",
            "mean_false_block_rate",
        ],
        &rows,
    )?;
    write_csv(
        &output.join("summary.csv"),
        &[
            "defense",
            "escalation_mean",
            "escalation_std",
            "escalation_ci95_halfwidth",
            "final_containment_failure_mean",
            "false_block_rate_mean",
        ],
        &summary,
    )?;
    write_json(&output.join("trajectories.json"), &json!(trajectories))?;
    Ok(json!({"experiment":"e005","output":output,"rows":rows.len(),"summary_rows":summary.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> Value {
        json!({"seed":2,"rounds":6,"population":500,"n_benign":2000,"n_eval_benign":1000})
    }

    #[test]
    fn both_defenses_are_seed_reproducible_with_bounded_rates() {
        for defense in ["static", "moving"] {
            let mut config = config();
            config["defense"] = json!(defense);
            let out = execute(&config).unwrap();
            assert_eq!(out, execute(&config).unwrap());
            assert_eq!(
                out["containment_failure_by_round"]
                    .as_array()
                    .unwrap()
                    .len(),
                6
            );
            for rate in out["containment_failure_by_round"]
                .as_array()
                .unwrap()
                .iter()
                .chain(out["false_block_rate_by_round"].as_array().unwrap())
            {
                let rate = rate.as_f64().unwrap();
                assert!((0.0..=1.0).contains(&rate));
            }
            let escalation = out["final_containment_failure"].as_f64().unwrap()
                - out["initial_containment_failure"].as_f64().unwrap();
            assert_eq!(out["escalation"], escalation);
            config["seed"] = json!(3);
            assert_ne!(out, execute(&config).unwrap());
        }
    }

    #[test]
    fn one_round_has_zero_escalation_and_fpr_is_held_out() {
        let mut config = config();
        config["rounds"] = json!(1);
        config["n_benign"] = json!(20000);
        config["n_eval_benign"] = json!(20000);
        let out = execute(&config).unwrap();
        assert_eq!(out["escalation"], 0.0);
        assert!((0.08..=0.12).contains(&out["mean_false_block_rate"].as_f64().unwrap()));
    }

    #[test]
    fn invalid_evasion_parameters_are_rejected() {
        for (key, value) in [
            ("rounds", json!(0)),
            ("rounds", json!(1.5)),
            ("population", json!(-1)),
            ("seed", json!(true)),
            ("target_fpr", json!(-0.01)),
            ("w0_lo", json!(0.9)),
            ("mutation_scale", json!(-1)),
            ("defense", json!("banana")),
            ("survival_fraction", json!(0)),
            ("fresh_fraction", json!(1.1)),
            ("n_benign", json!(0)),
            ("n_eval_benign", json!(false)),
        ] {
            let mut config = config();
            config[key] = value;
            assert!(execute(&config).is_err(), "{config}");
        }
    }

    #[test]
    fn single_sample_missing_classes_remain_undefined() {
        let mut found = false;
        for seed in 0..20 {
            let out = execute(
                &json!({"seed":seed,"rounds":1,"population":1,"n_benign":10,"n_eval_benign":10}),
            )
            .unwrap();
            if out["initial_containment_failure"].is_null() {
                found = true;
                assert!(out["escalation"].is_null());
            }
        }
        assert!(found);
    }

    #[test]
    fn sweep_preserves_defense_seed_grid_and_round_trajectories() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config();
        config["seeds"] = json!(2);
        sweep(&config, dir.path()).unwrap();
        let mut reader = csv::Reader::from_path(dir.path().join("results.csv")).unwrap();
        assert_eq!(reader.records().count(), 4);
        let mut summary = csv::Reader::from_path(dir.path().join("summary.csv")).unwrap();
        assert_eq!(summary.records().count(), 2);
        let trajectories: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("trajectories.json")).unwrap())
                .unwrap();
        assert_eq!(trajectories.as_array().unwrap().len(), 4);
    }
}
