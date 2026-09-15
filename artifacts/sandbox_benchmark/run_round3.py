"""Round-3 breakout suite: new IPC / metadata / resource vectors.

Rounds 1 (run_exploits) and 2 (run_breakout) already covered process-info
sysctls, exec recon, fork bombs, Mach bootstrap lookup, statfs, hardlinks,
renames and signals. This suite targets surfaces those rounds did not touch:

1. dyld allowlist content read  (SystemVersion.plist over subpath /System/Library)
2. raw Mach host port           (mach_host_self + host_statistics)
3. sysctl name allowlist scan   (sensitive names NOT in the runtime allowlist)
4. UNIX-domain + INET sockets   (host daemon sockets without process-exec)
5. System V IPC                 (semget / shmget / msgget)
6. POSIX shared memory          (shm_open)
7. account identity             (getpwuid / getgrgid)
8. metadata boundary map        (exact file-read-metadata edge via stat only)
9. bounded memory allocation    (RLIMIT_AS resource gap)

All probes are read-only or disposable. The memory probe is capped at 1 GiB.
Success here means information disclosure or an open resource plane, not
arbitrary code execution.

Usage:
    .venv/bin/python artifacts/sandbox_benchmark/run_round3.py --repeats 5
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_exploits import baseline_profile, hardened_profile  # noqa: E402
from run_exploits import _apply_nproc_limit  # noqa: E402


def permissive_profile(work: Path) -> str:
    """Positive control: (allow default) grants every plane the probes test.

    BASELINE only ever opened the round-1/2 planes (sysctl, file, exec, fork);
    it denies network and IPC by default, so it is not a valid control for the
    new vectors. This profile proves each probe is sound in an unconfined
    process, which is what makes a HARDENED block meaningful.
    """
    return "(version 1)\n(allow default)\n"


# ---------------------------------------------------------------------------
# Sandboxed payload — each case is a previously untested escape vector
# ---------------------------------------------------------------------------
ROUND3_PAYLOAD = r'''
import ctypes, errno, json, os, pwd, grp, resource, socket, sys
from pathlib import Path

case, work_dir, real_home = sys.argv[1:]
work = Path(work_dir)


def out(payload):
    if payload.get('status') == 'blocked' and 'errno' in payload:
        if payload['errno'] not in (errno.EPERM, errno.EACCES):
            payload['status'] = 'error'
    print(json.dumps(payload))
    sys.exit(0)


try:
    if case == "system_version_read":
        # dyld allowlist grants (subpath "/System/Library") as file-read*.
        # Does that expose host OS build info as *content* without process-exec?
        results = {}
        for t in ("/System/Library/CoreServices/SystemVersion.plist",
                  "/System/Library/CoreServices/SystemVersionCompat.plist",
                  "/System/Library/CoreServices/SystemVersionCompat.plist.original",
                  "/System/Library/CoreServices/PlatformVersion.plist"):
            try:
                data = open(t, "rb").read()
                results[t] = {"ok": True, "bytes": len(data),
                              "snippet": data[:160].decode("utf-8", "replace")}
            except OSError as exc:
                results[t] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "files": results})

    elif case == "mach_host_statistics":
        # mach_host_self() returns the task's host port without bootstrap
        # lookup. host_statistics on it may leak memory/CPU stats even when
        # mach-lookup is denied by default.
        libm = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libm.mach_host_self.restype = ctypes.c_uint32
        libm.host_statistics.argtypes = [ctypes.c_uint32, ctypes.c_int,
                                         ctypes.c_void_p,
                                         ctypes.POINTER(ctypes.c_int)]
        libm.host_statistics.restype = ctypes.c_int
        host = libm.mach_host_self()
        if host == 0:
            out({"status": "blocked", "errno": errno.EPERM,
                 "reason": "mach_host_self returned MACH_PORT_NULL"})
        results = {"host_port": host}
        # HOST_BASIC_INFO = 3 (8 words), HOST_VM_INFO = 2 (13 words),
        # HOST_CPU_LOAD_INFO = 8 (3 words), HOST_PREFERRED_USER_ARCH = 9 (1 word)
        for label, flavor, maxw in (("basic_info", 3, 8),
                                    ("vm_info", 2, 16),
                                    ("cpu_load", 8, 4),
                                    ("preferred_arch", 9, 1)):
            buf = (ctypes.c_int * maxw)()
            count = ctypes.c_int(maxw)
            ctypes.set_errno(0)
            rc = libm.host_statistics(host, flavor, buf, ctypes.byref(count))
            results[label] = {"rc": rc, "count": count.value,
                              "errno": ctypes.get_errno(),
                              "words": list(buf[:count.value])}
        leaked = any(v.get("rc") == 0 for k, v in results.items() if k != "host_port")
        out({"status": "escaped" if leaked else "blocked", "host": results})

    elif case == "sysctl_allowlist_scan":
        # The hardened profile allowlists exactly hw.machine, kern.hostname,
        # kern.ostype, kern.osrelease, kern.version. Verify sensitive names
        # outside that set are denied and the set itself stays readable.
        libc = ctypes.CDLL(None, use_errno=True)
        allowlisted = {b"hw.machine", b"kern.hostname",
                       b"kern.ostype", b"kern.osrelease", b"kern.version"}
        results = {}
        for name in (b"hw.machine", b"kern.hostname", b"kern.ostype",
                     b"kern.osrelease", b"kern.version",
                     b"hw.ncpu", b"hw.memsize", b"hw.model", b"hw.cputype",
                     b"hw.byteorder", b"hw.cpufrequency",
                     b"machdep.cpu.brand_string", b"machdep.cpu.features",
                     b"kern.boottime", b"kern.maxfiles", b"kern.maxproc",
                     b"kern.osrevision", b"vm.swapusage",
                     b"kern.proc.pid", b"net.inet.ip.forwarding"):
            buf = ctypes.create_string_buffer(512)
            size = ctypes.c_size_t(512)
            ctypes.set_errno(0)
            rc = libc.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
            results[name.decode()] = {"rc": rc, "errno": ctypes.get_errno(),
                                      "bytes": size.value}
        unexpected = {k: v for k, v in results.items()
                      if v["rc"] == 0 and k.encode() not in allowlisted}
        missing = {k for k in allowlisted
                   if results.get(k.decode(), {}).get("rc") != 0}
        out({"status": "escaped" if unexpected else "blocked",
             "unexpected_readable": unexpected,
             "allowlisted_missing": sorted(x.decode() for x in missing),
             "sysctls": results})

    elif case == "unix_socket_probe":
        # No (allow network*) in the profile. Check whether UNIX-domain
        # sockets to host daemons or a loopback TCP connect still work.
        results = {}
        probes = (("unix_syslog", socket.AF_UNIX, "/var/run/syslog"),
                  ("unix_mdns", socket.AF_UNIX, "/var/run/mDNSResponder"),
                  ("unix_cups", socket.AF_UNIX, "/private/var/run/cupsd"),
                  ("inet_loopback", socket.AF_INET, ("127.0.0.1", 9)))
        for label, fam, target in probes:
            try:
                s = socket.socket(fam, socket.SOCK_STREAM)
                s.settimeout(1)
                s.connect(target)
                results[label] = {"ok": True, "errno": 0}
                s.close()
            except OSError as exc:
                results[label] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "sockets": results})

    elif case == "sysv_ipc_probe":
        # deny default does NOT gate System V IPC get operations: semget,
        # shmget and msgget all succeed under the hardened profile, while the
        # matching IPC_RMID ctl is denied (EPERM) — leaving kernel-persistent
        # objects the sandboxed process cannot clean up. The runner removes
        # the reported ids from outside the sandbox.
        libc = ctypes.CDLL(None, use_errno=True)
        libc.semget.restype = ctypes.c_int
        libc.shmget.restype = ctypes.c_int
        libc.msgget.restype = ctypes.c_int
        libc.semctl.restype = ctypes.c_int
        libc.shmctl.restype = ctypes.c_int
        libc.msgctl.restype = ctypes.c_int
        IPC_PRIVATE, IPC_CREAT, IPC_RMID = 0, 0o1000, 0
        results = {}
        created_ids = {"semget": None, "shmget": None, "msgget": None}
        for label, fn, ctl, args in (("semget", libc.semget, libc.semctl,
                                      (IPC_PRIVATE, 1, IPC_CREAT | 0o600)),
                                     ("shmget", libc.shmget, libc.shmctl,
                                      (IPC_PRIVATE, 4096, IPC_CREAT | 0o600)),
                                     ("msgget", libc.msgget, libc.msgctl,
                                      (IPC_PRIVATE, IPC_CREAT | 0o600))):
            ctypes.set_errno(0)
            ident = fn(*args)
            results[label] = {"id": ident, "create_errno": ctypes.get_errno()}
            if ident != -1:
                created_ids[label] = ident
                ctypes.set_errno(0)
                rm_rc = ctl(ident, 0, IPC_RMID)
                results[label].update({"rm_rc": rm_rc,
                                       "rm_errno": ctypes.get_errno()})
        leaked = {k: v for k, v in results.items() if v["id"] != -1}
        out({"status": "escaped" if leaked else "blocked", "ipc": results,
             "created_ids": created_ids})

    elif case == "posix_shm_probe":
        libc = ctypes.CDLL(None, use_errno=True)
        libc.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_uint]
        libc.shm_open.restype = ctypes.c_int
        libc.shm_unlink.argtypes = [ctypes.c_char_p]
        libc.shm_unlink.restype = ctypes.c_int
        name = ("/halo-round3-%d" % os.getpid()).encode()
        results = {}
        for label, flags in (("create", os.O_CREAT | os.O_RDWR),
                             ("open_existing", os.O_RDWR)):
            ctypes.set_errno(0)
            fd = libc.shm_open(name, flags, 0o600)
            results[label] = {"fd": fd, "errno": ctypes.get_errno()}
            if fd != -1:
                os.close(fd)
        libc.shm_unlink(name)
        leaked = {k: v for k, v in results.items() if v["fd"] != -1}
        out({"status": "escaped" if leaked else "blocked", "shm": results})

    elif case == "identity_probe":
        # getpwuid/getgrgid reach account directories without exec'ing a
        # binary; the profile neither reads /etc/passwd nor grants Mach
        # lookup, so an identity answer is a boundary leak.
        results = {}
        for label, fn in (("getpwuid", lambda: pwd.getpwuid(os.getuid())),
                          ("getgrgid", lambda: grp.getgrgid(os.getgid()))):
            try:
                rec = fn()
                results[label] = {"ok": True,
                                  "name": getattr(rec, "pw_name", None) or getattr(rec, "gr_name", None),
                                  "home": getattr(rec, "pw_dir", None)}
            except (KeyError, OSError) as exc:
                # uid/gid not resolvable = Directory Services unreachable, which
                # the profile denies; classify as blocked, not a probe error.
                results[label] = {"ok": False, "blocked": True, "error": str(exc)}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        if leaked:
            out({"status": "escaped", "identity": leaked})
        if all(v.get("blocked") for v in results.values()):
            out({"status": "blocked", "identity": results})
        out({"status": "error", "identity": results})

    elif case == "metadata_boundary_map":
        # stat() only — map the exact file-read-metadata edge without reading
        # any content. Confirms which real host paths the allowlist exposes.
        results = {}
        for t in ("/", "/System/Library", "/usr/lib", "/usr/share",
                  "/System/Library/CoreServices/SystemVersion.plist",
                  "/etc/passwd", "/private/etc", "/opt/homebrew/etc",
                  os.path.join(real_home, ".zsh_history"),
                  os.path.join(real_home, ".ssh", "id_rsa")):
            try:
                st = os.stat(t)
                results[t] = {"ok": True, "size": st.st_size,
                              "uid": st.st_uid, "mtime": int(st.st_mtime)}
            except OSError as exc:
                results[t] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "metadata": leaked})

    elif case == "memory_exhaust_bounded":
        # Resource gap: RLIMIT_NPROC=1 blocks forks, but is there an address
        # space cap? Bounded probe, never touches swap limits destructively.
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        allocated = 0
        chunks = []
        try:
            while allocated < 1 << 30:  # 1 GiB cap
                chunk = bytearray(64 * 1024 * 1024)
                chunks.append(chunk)
                allocated += len(chunk)
        except (MemoryError, OverflowError):
            pass
        out({"status": "escaped" if allocated >= (1 << 28) else "blocked",
             "rlimit_as": {"soft": soft, "hard": hard},
             "allocated_bytes": allocated})

    else:
        out({"status": "error", "reason": "unknown case"})
except Exception as exc:
    out({"status": "error", "error": f"{type(exc).__name__}: {exc}"})
'''


CASES = [
    "system_version_read",
    "mach_host_statistics",
    "sysctl_allowlist_scan",
    "unix_socket_probe",
    "sysv_ipc_probe",
    "posix_shm_probe",
    "identity_probe",
    "metadata_boundary_map",
    "memory_exhaust_bounded",
]


def run_round3(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("This breakout suite requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")

    python = str(Path(sys.executable).resolve())
    real_home = str(Path("~").expanduser())
    profiles = {"PERMISSIVE": permissive_profile,
                "BASELINE": baseline_profile,
                "HARDENED": hardened_profile}
    rows: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="halo-round3-") as tmp:
        work = Path(tmp).resolve() / "work"
        work.mkdir()

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}

        for profile_name, profile_fn in profiles.items():
            profile_text = profile_fn(work)
            for repeat in range(repeats):
                for case in CASES:
                    args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                            python, "-I", "-S", "-c", ROUND3_PAYLOAD,
                            case, str(work), real_home]
                    start = time.perf_counter()
                    try:
                        proc = subprocess.run(
                            args, cwd=work, env=clean_env, capture_output=True,
                            text=True, close_fds=True, pass_fds=(),
                            preexec_fn=_apply_nproc_limit if profile_name == "HARDENED" else None,
                            timeout=10,
                        )
                        if proc.returncode != 0:
                            result: dict = {"status": "launch_error",
                                            "returncode": proc.returncode,
                                            "stderr": proc.stderr[:200]}
                        else:
                            try:
                                result = json.loads(proc.stdout)
                            except json.JSONDecodeError:
                                result = {"status": "invalid_output",
                                          "stdout": proc.stdout[:200],
                                          "stderr": proc.stderr[:200]}
                    except subprocess.TimeoutExpired:
                        result = {"status": "timeout"}

                    elapsed = (time.perf_counter() - start) * 1000
                    outcome = result.get("status", "error")
                    if outcome not in {"escaped", "blocked"}:
                        outcome = "error"
                    # System V objects created by a sandboxed child survive it
                    # (IPC_RMID is EPERM inside); the unconfined runner removes
                    # them so no kernel-persistent objects are left behind.
                    if case == "sysv_ipc_probe":
                        created = (result.get("created_ids") or {}).values()
                        for ident in created:
                            if isinstance(ident, int) and ident != -1:
                                for flag in ("-q", "-m", "-s"):
                                    subprocess.run(["ipcrm", flag, str(ident)],
                                                   capture_output=True)
                    rows.append({"profile": profile_name, "repeat": repeat,
                                 "case": case, "outcome": outcome,
                                 "elapsed_ms": round(elapsed, 3),
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

    return {"platform": platform.platform(), "python": sys.version,
            "repeats": repeats,
            "condition": ("BASELINE vs HARDENED, clean env, closed FDs; "
                          "HARDENED additionally gets RLIMIT_NPROC=1"),
            "summary": summary, "trials": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).with_name("round3_results.json"))
    args = parser.parse_args()

    report = run_round3(args.repeats)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")

    print("=== HALO Round-3 Breakout Suite: BASELINE vs HARDENED ===")
    for profile_name, cases in report["summary"].items():
        total_esc = sum(v["escaped"] for v in cases.values())
        total = sum(v["total"] for v in cases.values())
        print(f"\n[{profile_name}]  escaped={total_esc}/{total}")
        for case, counts in cases.items():
            tag = "x ESCAPED" if counts["escaped"] else (". blocked" if counts["blocked"] == counts["total"] and counts["total"] else "? ERROR")
            print(f"  {tag:12s}  {case}  (esc={counts['escaped']}, blk={counts['blocked']}, err={counts['error']})")
    # Exit 1 whenever HARDENED still leaks (round 3 deliberately probes
    # residual runtime allowlists, so this is a detection, not a bug).
    hardened_leaks = any(v["escaped"] > 0 for v in report["summary"]["HARDENED"].values())
    return 1 if hardened_leaks else 0


if __name__ == "__main__":
    raise SystemExit(main())