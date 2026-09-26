import threading
from wsgiref.simple_server import make_server

import pytest

from tools.duckdns_update import _read_private_file, main, update


def _write_private(path, content, mode=0o600):
    path.write_text(content)
    path.chmod(mode)
    return path


def test_accepts_private_file_and_strips_newline(tmp_path):
    path = _write_private(tmp_path / "token", "abc123\n")
    assert _read_private_file(path) == "abc123"


def test_rejects_group_or_world_readable(tmp_path):
    path = _write_private(tmp_path / "token", "abc123\n", mode=0o640)
    with pytest.raises(ValueError, match="private regular file"):
        _read_private_file(path)


def test_rejects_symlink(tmp_path):
    real = _write_private(tmp_path / "real-token", "abc123\n")
    link = tmp_path / "token"
    link.symlink_to(real)
    with pytest.raises(ValueError, match="private regular file"):
        _read_private_file(link)


def test_rejects_oversized_file(tmp_path):
    path = _write_private(tmp_path / "token", "x" * 300)
    with pytest.raises(ValueError, match="unexpectedly large"):
        _read_private_file(path, max_bytes=256)


@pytest.fixture
def live_duckdns_stub():
    """A local HTTP server standing in for www.duckdns.org, so update()'s
    request-building and response-parsing can be exercised without a real
    network call or a mocked urllib internals."""
    received = {}

    def app(environ, start_response):
        received["path_qs"] = environ.get("PATH_INFO", "") + "?" + environ.get("QUERY_STRING", "")
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"OK"]

    server = make_server("127.0.0.1", 0, app)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, received
    finally:
        server.shutdown()
        thread.join()


def test_update_builds_expected_query_and_parses_ok_response(monkeypatch, live_duckdns_stub):
    server, received = live_duckdns_stub
    host, port = server.server_address

    import tools.duckdns_update as mod

    real_urlopen = mod.urllib.request.urlopen

    def fake_urlopen(url, timeout):
        assert url.startswith("https://www.duckdns.org/update?")
        request_url = url.replace("https://www.duckdns.org", f"http://{host}:{port}", 1)
        return real_urlopen(request_url, timeout=timeout)

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
    result = update("myhost", "sekret-token")
    assert result == "OK"
    assert "domains=myhost" in received["path_qs"]
    assert "token=sekret-token" in received["path_qs"]


def test_main_exits_nonzero_when_response_is_not_ok(monkeypatch, tmp_path, capsys):
    import tools.duckdns_update as mod

    monkeypatch.setattr(mod, "DOMAIN_FILE", _write_private(tmp_path / "domain", "myhost\n"))
    monkeypatch.setattr(mod, "TOKEN_FILE", _write_private(tmp_path / "token", "sekret\n"))
    monkeypatch.setattr(mod, "update", lambda domain, token: "KO")
    with pytest.raises(SystemExit) as excinfo:
        main()
    assert excinfo.value.code == 1
    assert "failed" in capsys.readouterr().err


def test_main_succeeds_when_response_is_ok(monkeypatch, tmp_path, capsys):
    import tools.duckdns_update as mod

    monkeypatch.setattr(mod, "DOMAIN_FILE", _write_private(tmp_path / "domain", "myhost\n"))
    monkeypatch.setattr(mod, "TOKEN_FILE", _write_private(tmp_path / "token", "sekret\n"))
    calls = []
    monkeypatch.setattr(mod, "update", lambda domain, token: calls.append((domain, token)) or "OK")
    main()
    assert calls == [("myhost", "sekret")]
    assert "OK" in capsys.readouterr().out
