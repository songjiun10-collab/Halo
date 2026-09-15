import hashlib
import pytest
from halo.gateway import Gateway, Tool, Rejected


APPROVER = "a" * 48
EXECUTOR = "e" * 48


def make(path, calls):
    def execute(args):
        calls.append(args)
        return {"digest": hashlib.sha256(args["text"].encode()).hexdigest()}
    return Gateway(path, APPROVER, EXECUTOR, {
        "hash": Tool("v1", lambda a: type(a) is dict and set(a) == {"text"}
                     and type(a["text"]) is str and len(a["text"]) <= 1000, execute)
    })


def test_roles_binding_persistence_and_replay(tmp_path):
    calls = []
    path = tmp_path / "gateway.db"
    gateway = make(path, calls)
    request = {"tool": "hash", "args": {"text": "hello"}, "intent_id": "user-1"}
    with pytest.raises(Rejected):
        gateway.handle("/approve", EXECUTOR, request)
    token = gateway.handle("/approve", APPROVER, request)["token"]
    gateway = make(path, calls)
    with pytest.raises(Rejected):
        gateway.handle("/execute", EXECUTOR, {"token": token, "tool": "hash", "args": {"text": "changed"}})
    result = gateway.handle("/execute", EXECUTOR, {"token": token, "tool": "hash", "args": request["args"]})
    assert result["digest"] == hashlib.sha256(b"hello").hexdigest()
    with pytest.raises(Rejected):
        make(path, calls).handle("/execute", EXECUTOR, {"token": token, "tool": "hash", "args": request["args"]})
    assert len(calls) == 1


def test_unknown_tools_forged_tokens_and_approval_fields(tmp_path):
    calls = []
    gateway = make(tmp_path / "g.db", calls)
    for body in ({"tool": "shell", "args": {}, "token": "fake"},
                 {"tool": "hash", "args": {"text": "x"}, "token": "approved=True"},
                 {"tool": "hash", "args": {"text": "x"}, "token": "fake", "approved": True}):
        with pytest.raises(Rejected):
            gateway.handle("/execute", EXECUTOR, body)
    assert not calls


def test_revocation_and_concurrent_execution(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / "g.db"
    calls = []
    gateway = make(path, calls)
    body = {"tool": "hash", "args": {"text": "x"}, "intent_id": "one"}
    token = gateway.handle("/approve", APPROVER, body)["token"]
    gateway.handle("/revoke", APPROVER, {"token": token})
    request = {"tool": "hash", "args": body["args"], "token": token}
    with pytest.raises(Rejected):
        gateway.handle("/execute", EXECUTOR, request)
    request["token"] = gateway.handle("/approve", APPROVER, body)["token"]
    def attempt(_):
        try:
            make(path, calls).handle("/execute", EXECUTOR, request)
            return 1
        except Rejected:
            return 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(attempt, range(12))) == 1
    assert len(calls) == 1


def test_wsgi_parsing_and_role_enforcement(tmp_path):
    import io
    import json
    calls = []
    app = make(tmp_path / "g.db", calls)
    def post(path, key, raw):
        statuses = []
        env = {"REQUEST_METHOD": "POST", "PATH_INFO": path,
               "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json",
               "HTTP_AUTHORIZATION": "Bearer " + key, "wsgi.input": io.BytesIO(raw)}
        response = b"".join(app(env, lambda status, headers: statuses.append(status)))
        return statuses[0], json.loads(response)
    body = {"tool": "hash", "args": {"text": "hello"}, "intent_id": "one"}
    assert post("/approve", EXECUTOR, json.dumps(body).encode())[0] == "403 Forbidden"
    assert post("/approve", APPROVER, b'{"tool":"hash","tool":"shell"}')[0] == "403 Forbidden"
    status, result = post("/approve", APPROVER, json.dumps(body).encode())
    assert status == "200 OK"
    request = {"token": result["token"], "tool": "hash", "args": body["args"]}
    assert post("/execute", EXECUTOR, json.dumps(request).encode())[0] == "200 OK"
    assert post("/execute", EXECUTOR, json.dumps(request).encode())[0] == "403 Forbidden"


def test_changed_adapter_and_failure_consume_rules(tmp_path):
    calls = []
    path = tmp_path / "g.db"
    gateway = make(path, calls)
    body = {"tool": "hash", "args": {"text": "hello"}, "intent_id": "one"}
    token = gateway.handle("/approve", APPROVER, body)["token"]
    request = {"token": token, "tool": "hash", "args": body["args"]}
    changed = Gateway(path, APPROVER, EXECUTOR, {"hash": Tool("v2", lambda a: True, lambda a: {})})
    with pytest.raises(Rejected):
        changed.handle("/execute", EXECUTOR, request)
    def fail(args):
        raise RuntimeError("failure")
    failing = Gateway(path, APPROVER, EXECUTOR, {"hash": Tool("v1", lambda a: True, fail)})
    with pytest.raises(Rejected):
        failing.handle("/execute", EXECUTOR, request)
    with pytest.raises(Rejected):
        gateway.handle("/execute", EXECUTOR, request)
    assert not calls
