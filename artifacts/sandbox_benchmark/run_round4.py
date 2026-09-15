"""Round-4 breakout suite: planes the round-1/2/3 suites never touched.

Targets the HARDENED profile with fresh kernel-surface probes:
 1. libproc process enumeration     (proc_listpids / proc_pidpath / proc_pidinfo)
 2. getfsstat full mount table      (all mounted volumes at once)
 3. access()/F_OK file-existence oracle
 4. deeper hw.* / machdep.cpu.* / vm.* sysctl name scan
 5. UDP network plane               (SOCK_DGRAM bind/connect/sendto)
 6. /System/Library/LaunchDaemons content read (subpath grant reuse)
 7. /usr/share content read         (zoneinfo / man data)
 8. mach host_processor_info        (processor set topology)
 9. listxattr / getxattr on root + system files
10. getvfsstat + pathconf variants

All probes are read-only or use disposable canaries. No host writes.
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


ROUND4_PAYLOAD = r'''
import ctypes, errno, json, os, socket, struct, sys
from pathlib import Path

case, work_dir, canary, real_home = sys.argv[1:]
work = Path(work_dir)


def out(payload):
    print(json.dumps(payload))
    sys.exit(0)


def deny_code(exc):
    return isinstance(exc, OSError) and exc.errno in (errno.EPERM, errno.EACCES)


try:
    if case == "proc_listpids":
        # libproc proc_info(2) is a different gate than sysctl KERN_PROC;
        # `deny process-info*` blocks the sysctl plane, not necessarily this one.
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        PROC_ALL_PIDS = 1
        lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32,
                                      ctypes.c_void_p, ctypes.c_int]
        lib.proc_listpids.restype = ctypes.c_int
        buf = (ctypes.c_int * 8192)()
        ctypes.set_errno(0)
        n = lib.proc_listpids(PROC_ALL_PIDS, 0, ctypes.byref(buf), ctypes.sizeof(buf))
        pids = list(dict.fromkeys(sorted(buf[i] for i in range(max(0, n)) if buf[i] > 0)))
        if n > 0:
            out({"status": "escaped", "pid_count": len(pids),
                 "sample_pids": pids[:25], "proc_info_errno": ctypes.get_errno()})
        out({"status": "blocked", "n": n, "errno": ctypes.get_errno()})

    elif case == "proc_pidpath":
        # Resolve the parent and every PID we just saw to a full binary path.
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        PROC_ALL_PIDS = 1
        lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32,
                                      ctypes.c_void_p, ctypes.c_int]
        lib.proc_listpids.restype = ctypes.c_int
        lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        lib.proc_pidpath.restype = ctypes.c_int
        buf = (ctypes.c_int * 8192)()
        n = lib.proc_listpids(PROC_ALL_PIDS, 0, ctypes.byref(buf), ctypes.sizeof(buf))
        pids = sorted({buf[i] for i in range(max(0, n)) if buf[i] > 0})[:40]
        paths = {}
        for pid in pids:
            pbuf = ctypes.create_string_buffer(4096)
            r = lib.proc_pidpath(pid, pbuf, 4096)
            if r > 0:
                paths[str(pid)] = pbuf.value.decode("utf-8", "replace")
        out({"status": "escaped" if paths else "blocked", "proc_paths": paths})

    elif case == "proc_pidinfo_parent":
        # PROC_PIDTASKINFO on the parent: start time, vmem, cpu time.
        lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        PROC_PIDTASKINFO = 4
        lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                     ctypes.c_void_p, ctypes.c_int]
        lib.proc_pidinfo.restype = ctypes.c_int
        import struct as _s
        # proc_taskinfo layout: first word pti_flags
        rec = (ctypes.c_int64 * 32)()
        r = lib.proc_pidinfo(int(os.getppid()), PROC_PIDTASKINFO, 0,
                             ctypes.byref(rec), ctypes.sizeof(rec))
        out({"status": "escaped" if r > 0 else "blocked",
             "parent_taskinfo_bytes": r, "first_words": list(rec[:4])})

    elif case == "getfsstat_full":
        # statfs already leaks single volumes; getfsstat dumps the whole table
        # with mount point + source device for every host volume.
        class Statfs(ctypes.Structure):
            _fields_ = [
                ("f_bsize", ctypes.c_uint32), ("f_iosize", ctypes.c_int32),
                ("f_blocks", ctypes.c_uint64), ("f_bfree", ctypes.c_uint64),
                ("f_bavail", ctypes.c_uint64), ("f_files", ctypes.c_uint64),
                ("f_ffree", ctypes.c_uint64), ("f_fsid", ctypes.c_int64),
                ("f_owner", ctypes.c_uint32), ("f_type", ctypes.c_uint32),
                ("f_flags", ctypes.c_uint32), ("f_fssubtype", ctypes.c_uint32),
                ("f_fstypename", ctypes.c_char * 16),
                ("f_mntonname", ctypes.c_char * 1024),
                ("f_mntfromname", ctypes.c_char * 1024),
                ("f_flags_ext", ctypes.c_uint32),
                ("f_reserved", ctypes.c_uint32 * 7),
            ]
        lib = ctypes.CDLL(None, use_errno=True)
        MNT_NOWAIT = 2
        lib.getfsstat.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        lib.getfsstat.restype = ctypes.c_int
        n = lib.getfsstat(None, 0, MNT_NOWAIT)
        if n <= 0:
            out({"status": "blocked", "count": n, "errno": ctypes.get_errno()})
        bufs = (Statfs * n)()
        got = lib.getfsstat(bufs, ctypes.sizeof(bufs), MNT_NOWAIT)
        mounts = []
        for i in range(got):
            st = bufs[i]
            mounts.append({
                "on": st.f_mntonname.decode("utf-8", "replace"),
                "from": st.f_mntfromname.decode("utf-8", "replace"),
                "fs": st.f_fstypename.decode("utf-8", "replace"),
            })
        out({"status": "escaped" if mounts else "blocked",
             "mount_count": len(mounts), "mounts": mounts})

    elif case == "access_oracle":
        # access(2)/F_OK as a file-existence oracle outside the read allowlist.
        targets = [canary,
                   os.path.join(real_home, ".ssh", "id_rsa"),
                   os.path.join(real_home, ".zsh_history"),
                   "/etc/passwd", "/etc/master.passwd",
                   "/var/db/dyld/dyld_shared_cache_arm64e",
                   "/System/Library/CoreServices/SystemVersion.plist",
                   "/usr/share/zoneinfo/America/New_York",
                   "/dev/disk0", "/dev/tty"]
        results = {}
        for t in targets:
            try:
                results[t] = {"ok": os.access(t, os.F_OK)}
            except OSError as exc:
                results[t] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "access": results})

    elif case == "sysctl_deep_scan":
        lib = ctypes.CDLL(None, use_errno=True)
        names = [b"hw.logicalcpu", b"hw.physicalcpu", b"hw.packages",
                 b"hw.pagesize", b"hw.availcpu", b"hw.machine_arch",
                 b"hw.cpufrequency", b"hw.cpusubtype", b"hw.cacheconfig",
                 b"hw.l2cachesize", b"hw.l3cachesize",
                 b"machdep.cpu.brand_string", b"machdep.cpu.core_count",
                 b"machdep.cpu.thread_count", b"machdep.cpu.logical_per_package",
                 b"machdep.cpu.physical_per_package", b"machdep.cpu.features",
                 b"kern.maxfilesperproc", b"kern.sysv.shmmax", b"vm.loadavg",
                 b"vm.swapusage", b"net.inet.tcp.keepidle",
                 b"kern.osproductversion", b"kern.bootargs", b"kern.clockrate"]
        results = {}
        for name in names:
            buf = ctypes.create_string_buffer(2048)
            size = ctypes.c_size_t(2048)
            ctypes.set_errno(0)
            rc = lib.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
            results[name.decode()] = {"rc": rc, "errno": ctypes.get_errno(),
                                      "value": buf.value.decode("utf-8", "replace") if rc == 0 else None}
        leaked = {k: v for k, v in results.items() if v["rc"] == 0}
        out({"status": "escaped" if leaked else "blocked",
             "unexpected_readable": leaked})

    elif case == "udp_network":
        results = {}
        # loopback UDP bind + connect, then a 0-byte sendto (no payload sent).
        for label, fam, addr in (("udp_loopback_bind", socket.AF_INET, ("127.0.0.1", 0)),
                                 ("udp_loopback_send", socket.AF_INET, ("127.0.0.1", 53)),
                                 ("udp_outbound", socket.AF_INET, ("8.8.8.8", 53))):
            try:
                s = socket.socket(fam, socket.SOCK_DGRAM)
                if "bind" in label:
                    s.bind(addr)
                    results[label] = {"ok": True, "errno": 0}
                else:
                    s.connect(addr)
                    results[label] = {"ok": True, "errno": 0}
                s.close()
            except OSError as exc:
                results[label] = {"ok": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items() if v["ok"]}
        out({"status": "escaped" if leaked else "blocked", "udp": results})

    elif case == "launchdaemons_read":
        results = {}
        for base in ("/System/Library/LaunchDaemons", "/System/Library/LaunchAgents",
                     "/System/Library/Extensions", "/Library/LaunchDaemons"):
            try:
                names = sorted(os.listdir(base))
                sample = []
                for name in names[:3]:
                    try:
                        data = Path(base, name).read_bytes()[:300]
                        sample.append({"name": name,
                                       "bytes": len(data),
                                       "snippet": data.decode("utf-8", "replace")[:200]})
                    except OSError as exc:
                        sample.append({"name": name, "errno": exc.errno})
                results[base] = {"listable": True, "count": len(names),
                                 "sample": sample}
            except OSError as exc:
                results[base] = {"listable": False, "errno": exc.errno}
        leaked = {k: v for k, v in results.items()
                  if v.get("listable") and any(s.get("snippet") for s in v.get("sample", []))}
        out({"status": "escaped" if leaked else "blocked", "dirs": results})

    elif case == "usr_share_read":
        results = {}
        for base in ("/usr/share/zoneinfo/Asia/Seoul", "/usr/share/zoneinfo/America/New_York",
                     "/usr/share/man/man1", "/usr/share/misc/termcap",
                     "/usr/share/locale"):
            try:
                p = Path(base)
                if p.is_dir():
                    names = sorted(os.listdir(p))[:5]
                    results[base] = {"kind": "dir", "sample": names}
                else:
                    data = p.read_bytes()[:128]
                    results[base] = {"kind": "file", "bytes": len(data)}
            except OSError as exc:
                results[base] = {"errno": exc.errno}
        leaked = {k: v for k, v in results.items() if "errno" not in v}
        out({"status": "escaped" if leaked else "blocked", "share": results})

    elif case == "host_processor_info":
        libm = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libm.mach_host_self.restype = ctypes.c_uint32
        PROCESSOR_BASIC_INFO = 1
        libm.host_processor_info.argtypes = [
            ctypes.c_uint32, ctypes.c_int,
            ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_uint32)]
        libm.host_processor_info.restype = ctypes.c_int
        host = libm.mach_host_self()
        if host == 0:
            out({"status": "blocked", "reason": "MACH_PORT_NULL"})
        count = ctypes.c_uint32(0)
        info = ctypes.c_void_p(0)
        ctypes.set_errno(0)
        rc = libm.host_processor_info(host, PROCESSOR_BASIC_INFO,
                                      ctypes.byref(count), ctypes.byref(info),
                                      ctypes.byref(ctypes.c_uint32(0)))
        cpu_count = count.value
        out({"status": "escaped" if rc == 0 and cpu_count > 0 else "blocked",
             "rc": rc, "processor_count": cpu_count, "errno": ctypes.get_errno()})

    elif case == "xattr_scan":
        # os.listxattr is absent under -S -I; use libc listxattr/getxattr directly.
        lib = ctypes.CDLL(None, use_errno=True)
        lib.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.c_int]
        lib.listxattr.restype = ctypes.c_int
        lib.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p,
                                 ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int]
        lib.getxattr.restype = ctypes.c_int
        results = {}
        for t in ("/", "/System/Library/CoreServices/SystemVersion.plist",
                  "/usr/share", "/dev/null"):
            buf = ctypes.create_string_buffer(4096)
            n = lib.listxattr(t.encode(), buf, 4096, 0)
            if n < 0:
                results[t] = {"errno": ctypes.get_errno()}
                continue
            names = buf.value.decode("utf-8", "replace").split("\x00")
            names = [x for x in names if x]
            xv = {}
            for name in names[:8]:
                vb = ctypes.create_string_buffer(1024)
                r = lib.getxattr(t.encode(), name.encode(), vb, 1024, 0, 0)
                xv[name] = vb.value.decode("utf-8", "replace")[:64] if r >= 0 else r
            results[t] = {"names": names, "values": xv}
        leaked = {k: v for k, v in results.items() if v.get("names")}
        out({"status": "escaped" if leaked else "blocked", "xattr": results})

    elif case == "getattrlist_vol":
        # getattrlist(2) volume attributes: name, size, free space, capabilities.
        lib = ctypes.CDLL(None, use_errno=True)
        ATTR_BITMAP_COUNT = 5
        ATTR_VOL_INFO = 0x00000001
        ATTR_VOL_NAME = 0x00002000
        ATTR_VOL_SIZE = 0x00040000
        ATTR_VOL_CAPABILITIES = 0x00080000
        ATTR_VOL_FREE_SPACE = 0x00020000

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
        for t in ("/", "/System/Volumes/Data", "/Users"):
            al = AttrList(ATTR_BITMAP_COUNT, 0, 0,
                          ATTR_VOL_INFO | ATTR_VOL_NAME | ATTR_VOL_SIZE
                          | ATTR_VOL_CAPABILITIES | ATTR_VOL_FREE_SPACE, 0, 0, 0)
            buf = ctypes.create_string_buffer(4096)
            ctypes.set_errno(0)
            rc = lib.getattrlist(t.encode(), ctypes.byref(al), buf, 4096, 0)
            results[t] = {"rc": rc, "errno": ctypes.get_errno(),
                          "bytes": buf.raw[:64].hex()}
        leaked = {k: v for k, v in results.items() if v["rc"] == 0}
        out({"status": "escaped" if leaked else "blocked", "volumes": results})

    else:
        out({"status": "error", "reason": "unknown case"})
except Exception as exc:
    out({"status": "blocked" if deny_code(exc) else "error",
         "error": f"{type(exc).__name__}: {exc}"})
'''


CASES = [
    "proc_listpids",
    "proc_pidpath",
    "proc_pidinfo_parent",
    "getfsstat_full",
    "access_oracle",
    "sysctl_deep_scan",
    "udp_network",
    "launchdaemons_read",
    "usr_share_read",
    "host_processor_info",
    "xattr_scan",
    "getattrlist_vol",
]


def _setxattr_macos(path: Path, name: str, value: bytes) -> None:
    """Set an extended attribute via the raw syscall (macOS has no os.setxattr)."""
    import ctypes
    path_c = ctypes.create_string_buffer(str(path).encode())
    name_c = ctypes.create_string_buffer(name.encode())
    val_buf = ctypes.create_string_buffer(value, len(value))
    rc = ctypes.CDLL(None, use_errno=True).syscall(
        236, path_c, name_c, val_buf, ctypes.c_size_t(len(value)),
        ctypes.c_uint32(0), ctypes.c_int(0))
    if rc != 0:
        raise OSError(ctypes.get_errno(), f"setxattr failed on {path}")


def run_round4(repeats: int) -> dict:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise RuntimeError("This breakout suite requires macOS sandbox-exec")
    if repeats < 1:
        raise ValueError("repeats must be positive")

    python = str(Path(sys.executable).resolve())
    real_home = str(Path("~").expanduser())
    profiles = {"PERMISSIVE": permissive_profile, "HARDENED": hardened_profile}
    rows: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="halo-round4-") as tmp:
        root = Path(tmp).resolve()
        work, outside = root / "work", root / "outside"
        work.mkdir()
        outside.mkdir()
        canary = outside / "canary.txt"
        canary.write_text("ROUND4-CANARY")

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}

        for profile_name, profile_fn in profiles.items():
            profile_text = profile_fn(work)
            for repeat in range(repeats):
                for case in CASES:
                    args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                            python, "-I", "-S", "-c", ROUND4_PAYLOAD,
                            case, str(work), str(canary), real_home]
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
                        except json.JSONDecodeError:
                            result = {"status": "invalid_output",
                                      "stdout": proc.stdout[:200],
                                      "stderr": proc.stderr[:200]}
                    except subprocess.TimeoutExpired:
                        result = {"status": "timeout"}

                    outcome = result.get("status", "error")
                    if outcome not in {"escaped", "blocked"}:
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
                "error": sum(r["outcome"] not in {"escaped", "blocked"} for r in subset),
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
                        default=Path(__file__).with_name("round4_results.json"))
    args = parser.parse_args()

    report = run_round4(args.repeats)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")

    print("=== HALO Round-4 Breakout Suite: HARDENED under new planes ===")
    for profile_name, cases in report["summary"].items():
        total_esc = sum(v["escaped"] for v in cases.values())
        total = sum(v["total"] for v in cases.values())
        print(f"\n[{profile_name}]  escaped={total_esc}/{total}")
        for case, counts in cases.items():
            tag = "x ESCAPED" if counts["escaped"] else (". blocked" if counts["blocked"] == counts["total"] and counts["total"] else "? ERROR")
            print(f"  {tag:12s}  {case}  (esc={counts['escaped']}, blk={counts['blocked']}, err={counts['error']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())