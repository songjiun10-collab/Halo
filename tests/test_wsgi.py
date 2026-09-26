import os
import sys

import pytest

from tools.init_docker_secrets import initialize


@pytest.fixture
def configured(monkeypatch, tmp_path):
    directory = tmp_path / "keys"
    initialize(directory)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("HALO_STATE_DIR", str(state))
    for role in ("APPROVER", "EXECUTOR"):
        monkeypatch.delenv(f"HALO_{role}_KEY", raising=False)
        monkeypatch.setenv(f"HALO_{role}_KEY_FILE", str(directory / (role.lower() + "_key")))
    return directory, state


def test_wsgi_sets_restrictive_umask_and_builds_a_callable_app(configured, monkeypatch):
    monkeypatch.delitem(sys.modules, "halo.wsgi", raising=False)
    prior = os.umask(0o022)
    try:
        import halo.wsgi as wsgi

        observed = os.umask(0o022)
        os.umask(observed)
        assert observed == 0o077
        assert callable(wsgi.application)
    finally:
        os.umask(prior)
        monkeypatch.delitem(sys.modules, "halo.wsgi", raising=False)


def test_wsgi_application_serves_healthz(configured, monkeypatch):
    monkeypatch.delitem(sys.modules, "halo.wsgi", raising=False)
    import halo.wsgi as wsgi

    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    environ = {
        "REQUEST_METHOD": "GET",
        "PATH_INFO": "/healthz",
        "SERVER_PROTOCOL": "HTTP/1.1",
    }
    body = b"".join(wsgi.application(environ, start_response))
    assert captured["status"] == "200 OK"
    assert b"ready" in body
    monkeypatch.delitem(sys.modules, "halo.wsgi", raising=False)
