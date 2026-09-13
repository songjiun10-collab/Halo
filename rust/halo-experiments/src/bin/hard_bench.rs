//! Reproducible heavy workloads plus independent numerical invariants.
use halo_experiments::{e001, e001b, e002, e003, e004, e005};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, time::Instant};

fn execute(name: &str, c: &Value) -> Result<Value, String> {
    match name {
        "e001" => e001::execute(c),
        "e001b" => e001b::execute(c),
        "e002" => e002::execute(c),
        "e003" => e003::execute(c),
        "e004" => e004::execute(c),
        "e005" => e005::execute(c),
        _ => Err("unknown experiment".into()),
    }
}
fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-10
}
fn metric(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(f64::NAN)
}

fn invariant(name: &str, c: &Value, r: &Value) -> Result<(), String> {
    let require = |ok: bool, reason: &str| if ok { Ok(()) } else { Err(reason.to_string()) };
    match name {
        "e001" => {
            if c["corruption"] == 0.0 {
                for p in ["deterministic", "halo_redundant"] {
                    require(
                        r[p]["containment_failure_rate"] == 0.0 && r[p]["false_block_rate"] == 0.0,
                        "clean evidence must enforce exact policy",
                    )?;
                }
            }
        }
        "e001b" => {
            let rows = &r["results"];
            if c["rho"] == 1.0 {
                require(
                    rows["single_source"] == rows["redundant_fail_closed"],
                    "identical sources must collapse redundancy",
                )?;
            }
            let p = metric(c, "p");
            for s in [
                "source1_marginal_error",
                "source2_marginal_error",
                "source3_marginal_error",
            ] {
                require(
                    (metric(&r["diagnostics"], s) - p).abs() < 0.015,
                    "Bernoulli marginal outside generous tolerance",
                )?;
            }
        }
        "e002" => {
            let rows = &r["results"];
            require(
                near(
                    metric(&rows["max_pool"], "tpr"),
                    metric(&rows["conservative_max"], "tpr"),
                ),
                "positive score rescaling must preserve decisions after calibration",
            )?;
            for v in rows.as_object().ok_or("missing protocols")?.values() {
                require(
                    (metric(v, "fpr") - metric(c, "target_fpr")).abs()
                        <= 2. / metric(c, "n_benign"),
                    "empirical FPR calibration mismatch",
                )?;
            }
        }
        "e003" => {
            for p in ["use_time_revalidation", "adaptive_cached"] {
                require(
                    r["results"][p]["containment_failure_rate"] == 0.0
                        && r["results"][p]["false_block_rate"] == 0.0,
                    "use-time policy must match truth",
                )?;
            }
            let d = c["delay_steps"].as_u64().unwrap();
            let w = c["freshness_window"].as_u64().unwrap();
            require(
                r["diagnostics"]["fixed_window_verdict_age"] == d % (w + 1),
                "verdict age differs from refresh schedule",
            )?;
            require(
                r["diagnostics"]["fixed_window_revalidation_count"] == d / (w + 1),
                "refresh count differs from schedule",
            )?;
        }
        "e004" => {
            for p in ["worst_group_constrained", "robust_constrained"] {
                require(
                    metric(&r[p], "false_positive_rate") <= 0.1,
                    "selector exceeded FPR budget",
                )?;
            }
        }
        "e005" => {
            let first = metric(r, "initial_containment_failure");
            let last = metric(r, "final_containment_failure");
            require(
                near(last - first, metric(r, "escalation")),
                "trajectory endpoints inconsistent",
            )?;
            require(
                (metric(r, "mean_false_block_rate") - 0.1).abs() < 0.025,
                "held-out benign FPR far from target",
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn workloads() -> Vec<(&'static str, Value)> {
    let mut jobs = Vec::new();
    for seed in 0..5 {
        for p in [0., 0.05, 0.5, 1.] {
            jobs.push(("e001", json!({"seed":seed,"n":200000,"corruption":p})));
        }
        for p in [0.05, 0.5, 0.95] {
            for rho in [0., 0.999, 1.] {
                jobs.push(("e001b", json!({"seed":seed,"n":250000,"p":p,"rho":rho})));
            }
        }
        for h in [0., 0.5, 1.] {
            for fpr in [0.0001, 0.1] {
                jobs.push(("e002",json!({"seed":seed,"n_benign":100000,"n_attack":100000,"hidden_fraction":h,"target_fpr":fpr})));
            }
        }
        jobs.push(("e004", json!({"seed":seed,"n":100000})));
    }
    for seed in 0..3 {
        for delay in [256, 257] {
            for vol in [0., 0.001, 0.1, 1.] {
                for window in [0, 32] {
                    jobs.push(("e003",json!({"seed":seed,"n":50000,"delay_steps":delay,"volatility":vol,"freshness_window":window})));
                }
            }
        }
    }
    for seed in 0..10 {
        for defense in ["static", "moving"] {
            jobs.push(("e005",json!({"seed":seed,"rounds":100,"population":10000,"n_benign":40000,"n_eval_benign":20000,"defense":defense})));
        }
    }
    jobs
}

// Independent brute-force oracle: no sorting, cached statistics, or selector code.
fn oracle_case(rng: &mut StdRng, index: usize) -> Result<(), String> {
    let mut benign: Vec<f64> = (0..37)
        .map(|_| rng.gen_range(0..=10) as f64 / 10.)
        .collect();
    let common: Vec<f64> = (0..101)
        .map(|_| rng.gen_range(0..=10) as f64 / 10.)
        .collect();
    let rare: Vec<f64> = (0..(index % 7 + 1))
        .map(|_| rng.gen_range(0..=10) as f64 / 10.)
        .collect();
    let threshold = (index % 11) as f64 / 10.;
    let huge = index.is_multiple_of(2);
    let (w1, w2) = if huge {
        (1e308, 1e308)
    } else {
        (0.999999, 0.000001)
    };
    let config = json!({"operation":"evaluate","benign_scores":benign,"attack_scores":{"common":common,"rare":rare},"threshold":threshold,"attack_weights":{"common":w1,"rare":w2}});
    let r = e004::execute(&config)?;
    let rate = |a: &[f64]| a.iter().filter(|v| **v >= threshold).count() as f64 / a.len() as f64;
    let (a, b) = (rate(&common), rate(&rare));
    let expected = if huge { (a + b) / 2. } else { a * w1 + b * w2 };
    if !near(metric(&r, "attack_tpr"), expected)
        || !near(metric(&r, "worst_group_tpr"), a.min(b))
        || !near(metric(&r, "false_positive_rate"), rate(&benign))
    {
        return Err("brute force metric oracle disagrees".into());
    }
    // Permuting examples and splitting one subgroup must preserve unweighted aggregate.
    let mut plain = config.clone();
    plain.as_object_mut().unwrap().remove("attack_weights");
    let before = e004::execute(&plain)?;
    benign.reverse();
    plain["benign_scores"] = json!(benign);
    plain["attack_scores"] = json!({"left":&common[..50],"right":&common[50..],"rare":rare});
    let after = e004::execute(&plain)?;
    if !near(metric(&before, "attack_tpr"), metric(&after, "attack_tpr")) {
        return Err("group splitting changes aggregate TPR".into());
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let mut output = PathBuf::from("rust/results/hard-bench.json");
    while let Some(a) = args.next() {
        if a == "--output" {
            output = args.next().ok_or("missing output")?.into();
        } else {
            return Err(format!("unknown argument {a}"));
        }
    }
    let start = Instant::now();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    let jobs = workloads();
    let total = jobs.len();
    for (index, (name, c)) in jobs.into_iter().enumerate() {
        let clock = Instant::now();
        let result = execute(name, &c);
        let (r, check) = match result {
            Ok(r) => {
                let check = invariant(name, &c, &r);
                (r, check)
            }
            Err(e) => (Value::Null, Err(e)),
        };
        if let Err(e) = &check {
            failures.push(json!({"experiment":name,"config":c,"error":e}));
        }
        rows.push(json!({"experiment":name,"config":c,"elapsed_ms":clock.elapsed().as_secs_f64()*1000.,"passed":check.is_ok(),"result":r}));
        if index % 10 == 0 || index + 1 == total {
            eprintln!(
                "workloads {}/{total}; elapsed {:.1}s; failures {}",
                index + 1,
                start.elapsed().as_secs_f64(),
                failures.len()
            );
        }
    }
    let mut rng = StdRng::seed_from_u64(90513);
    for i in 0..512 {
        if let Err(e) = oracle_case(&mut rng, i) {
            failures.push(json!({"oracle_case":i,"error":e}));
        }
    }
    let mut rejected = 0;
    for name in ["e001", "e001b", "e002", "e003", "e004", "e005"] {
        let key = match name {
            "e002" => "n_attack",
            "e005" => "population",
            _ => "n",
        };
        for value in [
            json!(0),
            json!(-1),
            json!(true),
            json!(1.5),
            json!("large"),
            Value::Null,
        ] {
            let c = json!({key:value});
            if execute(name, &c).is_err() {
                rejected += 1;
            } else {
                failures.push(json!({"experiment":name,"accepted_invalid":c}));
            }
        }
    }
    let report = json!({"version":1,"workloads":rows,"oracle_cases":512,"invalid_inputs_rejected":rejected,"failures":failures,"elapsed_seconds":start.elapsed().as_secs_f64(),"scope":"Synthetic software and research stress benchmark. Runtime includes invariant checks. No Python timing baseline or full containment claim."});
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        &output,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        json!({"output":output,"workloads":total,"oracle_cases":512,"rejected":rejected,"failures":report["failures"].as_array().unwrap().len(),"elapsed_seconds":report["elapsed_seconds"]})
    );
    if report["failures"].as_array().unwrap().is_empty() {
        Ok(())
    } else {
        Err("hard benchmark failed; inspect report".into())
    }
}
