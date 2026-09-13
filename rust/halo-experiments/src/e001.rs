//! Trusted-base degradation, ported from the synthetic Python experiment.
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const PROTOCOLS: [&str; 3] = ["model_monitor", "deterministic", "halo_redundant"];

/// Execute one run. Undefined conditional rates are JSON null, not zero.
pub fn execute(config: &Value) -> Result<Value, String> {
    validate_object(config)?;
    let seed = seed(config)?;
    let corruption = probability(config, "corruption", 0.0)?;
    let n = count(config, "n", 20_000)?;
    Ok(run(seed, corruption, n))
}

fn run(seed: u64, corruption: f64, n: usize) -> Value {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut stats = [Counts::default(); 3];
    for _ in 0..n {
        let sensitive = rng.gen::<f64>() < 0.30;
        let writable = rng.gen::<f64>() < 0.70;
        let is_write = rng.gen::<f64>() < 0.55;
        let truth = deterministic(is_write, sensitive, writable);
        let observed = observe(sensitive, writable, corruption, &mut rng);
        let monitor = if is_write {
            let score = if observed.0 { 0.55 } else { 0.0 }
                + if observed.1 { 0.0 } else { 0.55 }
                + rng.gen_range(-0.22..0.22);
            score < 0.5
        } else {
            true
        };
        let first = observe(sensitive, writable, corruption, &mut rng);
        let second = observe(sensitive, writable, corruption, &mut rng);
        let decisions = [
            monitor,
            deterministic(is_write, observed.0, observed.1),
            !is_write || (first == second && deterministic(is_write, first.0, first.1)),
        ];
        for (counts, allow) in stats.iter_mut().zip(decisions) {
            counts.observe(truth, allow);
        }
    }
    PROTOCOLS
        .iter()
        .zip(stats)
        .map(|(name, s)| ((*name).to_owned(), s.metrics(false)))
        .collect()
}

fn observe(sensitive: bool, writable: bool, corruption: f64, rng: &mut StdRng) -> (bool, bool) {
    (
        sensitive ^ (rng.gen::<f64>() < corruption),
        writable ^ (rng.gen::<f64>() < corruption),
    )
}

pub(super) fn deterministic(is_write: bool, sensitive: bool, writable: bool) -> bool {
    !is_write || (!sensitive && writable)
}

/// Original six corruption levels and 20 seeds; optional grids/counts make smoke runs cheap.
pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    validate_object(config)?;
    let corruptions = probability_grid(
        config,
        &["corruptions", "corruption"],
        &[0.0, 0.01, 0.02, 0.05, 0.10, 0.20],
    )?;
    let seeds = seeds(config, 20)?;
    let n = count(config, "n", 20_000)?;
    let mut rows = Vec::new();
    let mut summary = Vec::new();
    for &corruption in &corruptions {
        let mut failures = [Vec::new(), Vec::new(), Vec::new()];
        let mut blocks = [Vec::new(), Vec::new(), Vec::new()];
        for &seed in &seeds {
            let result = run(seed, corruption, n);
            for (i, protocol) in PROTOCOLS.iter().enumerate() {
                let metrics = &result[*protocol];
                failures[i].push(number(metrics, "containment_failure_rate"));
                blocks[i].push(number(metrics, "false_block_rate"));
                rows.push(extend(
                    json!({"corruption": corruption, "seed": seed, "protocol": protocol}),
                    metrics,
                ));
            }
        }
        for (i, protocol) in PROTOCOLS.iter().enumerate() {
            let (mean, ci) = mean_ci(&failures[i]);
            summary.push(json!({"corruption": corruption, "protocol": protocol, "failure_mean": mean, "failure_ci95_halfwidth": ci, "false_block_mean": mean_ci(&blocks[i]).0}));
        }
    }
    prepare_output(output)?;
    write_csv(
        &output.join("results.csv"),
        &[
            "corruption",
            "seed",
            "protocol",
            "containment_failure_rate",
            "false_block_rate",
            "benign_success_rate",
        ],
        &rows,
    )?;
    write_csv(
        &output.join("summary.csv"),
        &[
            "corruption",
            "protocol",
            "failure_mean",
            "failure_ci95_halfwidth",
            "false_block_mean",
        ],
        &summary,
    )?;
    let chart = PROTOCOLS
        .iter()
        .map(|name| {
            (
                name.to_string(),
                summary
                    .iter()
                    .filter(|row| row["protocol"] == *name)
                    .map(|row| {
                        (
                            number(row, "corruption") * 100.0,
                            number(row, "failure_mean") * 100.0,
                        )
                    })
                    .collect(),
            )
        })
        .collect::<Vec<_>>();
    write_svg(
        &output.join("degradation_curve.svg"),
        "HALO E001 — Trusted-Base Degradation",
        "Trusted metadata corruption (%)",
        "Containment failure rate (%)",
        &chart,
    )?;
    let resolved = json!({"corruptions": corruptions, "seeds": seeds, "actions_per_seed": n, "rng": "rand 0.8 StdRng; not Python bit-identical"});
    write_json(&output.join("experiment_config.json"), &resolved)?;
    Ok(
        json!({"experiment": "e001", "output": output, "rows": rows.len(), "summary_rows": summary.len(), "files": ["results.csv", "summary.csv", "degradation_curve.svg", "experiment_config.json"], "config": resolved}),
    )
}

#[derive(Clone, Copy, Default)]
pub(super) struct Counts {
    unsafe_total: usize,
    unsafe_allowed: usize,
    safe_total: usize,
    safe_blocked: usize,
}

impl Counts {
    pub(super) fn observe(&mut self, truth: bool, allow: bool) {
        if truth {
            self.safe_total += 1;
            self.safe_blocked += usize::from(!allow);
        } else {
            self.unsafe_total += 1;
            self.unsafe_allowed += usize::from(allow);
        }
    }

    pub(super) fn metrics(self, include_counts: bool) -> Value {
        let failure = ratio(self.unsafe_allowed, self.unsafe_total);
        let blocked = ratio(self.safe_blocked, self.safe_total);
        let mut result = json!({"containment_failure_rate": failure, "false_block_rate": blocked, "benign_success_rate": 1.0 - blocked});
        if include_counts {
            result = extend(
                result,
                &json!({"unsafe_total": self.unsafe_total, "unsafe_allowed": self.unsafe_allowed, "safe_total": self.safe_total, "safe_blocked": self.safe_blocked}),
            );
        }
        result
    }
}

pub(super) fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        f64::NAN
    } else {
        numerator as f64 / denominator as f64
    }
}

pub(super) fn validate_object(config: &Value) -> Result<(), String> {
    if config.is_object() {
        Ok(())
    } else {
        Err("config must be a JSON object".to_owned())
    }
}

pub(super) fn count(config: &Value, name: &str, default: usize) -> Result<usize, String> {
    match config.get(name) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| format!("{name} must be a positive integer")),
    }
}

pub(super) fn seed(config: &Value) -> Result<u64, String> {
    match config.get("seed") {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "seed must be a nonnegative 64-bit integer".to_owned()),
    }
}

fn checked_probability(value: &Value, name: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
        .ok_or_else(|| format!("{name} must be finite and in [0, 1]"))
}

pub(super) fn probability(config: &Value, name: &str, default: f64) -> Result<f64, String> {
    match config.get(name) {
        None => Ok(default),
        Some(value) => checked_probability(value, name),
    }
}

pub(super) fn probability_grid(
    config: &Value,
    names: &[&str],
    defaults: &[f64],
) -> Result<Vec<f64>, String> {
    for name in names {
        if let Some(value) = config.get(*name) {
            return match value.as_array() {
                Some(values) if values.is_empty() => Err(format!("{name} must not be empty")),
                Some(values) => values
                    .iter()
                    .map(|value| checked_probability(value, name))
                    .collect(),
                None => checked_probability(value, name).map(|value| vec![value]),
            };
        }
    }
    Ok(defaults.to_vec())
}

pub(super) fn seeds(config: &Value, default: usize) -> Result<Vec<u64>, String> {
    match config.get("seeds") {
        None => Ok((0..default as u64).collect()),
        Some(Value::Array(values)) if !values.is_empty() => values
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| "seeds must contain nonnegative 64-bit integers".to_owned())
            })
            .collect(),
        Some(Value::Array(_)) => Err("seeds must not be empty".to_owned()),
        Some(_) => Ok((0..count(config, "seeds", default)? as u64).collect()),
    }
}

pub(super) fn number(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or(f64::NAN)
}

pub(super) fn extend(mut base: Value, values: &Value) -> Value {
    if let (Some(base), Some(values)) = (base.as_object_mut(), values.as_object()) {
        base.extend(values.clone());
    }
    base
}

pub(super) fn mean_ci(values: &[f64]) -> (f64, f64) {
    if values.is_empty() {
        return (f64::NAN, f64::NAN);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let ci = if values.len() > 1 {
        let variance =
            values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
        1.96 * variance.sqrt() / (values.len() as f64).sqrt()
    } else {
        f64::NAN
    };
    (mean, ci)
}

pub(super) fn prepare_output(output: &Path) -> Result<(), String> {
    fs::create_dir_all(output).map_err(|e| format!("cannot create {}: {e}", output.display()))
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let data = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, format!("{data}\n"))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub(super) fn write_csv(path: &Path, columns: &[&str], rows: &[Value]) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(path)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    writer.write_record(columns).map_err(|e| e.to_string())?;
    for row in rows {
        let record: Result<Vec<String>, String> = columns
            .iter()
            .map(|key| match row.get(*key) {
                Some(Value::Null) => Ok("NaN".to_owned()),
                Some(Value::String(value)) => Ok(value.clone()),
                Some(value) => Ok(value.to_string()),
                None => Err(format!("missing CSV field {key}")),
            })
            .collect();
        writer.write_record(record?).map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())
}

/// Dependency-free, inspectable figures. Undefined points leave gaps in a series.
pub(super) fn write_svg(
    path: &Path,
    title: &str,
    x_label: &str,
    y_label: &str,
    series: &[(String, Vec<(f64, f64)>)],
) -> Result<(), String> {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }
    let x_max = series
        .iter()
        .flat_map(|(_, points)| points)
        .map(|p| p.0)
        .filter(|x| x.is_finite())
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let y_max = series
        .iter()
        .flat_map(|(_, points)| points)
        .map(|p| p.1)
        .filter(|y| y.is_finite())
        .fold(0.0_f64, f64::max)
        .max(1.0)
        * 1.1;
    let x = |value: f64| 85.0 + value / x_max * 580.0;
    let y = |value: f64| 475.0 - value / y_max * 385.0;
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"980\" height=\"570\" viewBox=\"0 0 980 570\" role=\"img\"><title>{}</title><rect width=\"980\" height=\"570\" fill=\"white\"/><g font-family=\"sans-serif\" fill=\"#243247\"><text x=\"85\" y=\"40\" font-size=\"21\">{}</text>", escape(title), escape(title));
    for tick in 0..=5 {
        let fraction = tick as f64 / 5.0;
        let xp = x(x_max * fraction);
        let yp = y(y_max * fraction);
        svg.push_str(&format!("<path d=\"M85 {yp:.2} H665\" stroke=\"#dce3ea\"/><text x=\"73\" y=\"{:.2}\" text-anchor=\"end\" font-size=\"12\">{:.2}</text><text x=\"{xp:.2}\" y=\"499\" text-anchor=\"middle\" font-size=\"12\">{:.2}</text>", yp + 4.0, y_max * fraction, x_max * fraction));
    }
    svg.push_str(&format!("<path d=\"M85 90 V475 H665\" fill=\"none\" stroke=\"#243247\"/><text x=\"375\" y=\"540\" text-anchor=\"middle\" font-size=\"15\">{}</text><text x=\"22\" y=\"283\" transform=\"rotate(-90 22 283)\" text-anchor=\"middle\" font-size=\"15\">{}</text>", escape(x_label), escape(y_label)));
    let colors = [
        "#2864dc", "#d44832", "#168060", "#864cc2", "#ba740e", "#bf4785", "#148c9a", "#59677c",
    ];
    for (i, (name, points)) in series.iter().enumerate() {
        let color = colors[i % colors.len()];
        let mut path_data = String::new();
        let mut drawing = false;
        for &(px, py) in points {
            if !px.is_finite() || !py.is_finite() {
                drawing = false;
                continue;
            }
            path_data.push_str(&format!(
                "{} {:.2} {:.2} ",
                if drawing { "L" } else { "M" },
                x(px),
                y(py)
            ));
            drawing = true;
            svg.push_str(&format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"3.5\" fill=\"{color}\"/>",
                x(px),
                y(py)
            ));
        }
        let legend_y = 105 + i * 27;
        svg.push_str(&format!("<path d=\"{path_data}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"2\"/><path d=\"M690 {legend_y} H712\" stroke=\"{color}\" stroke-width=\"3\"/><text x=\"722\" y=\"{}\" font-size=\"12\">{}</text>", legend_y + 4, escape(name)));
    }
    svg.push_str("</g></svg>\n");
    fs::write(path, svg).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_metadata_is_exact_for_both_deterministic_boundaries() {
        let result = execute(&json!({"seed": 1, "corruption": 0, "n": 5000})).unwrap();
        for protocol in ["deterministic", "halo_redundant"] {
            assert_eq!(result[protocol]["containment_failure_rate"], 0.0);
            assert_eq!(result[protocol]["false_block_rate"], 0.0);
            assert_eq!(result[protocol]["benign_success_rate"], 1.0);
        }
        assert!(
            result["model_monitor"]["containment_failure_rate"]
                .as_f64()
                .unwrap()
                > 0.1
        );
    }

    #[test]
    fn validation_rejects_bad_probabilities_counts_and_config_types() {
        for config in [
            json!({"corruption": -0.1}),
            json!({"corruption": 1.1}),
            json!({"corruption": "bad"}),
            json!({"corruption": null}),
            json!({"n": 0}),
            json!({"n": -1}),
            json!({"n": true}),
            json!({"n": 1.5}),
            json!([]),
        ] {
            assert!(execute(&config).is_err(), "accepted {config}");
        }
    }

    #[test]
    fn single_observation_preserves_undefined_class_rates() {
        for seed in 0..10 {
            let result = execute(&json!({"seed": seed, "n": 1})).unwrap();
            for metrics in result.as_object().unwrap().values() {
                assert_ne!(
                    metrics["containment_failure_rate"].is_null(),
                    metrics["false_block_rate"].is_null()
                );
                assert_eq!(
                    metrics["false_block_rate"].is_null(),
                    metrics["benign_success_rate"].is_null()
                );
            }
            assert_eq!(result.as_object().unwrap().len(), 3);
        }
    }

    #[test]
    fn execution_is_seed_reproducible_and_redundancy_reduces_failures() {
        let config = json!({"seed": 17, "n": 20000, "corruption": 0.1});
        let result = execute(&config).unwrap();
        assert_eq!(result, execute(&config).unwrap());
        assert!(
            result["halo_redundant"]["containment_failure_rate"]
                .as_f64()
                .unwrap()
                < result["deterministic"]["containment_failure_rate"]
                    .as_f64()
                    .unwrap()
        );
    }

    #[test]
    fn sweep_preserves_full_grid_and_writes_reusable_artifacts() {
        let output = tempfile::tempdir().unwrap();
        let report = sweep(&json!({"seeds": 1, "n": 20}), output.path()).unwrap();
        assert_eq!(report["rows"], 18);
        assert_eq!(report["summary_rows"], 18);
        let mut csv = csv::Reader::from_path(output.path().join("results.csv")).unwrap();
        assert_eq!(csv.records().count(), 18);
        assert!(
            std::fs::read_to_string(output.path().join("degradation_curve.svg"))
                .unwrap()
                .contains("<svg")
        );
        assert!(sweep(&json!({"seeds": 0}), output.path()).is_err());
    }
}
