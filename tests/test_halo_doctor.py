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


def test_run_check_forwards_env_to_subprocess(monkeypatch, tmp_path):
    """Regression: env used to be computed by verify() but silently dropped,
    since run_check() had no env parameter — cargo invocations then failed
    with 'could not execute process `rustc -vV`' whenever RUSTUP_HOME/
    CARGO_HOME weren't already in the ambient environment."""
    captured = {}
    def fake_run(command, cwd, capture_output, text, timeout, env):
        captured["env"] = env
        class Proc:
            returncode = 0
            stdout = ""
            stderr = ""
        return Proc()
    monkeypatch.setattr(subprocess, "run", fake_run)
    sentinel_env = {"RUSTUP_HOME": "/fake/rustup", "CARGO_HOME": "/fake/cargo"}
    doctor.run_check("probe", ["probe"], tmp_path, env=sentinel_env)
    assert captured["env"] == sentinel_env


@pytest.mark.parametrize("scope", ["rust", "sandbox"])
def test_verify_passes_rustup_and_cargo_home_env_for_cargo_scopes(monkeypatch, tmp_path, scope):
    """The RUSTUP_HOME/CARGO_HOME env verify() builds must actually reach the
    cargo subprocess, not just be constructed and discarded."""
    cargo = tmp_path / ".venv" / "cargo" / "bin" / "cargo"
    cargo.parent.mkdir(parents=True)
    cargo.write_text("#!/bin/sh\n")
    if scope == "sandbox":
        manifest = tmp_path / "artifacts" / "sandbox_benchmark" / "rust_runner" / "Cargo.toml"
        manifest.parent.mkdir(parents=True)
        manifest.write_text("")

    calls = []
    def run(name, command, root, env=None):
        calls.append({"name": name, "command": command, "root": root, "env": env})
        return {"name": name, "ok": True, "output": ""}
    monkeypatch.setattr(doctor, "run_check", run)
    monkeypatch.setattr(doctor, "_evidence_check",
        lambda root: {"name": "evidence", "ok": True, "output": ""})

    doctor.verify(tmp_path, scope=scope)

    test_calls = [c for c in calls if c["name"] in ("rust-tests", "sandbox-tests")]
    assert len(test_calls) == 1
    env = test_calls[0]["env"]
    assert env is not None
    assert env["RUSTUP_HOME"] == str(tmp_path / ".venv" / "rustup")
    assert env["CARGO_HOME"] == str(tmp_path / ".venv" / "cargo")


def test_verify_is_side_effect_free_and_json_cli_output_is_pure(monkeypatch, capsys):
    """Regression: verify() and _report_security_gate() used to print()
    human-readable lines unconditionally, so `halo verify --json` emitted
    those lines before the JSON object instead of a single parseable
    document, contradicting its own documented contract."""
    canned = {"ok": True, "checks": [{"name": "pytest", "ok": True, "output": "ok"}],
              "security_gates": []}
    monkeypatch.setattr(doctor, "verify", lambda root, scope: canned)
    captured_direct = capsys.readouterr()  # drain setup noise, if any
    doctor.verify(None, scope="python")
    assert capsys.readouterr().out == ""

    assert doctor.main(["verify", "--json"]) == 0
    out = capsys.readouterr().out
    assert out.count("\n") == 1
    assert json.loads(out) == canned


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
