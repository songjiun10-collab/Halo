import io
import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from halo.gateway import Gateway, Rejected, Tool

A, B, E = "a" * 48, "b" * 48, "e" * 48


@pytest.mark.parametrize("length", ["１００", "+100", " 100", "1_00", None, "100 "])
def test_noncanonical_content_length_cannot_issue_a_grant(tmp_path, length):
    app = Gateway(tmp_path / "g.db", A, E, {"echo": Tool("1", lambda a: True, lambda a: a)})
    body = json.dumps({"tool": "echo", "args": {}, "intent_id": "test"}).encode().ljust(100)
    statuses = []
    env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/approve", "CONTENT_LENGTH": length,
           "CONTENT_TYPE": "application/json", "HTTP_AUTHORIZATION": "Bearer " + A,
           "wsgi.input": io.BytesIO(body)}
    b"".join(app(env, lambda status, headers: statuses.append(status)))
    assert statuses == ["403 Forbidden"]


def test_db_only_fork_is_rejected_and_original_grant_still_works(tmp_path):
    calls = []
    tools = {"echo": Tool("1", lambda a: True, lambda a: calls.append(a) or {})}
    app = Gateway(tmp_path / "g.db", A, E, tools)
    token = app.handle("/approve", A, {"tool": "echo", "args": {}, "intent_id": "test"})["token"]
    fork = tmp_path / "fork.db"
    shutil.copy2(app.path, fork)
    with pytest.raises(ValueError, match="realm identity"):
        Gateway(fork, A, E, tools)
    app.handle("/execute", E, {"tool": "echo", "args": {}, "token": token})
    assert calls == [{}]


def test_shared_explicit_realm_does_not_cross_role_key_identity(tmp_path):
    calls = []
    tools = {"echo": Tool("1", lambda a: True, lambda a: calls.append(a) or {})}
    app = Gateway(tmp_path / "g.db", A, E, tools, realm="shared")
    token = app.handle("/approve", A, {"tool": "echo", "args": {}, "intent_id": "test"})["token"]
    other = Gateway(app.path, B, E, tools, realm="shared")
    request = {"tool": "echo", "args": {}, "token": token}
    with pytest.raises(Rejected):
        other.handle("/execute", E, request)
    assert calls == []
    app.handle("/execute", E, request)
    assert calls == [{}]


def test_pending_capacity_and_expiry_reclaim_use_current_schema(tmp_path):
    app = Gateway(tmp_path / "g.db", A, E,
                  {"echo": Tool("1", lambda a: True, lambda a: a)},
                  clock=lambda: 1000, mono_clock=lambda: 10)
    with sqlite3.connect(app.path) as db:
        db.executemany("INSERT INTO grants(token,digest,expires,state,mono_deadline) VALUES(?,?,?,?,?)",
                       [(str(i), "fixture", 1060, "pending", 70) for i in range(1024)])
    request = {"tool": "echo", "args": {}, "intent_id": "test"}
    with pytest.raises(Rejected, match="capacity"):
        app.handle("/approve", A, request)
    with sqlite3.connect(app.path) as db:
        db.execute("UPDATE grants SET mono_deadline=10")
    assert app.handle("/approve", A, request)["token"]
    with sqlite3.connect(app.path) as db:
        assert db.execute("SELECT COUNT(*) FROM grants WHERE state='pending'").fetchone()[0] == 1


def test_realm_sidecar_symlink_is_not_trusted_state(tmp_path):
    app = Gateway(tmp_path / "g.db", A, E, {})
    sidecar = Path(app._realm_sidecar_path())
    saved = tmp_path / "saved-id"
    sidecar.rename(saved)
    sidecar.symlink_to(saved)
    with pytest.raises(ValueError, match="realm identity"):
        Gateway(app.path, A, E, {})
