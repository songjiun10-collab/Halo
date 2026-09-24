import json
from pathlib import Path
import subprocess
import sys

import pytest

from halo import doctor


def test_check_preserves_failure_and_uses_requested_directory(tmp_path):
    result = doctor.run_check("probe", [sys.executable, "-c",
        "import os,sys; print(os.getcwd()); print('error', file=sys.stderr); sys.exit(7)"], tmp_path)
    assert not result["ok"]
    assert result["returncode"] == 7
    assert str(tmp_path) in result["output"]
    assert "error" in result["output"]


@pytest.mark.parametrize("failure", [FileNotFoundError("missing"),
    subprocess.TimeoutExpired(["probe"], 300)])
def test_launch_errors_and_timeout_fail_closed(monkeypatch, failure):
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(subprocess, "run", fail)
    result = doctor.run_check("probe", ["probe"])
    assert not result["ok"]
    assert result["returncode"] is None


@pytest.mark.parametrize("outcomes", [(False, True), (True, False), (True, True)])
def test_verify_runs_both_checks_and_propagates_failure(monkeypatch, tmp_path, outcomes):
    calls = []
    def run(name, command, root):
        calls.append((name, command, root))
        return {"name": name, "ok": outcomes[len(calls) - 1], "output": ""}
    monkeypatch.setattr(doctor, "run_check", run)
    report = doctor.verify(tmp_path)
    assert report["ok"] == all(outcomes)
    assert [call[0] for call in calls] == ["pytest", "evidence"]
    assert all(call[2] == tmp_path for call in calls)
    assert calls[0][1][0] == sys.executable


def test_doctor_missing_registry_is_failure(tmp_path):
    report = doctor.diagnose(tmp_path)
    assert not report["ok"]
    assert not report["checks"][1]["ok"]


def test_json_cli_returns_nonzero_for_failed_evidence(monkeypatch, capsys):
    monkeypatch.setattr(doctor, "diagnose", lambda: {"ok": False, "checks": []})
    assert doctor.main(["doctor", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False


def test_module_help_outside_checkout(tmp_path):
    import os
    environment = dict(os.environ, PYTHONPATH=str(Path(doctor.__file__).resolve().parents[1]))
    result = subprocess.run([sys.executable, "-m", "halo", "--help"],
        cwd=tmp_path, env=environment, capture_output=True, text=True)
    assert result.returncode == 0
    assert "doctor" in result.stdout and "verify" in result.stdout
