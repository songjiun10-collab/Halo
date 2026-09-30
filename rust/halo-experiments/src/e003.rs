//! Verdict freshness simulation, ported from the Python experiment.
//! Python experiment.py SHA-256: a99f7647ea709bbf7bfaa807f66c16a3645f1cf153546f310c45209e55ff9b98
//! Python run_sweep.py SHA-256: e5271555b0a1df945d7612dc894fff5e9b41b7e1a65c78a6a19336b950eb78f1

use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Map, Value};
use std::path::Path;

const PROTOCOLS: [&str; 5] = [
    "cached_verdict",
    "use_time_revalidation",
    "fixed_window_revalidation",
    "adaptive_cached",
    "progressive_refresh",
];

/// Run one trajectory. Undefined class rates are JSON null (CSV NaN).
/// Randomness is reproducible with Rust StdRng, not NumPy's generator.
pub fn execute(config: &Value) -> Result<Value, String> {
    support::object(config)?;
    let seed = support::integer(config, "seed", 0, false)?;
    let delay = support::integer(config, "delay_steps", 4, false)?;
    let volatility = support::probability(config, "volatility", 0.05)?;
    let n = support::count(config, "n", 100_000)?;
    let window = support::integer(config, "freshness_window", 2, false)?;
    // No floor at 1: forcing one step of reuse aliased the periodic refresh
    // onto the state's own oscillation period at high volatility, and
    // silently overrode an explicit freshness_window of 0. See the Python
    // reference's adaptive_window() for the full rationale.
    let adaptive_window = (window as f64 * (1.0 - volatility)).round_ties_even() as u64;
    let mut rng = StdRng::seed_from_u64(seed);
    let mut sensitive: Vec<bool> = (0..n).map(|_| rng.gen::<f64>() < 0.30).collect();
    let mut writable: Vec<bool> = (0..n).map(|_| rng.gen::<f64>() < 0.70).collect();
    let is_write: Vec<bool> = (0..n).map(|_| rng.gen::<f64>() < 0.55).collect();
    let policy = |s: &[bool], w: &[bool]| -> Vec<bool> {
        (0..n).map(|i| !is_write[i] || (!s[i] && w[i])).collect()
    };
    let checked = policy(&sensitive, &writable);
    let mut fixed = checked.clone();
    let mut progressive = checked.clone();
    let mut fixed_last_check = 0;
    let mut progressive_last_check = 0;
    let mut fixed_count = 0;
    let mut progressive_count = 0;
    for step in 1..=delay {
        for state in &mut sensitive {
            *state ^= rng.gen::<f64>() < volatility;
        }
        for state in &mut writable {
            *state ^= rng.gen::<f64>() < volatility;
        }
        // A cached verdict remains valid when its age equals the bound.
        if step - fixed_last_check > window {
            fixed = policy(&sensitive, &writable);
            fixed_last_check = step;
            fixed_count += 1;
        }
        if step - progressive_last_check > adaptive_window {
            progressive = policy(&sensitive, &writable);
            progressive_last_check = step;
            progressive_count += 1;
        }
    }
    let at_use = policy(&sensitive, &writable);
    let adaptive: Vec<bool> = (0..n)
        .map(|i| {
            if is_write[i] || volatility > 0.05 {
                at_use[i]
            } else {
                checked[i]
            }
        })
        .collect();
    let safe_total = at_use.iter().filter(|&&allow| allow).count();
    let unsafe_total = n - safe_total;
    let mut results = Map::new();
    for (name, decisions) in
        PROTOCOLS
            .into_iter()
            .zip([&checked, &at_use, &fixed, &adaptive, &progressive])
    {
        let mut unsafe_allowed = 0;
        let mut safe_blocked = 0;
        for i in 0..n {
            unsafe_allowed += usize::from(!at_use[i] && decisions[i]);
            safe_blocked += usize::from(at_use[i] && !decisions[i]);
        }
        let failure = support::rate(unsafe_allowed, unsafe_total);
        let blocked = support::rate(safe_blocked, safe_total);
        results.insert(
            name.into(),
            json!({
                "containment_failure_rate": failure,
                "false_block_rate": blocked,
                "benign_success_rate": 1.0 - blocked,
            }),
        );
    }
    let approved = checked.iter().filter(|&&allow| allow).count();
    let expired = checked
        .iter()
        .zip(&at_use)
        .filter(|(check, now)| **check && !**now)
        .count();
    Ok(json!({"results": results, "diagnostics": {
        "approval_expiry_rate": expired as f64 / approved.max(1) as f64,
        "fixed_window_verdict_age": delay - fixed_last_check,
        "fixed_window_revalidation_count": fixed_count,
        "progressive_revalidation_count": progressive_count,
        "adaptive_window_size": adaptive_window,
        "volatility_level": volatility,
    }}))
}

/// Preserve the original grid and its three-policy summary; raw rows include
/// all five current policies. Extra grid/count overrides support small runs.
pub fn sweep(config: &Value, output: &Path) -> Result<Value, String> {
    support::object(config)?;
    let seeds = support::seeds(config, 30, 0)?;
    let delays = support::integer_grid(config, "delays", &[0, 1, 2, 4, 8, 16])?;
    let volatilities =
        support::probability_grid(config, "volatilities", &[0.005, 0.01, 0.02, 0.05])?;
    let mut rows = Vec::new();
    let mut expiry = Vec::new();
    let mut summary = Vec::new();
    for volatility in volatilities {
        for &delay in &delays {
            let start = rows.len();
            for &seed in &seeds {
                let mut params = config.clone();
                params["seed"] = json!(seed);
                params["delay_steps"] = json!(delay);
                params["volatility"] = json!(volatility);
                let out = execute(&params)?;
                for protocol in PROTOCOLS {
                    let mut row = out["results"][protocol].as_object().unwrap().clone();
                    row.extend([
                        ("volatility".into(), json!(volatility)),
                        ("delay_steps".into(), json!(delay)),
                        ("seed".into(), json!(seed)),
                        ("protocol".into(), json!(protocol)),
                    ]);
                    rows.push(Value::Object(row));
                }
                let mut row = out["diagnostics"].as_object().unwrap().clone();
                row.extend([
                    ("volatility".into(), json!(volatility)),
                    ("delay_steps".into(), json!(delay)),
                    ("seed".into(), json!(seed)),
                ]);
                expiry.push(Value::Object(row));
            }
            for protocol in [
                "cached_verdict",
                "fixed_window_revalidation",
                "use_time_revalidation",
            ] {
                let subset: Vec<&Value> = rows[start..]
                    .iter()
                    .filter(|row| row["protocol"] == protocol)
                    .collect();
                let failures: Vec<f64> = subset
                    .iter()
                    .map(|r| support::number_or_nan(&r["containment_failure_rate"]))
                    .collect();
                let blocks: Vec<f64> = subset
                    .iter()
                    .map(|r| support::number_or_nan(&r["false_block_rate"]))
                    .collect();
                summary.push(json!({
                    "volatility": volatility,
                    "delay_steps": delay,
                    "protocol": protocol,
                    "failure_mean": support::mean(&failures),
                    "failure_ci95_halfwidth": support::ci95(&failures),
                    "false_block_mean": support::mean(&blocks),
                }));
            }
        }
    }
    std::fs::create_dir_all(output).map_err(|e| e.to_string())?;
    support::write_csv(
        &output.join("results.csv"),
        &rows,
        &[
            "volatility",
            "delay_steps",
            "seed",
            "protocol",
            "containment_failure_rate",
            "false_block_rate",
            "benign_success_rate",
        ],
    )?;
    support::write_csv(
        &output.join("expiry.csv"),
        &expiry,
        &[
            "volatility",
            "delay_steps",
            "seed",
            "approval_expiry_rate",
            "fixed_window_verdict_age",
            "fixed_window_revalidation_count",
            "progressive_revalidation_count",
            "adaptive_window_size",
            "volatility_level",
        ],
    )?;
    support::write_csv(
        &output.join("summary.csv"),
        &summary,
        &[
            "volatility",
            "delay_steps",
            "protocol",
            "failure_mean",
            "failure_ci95_halfwidth",
            "false_block_mean",
        ],
    )?;
    support::write_json(&output.join("summary.json"), &json!(summary))?;
    support::write_json(
        &output.join("results.json"),
        &json!({"results": rows, "expiry": expiry}),
    )?;
    Ok(
        json!({"experiment": "e003", "rows": rows.len(), "summary_rows": summary.len(), "expiry_rows": expiry.len(), "output": output.display().to_string()}),
    )
}

/// Shared validation/output primitives for the independently ported E003–E005
/// modules. Null is used only at JSON boundaries, never as a zero observation.
pub(crate) mod support {
    use serde_json::{json, Value};
    use std::path::Path;

    pub fn object(config: &Value) -> Result<(), String> {
        if config.is_object() {
            Ok(())
        } else {
            Err("config must be an object".into())
        }
    }

    pub fn integer(config: &Value, key: &str, default: u64, positive: bool) -> Result<u64, String> {
        let value = match config.get(key) {
            Some(value) => value.as_u64().ok_or_else(|| {
                format!(
                    "{key} must be a {}integer",
                    if positive {
                        "positive "
                    } else {
                        "non-negative "
                    }
                )
            })?,
            None => default,
        };
        if positive && value == 0 {
            return Err(format!("{key} must be a positive integer"));
        }
        Ok(value)
    }

    pub fn count(config: &Value, key: &str, default: u64) -> Result<usize, String> {
        usize::try_from(integer(config, key, default, true)?)
            .map_err(|_| format!("{key} is too large"))
    }

    pub fn real(config: &Value, key: &str, default: f64) -> Result<f64, String> {
        let number = match config.get(key) {
            Some(value) => value
                .as_f64()
                .ok_or_else(|| format!("{key} must be finite and numeric"))?,
            None => default,
        };
        if !number.is_finite() {
            return Err(format!("{key} must be finite"));
        }
        Ok(number)
    }

    pub fn probability(config: &Value, key: &str, default: f64) -> Result<f64, String> {
        let value = real(config, key, default)?;
        if !(0.0..=1.0).contains(&value) {
            return Err(format!("{key} must be finite and in [0, 1]"));
        }
        Ok(value)
    }

    pub fn boolean(config: &Value, key: &str, default: bool) -> Result<bool, String> {
        match config.get(key) {
            Some(value) => value
                .as_bool()
                .ok_or_else(|| format!("{key} must be a boolean")),
            None => Ok(default),
        }
    }

    pub fn seeds(
        config: &Value,
        default_count: u64,
        default_start: u64,
    ) -> Result<Vec<u64>, String> {
        if let Some(Value::Array(values)) = config.get("seeds") {
            if values.is_empty() {
                return Err("seeds must not be empty".into());
            }
            return values
                .iter()
                .map(|v| {
                    v.as_u64()
                        .ok_or_else(|| "seeds must contain non-negative integers".into())
                })
                .collect();
        }
        let count = integer(config, "seeds", default_count, true)?;
        let start = integer(config, "seed_start", default_start, false)?;
        let end = start.checked_add(count).ok_or("seed range is too large")?;
        Ok((start..end).collect())
    }

    pub fn integer_grid(config: &Value, key: &str, defaults: &[u64]) -> Result<Vec<u64>, String> {
        match config.get(key) {
            None => Ok(defaults.to_vec()),
            Some(value) => {
                let values = value
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| format!("{key} must be a non-empty array"))?;
                values
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .ok_or_else(|| format!("{key} must contain non-negative integers"))
                    })
                    .collect()
            }
        }
    }

    pub fn probability_grid(
        config: &Value,
        key: &str,
        defaults: &[f64],
    ) -> Result<Vec<f64>, String> {
        match config.get(key) {
            None => Ok(defaults.to_vec()),
            Some(value) => {
                let values = value
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| format!("{key} must be a non-empty array"))?;
                values
                    .iter()
                    .map(|v| probability(&json!({key:v}), key, 0.0))
                    .collect()
            }
        }
    }

    pub fn rate(numerator: usize, denominator: usize) -> f64 {
        if denominator == 0 {
            f64::NAN
        } else {
            numerator as f64 / denominator as f64
        }
    }

    pub fn number_or_nan(value: &Value) -> f64 {
        value.as_f64().unwrap_or(f64::NAN)
    }

    pub fn mean(values: &[f64]) -> f64 {
        if values.is_empty() {
            f64::NAN
        } else {
            values.iter().sum::<f64>() / values.len() as f64
        }
    }

    pub fn stdev(values: &[f64]) -> f64 {
        if values.len() < 2 {
            return f64::NAN;
        }
        let avg = mean(values);
        (values.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / (values.len() - 1) as f64).sqrt()
    }

    pub fn ci95(values: &[f64]) -> f64 {
        1.96 * stdev(values) / (values.len() as f64).sqrt()
    }

    pub fn write_csv(path: &Path, rows: &[Value], fields: &[&str]) -> Result<(), String> {
        let mut writer = csv::Writer::from_path(path).map_err(|e| e.to_string())?;
        writer.write_record(fields).map_err(|e| e.to_string())?;
        for row in rows {
            let values: Vec<String> = fields
                .iter()
                .map(|field| match &row[*field] {
                    Value::Null => "NaN".into(),
                    Value::String(value) => value.clone(),
                    value => value.to_string(),
                })
                .collect();
            writer.write_record(values).map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())
    }

    pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        encoded.push('\n');
        std::fs::write(path, encoded).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adaptive_window_preserves_python_ties_to_even() {
        for (window, expected) in [(3, 2), (5, 2), (7, 4)] {
            let out = execute(&json!({"seed":3,"n":10,"delay_steps":3,
                "volatility":0.5,"freshness_window":window})).unwrap();
            assert_eq!(out["diagnostics"]["adaptive_window_size"], expected);
            assert_eq!(out["diagnostics"]["progressive_revalidation_count"], 3 / (expected + 1));
        }
    }

    #[test]
    fn zero_delay_never_expires_or_revalidates() {
        let out =
            execute(&json!({"seed": 0, "delay_steps": 0, "volatility": 0.05, "n": 2000})).unwrap();
        assert_eq!(out["diagnostics"]["approval_expiry_rate"], 0.0);
        assert_eq!(out["diagnostics"]["fixed_window_verdict_age"], 0);
        assert_eq!(out["diagnostics"]["fixed_window_revalidation_count"], 0);
        for result in out["results"].as_object().unwrap().values() {
            assert_eq!(result["containment_failure_rate"], 0.0);
            assert_eq!(result["false_block_rate"], 0.0);
        }
    }

    #[test]
    fn zero_window_revalidates_every_step() {
        let out = execute(&json!({"seed": 2, "delay_steps": 8, "volatility": 0.05, "n": 2000, "freshness_window": 0})).unwrap();
        assert_eq!(out["diagnostics"]["fixed_window_verdict_age"], 0);
        assert_eq!(out["diagnostics"]["fixed_window_revalidation_count"], 8);
        assert_eq!(
            out["results"]["fixed_window_revalidation"],
            out["results"]["use_time_revalidation"]
        );
        assert_eq!(
            out["results"]["adaptive_cached"],
            out["results"]["use_time_revalidation"]
        );
    }

    #[test]
    fn refresh_occurs_only_after_the_age_bound() {
        let out = execute(&json!({"seed": 3, "delay_steps": 4, "volatility": 0.05, "n": 10000, "freshness_window": 2})).unwrap();
        assert_eq!(out["diagnostics"]["fixed_window_revalidation_count"], 1);
        assert_eq!(out["diagnostics"]["fixed_window_verdict_age"], 1);
        assert!(
            out["results"]["fixed_window_revalidation"]["containment_failure_rate"]
                .as_f64()
                .unwrap()
                > 0.0
        );
        assert_eq!(out["diagnostics"]["progressive_revalidation_count"], 1);
        assert_eq!(out["diagnostics"]["adaptive_window_size"], 2);
        let within = execute(&json!({"seed": 4, "delay_steps": 2, "volatility": 0.05, "n": 2000, "freshness_window": 2})).unwrap();
        assert_eq!(within["diagnostics"]["fixed_window_revalidation_count"], 0);
        assert_eq!(
            within["results"]["fixed_window_revalidation"],
            within["results"]["cached_verdict"]
        );
    }

    #[test]
    fn progressive_refresh_does_not_alias_at_full_volatility() {
        // Regression: a floor of 1 on adaptive_window used to force one step
        // of reuse even when volatility=1.0 flips state every step. The
        // periodic refresh schedule then aliased onto that 2-step
        // oscillation, so every odd delay_steps used a verdict that was
        // deterministically the opposite of truth. The window must reach 0
        // (revalidate every step) instead.
        let out = execute(&json!({"seed": 5, "delay_steps": 3, "volatility": 1.0,
            "n": 50000, "freshness_window": 2}))
        .unwrap();
        assert_eq!(out["diagnostics"]["adaptive_window_size"], 0);
        assert_eq!(
            out["results"]["progressive_refresh"]["containment_failure_rate"],
            0.0
        );
        assert_eq!(
            out["results"]["progressive_refresh"],
            out["results"]["use_time_revalidation"]
        );

        // An explicit freshness_window=0 must bound progressive reuse too,
        // not just the fixed-window comparison group.
        let zero_window = execute(&json!({"seed": 6, "delay_steps": 8,
            "volatility": 0.05, "n": 2000, "freshness_window": 0}))
        .unwrap();
        assert_eq!(zero_window["diagnostics"]["progressive_revalidation_count"], 8);
        assert_eq!(
            zero_window["results"]["progressive_refresh"],
            zero_window["results"]["use_time_revalidation"]
        );
    }

    #[test]
    fn missing_class_is_null_and_config_validation_is_strict() {
        let out =
            execute(&json!({"seed": 0, "delay_steps": 0, "volatility": 0.0, "n": 1})).unwrap();
        let metrics = &out["results"]["cached_verdict"];
        assert_ne!(
            metrics["containment_failure_rate"].is_null(),
            metrics["false_block_rate"].is_null()
        );
        assert_eq!(
            metrics["false_block_rate"].is_null(),
            metrics["benign_success_rate"].is_null()
        );
        for config in [
            json!({"n": 0}),
            json!({"n": true}),
            json!({"delay_steps": -1}),
            json!({"delay_steps": 1.5}),
            json!({"volatility": 1.01}),
            json!({"freshness_window": -1}),
        ] {
            assert!(execute(&config).is_err(), "{config}");
        }
    }

    #[test]
    fn sweep_writes_complete_seed_rows_and_single_seed_ci_is_undefined() {
        let dir = tempfile::tempdir().unwrap();
        sweep(
            &json!({"seeds": 1, "n": 1000, "delays": [0, 4], "volatilities": [0.05]}),
            dir.path(),
        )
        .unwrap();
        let mut results = csv::Reader::from_path(dir.path().join("results.csv")).unwrap();
        assert_eq!(results.records().count(), 10);
        let mut summary = csv::Reader::from_path(dir.path().join("summary.csv")).unwrap();
        let ci = summary
            .headers()
            .unwrap()
            .iter()
            .position(|x| x == "failure_ci95_halfwidth")
            .unwrap();
        let rows: Vec<_> = summary.records().map(Result::unwrap).collect();
        assert_eq!(rows.len(), 6);
        assert!(rows.iter().all(|r| r[ci].parse::<f64>().unwrap().is_nan()));
        assert!(dir.path().join("expiry.csv").is_file());
        assert!(dir.path().join("summary.json").is_file());
    }
}
