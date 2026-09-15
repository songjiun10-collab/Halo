use serde_json::Value;

fn compare(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!((a - b).abs() <= 1e-12, "{path}: actual {a}, reference {b}");
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "keys at {path}");
            for (key, value) in b {
                compare(
                    a.get(key).expect("missing reference key"),
                    value,
                    &format!("{path}.{key}"),
                );
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                compare(x, y, &format!("{path}[{index}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn metric_and_selector_results_match_python_reference() {
    let rows: Value = serde_json::from_str(include_str!("fixtures/e004_reference.json")).unwrap();
    for (index, row) in rows.as_array().unwrap().iter().enumerate() {
        let actual = halo_experiments::e004::execute(&row["config"]).unwrap();
        compare(&actual, &row["expected"], &format!("fixture[{index}]"));
    }
}

#[test]
fn pooling_and_quantiles_match_python_reference() {
    let rows: Value = serde_json::from_str(include_str!("fixtures/e002_reference.json")).unwrap();
    for (index, row) in rows.as_array().unwrap().iter().enumerate() {
        let actual = halo_experiments::e002::execute(&row["config"]).unwrap();
        compare(&actual, &row["expected"], &format!("fixture[{index}]"));
    }
}
