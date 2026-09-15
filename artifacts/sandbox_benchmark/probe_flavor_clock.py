"""Live probe: host_statistics flavor sweep + clock service + mach time.

Runs inside the HARDENED sandbox profile. Read-only, disposable.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_exploits import hardened_profile, _apply_nproc_limit

PAYLOAD = r"""
import ctypes, json, os, sys
from pathlib import Path
work = sys.argv[1]
libm = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libm.mach_host_self.restype = ctypes.c_uint32
host = libm.mach_host_self()
out = {}
libm.host_statistics.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
libm.host_statistics.restype = ctypes.c_int
labels = {1: 'processor', 2: 'vm', 3: 'load', 4: 'vm_info64', 5: 'cpu',
          6: 'sched', 7: 'resource', 8: 'processor_info', 9: 'extmod',
          10: 'user', 11: 'lock', 12: 'physical_vm', 13: 'pipeline', 14: 'vm64'}
for fl in range(1, 15):
    buf = (ctypes.c_int * 64)()
    n = ctypes.c_uint32(64)
    rc = libm.host_statistics(host, fl, buf, ctypes.byref(n))
    if rc == 0:
        out['flavor%d_%s' % (fl, labels.get(fl, 'unknown'))] = ('OK', list(buf[:min(n.value, 8)]))
    else:
        out['flavor%d_%s' % (fl, labels.get(fl, 'unknown'))] = ('DENY', rc)

libm.host_get_clock_service.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
libm.host_get_clock_service.restype = ctypes.c_int
libm.clock_get_time.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
libm.clock_get_time.restype = ctypes.c_int
class MachTime(ctypes.Structure):
    _fields_ = [('sec', ctypes.c_uint32), ('nsec', ctypes.c_uint32)]
for cname, clock in [('realtime', 0), ('calendric', 1), ('micro', 3), ('sched', 2)]:
    cp = ctypes.c_uint32(0)
    rc = libm.host_get_clock_service(host, clock, ctypes.byref(cp))
    if rc != 0:
        out['clock_' + cname] = ('DENY', rc)
        continue
    mt = MachTime()
    rc2 = libm.clock_get_time(cp.value, ctypes.byref(mt))
    out['clock_' + cname] = ('OK', mt.sec, mt.nsec) if rc2 == 0 else ('GET_DENY', rc2)

libm.mach_absolute_time.restype = ctypes.c_uint64
out['mach_absolute_time'] = libm.mach_absolute_time()
print(json.dumps(out))
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="halo-flavor-") as tmp:
        work = Path(tmp).resolve() / "work"
        work.mkdir()
        py = str(Path(sys.executable).resolve())
        prof = hardened_profile(work)
        args = ["/usr/bin/sandbox-exec", "-p", prof, py, "-I", "-S", "-c", PAYLOAD, str(work)]
        proc = subprocess.run(
            args, cwd=work,
            env={"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work), "LC_ALL": "C"},
            capture_output=True, text=True, preexec_fn=_apply_nproc_limit, timeout=20,
        )
        print("rc", proc.returncode)
        print(proc.stdout)
        if proc.stderr:
            print("stderr", proc.stderr[:300])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())