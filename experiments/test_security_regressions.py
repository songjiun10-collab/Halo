import csv
import errno
import math
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from artifacts.sandbox_benchmark import run_benchmark as benchmark
from artifacts.sandbox_benchmark import run_exploits as exploits
from artifacts.sandbox_benchmark import run_breakout as breakout


@pytest.mark.parametrize('status', ['os_error', 'timeout', 'invalid_output'])
def test_external_write_overrides_payload_failure(tmp_path, status):
    target = tmp_path / 'target'
    target.write_text('changed')
    assert benchmark.classify('absolute_write', {'status': status, 'errno': errno.EPERM}, 'secret', target) == 'escaped'


def test_zero_trials_rejected():
    with pytest.raises(ValueError, match='positive'):
        exploits.run_exploit_suite(0)


def test_timeout_is_error(monkeypatch):
    monkeypatch.setattr(exploits.platform, 'platform', lambda: 'test')
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired('sandbox-exec', 5)
    monkeypatch.setattr(exploits.subprocess, 'run', timeout)
    report = exploits.run_exploit_suite(1)
    for cases in report['summary'].values():
        for counts in cases.values():
            assert counts == {'escaped': 0, 'blocked': 0, 'error': 1, 'total': 1}


def test_sweep_handles_absent_known_population(tmp_path):
    source = Path(__file__).parent / 'e002_shared_blind_spots'
    for name in ('experiment.py', 'run_sweep.py'):
        shutil.copy2(source / name, tmp_path / name)
    proc = subprocess.run([sys.executable, str(tmp_path / 'run_sweep.py')], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    with (tmp_path / 'results/summary.csv').open() as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 18
    assert all(math.isnan(float(r['known_tpr_mean'])) for r in rows if float(r['hidden_fraction']) == 1)


@pytest.mark.parametrize('suite,runner', [(exploits, 'run_exploit_suite'), (breakout, 'run_breakout')])
@pytest.mark.parametrize('counts', [
    {'escaped': 0, 'blocked': 0, 'error': 1, 'total': 1},
    {'escaped': 0, 'blocked': 0, 'error': 0, 'total': 0},
    {'escaped': 1, 'blocked': 0, 'error': 0, 'total': 1},
])
def test_cli_rejects_incomplete_or_unsafe_report(tmp_path, monkeypatch, suite, runner, counts):
    monkeypatch.setattr(suite, runner, lambda _: {'summary': {'HARDENED': {'probe': counts}}})
    monkeypatch.setattr(sys, 'argv', ['suite', '--output', str(tmp_path / 'report.json')])
    assert suite.main() == 1


def test_victim_death_overrides_payload_error():
    assert breakout.classify('signal_victim', 'error', True) == 'escaped'
    assert breakout.classify('signal_victim', 'delivered', False) == 'error'


@pytest.mark.skipif(sys.platform != 'darwin', reason='macOS sandbox required')
def test_hardened_runtime_works_without_broad_hardware_access(tmp_path):
    payload = '''import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name in (b"hw.model", b"hw.memsize", b"kern.boottime"):
    buf = ctypes.create_string_buffer(256)
    size = ctypes.c_size_t(256)
    rc = libc.sysctlbyname(name, buf, ctypes.byref(size), None, 0)
    assert rc != 0 and ctypes.get_errno() in (errno.EPERM, errno.EACCES)
print("runtime-ok")
'''
    proc = subprocess.run(['/usr/bin/sandbox-exec', '-p', exploits.hardened_profile(tmp_path.resolve()), str(Path(sys.executable).resolve()), '-I', '-S', '-c', payload], capture_output=True, text=True, timeout=5)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == 'runtime-ok'
