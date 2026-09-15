//! Parameter grids from the three legacy ultra_exploit_e*.py scripts.
//! All inputs and outputs are synthetic numbers. Observations do not establish
//! that similarly sized marginal error rates imply correlated error events.
use halo_experiments::{e001b, e002, e003};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

fn scenarios(experiment: &str, n: usize) -> Result<Vec<Value>, String> {
    if n == 0 {
        return Err("n must be positive".into());
    }
    let mut cases = Vec::new();
    let mut add = |experiment: &str, scenario: &str, config: Value| {
        cases.push(json!({"experiment":experiment,"scenario":scenario,"config":config}))
    };
    if experiment == "e001b" || experiment == "all" {
        for p in [0.6, 0.7, 0.8, 0.9, 0.95, 0.99] {
            add(
                "e001b",
                "extreme_error_rate",
                json!({"seed":42,"n":n,"p":p,"rho":1.0}),
            );
        }
        for i in 0..17 {
            add(
                "e001b",
                "error_rate_scan",
                json!({"seed":42,"n":n,"p":0.1+i as f64*0.05,"rho":1.0}),
            );
        }
        for rho in [0.9, 0.95, 0.99, 1.0] {
            add(
                "e001b",
                "third_source_marginals",
                json!({"seed":42,"n":n,"p":0.3,"rho":rho}),
            );
        }
        for p in [0.1, 0.3, 0.5, 0.7, 0.9] {
            add(
                "e001b",
                "voting_comparison",
                json!({"seed":42,"n":n,"p":p,"rho":0.8}),
            );
        }
        for p in [0.2, 0.4, 0.6] {
            add(
                "e001b",
                "mixed_correlation",
                json!({"seed":42,"n":n,"p":p,"rho":0.7}),
            );
        }
        add(
            "e001b",
            "perfect_correlation",
            json!({"seed":42,"n":n,"p":0.5,"rho":1.0}),
        );
    }
    if experiment == "e002" || experiment == "all" {
        let mut add2 = |scenario: &str, h: f64, fpr: f64| {
            add(
                "e002",
                scenario,
                json!({"seed":42,"n_benign":n,"n_attack":n,"hidden_fraction":h,"target_fpr":fpr}),
            )
        };
        for f in [0.0001, 0.001, 0.005, 0.01] {
            add2("low_fpr", 0.5, f);
        }
        for h in [0.3, 0.5, 0.7, 0.9] {
            add2("conservative_scaling", h, 0.05);
        }
        for h in [0.2, 0.4, 0.6, 0.8] {
            for f in [0.01, 0.02, 0.05, 0.10] {
                add2("joint_strategy_grid", h, f);
            }
        }
        for h in [0.1, 0.3, 0.5, 0.7, 0.9] {
            add2("weighted_scores", h, 0.10);
        }
        for f in [0.01, 0.20] {
            add2("fpr_sensitivity", 0.5, f);
        }
        for h in [0.2, 0.4, 0.6, 0.8] {
            add2("adaptive_fallback", h, 0.10);
        }
    }
    if experiment == "e003" || experiment == "all" {
        let mut add3 = |scenario: &str, v: f64, d: usize, w: usize| {
            add(
                "e003",
                scenario,
                json!({"seed":42,"n":n,"delay_steps":d,"volatility":v,"freshness_window":w}),
            )
        };
        for i in 1..=10 {
            add3("volatility_scan", i as f64 * 0.01, 20, 3);
        }
        for v in [0.06, 0.07, 0.08, 0.09] {
            add3("read_write_boundary", v, 20, 3);
        }
        for w in [1, 2, 3, 4, 5] {
            add3("freshness_windows", 0.08, 20, w);
        }
        for d in [5, 10, 15, 20, 25, 30] {
            add3("delay_scan", 0.08, d, 3);
        }
        for i in 0..19 {
            add3("fine_volatility_scan", 0.01 + i as f64 * 0.005, 20, 3);
        }
        for v in [0.02, 0.04, 0.06, 0.08, 0.10] {
            for w in [1, 2, 3, 5, 10] {
                add3("progressive_grid", v, 20, w);
            }
        }
    }
    if cases.is_empty() {
        return Err("experiment must be e001b, e002, e003 or all".into());
    }
    Ok(cases)
}

fn run() -> Result<(), String> {
    let mut experiment = "all".to_string();
    let mut n = 10000usize;
    let mut output: Option<PathBuf> = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--experiment" => experiment = args.next().ok_or("missing experiment")?,
            "--n" => {
                n = args
                    .next()
                    .ok_or("missing n")?
                    .parse()
                    .map_err(|_| "invalid n")?
            }
            "--output" => output = Some(args.next().ok_or("missing output path")?.into()),
            "--help" => {
                println!(
                    "parameter_stress [--experiment e001b|e002|e003|all] [--n N] [--output FILE]"
                );
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    let mut cases = scenarios(&experiment, n)?;
    for case in &mut cases {
        let result = match case["experiment"].as_str().unwrap() {
            "e001b" => e001b::execute(&case["config"]),
            "e002" => e002::execute(&case["config"]),
            "e003" => e003::execute(&case["config"]),
            _ => unreachable!(),
        }?;
        case["result"] = result;
    }
    let report = json!({"runner":"rust","experiment":experiment,"n":n,"scenario_count":cases.len(),"cases":cases,"interpretation":"Synthetic parameter comparisons; not evidence of real-system compromise. Rust RNG differs from NumPy."});
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    if let Some(path) = output {
        fs::write(path, format!("{text}\n")).map_err(|e| e.to_string())?;
    }
    println!("{text}");
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_source_grids_are_present() {
        assert_eq!(scenarios("e001b", 100).unwrap().len(), 36);
        assert_eq!(scenarios("e002", 100).unwrap().len(), 35);
        assert_eq!(scenarios("e003", 100).unwrap().len(), 69);
        assert_eq!(scenarios("all", 100).unwrap().len(), 140);
    }
    #[test]
    fn rejects_empty_or_unknown_scenarios() {
        assert!(scenarios("all", 0).is_err());
        assert!(scenarios("other", 100).is_err());
    }
}
