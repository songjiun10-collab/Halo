//! Robust threshold evaluation, ported from the Python experiment.
//! Python experiment.py SHA-256: 14f86133c7176906fb68bb005745566f37e0ae71c402664b71613a17092963d2
//! Python run_sweep.py SHA-256: c0f940cf8fb700c89abb9d1dda2bbd200346a514552f52e0877b60bfe1427444

use crate::e003::support;
use rand::{rngs::StdRng, SeedableRng};
use rand_distr::{Distribution, Normal};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
struct Metrics {
    threshold: f64,
    false_positive_rate: f64,
    attack_tpr: f64,
    worst_group_tpr: f64,
    group_tpr: BTreeMap<String, f64>,
}

/// Sorting once lets selectors evaluate the original threshold grid without
/// repeatedly materializing score-comparison arrays.
struct Scores {
    benign: Vec<f64>,
    attacks: BTreeMap<String, Vec<f64>>,
}

impl Scores {
    fn new(mut benign: Vec<f64>, mut attacks: BTreeMap<String, Vec<f64>>) -> Result<Self, String> {
        if benign.is_empty() {
            return Err("benign_scores must not be empty".into());
        }
        if attacks.is_empty() {
            return Err("attack_scores must not be empty".into());
        }
        if benign.iter().any(|x| !x.is_finite()) {
            return Err("benign_scores must be finite".into());
        }
        benign.sort_by(f64::total_cmp);
        for (name, values) in &mut attacks {
            if values.is_empty() {
                return Err(format!("attack group {name:?} must not be empty"));
            }
            if values.iter().any(|x| !x.is_finite()) {
                return Err(format!("attack group {name:?} scores must be finite"));
            }
            values.sort_by(f64::total_cmp);
        }
        Ok(Self { benign, attacks })
    }

    fn from_config(config: &Value) -> Result<Self, String> {
        let benign = scores_array(
            config
                .get("benign_scores")
                .ok_or("benign_scores is required")?,
            "benign_scores",
        )?;
        let groups = config
            .get("attack_scores")
            .and_then(Value::as_object)
            .ok_or("attack_scores must be an object")?;
        let attacks = groups
            .iter()
            .map(|(name, scores)| {
                scores_array(scores, &format!("attack group {name:?} scores"))
                    .map(|values| (name.clone(), values))
            })
            .collect::<Result<_, _>>()?;
        Self::new(benign, attacks)
    }

    fn weights(
        &self,
        supplied: Option<&Value>,
        balance: bool,
    ) -> Result<BTreeMap<String, f64>, String> {
        let mut weights: BTreeMap<String, f64> = match supplied.filter(|v| !v.is_null()) {
            None => self
                .attacks
                .iter()
                .map(|(name, scores)| (name.clone(), scores.len() as f64))
                .collect(),
            Some(value) => {
                let object = value
                    .as_object()
                    .ok_or("attack_weights must be an object")?;
                if object.len() != self.attacks.len()
                    || self.attacks.keys().any(|key| !object.contains_key(key))
                {
                    return Err("attack_weights keys must match attack_scores".into());
                }
                object
                    .iter()
                    .map(|(name, value)| {
                        let number = numeric(value)
                            .ok_or("attack weights must be finite and non-negative")?;
                        if !number.is_finite() || number < 0.0 {
                            return Err("attack weights must be finite and non-negative".into());
                        }
                        Ok((name.clone(), number))
                    })
                    .collect::<Result<_, String>>()?
            }
        };
        // Validate supplied values before balancing, matching the Python API.
        if balance {
            weights.values_mut().for_each(|value| *value = 1.0);
        }
        let scale = weights.values().copied().fold(0.0, f64::max);
        if scale <= 0.0 {
            return Err("attack weights must sum to > 0".into());
        }
        weights.values_mut().for_each(|value| *value /= scale);
        Ok(weights)
    }

    fn evaluate(&self, threshold: f64, weights: &BTreeMap<String, f64>) -> Metrics {
        let group_tpr: BTreeMap<String, f64> = self
            .attacks
            .iter()
            .map(|(name, scores)| {
                (
                    name.clone(),
                    (scores.len() - scores.partition_point(|score| *score < threshold)) as f64
                        / scores.len() as f64,
                )
            })
            .collect();
        let fpr = (self.benign.len() - self.benign.partition_point(|score| *score < threshold))
            as f64
            / self.benign.len() as f64;
        let total_weight = weights.values().sum::<f64>();
        let aggregate = group_tpr
            .iter()
            .map(|(name, rate)| rate * weights[name])
            .sum::<f64>()
            / total_weight;
        Metrics {
            threshold,
            false_positive_rate: fpr,
            attack_tpr: aggregate,
            worst_group_tpr: group_tpr.values().copied().fold(f64::INFINITY, f64::min),
            group_tpr,
        }
    }
}

fn numeric(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .or_else(|| value.as_bool().map(|value| if value { 1.0 } else { 0.0 }))
}

fn scores_array(value: &Value, label: &str) -> Result<Vec<f64>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?;
    values
        .iter()
        .map(|value| {
            let score =
                numeric(value).ok_or_else(|| format!("{label} must be finite and numeric"))?;
            if score.is_finite() {
                Ok(score)
            } else {
                Err(format!("{label} must be finite"))
            }
        })
        .collect()
}

fn thresholds(config: &Value) -> Result<Vec<f64>, String> {
    let values = config
        .get("thresholds")
        .and_then(Value::as_array)
        .ok_or("thresholds must be an array")?;
    values
        .iter()
        .map(|threshold| support::probability(&json!({"threshold":threshold}), "threshold", 0.5))
        .collect()
}

fn select_accuracy(candidates: &[Metrics]) -> Result<Metrics, String> {
    let mut best: Option<(f64, f64, &Metrics)> = None;
    for metrics in candidates {
        let score = 0.5 * (1.0 - metrics.false_positive_rate) + 0.5 * metrics.attack_tpr;
        let key = (score, -metrics.false_positive_rate);
        if best
            .as_ref()
            .map(|(score, fpr, _)| key > (*score, *fpr))
            .unwrap_or(true)
        {
            best = Some((key.0, key.1, metrics));
        }
    }
    best.map(|(_, _, metrics)| metrics.clone())
        .ok_or_else(|| "thresholds must not be empty".into())
}

fn select_worst(candidates: &[Metrics], max_fpr: f64) -> Result<Metrics, String> {
    let mut best: Option<&Metrics> = None;
    for metrics in candidates
        .iter()
        .filter(|metrics| metrics.false_positive_rate <= max_fpr)
    {
        let key = (metrics.worst_group_tpr, -metrics.false_positive_rate);
        if best
            .map(|best| key > (best.worst_group_tpr, -best.false_positive_rate))
            .unwrap_or(true)
        {
            best = Some(metrics);
        }
    }
    best.cloned()
        .ok_or_else(|| "no threshold satisfies max_fpr".into())
}

fn robust_score(metrics: &Metrics) -> f64 {
    let rates: Vec<f64> = metrics.group_tpr.values().copied().collect();
    let avg = support::mean(&rates);
    let variance = rates.iter().map(|rate| (rate - avg).powi(2)).sum::<f64>() / rates.len() as f64;
    metrics.worst_group_tpr * 3.0 + metrics.attack_tpr * 0.5
        - metrics.false_positive_rate * 0.5
        - variance * 0.5
}

fn select_robust(
    candidates: &[Metrics],
    max_fpr: f64,
    min_worst: f64,
    min_any: f64,
) -> Result<Metrics, String> {
    // Detection floors are requirements, not preferences. Infeasibility is an error.
    {
        let mut best: Option<(f64, &Metrics)> = None;
        for metrics in candidates {
            if metrics.false_positive_rate > max_fpr
                || metrics.worst_group_tpr < min_worst
                || metrics.group_tpr.values().any(|tpr| *tpr < min_any)
            {
                continue;
            }
            let score = robust_score(metrics);
            if best.as_ref().map(|(best, _)| score > *best).unwrap_or(true) {
                best = Some((score, metrics));
            }
        }
        if let Some((_, metrics)) = best {
            return Ok(metrics.clone());
        }
    }
    Err("no threshold satisfies constraints".into())
}

fn demonstrate(config: &Value) -> Result<Value, String> {
    let seed = support::integer(config, "seed", 7, false)?;
    let n = support::count(config, "n", 20_000)?;
    let benign_n = n.checked_mul(5).ok_or("n is too large")?;
    let known_n = n.checked_mul(4).ok_or("n is too large")?;
    let mut rng = StdRng::seed_from_u64(seed);
    let mut draw = |mean, stddev, count| -> Vec<f64> {
        let normal = Normal::<f64>::new(mean, stddev).expect("fixed normal parameters are valid");
        (0..count)
            .map(|_| normal.sample(&mut rng).clamp(0.0, 1.0))
            .collect()
    };
    let benign = draw(0.25, 0.15, benign_n);
    let known = draw(0.78, 0.12, known_n);
    let hard = draw(0.48, 0.17, n);
    let scores = Scores::new(
        benign,
        BTreeMap::from([("known_family".into(), known), ("hard_family".into(), hard)]),
    )?;
    let dev_weights = json!({"known_family":0.8,"hard_family":0.2});
    let weights = scores.weights(Some(&dev_weights), false)?;
    let balanced = scores.weights(Some(&dev_weights), true)?;
    let grid: Vec<f64> = (0..181)
        .map(|i| {
            if i == 180 {
                0.95
            } else {
                0.05 + i as f64 * ((0.95 - 0.05) / 180.0)
            }
        })
        .collect();
    let candidates: Vec<Metrics> = grid
        .iter()
        .map(|threshold| scores.evaluate(*threshold, &weights))
        .collect();
    let balanced_candidates: Vec<Metrics> = grid
        .iter()
        .map(|threshold| scores.evaluate(*threshold, &balanced))
        .collect();
    let accuracy = select_accuracy(&candidates)?;
    let worst = select_worst(&candidates, 0.10)?;
    let robust = select_robust(&balanced_candidates, 0.10, 0.5, 0.35)?;
    let mut shifted = Map::new();
    for hard_share in [0.0, 0.25, 0.50, 0.75, 1.0] {
        let shifted_weights = scores.weights(
            Some(&json!({"known_family":1.0-hard_share,"hard_family":hard_share})),
            false,
        )?;
        shifted.insert(
            format!("{hard_share:.2}"),
            json!({
                "accuracy_optimal": scores.evaluate(accuracy.threshold, &shifted_weights),
                "worst_group_constrained": scores.evaluate(worst.threshold, &shifted_weights),
                "robust_constrained": scores.evaluate(robust.threshold, &shifted_weights),
            }),
        );
    }
    Ok(
        json!({"accuracy_optimal":accuracy,"worst_group_constrained":worst,"robust_constrained":robust,"shifted":shifted}),
    )
}

/// `operation` defaults to `run`; custom operations use Python's argument
/// names and return a flat Metrics object suitable for differential checks.
pub fn execute(config: &Value) -> Result<Value, String> {
    support::object(config)?;
    let operation = match config.get("operation") {
        Some(value) => value.as_str().ok_or("operation must be a string")?,
        None => "run",
    };
    if operation == "run" {
        return demonstrate(config);
    }
    if ![
        "evaluate",
        "select_accuracy_threshold",
        "select_worst_group_threshold",
        "select_robust_threshold",
    ]
    .contains(&operation)
    {
        return Err(format!("unknown E004 operation: {operation}"));
    }
    let scores = Scores::from_config(config)?;
    let robust = operation == "select_robust_threshold";
    let balance = support::boolean(config, "enforce_balance", false)? || robust;
    let weights = scores.weights(config.get("attack_weights"), balance)?;
    let metrics = if operation == "evaluate" {
        let threshold = support::probability(config, "threshold", 0.5)?;
        scores.evaluate(threshold, &weights)
    } else {
        let thresholds = thresholds(config)?;
        let candidates: Vec<Metrics> = thresholds
            .iter()
            .map(|threshold| scores.evaluate(*threshold, &weights))
            .collect();
        match operation {
            "select_accuracy_threshold" => select_accuracy(&candidates)?,
            "select_worst_group_threshold" => {
                select_worst(&candidates, support::probability(config, "max_fpr", 0.10)?)?
            }
            _ => select_robust(
                &candidates,
                support::probability(config, "max_fpr", 0.10)?,
                support::probability(config, "min_worst_group_tpr", 0.5)?,
                support::probability(config, "min_any_group_tpr", 0.35)?,
            )?,
        }
    };
    serde_json::to_value(metrics).map_err(|e| e.to_string())
}

/// The original one-seed sweep writes the complete demonstration to
/// summary.json. An explicit seeds count/list additionally runs that seed grid.
pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    support::object(config)?;
    let seeds = if config.get("seeds").is_some() {
        support::seeds(config, 1, 0)?
    } else {
        vec![support::integer(config, "seed", 7, false)?]
    };
    let mut runs = Vec::new();
    let mut rows = Vec::new();
    for seed in seeds {
        let mut params = config.clone();
        params["seed"] = json!(seed);
        let out = execute(&params)?;
        if out.get("threshold").is_some() {
            let mut row = out.as_object().unwrap().clone();
            row.extend([
                ("seed".into(), json!(seed)),
                ("protocol".into(), params["operation"].clone()),
            ]);
            rows.push(Value::Object(row));
        } else {
            for protocol in [
                "accuracy_optimal",
                "worst_group_constrained",
                "robust_constrained",
            ] {
                let mut row = out[protocol].as_object().unwrap().clone();
                row.extend([
                    ("seed".into(), json!(seed)),
                    ("protocol".into(), json!(protocol)),
                ]);
                rows.push(Value::Object(row));
            }
        }
        runs.push(json!({"seed":seed,"result":out}));
    }
    std::fs::create_dir_all(output).map_err(|e| e.to_string())?;
    support::write_json(&output.join("summary.json"), &runs[0]["result"])?;
    support::write_json(&output.join("runs.json"), &json!(runs))?;
    support::write_csv(
        &output.join("results.csv"),
        &rows,
        &[
            "seed",
            "protocol",
            "threshold",
            "false_positive_rate",
            "attack_tpr",
            "worst_group_tpr",
            "group_tpr",
        ],
    )?;
    let mut summary = Vec::new();
    let protocols: std::collections::BTreeSet<String> = rows
        .iter()
        .filter_map(|row| row["protocol"].as_str().map(str::to_owned))
        .collect();
    for protocol in protocols {
        let subset: Vec<&Value> = rows
            .iter()
            .filter(|row| row["protocol"] == protocol)
            .collect();
        let mut row = Map::from_iter([("protocol".into(), json!(protocol))]);
        for metric in [
            "threshold",
            "false_positive_rate",
            "attack_tpr",
            "worst_group_tpr",
        ] {
            let values: Vec<f64> = subset
                .iter()
                .map(|row| support::number_or_nan(&row[metric]))
                .collect();
            row.insert(format!("{metric}_mean"), json!(support::mean(&values)));
            row.insert(
                format!("{metric}_ci95_halfwidth"),
                json!(support::ci95(&values)),
            );
        }
        summary.push(Value::Object(row));
    }
    support::write_csv(
        &output.join("summary.csv"),
        &summary,
        &[
            "protocol",
            "threshold_mean",
            "threshold_ci95_halfwidth",
            "false_positive_rate_mean",
            "false_positive_rate_ci95_halfwidth",
            "attack_tpr_mean",
            "attack_tpr_ci95_halfwidth",
            "worst_group_tpr_mean",
            "worst_group_tpr_ci95_halfwidth",
        ],
    )?;
    Ok(
        json!({"experiment":"e004","rows":rows.len(),"summary_rows":summary.len(),"runs":runs.len(),"output":output.display().to_string()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(operation: &str) -> Value {
        json!({"operation": operation, "benign_scores": [0.1,0.2,0.3,0.4], "attack_scores": {"easy": [0.9,0.8,0.7], "hard": [0.65,0.55,0.45]}, "threshold": 0.5, "thresholds": [0.3,0.4,0.5], "max_fpr": 0.25})
    }

    #[test]
    fn evaluation_includes_threshold_boundary_and_size_weighted_aggregate() {
        let out = execute(&json!({"operation":"evaluate", "benign_scores":[0.1,0.5,0.9], "attack_scores":{"large":[0.5,0.6,0.7],"small":[0.1]}, "threshold":0.5})).unwrap();
        assert_eq!(out["false_positive_rate"], 2.0 / 3.0);
        assert_eq!(out["attack_tpr"], 0.75);
        assert_eq!(out["worst_group_tpr"], 0.0);
        assert_eq!(out["group_tpr"]["large"], 1.0);
    }

    #[test]
    fn explicit_large_weights_are_scaled_and_balance_is_equal_weighting() {
        let mut config = json!({"operation":"evaluate", "benign_scores":[0.1], "attack_scores":{"detected":[0.9],"missed":[0.1]}, "threshold":0.5, "attack_weights":{"detected":1e308,"missed":1e308}});
        assert_eq!(execute(&config).unwrap()["attack_tpr"], 0.5);
        config["attack_weights"] = json!({"detected":1.0,"missed":0.0});
        assert_eq!(execute(&config).unwrap()["attack_tpr"], 1.0);
        config["enforce_balance"] = json!(true);
        assert_eq!(execute(&config).unwrap()["attack_tpr"], 0.5);
    }

    #[test]
    fn worst_group_budget_boundary_is_inclusive() {
        let out = execute(&fixture("select_worst_group_threshold")).unwrap();
        assert_eq!(out["threshold"], 0.4);
        assert_eq!(out["false_positive_rate"], 0.25);
        assert_eq!(out["worst_group_tpr"], 1.0);
    }

    #[test]
    fn selection_ties_prefer_lower_fpr_then_first_candidate() {
        let config = json!({"operation":"select_accuracy_threshold", "benign_scores":[0.2,0.7], "attack_scores":{"a":[0.3,0.8]}, "attack_weights":{"a":1.0}, "thresholds":[0.2,0.7,0.9]});
        assert_eq!(execute(&config).unwrap()["threshold"], 0.9);
        let config = json!({"operation":"select_worst_group_threshold", "benign_scores":[0.1], "attack_scores":{"a":[0.9]}, "thresholds":[0.6,0.5], "max_fpr":0.0});
        assert_eq!(execute(&config).unwrap()["threshold"], 0.6);
    }

    #[test]
    fn robust_selector_rejects_infeasible_detection_floors() {
        let config = json!({"operation":"select_robust_threshold", "benign_scores":[0.1,0.3], "attack_scores":{"a":[0.9],"b":[0.2]}, "attack_weights":{"a":1.0,"b":0.0}, "thresholds":[0.2,0.4,0.8], "max_fpr":0.0, "min_worst_group_tpr":0.8, "min_any_group_tpr":0.9});
        assert!(execute(&config).unwrap_err().contains("no threshold satisfies constraints"));
        let mut feasible = config.clone();
        feasible["min_worst_group_tpr"] = json!(0.0);
        feasible["min_any_group_tpr"] = json!(0.0);
        let out = execute(&feasible).unwrap();
        assert_eq!(out["threshold"], 0.4);
        assert_eq!(out["false_positive_rate"], 0.0);
        assert_eq!(out["worst_group_tpr"], 0.0);
        assert_eq!(out["attack_tpr"], 0.5);
        let mut impossible = config;
        impossible["thresholds"] = json!([0.0, 0.1]);
        assert!(execute(&impossible).is_err());
    }

    #[test]
    fn invalid_arrays_weights_thresholds_and_constraints_are_rejected() {
        for (key, value) in [
            ("benign_scores", json!([])),
            ("attack_scores", json!({})),
            ("attack_weights", json!({"wrong":1})),
            ("threshold", json!(1.1)),
            ("attack_weights", json!({"easy":0,"hard":0})),
            ("attack_weights", json!({"easy":"bad","hard":1})),
            ("benign_scores", json!([null])),
        ] {
            let mut config = fixture("evaluate");
            config[key] = value;
            assert!(execute(&config).is_err(), "{config}");
        }
        let mut empty = fixture("select_accuracy_threshold");
        empty["thresholds"] = json!([]);
        assert!(execute(&empty).is_err());
        let mut invalid = fixture("select_robust_threshold");
        invalid["min_any_group_tpr"] = json!(1.01);
        assert!(execute(&invalid).is_err());
    }

    #[test]
    fn demonstration_preserves_shifted_groups_and_reproducibility() {
        let config = json!({"seed":7,"n":1000});
        let out = execute(&config).unwrap();
        assert_eq!(out, execute(&config).unwrap());
        for (share, row) in out["shifted"].as_object().unwrap() {
            let hard_share: f64 = share.parse().unwrap();
            let metric = &row["robust_constrained"];
            let expected = (1.0 - hard_share) * metric["group_tpr"]["known_family"].as_f64().unwrap()
                + hard_share * metric["group_tpr"]["hard_family"].as_f64().unwrap();
            assert!((metric["attack_tpr"].as_f64().unwrap() - expected).abs() <= 1e-12);
        }
        assert_eq!(
            out["shifted"]["1.00"]["accuracy_optimal"]["attack_tpr"],
            out["accuracy_optimal"]["group_tpr"]["hard_family"]
        );
        assert!(
            out["worst_group_constrained"]["false_positive_rate"]
                .as_f64()
                .unwrap()
                <= 0.1
        );
        assert!(
            out["robust_constrained"]["false_positive_rate"]
                .as_f64()
                .unwrap()
                <= 0.1
        );
    }

    #[test]
    fn sweep_writes_default_summary_and_optional_multi_seed_rows() {
        let dir = tempfile::tempdir().unwrap();
        sweep(&json!({"n":200}), dir.path()).unwrap();
        let out: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("summary.json")).unwrap())
                .unwrap();
        assert!(out["accuracy_optimal"]["threshold"].is_number());
        sweep(&json!({"n":100,"seeds":2}), dir.path()).unwrap();
        let mut reader = csv::Reader::from_path(dir.path().join("results.csv")).unwrap();
        assert_eq!(reader.records().count(), 6);
    }
}
