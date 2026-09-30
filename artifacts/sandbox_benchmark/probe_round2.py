"""Live probe round 2: host_processors / host_processor_info, getattrlist,
searchfs, /dev/disk, decode load average. Runs inside HARDENED profile."""
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
u32p = ctypes.POINTER(ctypes.c_uint32)

# A. host_processors -> per-processor ports
libm.host_processors.argtypes = [ctypes.c_uint32, u32p, u32p]
libm.host_processors.restype = ctypes.c_int
arr = ctypes.c_void_p(0)
cnt = ctypes.c_uint32(0)
rc = libm.host_processors(host, ctypes.byref(arr), ctypes.byref(cnt))
out['host_processors'] = ('OK', cnt.value) if rc == 0 else ('DENY', rc)
if rc == 0 and cnt.value:
    procs = [ctypes.cast(arr.value + 4 * i, u32p)[0] for i in range(cnt.value)]
    libm.processor_info.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p, u32p]
    libm.processor_info.restype = ctypes.c_int
    infos = {}
    for i, p in enumerate(procs[:4]):
        buf = (ctypes.c_int * 16)()
        n = ctypes.c_uint32(16)
        prc = libm.processor_info(p, 1, buf, ctypes.byref(n))
        infos['cpu%d' % i] = ('OK', list(buf[:min(n.value, 4)])) if prc == 0 else ('DENY', prc)
    out['processor_info'] = infos

# B. host_processor_info (HOST_CPU_LOAD_INFO = 1)
libm.host_processor_info.argtypes = [ctypes.c_uint32, ctypes.c_int,
                                     ctypes.POINTER(ctypes.c_uint32),
                                     ctypes.POINTER(ctypes.c_void_p),
                                     ctypes.POINTER(ctypes.c_uint32)]
libm.host_processor_info.restype = ctypes.c_int
pcount = ctypes.c_uint32(0)
pinfo = ctypes.c_void_p(0)
info_count = ctypes.c_uint32(0)
rc = libm.host_processor_info(host, 1, ctypes.byref(pcount), ctypes.byref(pinfo), ctypes.byref(info_count))
out['host_processor_info'] = ('OK', pcount.value, info_count.value) if rc == 0 else ('DENY', rc)

# C. getattrlist on an outside path with limited attrs
libc = ctypes.CDLL(None, use_errno=True)
class AttrList(ctypes.Structure):
    _fields_ = [('bitmapcount', ctypes.c_uint), ('commonattr', ctypes.c_uint),
                ('volattr', ctypes.c_uint), ('dirattr', ctypes.c_uint),
                ('fileattr', ctypes.c_uint), ('forkattr', ctypes.c_uint)]
class TimeSpec(ctypes.Structure):
    _fields_ = [('tv_sec', ctypes.c_long), ('tv_nsec', ctypes.c_long)]
class AttrBuf(ctypes.Structure):
    _fields_ = [('length', ctypes.c_uint), ('flags', ctypes.c_uint),
                ('atime', TimeSpec), ('mtime', TimeSpec), ('ctime', TimeSpec)]
libc.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(AttrList), ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint]
libc.getattrlist.restype = ctypes.c_int
targets = [b'/etc/passwd', b'/Users', os.environ.get('HOME', '/').encode()]
for t in targets:
    al = AttrList(2, 0x20000000 | 0x10, 0, 0, 0, 0)  # ATTR_CMN_ACCESSMASK | ATTR_CMN_MODTIME
    ab = ctypes.create_string_buffer(4096)
    ctypes.set_errno(0)
    rc = libc.getattrlist(t, ctypes.byref(al), ab, 4096, 0)
    out['getattrlist_' + t.decode()] = ('OK', rc) if rc == 0 else ('DENY', ctypes.get_errno())

# D. searchfs on root volume
libc.searchfs.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_uint]
libc.searchfs.restype = ctypes.c_int
class SearchState(ctypes.Structure):
    _fields_ = [('index', ctypes.c_uint32), ('key', ctypes.c_uint32), ('start_time', ctypes.c_uint32), ('flags', ctypes.c_uint32), ('searchdir', ctypes.c_uint32), ('term', ctypes.c_char * 256)]
ss = SearchState()
count = ctypes.c_uint32(0)
ctypes.set_errno(0)
rc = libc.searchfs(b'/', ctypes.byref(ss), None, 0, 0, 0, ctypes.byref(count), 0)
out['searchfs_root'] = ('OK', count.value) if rc == 0 else ('DENY', ctypes.get_errno())

# E. /dev/disk* read attempt
for dev in [b'/dev/disk0', b'/dev/disk3s1s1']:
    try:
        fd = os.open(dev, os.O_RDONLY)
        data = os.read(fd, 16)
        os.close(fd)
        out['dev_' + dev.decode()] = ('READ', data[:16])
    except OSError as e:
        out['dev_' + dev.decode()] = ('DENY', e.errno)

# F. load average via os.getloadavg (stdlib path)
try:
    out['os_getloadavg'] = os.getloadavg()
except OSError as e:
    out['os_getloadavg'] = ('DENY', e.errno)

print(json.dumps(out))
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="halo-r2-") as tmp:
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