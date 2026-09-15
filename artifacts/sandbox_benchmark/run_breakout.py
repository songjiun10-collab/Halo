"""Round-2 breakout suite: attacks the HARDENED profile with vectors the
original 5-exploit suite did not cover.

Usage:
    .venv/bin/python artifacts/sandbox_benchmark/run_breakout.py --repeats 5

Default cases mutate only disposable canaries and a sacrificial sleep child.
Read-only host metadata probes report residual exposure, not arbitrary execution.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import secrets
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_exploits import baseline_profile, hardened_profile  # noqa: E402
from run_exploits import _apply_nproc_limit  # noqa: E402


# ---------------------------------------------------------------------------
# Sandboxed payload — each case is a previously untested escape vector
# ---------------------------------------------------------------------------
BREAKOUT_PAYLOAD = r'''
import ctypes, errno, json, os, resource, signal, subprocess, sys
from pathlib import Path

case, work_dir, canary, victim, ppid, real_home = sys.argv[1:]
work = Path(work_dir)


def out(payload):
    if payload.get('status') == 'blocked' and 'errno' in payload:
        valid = payload['errno'] in (errno.EPERM, errno.EACCES)
        if case == 'reexec_canary' and payload['errno'] == errno.EAGAIN:
            valid = resource.getrlimit(resource.RLIMIT_NPROC)[0] == 1
        if not valid:
            payload['status'] = 'error'
    print(json.dumps(payload))
    sys.exit(0)


try:
    if case == "hardlink_canary":
        dst = work / "hl_canary"
        try:
            os.link(canary, dst)
        except OSError as exc:
            out({"status": "blocked", "stage": "link", "errno": exc.errno, "error": str(exc)})
        out({"status": "escaped", "value": dst.read_text()})

    elif case == "signal_victim":
        # POSIX signals between same-uid processes are not a sandboxed
        # operation: sandbox-exec has no rule class for kill(2).
        pid = int(victim)
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as exc:
            out({"status": "blocked", "errno": exc.errno, "error": str(exc)})
        out({"status": "delivered", "pid": pid})

    elif case == "signal_probe":
        try:
            os.kill(int(ppid), 0)
            out({"status": "reachable", "note": "kill(ppid,0) succeeded; signal plane open"})
        except OSError as exc:
            out({"status": "blocked", "errno": exc.errno, "error": str(exc)})

    elif case == "mach_lookup":
        # deny-default should gate mach-lookup, but verify bootstrap_look_up
        # cannot still resolve named services through the inherited bootstrap
        # port.
        libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        bootstrap_port = ctypes.c_uint32.in_dll(libsystem, "bootstrap_port")
        libsystem.bootstrap_look_up.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32)]
        libsystem.bootstrap_look_up.restype = ctypes.c_int
        results = {}
        for name in (b"com.apple.system.opendirectoryd",
                     b"com.apple.SecurityServer",
                     b"com.apple.system.logger"):
            port = ctypes.c_uint32(0)
            rc = libsystem.bootstrap_look_up(
                bootstrap_port.value, name, ctypes.byref(port))
            results[name.decode()] = {"rc": rc, "port": port.value if rc == 0 else None}
        leaked = any(v["rc"] == 0 and v["port"] for v in results.values())
        # macOS SDK servers/bootstrap.h: BOOTSTRAP_NOT_PRIVILEGED == 1100.
        denied = all(v['rc'] == 1100 for v in results.values())
        out({"status": "escaped" if leaked else "blocked" if denied else "error", "lookups": results})

    elif case == "statfs_probe":
        # statfs(2) exposes volume layout; check whether it is mediated by the
        # same file-read-metadata scoping or slips past it.
        results = {}
        for t in ("/", "/private/etc", real_home, str(Path(canary).parent)):
            try:
                st = os.statvfs(t)
                results[t] = {"ok": True, "f_bsize": st.f_bsize, "f_blocks": st.f_blocks}
            except OSError as exc:
                results[t] = {"ok": False, "errno": exc.errno}
        outside_leak = any(v["ok"] for k, v in results.items() if k not in {"/"})
        out({"status": "escaped" if outside_leak else "blocked", "statvfs": results})

    elif case == "rename_steal":
        # rename(2) of an outside file into the allowed work dir requires
        # write permission on the source's parent — it should fail.
        dst = work / "stolen_canary"
        try:
            os.rename(canary, dst)
        except OSError as exc:
            out({"status": "blocked", "errno": exc.errno, "error": str(exc)})
        out({"status": "escaped", "value": dst.read_text()})

    elif case == "reexec_canary":
        # process-exec allows re-running the interpreter itself.  Verify the
        # child inherits the same sandbox and still cannot read the canary.
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-S", "-c",
                 "import sys; print(open(sys.argv[1]).read())", canary],
                capture_output=True, text=True, timeout=3,
            )
        except OSError as exc:
            out({"status": "blocked", "stage": "spawn", "errno": exc.errno, "error": str(exc)})
        value = proc.stdout.strip()
        if value and "No such file" not in value and proc.returncode == 0 and value:
            out({"status": "escaped", "value": value})
        denied = 'Operation not permitted' in proc.stderr or 'Permission denied' in proc.stderr
        out({"status": "blocked" if denied else "error", "rc": proc.returncode, "stderr": proc.stderr.strip()[-200:]})

    elif case == "listdir_root":
        # (literal "/") is granted for the loader; check whether it also
        # exposes the top-level directory listing, and whether /Users or the
        # real home leak names.
        names = {}
        for t in ("/", "/Users", real_home):
            try:
                names[t] = sorted(os.listdir(t))[:10]
            except OSError as exc:
                names[t] = {"errno": exc.errno}
        leaked = {k: v for k, v in names.items() if isinstance(v, list)}
        out({"status": "escaped" if leaked else "blocked", "listings": names})

    elif case == "sysctl_hw_leak":
        # The hw.* / kern.boottime allowlist is needed by the runtime, but it
        # doubles as a host-fingerprinting channel.  Quantify what leaks.
        libc = ctypes.CDLL(None, use_errno=True)
        leaked = {}
        for name in (b"hw.model", b"hw.memsize", b"hw.machine",
                     b"kern.boottime", b"kern.hostname"):
            buf = ctypes.create_string_buffer(256)
            size = ctypes.c_size_t(256)
            rc = libc.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
            if rc == 0:
                leaked[name.decode()] = {"bytes_returned": size.value}
        out({"status": "escaped" if leaked else "blocked", "leaked_sysctls": leaked})

    else:
        out({"status": "error", "reason": "unknown case"})
except Exception as exc:
    out({"status": "error", "error": f"{type(exc).__name__}: {exc}"})
'''


CASES = [
    "hardlink_canary",
    "signal_victim", "signal_probe",
    "mach_lookup",
    "statfs_probe", "rename_steal",
    "reexec_canary", "listdir_root", "sysctl_hw_leak",
]


def classify(case: str, payload_status: str, victim_dead: bool | None) -> str:
    if case == "signal_victim" and victim_dead:
        return "escaped"
    if payload_status == "escaped":
        return "escaped"
    if payload_status == "delivered":          # signal_victim: check external truth
        return "escaped" if victim_dead else "error"
    if payload_status == "reachable":          # signal capability exists at all
        return "escaped"
    if payload_status == "blocked":
        return "blocked"
    return "error"


def run_breakout(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("This breakout suite requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")

    python = str(Path(sys.executable).resolve())
    ppid = str(os.getpid())
    real_home = str(Path("~").expanduser())
    profiles = {"BASELINE": baseline_profile, "HARDENED": hardened_profile}
    rows: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="halo-breakout-") as tmp:
        root = Path(tmp).resolve()
        work, outside = root / "work", root / "outside"
        work.mkdir()
        outside.mkdir()
        secret = "BREAKOUT-CANARY-" + secrets.token_hex(16)
        canary = outside / "canary.txt"
        canary.write_text(secret)

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}

        for profile_name, profile_fn in profiles.items():
            profile_text = profile_fn(work)
            for repeat in range(repeats):
                for case in CASES:
                    # Reset mutable fixtures before every profile/case/repeat.
                    for name in ("hl_canary", "stolen_canary"):
                        (work / name).unlink(missing_ok=True)
                    canary.write_text(secret)
                    victim_proc = None
                    victim_pid = "-1"
                    if case == "signal_victim":
                        victim_proc = subprocess.Popen(["/bin/sleep", "30"])
                        victim_pid = str(victim_proc.pid)
                    args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                            python, "-I", "-S", "-c", BREAKOUT_PAYLOAD,
                            case, str(work), str(canary), victim_pid, ppid, real_home]
                    start = time.perf_counter()
                    try:
                        proc = subprocess.run(
                            args, cwd=work, env=clean_env, capture_output=True,
                            text=True, close_fds=True, pass_fds=(),
                            preexec_fn=_apply_nproc_limit if profile_name == "HARDENED" else None,
                            timeout=5,
                        )
                        try:
                            result = json.loads(proc.stdout)
                        except json.JSONDecodeError:
                            result = {"status": "invalid_output",
                                      "stdout": proc.stdout[:200], "stderr": proc.stderr[:200]}
                    except subprocess.TimeoutExpired:
                        result = {"status": "timeout"}

                    # ---- external ground truth (observed from OUTSIDE) ----
                    victim_dead = None
                    if victim_proc is not None:
                        time.sleep(0.3)
                        victim_dead = victim_proc.poll() is not None
                        if victim_proc.poll() is None:
                            victim_proc.kill()
                        victim_proc.wait()

                    if case == "hardlink_canary":
                        leaked = work / "hl_canary"
                        if leaked.exists() and leaked.samefile(canary):
                            result = {"status": "escaped", "reason": "external hardlink observed"}
                        elif result.get("status") == "escaped":
                            result = {"status": "error", "reason": "external check failed"}
                    if case == "rename_steal":
                        if (work / "stolen_canary").exists() or not canary.exists():
                            result = {"status": "escaped", "reason": "external rename observed"}
                        elif result.get("status") == "escaped":
                            result = {"status": "error", "reason": "external check failed"}
                    if result.get("value") == secret:
                        result["value"] = "<synthetic-canary-matched>"

                    outcome = classify(case, result.get("status", "error"), victim_dead)
                    rows.append({"profile": profile_name, "repeat": repeat, "case": case,
                                 "outcome": outcome,
                                 "elapsed_ms": round((time.perf_counter() - start) * 1000, 3),
                                 "evidence": result})

    summary: dict[str, dict] = {}
    for profile_name in profiles:
        summary[profile_name] = {}
        for case in CASES:
            subset = [r for r in rows if r["profile"] == profile_name and r["case"] == case]
            summary[profile_name][case] = {
                "escaped": sum(r["outcome"] == "escaped" for r in subset),
                "blocked": sum(r["outcome"] == "blocked" for r in subset),
                "error": sum(r["outcome"] not in {"escaped", "blocked"} for r in subset),
                "total": len(subset),
            }

    return {"platform": platform.platform(), "python": sys.version, "repeats": repeats,
            "condition": ("BASELINE vs HARDENED, clean env, closed FDs; "
                          "HARDENED additionally gets RLIMIT_NPROC=1"),
            "summary": summary, "trials": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).with_name("breakout_results.json"))
    args = parser.parse_args()

    report = run_breakout(args.repeats)
    args.output.write_text(json.dumps(report, indent=2) + "\n")

    print("=== HALO Round-2 Breakout Suite: HARDENED under new vectors ===")
    for profile_name, cases in report["summary"].items():
        total_esc = sum(v["escaped"] for v in cases.values())
        total = sum(v["total"] for v in cases.values())
        print(f"\n[{profile_name}]  escaped={total_esc}/{total}")
        for case, counts in cases.items():
            tag = "x ESCAPED" if counts["escaped"] else ("? ERROR " if counts["error"] else ". blocked")
            print(f"  {tag}  {case}  (esc={counts['escaped']}, blk={counts['blocked']}, err={counts['error']})")
    return 0 if all(v["total"] > 0 and v["blocked"] == v["total"] for v in report["summary"]["HARDENED"].values()) and all(v["error"] == 0 for cases in report["summary"].values() for v in cases.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
