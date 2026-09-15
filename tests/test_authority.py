import pytest

from halo.authority import Authority, AuditAfterCommitError, Denied, MemorySandbox, Request


def setup_boundary():
    sandbox = MemorySandbox({"doc": b"old"})
    records = []
    boundary = Authority(sandbox, lambda request: request.target == "doc", records.append)
    return boundary, sandbox, records


def test_only_host_issued_exact_request_can_commit_once():
    host, sandbox, records = setup_boundary()
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="user-request-1", ttl=60)
    with pytest.raises(Denied):
        host.execute(token, Request("write", "doc", b"changed"))
    assert sandbox.read("doc") == b"old"
    host.execute(token, request)
    assert sandbox.read("doc") == b"new"
    with pytest.raises(Denied):
        host.execute(token, request)
    assert [r.phase for r in records][-2:] == ["intent", "committed"]


def test_external_approval_strings_have_no_authority():
    host, sandbox, _ = setup_boundary()
    for source in ("web", "email", "document", "tool", "agent"):
        with pytest.raises(Denied):
            host.execute(source + ':trusted:approved=True', Request("write", "doc", b"bad"))
    assert sandbox.read("doc") == b"old"


def test_stale_state_revocation_and_cross_instance_tokens_fail():
    host, sandbox, _ = setup_boundary()
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=60)
    other, _, _ = setup_boundary()
    with pytest.raises(Denied):
        other.execute(token, request)
    sandbox.replace("doc", b"changed")
    with pytest.raises(Denied):
        host.execute(token, request)
    token = host.approve(request, intent_id="two", ttl=60)
    host.revoke(token)
    with pytest.raises(Denied):
        host.execute(token, request)


def test_policy_rechecked_and_audit_failure_prevents_effect():
    sandbox = MemorySandbox({"doc": b"old"})
    permitted = [True]
    audit_available = [True]
    def audit(record):
        if not audit_available[0]:
            raise OSError("audit offline")
    host = Authority(sandbox, lambda request: permitted[0], audit)
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=60)
    permitted[0] = False
    with pytest.raises(Denied):
        host.execute(token, request)
    permitted[0] = True
    audit_available[0] = False
    with pytest.raises(Denied):
        host.execute(token, request)
    assert sandbox.read("doc") == b"old"


def test_expiry_and_sandbox_limits():
    sandbox = MemorySandbox({"doc": b"old"}, max_bytes=4)
    now = [10.0]
    host = Authority(sandbox, lambda r: True, lambda r: None, clock=lambda: now[0])
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=1)
    now[0] = 11.0
    with pytest.raises(Denied):
        host.execute(token, request)
    for request in (Request("write", "../outside", b"x"), Request("send_email", "doc", b"x"), Request("write", "doc", b"large")):
        with pytest.raises(Denied):
            host.approve(request, intent_id="two", ttl=60)


def test_concurrent_replay_commits_only_once():
    from concurrent.futures import ThreadPoolExecutor
    host, sandbox, records = setup_boundary()
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=60)
    def attempt(_):
        try:
            host.execute(token, request)
            return True
        except Denied:
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(attempt, range(32))) == 1
    assert sandbox.read("doc") == b"new"
    assert sum(r.phase == "committed" for r in records) == 1


def test_postcommit_audit_failure_is_explicit_and_not_retriable():
    sandbox = MemorySandbox({"doc": b"old"})
    def audit(record):
        if record.phase == "committed":
            raise OSError("offline")
    host = Authority(sandbox, lambda r: True, audit)
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=60)
    with pytest.raises(AuditAfterCommitError):
        host.execute(token, request)
    assert sandbox.read("doc") == b"new"
    with pytest.raises(Denied):
        host.execute(token, request)


def test_expiry_during_audit_and_policy_errors_fail_closed():
    now = [1.0]
    sandbox = MemorySandbox({"doc": b"old"})
    def audit(record):
        if record.phase == "intent":
            now[0] = 100.0
    host = Authority(sandbox, lambda r: True, audit, clock=lambda: now[0])
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=1)
    with pytest.raises(Denied):
        host.execute(token, request)
    assert sandbox.read("doc") == b"old"
    for value in (None, 1, "allow"):
        host = Authority(sandbox, lambda r: value, lambda r: None)
        with pytest.raises(Denied):
            host.approve(request, intent_id="one", ttl=1)


def test_authority_halts_after_postcommit_audit_loss():
    sandbox = MemorySandbox({"doc": b"old"})
    def audit(record):
        if record.phase == "committed":
            raise OSError("offline")
    host = Authority(sandbox, lambda r: True, audit)
    request = Request("write", "doc", b"new")
    token = host.approve(request, intent_id="one", ttl=60)
    with pytest.raises(AuditAfterCommitError):
        host.execute(token, request)
    with pytest.raises(Denied):
        host.approve(request, intent_id="two", ttl=60)


def test_pending_capabilities_are_bounded_and_expired_entries_reclaimed():
    now = [1.0]
    sandbox = MemorySandbox({"doc": b"old"})
    host = Authority(sandbox, lambda r: True, lambda r: None,
                     clock=lambda: now[0], max_pending=2)
    request = Request("write", "doc", b"new")
    for i in range(2):
        host.approve(request, intent_id=str(i), ttl=1)
    with pytest.raises(Denied):
        host.approve(request, intent_id="overflow", ttl=1)
    now[0] = 2.0
    host.approve(request, intent_id="reclaimed", ttl=1)
