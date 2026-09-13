use halo_experiments::{e001, e001b, e002, e003, e004, e005};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

type Execute = fn(&Value) -> Result<Value, String>;
type Sweep = fn(&Value, &std::path::Path) -> Result<Value, String>;

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let name = args
        .next()
        .ok_or("expected experiment e001|e001b|e002|e003|e004|e005")?;
    if name == "--help" || name == "-h" {
        println!("halo-experiments EXPERIMENT [--config JSON_FILE | --json JSON] [--sweep] [--output PATH]\nRun: output is a JSON file. Sweep: output is a directory of CSV/JSON/figures.\nRust seeded RNG is reproducible but differs from Python/NumPy streams. Undefined rates are JSON null.");
        return Ok(());
    }
    let (execute, sweep): (Execute, Sweep) = match name.to_ascii_lowercase().as_str() {
        "e001" => (e001::execute, e001::sweep),
        "e001b" | "e001-b" => (e001b::execute, e001b::sweep),
        "e002" => (e002::execute, e002::sweep),
        "e003" => (e003::execute, e003::sweep),
        "e004" => (e004::execute, e004::sweep),
        "e005" => (e005::execute, e005::sweep),
        _ => return Err(format!("unknown experiment: {name}")),
    };
    let mut config = json!({});
    let mut config_seen = false;
    let mut output = None;
    let mut full_sweep = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" | "--json" => {
                if config_seen {
                    return Err("only one config input is allowed".into());
                }
                let value = args.next().ok_or("missing config argument")?;
                let text = if arg == "--config" {
                    fs::read_to_string(value).map_err(|e| e.to_string())?
                } else {
                    value
                };
                config = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if !config.is_object() {
                    return Err("config must be a JSON object".into());
                }
                config_seen = true;
            }
            "--sweep" => full_sweep = true,
            "--output" => output = Some(PathBuf::from(args.next().ok_or("missing output path")?)),
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    let report = if full_sweep {
        let path = output.unwrap_or_else(|| PathBuf::from("results").join(&name));
        sweep(&config, &path)?
    } else {
        let result = execute(&config)?;
        if let Some(path) = output {
            fs::write(
                path,
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
                ),
            )
            .map_err(|e| e.to_string())?;
        }
        result
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
