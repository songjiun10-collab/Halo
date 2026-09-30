import hashlib
import http.client
import json
import os
import threading
from wsgiref.simple_server import make_server

import pytest

from halo.dev_server import QuietHandler, application, load_role_keys
from tools.init_docker_secrets import initialize


@pytest.fixture
def configured(monkeypatch, tmp_path):
    directory = tmp_path / "keys"
    initialize(directory)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("HALO_STATE_DIR", str(state))
    for role in ("APPROVER", "EXECUTOR"):
        # Record absence too, so file-loader assignments are undone after test.
        monkeypatch.setenv(f"HALO_{role}_KEY", "")
        monkeypatch.delenv(f"HALO_{role}_KEY", raising=False)
        monkeypatch.setenv(f"HALO_{role}_KEY_FILE", str(directory / (role.lower() + "_key")))
    return directory, state


def test_secret_initialization_is_private_and_does_not_replace_keys(tmp_path):
    directory = tmp_path / "keys"
    initialize(directory)
    original = (directory / "approver_key").read_bytes()
    assert directory.stat().st_mode & 0o777 == 0o700
    assert original != (directory / "executor_key").read_bytes()
    with pytest.raises(FileExistsError):
        initialize(directory)
    assert (directory / "approver_key").read_bytes() == original


def test_secret_initialization_rejects_public_parent(tmp_path):
    directory = tmp_path / "keys"
    directory.mkdir()
    directory.chmod(0o755)
    with pytest.raises(ValueError):
        initialize(directory)
    assert list(directory.iterdir()) == []


@pytest.mark.parametrize("content", [b"short", b"x" * 257, b"\xff" * 40, b"a b" * 20])
def test_bad_secret_file_is_rejected(configured, content):
    directory, _ = configured
    key = directory / "approver_key"
    key.chmod(0o600)
    key.write_bytes(content)
    with pytest.raises(ValueError):
        load_role_keys()


def test_ambiguous_key_configuration_is_rejected(configured, monkeypatch):
    monkeypatch.setenv("HALO_APPROVER_KEY", "a" * 48)
    with pytest.raises(ValueError, match="Set only"):
        load_role_keys()


def test_http_gateway_with_file_keys_and_persistent_private_state(configured, capsys):
    directory, state = configured
    app = application()
    server = make_server("127.0.0.1", 0, app, handler_class=QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    approver = (directory / "approver_key").read_text().strip()
    executor = (directory / "executor_key").read_text().strip()

    def request(path, key=None, body=None):
        connection = http.client.HTTPConnection(*server.server_address, timeout=3)
        try:
            headers = {"Content-Type": "application/json"}
            if key:
                headers["Authorization"] = "Bearer " + key
            connection.request("POST" if body is not None else "GET", path,
                               json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    try:
        assert request("/healthz")[0] == 200
        status, grant = request("/approve", approver,
            {"tool": "sha256", "args": {"text": "hello"}, "intent_id": "local-dev"})
        assert status == 200
        body = {"tool": "sha256", "args": {"text": "hello"}, "token": grant["token"]}
        assert request("/execute", approver, body)[0] == 403
        status, result = request("/execute", executor, body)
        assert status == 200 and result["sha256"] == hashlib.sha256(b"hello").hexdigest()
        assert request("/execute", executor, body)[0] == 403
        assert (state / "gateway.sqlite3").stat().st_mode & 0o077 == 0
        assert list(state.glob("*.realm-*.id"))
        # Gateway restart uses the persisted claim and refuses the old grant.
        from halo.gateway_app import create_app
        from halo.gateway import Rejected
        with pytest.raises(Rejected):
            create_app().handle("/execute", executor, body)
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()
    logs = capsys.readouterr()
    assert approver not in logs.out + logs.err
    assert executor not in logs.out + logs.err
    assert grant["token"] not in logs.out + logs.err
