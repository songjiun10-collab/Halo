"""Experimental macOS containment probe, not a production sandbox.

All attack targets are disposable canaries and a loopback listener created here.
Run with a local Python 3.11+ on macOS; no third-party packages are required.
"""
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import platform
import secrets
import socket
import statistics
import subprocess
import sys
import tempfile
import time

PAYLOAD = r'''
import errno, json, os, socket, subprocess, sys
from pathlib import Path
case, outside, work, port, fd = sys.argv[1:]
outside, work = Path(outside), Path(work)
try:
    if case == "allowed_compute":
        value = sum(range(1000))
    elif case == "allowed_read":
        value = (work / "input.txt").read_text()
    elif case == "allowed_write":
        p = work / "output.txt"
        p.write_text("allowed")
        value = p.read_text()
    elif case == "absolute_read":
        value = (outside / "canary.txt").read_text()
    elif case == "traversal_read":
        value = (work / ".." / "outside" / "canary.txt").read_text()
    elif case == "symlink_read":
        value = (work / "read-link").read_text()
    elif case == "absolute_write":
        (outside / "target.txt").write_text("changed")
        value = "changed"
    elif case == "symlink_write":
        (work / "write-link").write_text("changed")
        value = "changed"
    elif case == "child_read":
        result = subprocess.run(
            ["/bin/cat", str(outside / "canary.txt")],
            capture_output=True, text=True, timeout=2,
        )
        print(json.dumps({"status": "child", "returncode": result.returncode,
                          "value": result.stdout, "stderr": result.stderr}))
        sys.exit(0)
    elif case == "tcp_connect":
        with socket.create_connection(("127.0.0.1", int(port)), timeout=1):
            value = "connected"
    elif case == "environment_secret":
        value = os.environ.get("HALO_SYNTHETIC_SECRET")
    elif case == "inherited_fd":
        value = os.pread(int(fd), 4096, 0).decode()
    else:
        raise ValueError(case)
    print(json.dumps({"status": "ok", "value": value}))
except OSError as exc:
    print(json.dumps({"status": "os_error", "errno": exc.errno,
                      "error": str(exc)}))
'''

BENIGN = {
    "allowed_compute": 499500,
    "allowed_read": "public input",
    "allowed_write": "allowed",
}
ATTACKS = [
    "absolute_read", "traversal_read", "symlink_read", "absolute_write",
    "symlink_write", "child_read", "tcp_connect", "environment_secret", "inherited_fd",
]


def _python_cellar_root(executable: Path) -> str:
    """Resolve the Cellar/<formula> root hosting the current interpreter."""
    for parent in executable.parents:
        if parent.parent.name == "Cellar":
            return str(parent)
    return str(executable.parent)


def sandbox_profile(work: Path, executable: Path) -> str:
    # Root directory itself is needed by the macOS loader; this is literal,
    # not a recursive read grant. Runtime trees are read-only exceptions,
    # narrowed to exactly the interpreter subtree so /opt/homebrew/etc and
    # /var are not exposed. sysctl-read and file-read-metadata are scoped to
    # limit process inspection. Root listings and volume metadata remain
    # observable; this profile is not a complete host confidentiality boundary.
    cellar = _python_cellar_root(executable)
    readable = [cellar, "/System/Library", "/usr/lib", "/usr/share", str(work)]
    filters = " ".join(f"(subpath {json.dumps(p)})" for p in readable)
    executable_paths = [str(executable)]
    framework_app = executable.parent.parent / "Resources/Python.app/Contents/MacOS/Python"
    if framework_app != executable:
        executable_paths.append(str(framework_app))
    exec_rules = " ".join(f"(literal {json.dumps(path)})" for path in executable_paths)
    return f'''(version 1)
(deny default)
(allow process-exec {exec_rules})
(allow sysctl-read
      (sysctl-name-prefix "kern.os")
      (sysctl-name-prefix "kern.version")
      (sysctl-name "kern.maxfilesperproc")
      (sysctl-name "kern.maxfiles")
      (sysctl-name "machdep.cpu.brand_string"))
(allow file-read-metadata
      (subpath {json.dumps(str(work))})
      (literal "/opt")
      (literal "/opt/homebrew")
      (literal "/opt/homebrew/Cellar")
      (subpath {json.dumps(cellar)})
      (subpath "/System/Library")
      (subpath "/usr/lib")
      (literal "/")
      (literal "/dev/null"))
(allow file-read* {filters} (literal "/") (literal "/dev/null")
      (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write* (subpath {json.dumps(str(work))}) (literal "/dev/null"))
(deny process-info*)
'''


def validate_workspace(work: Path) -> None:
    """Reject pre-existing hardlinks before granting a writable sandbox root."""
    for path in work.rglob("*"):
        if path.is_file() and path.stat().st_nlink != 1:
            raise ValueError(f"workspace contains a hardlinked file: {path}")


def classify(case: str, result: dict, secret: str, target: Path) -> str:
    if case in BENIGN:
        return "allowed" if result.get("status") == "ok" and result.get("value") == BENIGN[case] else "error"
    if case.endswith("write"):
        try:
            if target.read_bytes() != b"original":
                return "escaped"
        except FileNotFoundError:
            return "escaped"
        except OSError:
            return "error"
    expected = "changed" if case.endswith("write") else "connected" if case == "tcp_connect" else secret
    if result.get("value") == expected:
        if case.endswith("write") and target.read_text() != "changed":
            return "error"
        return "escaped"
    if result.get("status") == "os_error":
        blocked_errnos = {errno.EPERM, errno.EACCES}
        if case == "inherited_fd":
            blocked_errnos.add(errno.EBADF)
        return "blocked" if result.get("errno") in blocked_errnos else "error"
    if case == "child_read" and result.get("returncode") != 0:
        detail = result.get("stderr", "")
        return "blocked" if "Operation not permitted" in detail or "Permission denied" in detail else "error"
    if case == "environment_secret" and result.get("status") == "ok" and result.get("value") is None:
        return "blocked"
    return "error"


def run_benchmark(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("This experimental benchmark requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")
    rows = []
    python = str(Path(sys.executable).resolve())
    with tempfile.TemporaryDirectory(prefix="halo-containment-") as tmp, socket.socket() as server:
        root = Path(tmp).resolve()
        work, outside = root / "work", root / "outside"
        work.mkdir()
        outside.mkdir()
        secret = "SYNTHETIC-" + secrets.token_hex(16)
        canary, target = outside / "canary.txt", outside / "target.txt"
        canary.write_text(secret)
        target.write_text("original")
        (work / "input.txt").write_text("public input")
        (work / "read-link").symlink_to(canary)
        (work / "write-link").symlink_to(target)
        validate_workspace(work)
        profile = sandbox_profile(work, Path(python))
        server.bind(("127.0.0.1", 0))
        server.listen(128)
        port = server.getsockname()[1]
        with canary.open("rb") as handle:
            for mode in ("unconfined_control", "sandbox_inherited_capabilities", "sandbox_clean_launch"):
                env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work), "LC_ALL": "C"}
                inherited = mode != "sandbox_clean_launch"
                if inherited:
                    env["HALO_SYNTHETIC_SECRET"] = secret
                for repeat in range(repeats):
                    for case in [*BENIGN, *ATTACKS]:
                        target.write_text("original")
                        args = [python, "-I", "-S", "-c", PAYLOAD, case,
                                str(outside), str(work), str(port), str(handle.fileno())]
                        if mode != "unconfined_control":
                            args = ["/usr/bin/sandbox-exec", "-p", profile, *args]
                        start = time.perf_counter()
                        try:
                            proc = subprocess.run(
                                args, cwd=work, env=env, capture_output=True, text=True,
                                close_fds=True,
                                pass_fds=(handle.fileno(),) if inherited else (), timeout=5,
                            )
                            if proc.returncode != 0:
                                result = {"status": "launch_error", "returncode": proc.returncode, "stderr": proc.stderr}
                            else:
                                try:
                                    result = json.loads(proc.stdout)
                                except json.JSONDecodeError:
                                    result = {"status": "invalid_output", "stdout": proc.stdout}
                        except subprocess.TimeoutExpired:
                            result = {"status": "timeout"}
                        elapsed = (time.perf_counter() - start) * 1000
                        outcome = classify(case, result, secret, target)
                        # Preserve evidence without publishing ephemeral canary contents.
                        if result.get("value") == secret:
                            result["value"] = "<synthetic-canary-matched>"
                        rows.append({"mode": mode, "repeat": repeat, "case": case,
                                     "outcome": outcome, "elapsed_ms": round(elapsed, 3),
                                     "evidence": result})
        summary = {}
        for mode in dict.fromkeys(row["mode"] for row in rows):
            subset = [row for row in rows if row["mode"] == mode]
            benign = [row for row in subset if row["case"] in BENIGN]
            attack = [row for row in subset if row["case"] in ATTACKS]
            summary[mode] = {
                "benign_allowed": sum(row["outcome"] == "allowed" for row in benign),
                "benign_total": len(benign),
                "attacks_escaped": sum(row["outcome"] == "escaped" for row in attack),
                "attacks_blocked": sum(row["outcome"] == "blocked" for row in attack),
                "attack_total": len(attack),
                "errors": sum(row["outcome"] == "error" for row in subset),
                "median_process_ms": round(statistics.median(row["elapsed_ms"] for row in subset), 3),
            }
    return {"platform": platform.platform(), "python": sys.version, "repeats": repeats,
            "profile_template": profile.replace(str(work), "<temporary-work-dir>"),
            "temporary_fixtures_removed": not root.exists(), "summary": summary, "trials": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("results.json"))
    args = parser.parse_args()
    report = run_benchmark(args.repeats)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report["summary"], indent=2))
    control = report["summary"]["unconfined_control"]
    clean = report["summary"]["sandbox_clean_launch"]
    valid = all(s["errors"] == 0 and s["benign_allowed"] == s["benign_total"] for s in report["summary"].values())
    valid = valid and control["attacks_escaped"] == control["attack_total"]
    valid = valid and clean["attacks_blocked"] == clean["attack_total"]
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
