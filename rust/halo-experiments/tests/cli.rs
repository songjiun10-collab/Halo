use serde_json::{json, Value};
use std::process::Command;
const BIN: &str = env!("CARGO_BIN_EXE_halo-experiments");

#[test]
fn every_experiment_runs_without_python_and_is_repeatable() {
    for name in ["e001", "e001b", "e002", "e003", "e004", "e005"] {
        let config = json!({"seed":42,"n":100,"n_benign":200,"n_attack":200,"n_eval_benign":100,"population":100,"rounds":3,"delay_steps":2,"volatility":0.05,"p":0.05,"rho":0.5,"hidden_fraction":0.5});
        let invoke = || {
            Command::new(BIN)
                .args([name, "--json", &config.to_string()])
                .env("PATH", "/nonexistent")
                .output()
                .unwrap()
        };
        let first = invoke();
        let second = invoke();
        assert!(
            first.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&first.stderr)
        );
        assert!(serde_json::from_slice::<Value>(&first.stdout).is_ok());
        assert_eq!(first.stdout, second.stdout, "{name} is not reproducible");
    }
}

#[test]
fn bad_cli_and_invalid_experiment_inputs_fail() {
    for args in [
        vec!["bogus"],
        vec!["e001", "--json", "[]"],
        vec!["e001", "--config"],
        vec!["e001", "--json", "{\"n\":0}"],
        vec!["e005", "--json", "{\"defense\":\"wrong\"}"],
    ] {
        let r = Command::new(BIN).args(args).output().unwrap();
        assert!(!r.status.success());
        assert!(!String::from_utf8_lossy(&r.stderr).contains("panicked"));
    }
}
