use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_halo-sandbox-runner");

#[test]
fn malformed_arguments_are_usage_errors() {
    for args in [
        vec!["--child"],
        vec!["--repeats"],
        vec!["--repeats", "0"],
        vec!["--unknown"],
    ] {
        let output = Command::new(BIN).args(&args).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {:?}", output);
        assert!(!String::from_utf8_lossy(&output.stderr).contains("panicked"));
    }
}

#[test]
#[cfg(target_os = "macos")]
fn real_control_and_sandbox_have_expected_outcomes() {
    let output = Command::new(BIN).args(["--repeats", "1"]).output().unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["temporary_fixtures_removed"], true, "{report}");
    assert_eq!(report["trials"].as_array().unwrap().len(), 36);
    assert_eq!(
        report["summary"]["unconfined_control"]["attacks_escaped"],
        9
    );
    assert_eq!(
        report["summary"]["sandbox_inherited_capabilities"]["attacks_escaped"],
        2
    );
    assert_eq!(
        report["summary"]["sandbox_clean_launch"]["attacks_blocked"],
        9
    );
    for summary in report["summary"].as_object().unwrap().values() {
        assert_eq!(summary["benign_allowed"], 3, "{report}");
        assert_eq!(summary["errors"], 0, "{report}");
    }
    assert!(output.status.success(), "{report}");
}
