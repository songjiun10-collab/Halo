use serde_json::{json, Value};
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{symlink, MetadataExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BENIGN: [&str; 3] = ["allowed_compute", "allowed_read", "allowed_write"];
const ATTACKS: [&str; 9] = [
    "absolute_read",
    "traversal_read",
    "symlink_read",
    "absolute_write",
    "symlink_write",
    "child_read",
    "tcp_connect",
    "environment_secret",
    "inherited_fd",
];
const MODES: [&str; 3] = [
    "unconfined_control",
    "sandbox_inherited_capabilities",
    "sandbox_clean_launch",
];

fn os_error(error: io::Error) -> Value {
    json!({"status":"os_error", "errno":error.raw_os_error(), "error":error.to_string()})
}

fn payload(case: &str, outside: &Path, work: &Path, port: u16, fd: i32) -> Value {
    let result: io::Result<Value> = (|| {
        let value = match case {
            "allowed_compute" => json!((0..1000).sum::<u64>()),
            "allowed_read" => json!(fs::read_to_string(work.join("input.txt"))?),
            "allowed_write" => {
                let path = work.join("output.txt");
                fs::write(&path, "allowed")?;
                json!(fs::read_to_string(path)?)
            }
            "absolute_read" => json!(fs::read_to_string(outside.join("canary.txt"))?),
            "traversal_read" => json!(fs::read_to_string(work.join("../outside/canary.txt"))?),
            "symlink_read" => json!(fs::read_to_string(work.join("read-link"))?),
            "absolute_write" | "symlink_write" => {
                let path = if case == "absolute_write" {
                    outside.join("target.txt")
                } else {
                    work.join("write-link")
                };
                fs::write(path, "changed")?;
                json!("changed")
            }
            "child_read" => {
                let mut cmd = Command::new("/bin/cat");
                cmd.arg(outside.join("canary.txt"));
                let (status, stdout, stderr, timed_out) =
                    capture(&mut cmd, Duration::from_secs(2))?;
                if timed_out {
                    return Ok(json!({"status":"timeout"}));
                }
                return Ok(
                    json!({"status":"child", "returncode":status.code(), "value":String::from_utf8_lossy(&stdout), "stderr":String::from_utf8_lossy(&stderr)}),
                );
            }
            "tcp_connect" => {
                let address = SocketAddr::from(([127, 0, 0, 1], port));
                let _connection = TcpStream::connect_timeout(&address, Duration::from_secs(1))?;
                json!("connected")
            }
            "environment_secret" => json!(env::var("HALO_SYNTHETIC_SECRET").ok()),
            "inherited_fd" => {
                let mut buffer = [0u8; 4096];
                // SAFETY: buffer is writable for its full length; pread does not own fd.
                let size = unsafe { libc::pread(fd, buffer.as_mut_ptr().cast(), buffer.len(), 0) };
                if size < 0 {
                    return Err(io::Error::last_os_error());
                }
                json!(String::from_utf8_lossy(&buffer[..size as usize]))
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "unknown case")),
        };
        Ok(json!({"status":"ok", "value":value}))
    })();
    result.unwrap_or_else(os_error)
}

// Root/runtime read exceptions remain. This port tests the existing nine
// vectors; it is not a proof of host metadata isolation.
fn profile(work: &Path, exe: &Path) -> String {
    let work = json!(work.to_string_lossy()).to_string();
    let exe = json!(exe.to_string_lossy()).to_string();
    format!(
        r#"(version 1)
(deny default)
(allow process-exec (literal {exe}))
(allow sysctl-read (sysctl-name "hw.pagesize") (sysctl-name "hw.pagesize_compat"))
(allow file-read* (literal {exe}) (subpath {work})
    (subpath "/System/Library") (subpath "/usr/lib")
    (literal "/") (literal "/dev/null"))
(allow file-write* (subpath {work}) (literal "/dev/null"))
(deny process-info*)
"#
    )
}

fn classify(case: &str, result: &Value, secret: &str, target: &Path) -> &'static str {
    let benign = match case {
        "allowed_compute" => Some(json!(499500)),
        "allowed_read" => Some(json!("public input")),
        "allowed_write" => Some(json!("allowed")),
        _ => None,
    };
    if let Some(expected) = benign {
        return if result["status"] == "ok" && result["value"] == expected {
            "allowed"
        } else {
            "error"
        };
    }
    if case.ends_with("write") {
        match fs::read(target) {
            Ok(bytes) if bytes != b"original" => return "escaped",
            Err(e) if e.kind() == io::ErrorKind::NotFound => return "escaped",
            Err(_) => return "error",
            _ => {}
        }
    }
    let expected = if case.ends_with("write") {
        "changed"
    } else if case == "tcp_connect" {
        "connected"
    } else {
        secret
    };
    if result["value"] == expected {
        return if case.ends_with("write") {
            "error"
        } else {
            "escaped"
        };
    }
    if result["status"] == "os_error" {
        let code = result["errno"].as_i64();
        if code == Some(libc::EPERM as i64)
            || code == Some(libc::EACCES as i64)
            || (case == "inherited_fd" && code == Some(libc::EBADF as i64))
        {
            return "blocked";
        }
    }
    if case == "child_read" && result["status"] == "child" && result["returncode"] != 0 {
        let stderr = result["stderr"].as_str().unwrap_or("");
        if stderr.contains("Operation not permitted") || stderr.contains("Permission denied") {
            return "blocked";
        }
    }
    if case == "environment_secret"
        && result["status"] == "ok"
        && result.get("value") == Some(&Value::Null)
    {
        return "blocked";
    }
    "error"
}

type Capture = (std::process::ExitStatus, Vec<u8>, Vec<u8>, bool);

struct ProcessGroup(std::process::Child, bool);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if !self.1 {
            return;
        }
        // The leader remains unreaped until here, preventing PID reuse while
        // signalling the process group created exclusively for this launch.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}

fn nonblocking(pipe: &impl AsRawFd) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    // SAFETY: fd is owned by the live pipe and fcntl does not take ownership.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn drain(pipe: &mut impl Read, bytes: &mut Vec<u8>) -> io::Result<bool> {
    let mut buffer = [0u8; 8192];
    // Bounded work per iteration keeps a continuously writing child from
    // starving the deadline or the other pipe.
    for _ in 0..8 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                if bytes.len() + n > 65536 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "child output exceeds 64 KiB per stream",
                    ));
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

fn exited_without_reaping(pid: u32) -> io::Result<bool> {
    // SAFETY: initialized siginfo is passed by pointer to waitid. WNOWAIT
    // observes exit while retaining ownership of the leader's PID.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        if libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) < 0
        {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(error);
        }
        Ok(info.si_pid() != 0)
    }
}

fn capture(cmd: &mut Command, timeout: Duration) -> io::Result<Capture> {
    let child = cmd
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut group = ProcessGroup(child, true);
    let mut stdout = group.0.stdout.take().unwrap();
    let mut stderr = group.0.stderr.take().unwrap();
    nonblocking(&stdout)?;
    nonblocking(&stderr)?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let start = Instant::now();
    let timed_out = loop {
        let out_done = drain(&mut stdout, &mut out)?;
        let err_done = drain(&mut stderr, &mut err)?;
        if exited_without_reaping(group.0.id())? && out_done && err_done {
            break false;
        }
        if start.elapsed() >= timeout {
            break true;
        }
        thread::sleep(Duration::from_millis(5));
    };
    // Kill any descendants before reaping the leader, including when the
    // leader exited but descendants kept its output pipes open.
    unsafe {
        libc::kill(-(group.0.id() as i32), libc::SIGKILL);
    }
    let status = group.0.wait()?;
    // Child::wait is cached after success. Avoid sending another group signal
    // after this PID has been released.
    group.1 = false;
    Ok((status, out, err, timed_out))
}

fn validate_workspace(work: &Path) -> io::Result<()> {
    for entry in fs::read_dir(work)? {
        let path = entry?.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_file() && metadata.nlink() != 1 {
            return Err(io::Error::other("hardlinked workspace file"));
        }
        if path.symlink_metadata()?.is_dir() {
            validate_workspace(&path)?;
        }
    }
    Ok(())
}

fn report_passes(report: &Value) -> bool {
    let Some(summaries) = report["summary"].as_object() else {
        return false;
    };
    if summaries.len() != MODES.len() {
        return false;
    }
    for mode in MODES {
        let Some(s) = summaries.get(mode) else {
            return false;
        };
        if s["benign_total"].as_u64().unwrap_or(0) == 0
            || s["attack_total"].as_u64().unwrap_or(0) == 0
            || s["errors"] != 0
            || s["benign_allowed"] != s["benign_total"]
        {
            return false;
        }
        let (Some(escaped), Some(blocked), Some(total)) = (
            s["attacks_escaped"].as_u64(),
            s["attacks_blocked"].as_u64(),
            s["attack_total"].as_u64(),
        ) else {
            return false;
        };
        if escaped.checked_add(blocked) != Some(total) {
            return false;
        }
    }
    summaries[MODES[0]]["attacks_escaped"] == summaries[MODES[0]]["attack_total"]
        && summaries[MODES[2]]["attacks_blocked"] == summaries[MODES[2]]["attack_total"]
}

fn benchmark(repeats: usize) -> Result<Value, Box<dyn std::error::Error>> {
    if !cfg!(target_os = "macos") || !Path::new("/usr/bin/sandbox-exec").exists() {
        return Err("requires macOS sandbox-exec".into());
    }
    let temp = tempfile::Builder::new().prefix("halo-rust-").tempdir()?;
    let root = temp.path().canonicalize()?;
    let work = root.join("work");
    let outside = root.join("outside");
    fs::create_dir(&work)?;
    fs::create_dir(&outside)?;
    let mut random = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let secret = format!(
        "RUST-CANARY-{}",
        random
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect::<String>()
    );
    let canary = outside.join("canary.txt");
    let target = outside.join("target.txt");
    fs::write(&canary, &secret)?;
    fs::write(&target, "original")?;
    fs::write(work.join("input.txt"), "public input")?;
    symlink(&canary, work.join("read-link"))?;
    symlink(&target, work.join("write-link"))?;
    validate_workspace(&work)?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let handle = File::open(&canary)?;
    // Keep the test FD away from Rust's launch-error pipe. Parent retains CLOEXEC.
    let raw = unsafe { libc::fcntl(handle.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 100) };
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: fcntl returned a new owned descriptor.
    let inherited_handle = unsafe { File::from_raw_fd(raw) };
    let exe = env::current_exe()?.canonicalize()?;
    let profile_text = profile(&work, &exe);
    let mut rows = Vec::new();
    for mode in MODES {
        let inherited = mode != "sandbox_clean_launch";
        for repeat in 0..repeats {
            for case in BENIGN.iter().chain(ATTACKS.iter()) {
                fs::write(&target, "original")?;
                let mut cmd = if mode == "unconfined_control" {
                    Command::new(&exe)
                } else {
                    let mut c = Command::new("/usr/bin/sandbox-exec");
                    c.args(["-p", &profile_text]).arg(&exe);
                    c
                };
                cmd.arg("--child")
                    .arg(case)
                    .arg(&outside)
                    .arg(&work)
                    .arg(port.to_string())
                    .arg(raw.to_string())
                    .current_dir(&work)
                    .env_clear()
                    .env("PATH", "/usr/bin:/bin")
                    .env("HOME", &work)
                    .env("TMPDIR", &work)
                    .env("LC_ALL", "C");
                if inherited {
                    cmd.env("HALO_SYNTHETIC_SECRET", &secret);
                }
                // SAFETY: only async-signal-safe fcntl calls in the forked child.
                let max_fd = unsafe { libc::getdtablesize() };
                unsafe {
                    cmd.pre_exec(move || {
                        for fd in 3..max_fd {
                            let flags = libc::fcntl(fd, libc::F_GETFD);
                            if flags < 0 {
                                if io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
                                    continue;
                                }
                                return Err(io::Error::last_os_error());
                            }
                            let flags = if inherited && fd == raw {
                                flags & !libc::FD_CLOEXEC
                            } else {
                                flags | libc::FD_CLOEXEC
                            };
                            if libc::fcntl(fd, libc::F_SETFD, flags) < 0 {
                                return Err(io::Error::last_os_error());
                            }
                        }
                        Ok(())
                    });
                }
                let start = Instant::now();
                let mut result = match capture(&mut cmd, Duration::from_secs(5)) {
                    Ok((_, _, _, true)) => json!({"status":"timeout"}),
                    Ok((status, _, stderr, false)) if !status.success() => {
                        json!({"status":"launch_error", "returncode":status.code(), "stderr":String::from_utf8_lossy(&stderr)})
                    }
                    Ok((_, stdout, _, false)) => match serde_json::from_slice::<Value>(&stdout) {
                        Ok(v) if v.is_object() => v,
                        _ => json!({"status":"invalid_output"}),
                    },
                    Err(error) => json!({"status":"launch_error", "error":error.to_string()}),
                };
                let outcome = classify(case, &result, &secret, &target);
                if result["value"] == secret {
                    result["value"] = json!("<synthetic-canary-matched>");
                }
                rows.push(json!({"mode":mode,"repeat":repeat,"case":case,"outcome":outcome,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0,"evidence":result}));
                while listener.accept().is_ok() {}
            }
        }
    }
    let mut summary = serde_json::Map::new();
    for mode in MODES {
        let subset: Vec<_> = rows.iter().filter(|r| r["mode"] == mode).collect();
        let count = |outcome: &str| subset.iter().filter(|r| r["outcome"] == outcome).count();
        summary.insert(mode.into(), json!({"benign_allowed":count("allowed"),"benign_total":BENIGN.len()*repeats,"attacks_escaped":count("escaped"),"attacks_blocked":count("blocked"),"attack_total":ATTACKS.len()*repeats,"errors":count("error")}));
    }
    drop(inherited_handle);
    drop(handle);
    temp.close()?;
    Ok(
        json!({"runner":"rust","repeats":repeats,"profile_template":profile_text.replace(work.to_str().unwrap(),"<temporary-work-dir>"),"temporary_fixtures_removed":!root.exists(),"summary":summary,"trials":rows}),
    )
}

enum Action {
    Run(usize, Option<PathBuf>),
    Child(String, PathBuf, PathBuf, u16, i32),
    Help,
}

fn parse(args: &[String]) -> Result<Action, String> {
    if args.first().map(String::as_str) == Some("--child") {
        if args.len() != 6 {
            return Err("--child requires CASE OUTSIDE WORK PORT FD".into());
        }
        if !BENIGN.contains(&args[1].as_str()) && !ATTACKS.contains(&args[1].as_str()) {
            return Err("unknown case".into());
        }
        let port = args[4].parse().map_err(|_| "invalid port")?;
        let fd = args[5].parse::<i32>().map_err(|_| "invalid fd")?;
        if fd < 3 {
            return Err("fd must be at least 3".into());
        }
        return Ok(Action::Child(
            args[1].clone(),
            args[2].clone().into(),
            args[3].clone().into(),
            port,
            fd,
        ));
    }
    let mut repeats = 1;
    let mut output = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--repeats" => {
                repeats = iter
                    .next()
                    .ok_or("missing repeats")?
                    .parse::<usize>()
                    .map_err(|_| "invalid repeats")?;
                if repeats == 0 {
                    return Err("repeats must be positive".into());
                }
            }
            "--output" => output = Some(PathBuf::from(iter.next().ok_or("missing output path")?)),
            "--help" | "-h" => return Ok(Action::Help),
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    Ok(Action::Run(repeats, output))
}

fn main() {
    let action = match parse(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let code = match action {
        Action::Help => {
            println!("halo-sandbox-runner [--repeats N] [--output FILE]");
            0
        }
        Action::Child(case, outside, work, port, fd) => {
            println!("{}", payload(&case, &outside, &work, port, fd));
            0
        }
        Action::Run(repeats, output) => match benchmark(repeats) {
            Ok(report) => {
                let text = serde_json::to_string_pretty(&report).unwrap();
                if let Some(path) = output {
                    if let Err(error) = fs::write(path, format!("{text}\n")) {
                        eprintln!("{error}");
                        std::process::exit(1);
                    }
                }
                println!("{text}");
                if report_passes(&report) {
                    0
                } else {
                    1
                }
            }
            Err(error) => {
                eprintln!("{error}");
                1
            }
        },
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excessive_output_is_an_error_not_a_truncated_success() {
        let mut command = Command::new("/usr/bin/printf");
        command.args(["%s", &"x".repeat(70000)]);
        assert!(capture(&mut command, Duration::from_secs(2)).is_err());
    }

    #[test]
    fn timeout_includes_descendants_holding_output_pipes() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2 & wait"]);
        let start = Instant::now();
        let result = capture(&mut command, Duration::from_millis(50)).unwrap();
        assert!(result.3);
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "descendant bypassed deadline"
        );
    }

    #[test]
    fn parent_exit_does_not_bypass_pipe_deadline() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2 & exit 0"]);
        let start = Instant::now();
        let result = capture(&mut command, Duration::from_millis(50)).unwrap();
        assert!(result.3, "open descendant pipes must count as timeout");
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn contradictory_attack_counts_cannot_pass() {
        let mut report = json!({"summary":{}});
        for mode in MODES {
            report["summary"][mode] = json!({"benign_allowed":3,"benign_total":3,"attacks_escaped":9,"attacks_blocked":9,"attack_total":9,"errors":0});
        }
        assert!(!report_passes(&report));
    }

    #[test]
    fn detects_exact_canary_and_connection_values() {
        let t = tempfile::tempdir().unwrap();
        let target = t.path().join("target");
        for case in ["absolute_read", "environment_secret", "inherited_fd"] {
            assert_eq!(
                classify(
                    case,
                    &json!({"status":"ok","value":"RUST-CANARY"}),
                    "RUST-CANARY",
                    &target
                ),
                "escaped"
            );
        }
        assert_eq!(
            classify(
                "tcp_connect",
                &json!({"status":"ok","value":"connected"}),
                "secret",
                &target
            ),
            "escaped"
        );
    }

    #[test]
    fn failures_are_not_successful_normal_work_or_blocked_attacks() {
        for result in [
            json!({"status":"timeout"}),
            json!({"status":"launch_error"}),
            json!({"status":"invalid_output"}),
            json!({"status":"os_error","errno":libc::ENOENT}),
        ] {
            for case in ["allowed_read", "absolute_read"] {
                assert_eq!(
                    classify(case, &result, "secret", Path::new("unused")),
                    "error"
                );
            }
        }
        assert_eq!(
            classify(
                "allowed_read",
                &json!({"status":"ok","value":"wrong"}),
                "secret",
                Path::new("unused")
            ),
            "error"
        );
    }

    #[test]
    fn external_mutation_overrides_payload_failure() {
        let t = tempfile::tempdir().unwrap();
        let target = t.path().join("target");
        fs::write(&target, "partial write").unwrap();
        assert_eq!(
            classify(
                "absolute_write",
                &json!({"status":"timeout"}),
                "secret",
                &target
            ),
            "escaped"
        );
        fs::remove_file(&target).unwrap();
        assert_eq!(
            classify(
                "absolute_write",
                &json!({"status":"os_error","errno":libc::EPERM}),
                "secret",
                &target
            ),
            "escaped"
        );
    }

    #[test]
    fn reads_real_fd() {
        let mut file = tempfile::tempfile().unwrap();
        use std::io::Write;
        file.write_all(b"fd-canary").unwrap();
        assert_eq!(
            payload(
                "inherited_fd",
                Path::new("unused"),
                Path::new("unused"),
                0,
                file.as_raw_fd()
            )["value"],
            "fd-canary"
        );
    }

    #[test]
    fn invalid_reports_fail_exit_gate() {
        assert!(!report_passes(&json!({})));
        let mut report = json!({"summary":{}});
        for mode in MODES {
            let escaped = match mode {
                "unconfined_control" => 9,
                "sandbox_inherited_capabilities" => 2,
                _ => 0,
            };
            report["summary"][mode] = json!({"benign_allowed":3,"benign_total":3,"attacks_escaped":escaped,"attacks_blocked":9-escaped,"attack_total":9,"errors":0});
        }
        assert!(report_passes(&report));
        report["summary"][MODES[2]]["errors"] = json!(1);
        assert!(!report_passes(&report));
        report["summary"][MODES[2]]["errors"] = json!(0);
        report["summary"][MODES[2]]["attacks_blocked"] = json!(8);
        assert!(!report_passes(&report));
    }

    #[test]
    fn timeout_terminates_child() {
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let result = capture(&mut command, Duration::from_millis(30)).unwrap();
        assert!(result.3);
        assert!(!result.0.success());
    }
}
