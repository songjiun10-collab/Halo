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
fn one_hundred_probes_block_sensitive_access_and_pass_the_gate() {
    let output = Command::new(BIN).args(["--repeats", "1"]).output().unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["temporary_fixtures_removed"], true, "{report}");
    assert_eq!(report["trials"].as_array().unwrap().len(), 309);
    assert_eq!(
        report["summary"]["unconfined_control"]["attacks_escaped"],
        97
    );
    assert_eq!(
        report["summary"]["unconfined_control"]["attacks_informational"],
        3
    );
    assert_eq!(
        report["summary"]["sandbox_inherited_capabilities"]["attack_total"],
        100
    );
    assert_eq!(
        report["summary"]["sandbox_clean_launch"]["attack_total"],
        100
    );
    for summary in report["summary"].as_object().unwrap().values() {
        assert_eq!(summary["benign_allowed"], 3, "{report}");
        assert_eq!(summary["errors"], 0, "{report}");
    }
    let clean_escaped = report["summary"]["sandbox_clean_launch"]["attacks_escaped"]
        .as_u64()
        .unwrap();
    let clean_blocked = report["summary"]["sandbox_clean_launch"]["attacks_blocked"]
        .as_u64()
        .unwrap();
    let clean_informational = report["summary"]["sandbox_clean_launch"]["attacks_informational"]
        .as_u64()
        .unwrap();
    assert_eq!(clean_escaped + clean_blocked + clean_informational, 100);
    let escaped: Vec<_> = report["trials"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["mode"] == "sandbox_clean_launch" && r["outcome"] == "escaped")
        .map(|r| r["case"].as_str().unwrap())
        .collect();
    assert!(!escaped.contains(&"metadata_fstatat_root"));
    assert!(!escaped.contains(&"metadata_lstat_root"));
    assert!(!escaped.contains(&"metadata_getcwd"));
    assert!(!escaped.contains(&"metadata_getpid"));
    assert!(!escaped.contains(&"metadata_access_parent"));
    assert_eq!(clean_escaped, 0, "{escaped:?}");
    assert_eq!(clean_blocked, 97);
    assert_eq!(clean_informational, 3);
    for case in ["metadata_statvfs", "metadata_pathconf", "metadata_statfs"] {
        let trial = report["trials"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["mode"] == "sandbox_clean_launch" && r["case"] == case)
            .unwrap();
        assert_eq!(trial["outcome"], "blocked", "{trial}");
        assert_eq!(trial["evidence"]["status"], "os_error", "{trial}");
        assert_eq!(trial["evidence"]["errno"], libc::EPERM, "{trial}");
    }
    assert_eq!(output.status.code(), Some(0), "{report}");
    assert_eq!(report["security_gate"]["passed"], true);
    let residual = report["security_gate"]["residual_cases"]
        .as_array()
        .unwrap();
    assert!(residual.is_empty(), "{residual:?}");
}
