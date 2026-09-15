"""Round-3 "madness" breakout suite — vectors the round-1/round-2 suites never
covered. Targets the HARDENED profile via whole kernel subsystems that
sandbox-exec's rule classes do not mediate, rather than via path grants.

All targets are disposable canaries or read-only host-metadata probes. This
suite never reads host credentials, keychains, or user files.

Usage:
    .venv/bin/python artifacts/sandbox_benchmark/run_madness.py --repeats 5
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_exploits import baseline_profile, hardened_profile  # noqa: E402
from run_exploits import _apply_nproc_limit  # noqa: E402


# ---------------------------------------------------------------------------
# Payload — runs inside the sandbox
# ---------------------------------------------------------------------------
MADNESS_PAYLOAD = r'''
import ctypes, errno, json, os, sys
from pathlib import Path

case, work_dir, ppid = sys.argv[1:]
work = Path(work_dir)

def out(p):
    print(json.dumps(p))
    sys.exit(0)

def is_denied(exc):
    return isinstance(exc, OSError) and exc.errno in (errno.EPERM, errno.EACCES)

try:
    if case == "ioregistry_enum":
        # IORegistry is hosted by IOKit, not mediated by file-* or mach-* rules.
        # Count the full host service/device tree from inside the sandbox.
        iokit = ctypes.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
        iokit.IOServiceGetMatchingServices.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        iokit.IOServiceGetMatchingServices.restype = ctypes.c_int
        iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
        iokit.IOServiceMatching.restype = ctypes.c_void_p
        iokit.IOIteratorNext.argtypes = [ctypes.c_uint32]
        iokit.IOIteratorNext.restype = ctypes.c_uint32
        counts = {}
        for cls in ("IOService", "IONetworkInterface", "IOBlockStorageDriver", "IOPlatformExpertDevice"):
            d = iokit.IOServiceMatching(cls.encode())
            it = ctypes.c_uint32(0)
            rc = iokit.IOServiceGetMatchingServices(0, d, ctypes.byref(it))
            if rc != 0:
                counts[cls] = {"rc": rc}
                continue
            n = 0
            while iokit.IOIteratorNext(it):
                n += 1
            counts[cls] = n
        out({"status": "escaped" if counts.get("IOService", 0) > 0 else "blocked", "io_count": counts})

    elif case == "hw_machine":
        # sysctl CTL_HW/HW_MACHINE: CPU architecture fingerprint. Already
        # observed to leave the sandbox; record it as residual host exposure.
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 2)(6, 1)  # CTL_HW, HW_MACHINE
        buf = ctypes.create_string_buffer(256)
        size = ctypes.c_size_t(256)
        rc = libc.sysctl(mib, 2, buf, ctypes.byref(size), None, 0)
        if rc != 0:
            out({"status": "blocked" if ctypes.get_errno() in (errno.EPERM, errno.EACCES) else "error",
                 "errno": ctypes.get_errno()})
        out({"status": "escaped", "hw_machine": buf.value.decode()})

    elif case == "hw_model":
        # hw.model / hw.product: expose the specific Mac model string.
        libc = ctypes.CDLL(None, use_errno=True)
        leaked = {}
        for name in (b"hw.model", b"hw.product"):
            buf = ctypes.create_string_buffer(256)
            size = ctypes.c_size_t(256)
            rc = libc.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
            if rc == 0:
                leaked[name.decode()] = buf.value.decode()
        out({"status": "escaped" if leaked else "blocked", "leaked": leaked})

    elif case == "kern_osversion":
        # Build number / OS product version, distinct from the documented
        # kern.version exemption, to close the loop on host fingerprinting.
        libc = ctypes.CDLL(None, use_errno=True)
        leaked = {}
        for name in (b"kern.osproductversion", b"kern.osversion"):
            buf = ctypes.create_string_buffer(256)
            size = ctypes.c_size_t(256)
            rc = libc.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
            if rc == 0:
                leaked[name.decode()] = buf.value.decode()
        out({"status": "escaped" if leaked else "blocked", "leaked": leaked})

    elif case == "task_port":
        # task_for_pid on the parent: taskgated-mediated, not sandbox-mediated.
        # Record whether the raw trait is gated by the sandbox at all.
        ls = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        ls.task_for_pid.restype = ctypes.c_int
        ls.task_for_pid.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
        self_ = ls.mach_task_self()
        port = ctypes.c_uint32(0)
        rc = ls.task_for_pid(self_, int(ppid), ctypes.byref(port))
        # rc==5 KERN_FAILURE = taskgated denial (not sandbox). Report honestly.
        out({"status": "blocked", "note": "taskgated" if rc == 5 else "other", "rc": rc} if rc != 0 else {"status": "escaped", "port": port.value})

    elif case == "statfs_host":
        # statfs/statvfs on host paths is a kernel metadata call that bypasses
        # file-read-metadata scoping. Already known; record as residual.
        results = {}
        for t in ("/", "/System/Volumes/Data"):
            try:
                st = os.statvfs(t)
                results[t] = {"f_blocks": st.f_blocks, "f_frsize": st.f_frsize}
            except OSError as exc:
                results[t] = {"errno": exc.errno}
        out({"status": "escaped" if any(isinstance(v, dict) and "f_blocks" in v for v in results.values()) else "blocked",
             "statvfs": results})

    else:
        out({"status": "error", "reason": "unknown case"})

except Exception as exc:
    if is_denied(exc):
        out({"status": "blocked", "error": str(exc)})
    out({"status": "error", "error": f"{type(exc).__name__}: {exc}"})
'''

CASES = [
    "ioregistry_enum",
    "hw_machine",
    "hw_model",
    "kern_osversion",
    "task_port",
    "statfs_host",
]


def run_madness(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("Requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")

    python = str(Path(sys.executable).resolve())
    ppid = str(os.getpid())
    profiles = {"BASELINE": baseline_profile, "HARDENED": hardened_profile}
    rows: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="halo-madness-") as tmp:
        root = Path(tmp).resolve()
        work, outside = root / "work", root / "outside"
        work.mkdir()
        outside.mkdir()
        (outside / "canary.txt").write_text("MADNESS-CANARY")

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}

        for profile_name, profile_fn in profiles.items():
            profile_text = profile_fn(work)
            for repeat in range(repeats):
                for case in CASES:
                    args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                            python, "-I", "-S", "-c", MADNESS_PAYLOAD,
                            case, str(work), ppid]
                    start = time.perf_counter()
                    try:
                        proc = subprocess.run(
                            args, cwd=work, env=clean_env, capture_output=True,
                            text=True, close_fds=True, pass_fds=(),
                            preexec_fn=_apply_nproc_limit if profile_name == "HARDENED" else None,
                            timeout=5,
                        )
                        if proc.returncode != 0:
                            result = {"status": "launch_error", "returncode": proc.returncode,
                                      "stderr": proc.stderr[:200]}
                        else:
                            try:
                                result = json.loads(proc.stdout)
                            except Exception:
                                result = {"status": "invalid_output", "raw": proc.stdout[:200]}
                    except subprocess.TimeoutExpired:
                        result = {"status": "timeout"}

                    rows.append({"profile": profile_name, "repeat": repeat, "case": case,
                                 "outcome": result.get("status", "error"),
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
            "condition": "BASELINE vs HARDENED, clean env, closed FDs; HARDENED + RLIMIT_NPROC=1",
            "summary": summary, "trials": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).with_name("madness_results.json"))
    args = parser.parse_args()

    report = run_madness(args.repeats)
    args.output.write_text(json.dumps(report, indent=2) + "\n")

    print("=== HALO Round-3 Madness Breakout: BASELINE vs HARDENED ===")
    for profile_name, cases in report["summary"].items():
        total_esc = sum(v["escaped"] for v in cases.values())
        total = sum(v["total"] for v in cases.values())
        print(f"\n[{profile_name}]  escaped={total_esc}/{total}")
        for case, counts in cases.items():
            tag = "x ESCAPED" if counts["escaped"] else ("? ERROR" if counts["error"] else ". blocked")
            print(f"  {tag}  {case}  (esc={counts['escaped']}, blk={counts['blocked']}, err={counts['error']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())