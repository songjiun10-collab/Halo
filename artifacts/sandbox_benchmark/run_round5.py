"""Round-5 breakout suite: name-matching bypasses and unmediated planes.

Round-1..4 covered file/exe/sysctl-name/mach/ipc/net planes. This round attacks
specific structural gaps:

 1. sysctl MIB(OID)-based reads            — allowlist matches by NAME string; a
                                            direct sysctl(2) with numeric OIDs may
                                            skip the name check entirely.
 2. getifaddrs / AF_ROUTE                  — host network interface enumeration
                                            (names, IPs, flags) outside the
                                            network-socket allowlist.
 3. POSIX sem_open / sem_trywait           — named semaphore plane (shm was tested,
                                            sem was not).
 4. getattrlist with common attrs          — on real-home paths (volattr on "/"
                                            already leaked in round 4).
 5. fsgetpath                              — vnode -> canonical path helper.
 6. Mach host extras                       — host_page_size / host_get_boot_info /
                                            host_get_clock_service.

All read-only, disposable names, no host writes.
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
from run_exploits import hardened_profile  # noqa: E402
from run_exploits import _apply_nproc_limit  # noqa: E402


def permissive_profile(work: Path) -> str:
    return "(version 1)\n(allow default)\n"


ROUND5_PAYLOAD = r'''
import ctypes, errno, json, os, socket, sys
from pathlib import Path

case, work_dir, real_home = sys.argv[1:]
work = Path(work_dir)


def out(payload):
    print(json.dumps(payload))
    sys.exit(0)


def deny_code(exc):
    return isinstance(exc, OSError) and exc.errno in (errno.EPERM, errno.EACCES)


try:
    if case == "sysctl_mib_bypass":
        # Numeric-OID sysctl reads for names the profile does NOT allowlist.
        # If name-matching is the only gate, these should all return EPERM;
        # if the sandbox resolves OID->name differently, some may leak.
        lib = ctypes.CDLL(None, use_errno=True)
        lib.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                               ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                               ctypes.c_void_p, ctypes.c_size_t]
        lib.sysctl.restype = ctypes.c_int
        targets = {
            "hw.model": (6, 2),
            "hw.memsize": (6, 24),
            "hw.ncpu": (6, 3),
            "hw.logicalcpu": (6, 25),
            "hw.physicalcpu": (6, 26),
            "kern.boottime": (1, 21),
            "kern.maxproc": (1, 38),
            "kern.proc": (1, 25),
            "vm.swapusage": (2, 5),
            "machdep.cpu.brand_string": (7, 1, 3),
            "kern.osproductversion": (1, 89),
        }
        results = {}
        for label, mib_tuple in targets.items():
            mib = (ctypes.c_int * len(mib_tuple))(*mib_tuple)
            buf = ctypes.create_string_buffer(4096)
            size = ctypes.c_size_t(4096)
            ctypes.set_errno(0)
            rc = lib.sysctl(mib, len(mib_tuple), buf, ctypes.byref(size), None, 0)
            value = None
            if rc == 0:
                if mib_tuple[-1] in (24, 3, 25, 26, 38):  # integer sizes
                    value = int.from_bytes(buf.raw[:8], "little")
                else:
                    value = buf.value.decode("utf-8", "replace")
            results[label] = {"rc": rc, "errno": ctypes.get_errno(), "value": value}
        leaked = {k: v for k, v in results.items() if v["rc"] == 0}
        out({"status": "escaped" if leaked else "blocked", "mib_reads": results})

    elif case == "getifaddrs":
        # Host network interface table (names, families, IPv4 addrs, flags).
        lib = ctypes.CDLL(None, use_errno=True)

        class Sockaddr(ctypes.Structure):
            _fields_ = [("sa_len", ctypes.c_ubyte), ("sa_family", ctypes.c_ubyte),
                        ("sa_data", ctypes.c_char * 14)]

        class Ifaddrs(ctypes.Structure):
            pass

        Ifaddrs._fields_ = [
            ("ifa_next", ctypes.POINTER(Ifaddrs)),
            ("ifa_name", ctypes.c_char_p),
            ("ifa_flags", ctypes.c_uint),
            ("ifa_addr", ctypes.POINTER(Sockaddr)),
            ("ifa_netmask", ctypes.POINTER(Sockaddr)),
            ("ifa_dstaddr", ctypes.POINTER(Sockaddr)),
            ("ifa_data", ctypes.c_void_p),
        ]
        lib.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(Ifaddrs))]
        lib.getifaddrs.restype = ctypes.c_int
        lib.freeifaddrs.argtypes = [ctypes.POINTER(Ifaddrs)]
        head = ctypes.POINTER(Ifaddrs)()
        ctypes.set_errno(0)
        if lib.getifaddrs(ctypes.byref(head)) != 0:
            out({"status": "blocked", "errno": ctypes.get_errno()})
        ifaces = {}
        cur = head
        while cur:
            i = cur.contents
            name = i.ifa_name.decode("utf-8", "replace") if i.ifa_name else "?"
            entry = ifaces.setdefault(name, {"flags": i.ifa_flags, "addrs": []})
            if i.ifa_addr:
                fam = i.ifa_addr.contents.sa_family
                entry["addrs"].append(fam)
            cur = i.ifa_next
        lib.freeifaddrs(head)
        leaked = {k: v for k, v in ifaces.items()
                  if any(a == socket.AF_INET for a in v["addrs"])}
        out({"status": "escaped" if leaked else "blocked",
             "interfaces": leaked, "all_names": list(ifaces)})

    elif case == "route_socket":
        # Raw PF_ROUTE socket: can we enumerate the routing table ourselves?
        results = {}
        for fam in (socket.AF_ROUTE, socket.AF_LINK):
            try:
                s = socket.socket(fam, socket.SOCK_RAW)
                results[fam] = {"ok": True, "errno": 0}
                s.close()
            except OSError as exc:
                results[fam] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "route": results})

    elif case == "sem_open":
        lib = ctypes.CDLL(None, use_errno=True)
        lib.sem_open.argtypes = [ctypes.c_char_p, ctypes.c_int,
                                 ctypes.c_uint, ctypes.c_uint]
        lib.sem_open.restype = ctypes.c_void_p
        lib.sem_close.argtypes = [ctypes.c_void_p]
        lib.sem_close.restype = ctypes.c_int
        lib.sem_unlink.argtypes = [ctypes.c_char_p]
        lib.sem_unlink.restype = ctypes.c_int
        name = ("/halo-r5-%d" % os.getpid()).encode()
        results = {}
        ctypes.set_errno(0)
        s = lib.sem_open(name, os.O_CREAT | os.O_RDWR, 0o600, 1)
        create_errno = ctypes.get_errno()
        # Darwin SEM_FAILED is (sem_t *)-1, a truthy pointer in ctypes.
        created = s is not None and s != ctypes.c_void_p(-1).value
        results["create"] = {"fd": created, "errno": create_errno}
        if created:
            ctypes.set_errno(0)
            results["close_rc"] = lib.sem_close(s)
            ctypes.set_errno(0)
            results["unlink_rc"] = lib.sem_unlink(name)
            results["unlink"] = ctypes.get_errno()
        status = "escaped" if created else (
            "blocked" if create_errno in (errno.EPERM, errno.EACCES) else "error")
        out({"status": status, "sem": results})

    elif case == "getattrlist_home":
        lib = ctypes.CDLL(None, use_errno=True)
        ATTR_BITMAP_COUNT = 5
        ATTR_CMN_NAME = 0x00000001
        ATTR_CMN_MODTIME = 0x00000040
        ATTR_CMN_CRTIME = 0x00000200

        class AttrList(ctypes.Structure):
            _fields_ = [("bitmapcount", ctypes.c_uint16),
                        ("reserved", ctypes.c_uint16),
                        ("commonattr", ctypes.c_uint32),
                        ("volattr", ctypes.c_uint32),
                        ("dirattr", ctypes.c_uint32),
                        ("fileattr", ctypes.c_uint32),
                        ("forkattr", ctypes.c_uint32)]

        lib.getattrlist.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                    ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong]
        lib.getattrlist.restype = ctypes.c_int
        results = {}
        for t in (real_home,
                  os.path.join(real_home, ".zsh_history"),
                  os.path.join(real_home, "Library"),
                  "/System/Volumes/Data",
                  "/System/Volumes/Data/Users",
                  "/etc/passwd"):
            al = AttrList(ATTR_BITMAP_COUNT, 0, ATTR_CMN_NAME | ATTR_CMN_MODTIME,
                          0, 0, 0, 0)
            buf = ctypes.create_string_buffer(4096)
            ctypes.set_errno(0)
            rc = lib.getattrlist(t.encode(), ctypes.byref(al), buf, 4096, 0)
            results[t] = {"rc": rc, "errno": ctypes.get_errno()}
        leaked = {k: v for k, v in results.items() if v["rc"] == 0}
        out({"status": "escaped" if leaked else "blocked", "attr": results})

    elif case == "opendir_home":
        # Verify exactly how deep host directory listing goes without content read.
        results = {}
        for t in ("/Users", real_home,
                  os.path.join(real_home, "Library"),
                  "/System/Volumes/Data/Users"):
            try:
                names = os.listdir(t)
                results[t] = {"ok": True, "count": len(names),
                              "sample": names[:6]}
            except OSError as exc:
                results[t] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "dirs": leaked})

    elif case == "fsgetpath":
        # The previous probe passed an FD where Darwin requires an fsid_t
        # and object ID. Its failures never established policy denial.
        out({"status": "unsupported", "reason":
             "fsgetpath requires a validated filesystem ID and object ID fixture"})

    elif case == "mach_host_extras":
        libm = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libm.mach_host_self.restype = ctypes.c_uint32
        libm.host_page_size.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
        libm.host_page_size.restype = ctypes.c_int
        libm.host_get_boot_info.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        libm.host_get_boot_info.restype = ctypes.c_int
        host = libm.mach_host_self()
        results = {"host": host}
        ps = ctypes.c_uint32(0)
        ctypes.set_errno(0)
        r1 = libm.host_page_size(host, ctypes.byref(ps))
        results["page_size"] = {"rc": r1, "pagesize": ps.value,
                                "errno": ctypes.get_errno()}
        boot = ctypes.create_string_buffer(4096)
        ctypes.set_errno(0)
        r2 = libm.host_get_boot_info(host, boot)
        results["boot_info"] = {"rc": r2,
                                "value": boot.value.decode("utf-8", "replace"),
                                "errno": ctypes.get_errno()}
        leaked = (r1 == 0) or (r2 == 0)
        out({"status": "escaped" if leaked else "blocked", "host": results})

    else:
        out({"status": "error", "reason": "unknown case"})
except Exception as exc:
    out({"status": "blocked" if deny_code(exc) else "error",
         "error": f"{type(exc).__name__}: {exc}"})
'''


CASES = [
    "sysctl_mib_bypass",
    "getifaddrs",
    "route_socket",
    "sem_open",
    "getattrlist_home",
    "opendir_home",
    "fsgetpath",
    "mach_host_extras",
]


def run_round5(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("This breakout suite requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")

    python = str(Path(sys.executable).resolve())
    real_home = str(Path("~").expanduser())
    profiles = {"PERMISSIVE": permissive_profile, "HARDENED": hardened_profile}
    rows: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="halo-round5-") as tmp:
        root = Path(tmp).resolve()
        work = root / "work"
        work.mkdir()

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}

        for profile_name, profile_fn in profiles.items():
            profile_text = profile_fn(work)
            for repeat in range(repeats):
                for case in CASES:
                    args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                            python, "-I", "-S", "-c", ROUND5_PAYLOAD,
                            case, str(work), real_home]
                    start = time.perf_counter()
                    try:
                        proc = subprocess.run(
                            args, cwd=work, env=clean_env, capture_output=True,
                            text=True, close_fds=True, pass_fds=(),
                            preexec_fn=_apply_nproc_limit if profile_name == "HARDENED" else None,
                            timeout=8,
                        )
                        try:
                            result = json.loads(proc.stdout)
                            if not isinstance(result, dict):
                                result = {"status": "invalid_output"}
                        except json.JSONDecodeError:
                            result = {"status": "invalid_output",
                                      "stdout": proc.stdout[:200],
                                      "stderr": proc.stderr[:200]}
                        if proc.returncode != 0:
                            result = {"status": "launch_error",
                                      "returncode": proc.returncode,
                                      "stderr": proc.stderr[:200]}
                    except subprocess.TimeoutExpired:
                        result = {"status": "timeout"}

                    outcome = result.get("status", "error")
                    if outcome not in {"escaped", "blocked", "unsupported"}:
                        outcome = "error"
                    rows.append({"profile": profile_name, "repeat": repeat,
                                 "case": case, "outcome": outcome,
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
                "error": sum(r["outcome"] == "error" for r in subset),
                "unsupported": sum(r["outcome"] == "unsupported" for r in subset),
                "total": len(subset),
            }

    return {"platform": platform.platform(), "python": sys.version,
            "repeats": repeats,
            "condition": "PERMISSIVE vs HARDENED, clean env, closed FDs; HARDENED + RLIMIT_NPROC=1",
            "summary": summary, "trials": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).with_name("round5_results.json"))
    args = parser.parse_args()

    report = run_round5(args.repeats)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")

    print("=== HALO Round-5 Breakout Suite: HARDENED under new planes ===")
    for profile_name, cases in report["summary"].items():
        total_esc = sum(v["escaped"] for v in cases.values())
        total = sum(v["total"] for v in cases.values())
        print(f"\n[{profile_name}]  escaped={total_esc}/{total}")
        for case, counts in cases.items():
            tag = "x ESCAPED" if counts["escaped"] else (". blocked" if counts["blocked"] == counts["total"] and counts["total"] else "? ERROR")
            if counts["unsupported"]:
                tag = "? UNSUPPORTED"
            print(f"  {tag:12s}  {case}  (esc={counts['escaped']}, blk={counts['blocked']}, err={counts['error']}, unsupported={counts['unsupported']})")
    return 0 if all(r["outcome"] == "blocked" for r in report["trials"]
                    if r["profile"] == "HARDENED") else 1


if __name__ == "__main__":
    raise SystemExit(main())
