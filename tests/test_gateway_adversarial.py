import io
import json
from pathlib import Path
import subprocess
import sys
import threading
import sqlite3

import pytest

from halo.gateway import Gateway, Rejected, Tool

A, E = "a" * 48, "e" * 48


def post(app, path, key, body):
    raw = json.dumps(body).encode()
    statuses = []
    env = {"REQUEST_METHOD": "POST", "PATH_INFO": path,
           "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json",
           "HTTP_AUTHORIZATION": "Bearer " + key, "wsgi.input": io.BytesIO(raw)}
    result = b"".join(app(env, lambda status, headers: statuses.append(status)))
    return statuses[0], json.loads(result)


def test_invalid_credentials_rejected_before_reading_body(tmp_path):
    app = Gateway(tmp_path / "g.db", A, E, {})
    class Trap:
        read_called = False
        def read(self, n):
            self.read_called = True
            return b"{}"
    stream = Trap()
    env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/approve", "CONTENT_LENGTH": "2",
           "CONTENT_TYPE": "application/json", "HTTP_AUTHORIZATION": "Bearer wrong",
           "wsgi.input": stream}
    list(app(env, lambda *args: None))
    assert not stream.read_called


def test_forged_capability_cannot_invoke_validator(tmp_path):
    calls = []
    app = Gateway(tmp_path / "g.db", A, E, {
        "tool": Tool("1", lambda args: calls.append(args) or True, lambda args: {})})
    with pytest.raises(Rejected):
        app.handle("/execute", E, {"tool": "tool", "args": {}, "token": "forged"})
    assert calls == []


def test_failure_after_effect_is_not_reported_as_rejected(tmp_path):
    effects = []
    def tool(args):
        effects.append("sent")
        raise OSError("connection lost after send")
    app = Gateway(tmp_path / "g.db", A, E, {"tool": Tool("1", lambda args: True, tool)})
    token = app.handle("/approve", A, {"tool": "tool", "args": {}, "intent_id": "one"})["token"]
    status, body = post(app, "/execute", E, {"tool": "tool", "args": {}, "token": token})
    assert effects == ["sent"]
    assert status == "503 Service Unavailable"
    assert "reconcile" in body["error"]


def test_revoke_during_running_tool_does_not_claim_success(tmp_path):
    entered, release = threading.Event(), threading.Event()
    def tool(args):
        entered.set()
        assert release.wait(5)
        return {}
    path = tmp_path / "g.db"
    app = Gateway(path, A, E, {"tool": Tool("1", lambda args: True, tool)})
    token = app.handle("/approve", A, {"tool": "tool", "args": {}, "intent_id": "one"})["token"]
    worker = threading.Thread(target=lambda: app.handle("/execute", E, {"tool": "tool", "args": {}, "token": token}))
    worker.start()
    try:
        assert entered.wait(5)
        result = app.handle("/revoke", A, {"token": token})
        assert result["revoked"] is False
    finally:
        release.set()
        worker.join(5)


def test_revocation_during_validation_prevents_dispatch(tmp_path):
    entered, release = threading.Event(), threading.Event()
    validating_execution = [False]
    effects, results = [], []
    def validate(args):
        if validating_execution[0]:
            entered.set()
            assert release.wait(5)
        return True
    app = Gateway(tmp_path / "g.db", A, E, {
        "tool": Tool("1", validate, lambda args: effects.append(args) or {})})
    token = app.handle("/approve", A, {"tool": "tool", "args": {}, "intent_id": "one"})["token"]
    validating_execution[0] = True
    def execute():
        results.append(post(app, "/execute", E, {"tool": "tool", "args": {}, "token": token})[0])
    worker = threading.Thread(target=execute)
    worker.start()
    try:
        assert entered.wait(5)
        assert app.handle("/revoke", A, {"token": token}) == {"revoked": True}
    finally:
        release.set()
        worker.join(5)
    assert results == ["403 Forbidden"]
    assert effects == []


@pytest.mark.parametrize("phase,expected_effects", [("claimed", 0), ("completed", 1)])
def test_real_database_audit_failure_at_commit_boundary(tmp_path, phase, expected_effects):
    path = tmp_path / "g.db"
    effects = []
    tools = {"tool": Tool("1", lambda args: True, lambda args: effects.append(args) or {})}
    app = Gateway(path, A, E, tools)
    token = app.handle("/approve", A, {"tool": "tool", "args": {}, "intent_id": "one"})["token"]
    db = sqlite3.connect(path)
    try:
        db.execute("CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.phase = '" + phase + "' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        db.commit()
    finally:
        db.close()
    request = {"tool": "tool", "args": {}, "token": token}
    assert post(app, "/execute", E, request)[0] == "503 Service Unavailable"
    assert len(effects) == expected_effects
    # Keep the injected failure active; neither restart path duplicates effects.
    post(Gateway(path, A, E, tools), "/execute", E, request)
    assert len(effects) == expected_effects


def test_factory_can_initialize_fresh_state_directory(tmp_path, monkeypatch):
    from halo.gateway_app import create_app
    monkeypatch.setenv("HALO_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("HALO_APPROVER_KEY", A)
    monkeypatch.setenv("HALO_EXECUTOR_KEY", E)
    app = create_app()
    assert Path(app.path).exists()
    assert app.realm
    body = {"tool": "sha256", "args": {"text": "restart"}, "intent_id": "fresh"}
    token = app.handle("/approve", A, body)["token"]
    request = {"tool": body["tool"], "args": body["args"], "token": token}
    restarted = create_app()
    assert post(restarted, "/execute", E, request)[0] == "200 OK"
    assert post(app, "/execute", E, request)[0] == "403 Forbidden"


def test_failed_dispatch_and_failed_audit_remain_uncertain(tmp_path):
    now, effects = [1000.0], []
    def execute(args):
        effects.append(args)
        now[0] -= 1
        raise RuntimeError("after effect")
    app = Gateway(tmp_path / "g.db", A, E,
                  {"tool": Tool("1", lambda args: True, execute)},
                  clock=lambda: now[0])
    token = app.handle("/approve", A, {
        "tool": "tool", "args": {}, "intent_id": "failure"})["token"]
    request = {"tool": "tool", "args": {}, "token": token}
    assert post(app, "/execute", E, request)[0] == "503 Service Unavailable"
    now[0] = 1001
    assert post(app, "/execute", E, request)[0] == "403 Forbidden"
    assert effects == [{}]


@pytest.mark.parametrize("tolerance", [float("nan"), float("inf"), -1])
def test_invalid_clock_tolerance_creates_no_state(tmp_path, tolerance):
    with pytest.raises(ValueError):
        Gateway(tmp_path / "g.db", A, E, {}, rollback_tolerance=tolerance)
    assert list(tmp_path.iterdir()) == []


def test_database_is_private_before_sqlite_connect(tmp_path, monkeypatch):
    connect = sqlite3.connect
    def checked_connect(path, *args, **kwargs):
        import os
        assert os.stat(path).st_mode & 0o077 == 0
        return connect(path, *args, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", checked_connect)
    Gateway(tmp_path / "g.db", A, E, {})


def test_factory_rejects_dangling_database_symlink(tmp_path, monkeypatch):
    from halo.gateway_app import create_app
    target = tmp_path / "must-not-create"
    (tmp_path / "gateway.sqlite3").symlink_to(target)
    monkeypatch.setenv("HALO_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("HALO_APPROVER_KEY", A)
    monkeypatch.setenv("HALO_EXECUTOR_KEY", E)
    with pytest.raises((ValueError, OSError)):
        create_app()
    assert not target.exists()


def test_nested_code_fingerprint_is_stable_across_processes():
    source = ("from halo.gateway import Gateway\n"
              "def adapter(args):\n    return [x + 2 for x in args]\n"
              "print(Gateway._code_fingerprint(adapter))\n")
    fingerprints = [subprocess.check_output([sys.executable, "-c", source], text=True)
                    for _ in range(2)]
    assert fingerprints[0] == fingerprints[1]


def test_fingerprint_distinguishes_constants_and_defaults():
    def adapter(args, offset=1):
        return offset + 1
    import types
    changed = types.FunctionType(adapter.__code__.replace(co_consts=(None, 2)),
                                 globals(), argdefs=(1,))
    assert Gateway._code_fingerprint(adapter) != Gateway._code_fingerprint(changed)
    changed = types.FunctionType(adapter.__code__, globals(), argdefs=(2,))
    assert Gateway._code_fingerprint(adapter) != Gateway._code_fingerprint(changed)
