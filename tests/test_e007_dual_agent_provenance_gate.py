"""E007 -- ApproverAgent/ExecutorAgent judgment is entirely halo.safety_cases
.evaluate_trace() + halo.policy.decide(); this suite pins that no free-form
judgment, self-reported trust, or silent REVIEW/DENY collapse can creep in.

The flagship result (tests below marked "core result") is the provenance-
laundering catch already tracked in the repo's ledger as P9-B2: an executor
that self-labels its own request provenance="trusted" is denied once the
approver applies an independently-acquired host_provenance classification,
whereas an approver that naively trusted the self-report would have allowed
it -- both sides of that contrast are asserted directly, not by fiat.
"""
import hashlib
import http.client
import json
import threading
from wsgiref.simple_server import make_server

import pytest

from halo.dev_server import QuietHandler, application
from halo.policy import Decision
from halo.safety_cases import Signal, evaluate_trace
from tools.init_docker_secrets import initialize

from experiments.e007_dual_agent_provenance_gate.channel import LoopbackChannel
from experiments.e007_dual_agent_provenance_gate.experiment import (
    ApprovalDecision,
    ApprovalRequest,
    ApproverAgent,
    EventClaim,
    ExecutorAgent,
    GatewayClient,
    ProtocolError,
    RequestDenied,
)


# ---------------------------------------------------------------------------
# Wire-format strictness -- no I/O.
# ---------------------------------------------------------------------------

def _claim(**changes):
    base = dict(kind="tool", provenance="trusted", action="compute", target_scope="local",
               declared_scope="local", effect=None, contains_secret=False,
               telemetry_complete=True, approved=False, metadata={})
    base.update(changes)
    return EventClaim(**base)


def test_event_claim_round_trip_preserves_fields():
    claim = _claim(metadata={"k": "v"})
    assert EventClaim.from_plain(claim.to_plain()) == claim


@pytest.mark.parametrize("bad", [None, [], "not-a-dict", 42])
def test_event_claim_from_plain_rejects_non_dict(bad):
    with pytest.raises(ProtocolError):
        EventClaim.from_plain(bad)


def test_event_claim_from_plain_rejects_unexpected_or_missing_keys():
    plain = _claim().to_plain()
    plain["unexpected"] = "x"
    with pytest.raises(ProtocolError):
        EventClaim.from_plain(plain)
    del plain["unexpected"]
    del plain["kind"]
    with pytest.raises(ProtocolError):
        EventClaim.from_plain(plain)


def test_event_claim_from_plain_rejects_wrong_field_types():
    plain = _claim().to_plain()
    plain["contains_secret"] = "true"
    with pytest.raises(ProtocolError):
        EventClaim.from_plain(plain)


def test_approval_request_from_plain_rejects_oversized_events_list():
    plain = {"tool": "sha256", "args": {}, "intent_id": "x",
             "events": [_claim().to_plain()] * 65}
    with pytest.raises(ProtocolError):
        ApprovalRequest.from_plain(plain)


def test_approval_request_from_plain_rejects_empty_events_list():
    plain = {"tool": "sha256", "args": {}, "intent_id": "x", "events": []}
    with pytest.raises(ProtocolError):
        ApprovalRequest.from_plain(plain)


def test_approval_decision_round_trip_allow_carries_token():
    decision = ApprovalDecision(decision=Decision.ALLOW, reasons=(), token="tok", expires_in=60)
    assert ApprovalDecision.from_plain(decision.to_plain()) == decision


def test_approval_decision_round_trip_deny_carries_no_token():
    decision = ApprovalDecision(decision=Decision.DENY, reasons=("bad",))
    assert ApprovalDecision.from_plain(decision.to_plain()) == decision


@pytest.mark.parametrize("token", ["present", None])
def test_approval_decision_from_plain_rejects_token_decision_mismatch(token):
    # ALLOW must carry a token; every other decision must not.
    plain = {"decision": "allow" if token is None else "deny",
             "reasons": [], "token": token, "expires_in": None}
    with pytest.raises(ProtocolError):
        ApprovalDecision.from_plain(plain)


# ---------------------------------------------------------------------------
# Test doubles.
# ---------------------------------------------------------------------------

class _CountingGatewayClient(GatewayClient):
    """Spy: records approve() calls without ever making a real request."""

    def __init__(self):
        self.approve_calls = []

    def approve(self, tool, args, intent_id):
        self.approve_calls.append((tool, args, intent_id))
        return 200, {"token": "unused", "expires_in": 60}


def _benign_request(provenance="trusted"):
    return ApprovalRequest(
        tool="sha256", args={"text": "hello"}, intent_id="e007-test",
        events=(_claim(kind="tool", action="compute", provenance=provenance,
                       target_scope="local", declared_scope="local"),))


# ---------------------------------------------------------------------------
# (a) Benign flow.
# ---------------------------------------------------------------------------

def test_benign_compute_request_allowed_with_agreeing_host_classification():
    gateway = _CountingGatewayClient()
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "trusted")
    findings, result = approver.evaluate(_benign_request())
    assert findings == []
    assert result.decision is Decision.ALLOW


# ---------------------------------------------------------------------------
# (b) Provenance-laundering catch -- core result.
# ---------------------------------------------------------------------------

def test_self_reported_trusted_but_host_classifies_untrusted_is_denied():
    gateway = _CountingGatewayClient()
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "untrusted")
    findings, result = approver.evaluate(_benign_request(provenance="trusted"))
    assert any(f.signal is Signal.MONITORING_GAP and "disagrees with host telemetry" in f.reason
              for f in findings)
    # effectful=True (the ApproverAgent default) turns a MONITORING_GAP into a
    # hard DENY, not REVIEW -- see halo/policy.py's effectful branch.
    assert result.decision is Decision.DENY
    assert gateway.approve_calls == []


def test_naive_self_report_trust_would_have_wrongly_allowed():
    """The contrast half of the core result: an approver that skips the
    independent host_provenance classification and lets the executor's own
    self-report stand unchallenged reaches ALLOW on the exact same request
    that test_self_reported_trusted_but_host_classifies_untrusted_is_denied
    correctly denies. This proves the defense is doing real work, not just
    asserted by fiat."""
    request = _benign_request(provenance="trusted")
    events = [claim.to_event() for claim in request.events]
    findings = evaluate_trace(events, trusted_telemetry=False, host_provenance=None)
    assert findings == []
    from halo.policy import decide
    assert decide(findings, effectful=True).decision is Decision.ALLOW


def test_end_to_end_provenance_mismatch_never_reaches_gateway():
    gateway = _CountingGatewayClient()
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "untrusted")
    executor_side, approver_side = LoopbackChannel.make_pair()
    executor_side.send(_benign_request(provenance="trusted").to_plain())
    approver.serve_once(approver_side)
    decision = ApprovalDecision.from_plain(executor_side.recv())
    assert decision.decision is Decision.DENY
    assert gateway.approve_calls == []


# ---------------------------------------------------------------------------
# (c) Hard-deny signals win regardless of self-report.
# ---------------------------------------------------------------------------

def test_secret_egress_self_reported_approved_is_denied_regardless_of_host_classification():
    gateway = _CountingGatewayClient()
    # classify_provenance agrees with the (lying) self-report -- the secret
    # scan must still fire independently of any provenance judgment.
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "trusted")
    request = ApprovalRequest(
        tool="sha256", args={"text": "x"}, intent_id="e007-test",
        events=(_claim(kind="tool", action="send_email", provenance="trusted",
                       target_scope="external", declared_scope="external",
                       contains_secret=True, approved=True,
                       metadata={"body": "api_key=" + "a" * 40}),))
    findings, result = approver.evaluate(request)
    assert any(f.signal is Signal.SECRET_EGRESS and f.severity == 5 for f in findings)
    assert result.decision is Decision.DENY
    assert gateway.approve_calls == []


def test_privilege_escalation_without_independent_approval_is_denied():
    gateway = _CountingGatewayClient()
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "trusted")
    request = ApprovalRequest(
        tool="sha256", args={"text": "x"}, intent_id="e007-test",
        events=(_claim(kind="tool", action="grant_access", provenance="trusted",
                       target_scope="workspace", declared_scope="workspace",
                       approved=False),))
    findings, result = approver.evaluate(request)
    assert any(f.signal is Signal.PRIVILEGE_ESCALATION for f in findings)
    assert result.decision is Decision.DENY


def test_approver_default_trusted_telemetry_false_denies_effectful_claims_by_construction():
    gateway = _CountingGatewayClient()
    # An otherwise-clean, fully-approved, scope-matched external write --
    # still denied, because ApproverAgent never sets trusted_telemetry=True
    # (it has no independently-acquired telemetry channel in this demo).
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "trusted")
    request = ApprovalRequest(
        tool="sha256", args={"text": "x"}, intent_id="e007-test",
        events=(_claim(kind="tool", action="send_message", provenance="trusted",
                       target_scope="external", declared_scope="external",
                       approved=True),))
    findings, result = approver.evaluate(request)
    assert any(f.signal is Signal.MONITORING_GAP
              and "not independent execution authority" in f.reason for f in findings)
    assert result.decision is Decision.DENY


# ---------------------------------------------------------------------------
# (e) REVIEW is a distinct outcome, never silently collapsed.
# ---------------------------------------------------------------------------

def test_review_decision_surfaces_reasons_and_is_not_silently_allow_or_deny():
    gateway = _CountingGatewayClient()
    # classify_provenance AGREES with the self-report here (both "untrusted"):
    # no host/self disagreement, so no MONITORING_GAP is produced. Under
    # effectful=True, policy.decide() turns any MONITORING_GAP into a hard
    # DENY before review_signals is even consulted (see
    # test_self_reported_trusted_but_host_classifies_untrusted_is_denied) --
    # this case isolates a clean UNTRUSTED_INSTRUCTION-only finding so the
    # REVIEW branch itself is reachable and distinguishable from DENY.
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "untrusted")
    request = ApprovalRequest(
        tool="sha256", args={"text": "x"}, intent_id="e007-test",
        events=(_claim(kind="instruction", provenance="untrusted", action=None,
                       target_scope=None, declared_scope=None),))
    findings, result = approver.evaluate(request)
    assert result.decision is Decision.REVIEW
    assert result.reasons

    executor_gateway = GatewayClient("127.0.0.1", 1, "x" * 32)  # never actually called
    executor_side, approver_side = LoopbackChannel.make_pair()
    executor = ExecutorAgent(executor_gateway, executor_side)
    outcomes = []
    def run_executor():
        try:
            outcomes.append(("result", executor.run(request)))
        except RequestDenied as exc:
            outcomes.append(("denied", exc.decision, exc.reasons))
    thread = threading.Thread(target=run_executor)
    thread.start()
    approver.serve_once(approver_side)
    thread.join(timeout=3)

    assert outcomes and outcomes[0][0] == "denied"
    assert outcomes[0][1] is Decision.REVIEW  # distinguishable from DENY
    assert outcomes[0][2] == result.reasons  # reasons passed through verbatim
    assert gateway.approve_calls == []


def test_approver_never_calls_gateway_approve_on_review_or_deny():
    gateway = _CountingGatewayClient()
    approver = ApproverAgent(gateway, classify_provenance=lambda req: "untrusted")
    deny_request = _benign_request(provenance="trusted")
    review_request = ApprovalRequest(
        tool="sha256", args={"text": "x"}, intent_id="e007-test",
        events=(_claim(kind="instruction", provenance="untrusted", action=None,
                       target_scope=None, declared_scope=None),))
    approver.decide_and_approve(deny_request)
    approver.decide_and_approve(review_request)
    assert gateway.approve_calls == []


# ---------------------------------------------------------------------------
# (d) Role-key isolation over real HTTP, both directions.
# ---------------------------------------------------------------------------

@pytest.fixture
def configured(monkeypatch, tmp_path):
    directory = tmp_path / "keys"
    initialize(directory)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("HALO_STATE_DIR", str(state))
    for role in ("APPROVER", "EXECUTOR"):
        monkeypatch.setenv(f"HALO_{role}_KEY", "")
        monkeypatch.delenv(f"HALO_{role}_KEY", raising=False)
        monkeypatch.setenv(f"HALO_{role}_KEY_FILE", str(directory / (role.lower() + "_key")))
    return directory, state


@pytest.fixture
def live_gateway(configured):
    directory, _state = configured
    app = application()
    server = make_server("127.0.0.1", 0, app, handler_class=QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    approver_key = (directory / "approver_key").read_text().strip()
    executor_key = (directory / "executor_key").read_text().strip()
    try:
        yield host, port, approver_key, executor_key
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()


def test_end_to_end_allow_executes_real_sha256_over_http(live_gateway):
    host, port, approver_key, executor_key = live_gateway
    approver_gateway = GatewayClient(host, port, approver_key)
    executor_gateway = GatewayClient(host, port, executor_key)
    approver = ApproverAgent(approver_gateway, classify_provenance=lambda req: "trusted")
    executor_side, approver_side = LoopbackChannel.make_pair()
    executor = ExecutorAgent(executor_gateway, executor_side)

    request = _benign_request(provenance="trusted")
    request_thread = threading.Thread(target=lambda: results.append(executor.run(request)))
    results = []
    request_thread.start()
    approver.serve_once(approver_side)
    request_thread.join(timeout=3)

    assert results and results[0]["sha256"] == hashlib.sha256(b"hello").hexdigest()


def test_end_to_end_denied_request_raises_and_never_calls_execute(live_gateway):
    host, port, approver_key, executor_key = live_gateway
    approver_gateway = GatewayClient(host, port, approver_key)
    executor_gateway = GatewayClient(host, port, executor_key)
    approver = ApproverAgent(approver_gateway, classify_provenance=lambda req: "untrusted")
    executor_side, approver_side = LoopbackChannel.make_pair()
    executor = ExecutorAgent(executor_gateway, executor_side)

    request = _benign_request(provenance="trusted")
    outcomes = []
    def run_executor():
        try:
            outcomes.append(("result", executor.run(request)))
        except RequestDenied as exc:
            outcomes.append(("denied", exc.decision, exc.reasons))
    thread = threading.Thread(target=run_executor)
    thread.start()
    approver.serve_once(approver_side)
    thread.join(timeout=3)

    assert outcomes and outcomes[0][0] == "denied"
    assert outcomes[0][1] is Decision.DENY
    assert outcomes[0][2]  # reasons are non-empty, not swallowed


def test_end_to_end_approver_key_cannot_execute(live_gateway):
    host, port, approver_key, _executor_key = live_gateway
    approver_gateway = GatewayClient(host, port, approver_key)
    status, grant = approver_gateway.approve("sha256", {"text": "hello"}, "e007-test")
    assert status == 200
    status, _body = approver_gateway.execute("sha256", {"text": "hello"}, grant["token"])
    assert status == 403


def test_end_to_end_executor_key_cannot_approve(live_gateway):
    host, port, _approver_key, executor_key = live_gateway
    executor_gateway = GatewayClient(host, port, executor_key)
    status, _body = executor_gateway.approve("sha256", {"text": "hello"}, "e007-test")
    assert status == 403


# Real OS-process transport. Existing in-process coverage above stays intact.
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time


@pytest.fixture
def private_socket_path():
    # macOS sockaddr_un has a short path limit; canonicalize /tmp's symlink.
    with tempfile.TemporaryDirectory(prefix="e007-", dir="/tmp") as directory:
        yield Path(directory).resolve() / "channel.sock"


def _role_env(role, directory):
    return {"PATH": os.defpath,
            f"HALO_{role}_KEY_FILE": str(directory / (role.lower() + "_key"))}


def _process_args(role, path, host, port):
    return [sys.executable, "-m", f"experiments.e007_dual_agent_provenance_gate.{role}_process",
            "--socket", str(path), "--gateway-host", host, "--gateway-port", str(port)]


@pytest.mark.parametrize("provenance,exit_code", [("trusted", 0), ("untrusted", 1)])
def test_real_process_pair_completes(live_gateway, configured, private_socket_path,
                                    provenance, exit_code):
    host, port, *_ = live_gateway
    directory, _ = configured
    approver = subprocess.Popen(
        _process_args("approver", private_socket_path, host, port)
        + ["--provenance", provenance], env=_role_env("APPROVER", directory),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    executor = None
    try:
        deadline = time.monotonic() + 5
        while not private_socket_path.exists():
            assert approver.poll() is None, approver.communicate()
            assert time.monotonic() < deadline
            time.sleep(0.01)
        executor = subprocess.Popen(
            _process_args("executor", private_socket_path, host, port)
            + ["--request-json", json.dumps(_benign_request().to_plain())],
            env=_role_env("EXECUTOR", directory),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = executor.communicate(timeout=10)
        assert executor.returncode == exit_code, (out, err)
        result = json.loads(out)
        if exit_code == 0:
            assert result["sha256"] == hashlib.sha256(b"hello").hexdigest()
        else:
            assert result["decision"] == "deny" and result["reasons"]
        _, err = approver.communicate(timeout=10)
        assert approver.returncode == 0, err
        assert not private_socket_path.exists()
    finally:
        for process in (executor, approver):
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


@pytest.mark.parametrize("role,opposite", [("approver", "EXECUTOR"), ("executor", "APPROVER")])
@pytest.mark.parametrize("suffix", ["", "_FILE"])
def test_process_rejects_opposite_key_before_socket(role, opposite, suffix,
                                                 configured, private_socket_path):
    directory, _ = configured
    env = _role_env(role.upper(), directory)
    env[f"HALO_{opposite}_KEY{suffix}"] = ""  # Presence, even empty, is forbidden.
    args = _process_args(role, private_socket_path, "127.0.0.1", 1)
    if role == "executor":
        args += ["--request-json", json.dumps(_benign_request().to_plain())]
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert "opposite role" in result.stderr
    assert not private_socket_path.exists()


@pytest.mark.parametrize("wire", [struct.pack("!I", 65537), b"\x00\x00",
                                  struct.pack("!I", 5) + b"{}"])
def test_unix_channel_rejects_oversized_or_truncated_frame(wire):
    from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel
    left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    channel = UnixSocketChannel(left, server=True)
    try:
        right.sendall(wire)
        right.shutdown(socket.SHUT_WR)
        with pytest.raises((ValueError, EOFError)):
            channel.recv()
        assert left.fileno() == -1
    finally:
        channel.close()
        right.close()


def test_demo_uses_real_role_processes(live_gateway, configured, private_socket_path):
    host, port, *_ = live_gateway
    directory, _ = configured
    result = subprocess.run(
        [sys.executable, "-m", "experiments.e007_dual_agent_provenance_gate.run_two_process_demo",
         "--socket", str(private_socket_path), "--gateway-host", host,
         "--gateway-port", str(port), "--approver-key-file", str(directory / "approver_key"),
         "--executor-key-file", str(directory / "executor_key"), "--provenance", "trusted"],
        # Deliberately contaminate the orchestrator's environment. Children must
        # receive fresh role-only environments rather than inheriting these.
        env={"PATH": os.defpath, "HALO_APPROVER_KEY": "do-not-forward-approver",
             "HALO_EXECUTOR_KEY": "do-not-forward-executor",
             "HALO_APPROVER_KEY_FILE": "/missing/approver",
             "HALO_EXECUTOR_KEY_FILE": "/missing/executor"},
        capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert json.loads(result.stdout)["sha256"] == hashlib.sha256(b"hello").hexdigest()


@pytest.mark.parametrize("operation", ["listen", "connect"])
def test_unix_channel_rejects_symlinks_and_nonprivate_directory(private_socket_path, operation):
    from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel
    open_channel = getattr(UnixSocketChannel, operation)
    target = private_socket_path.parent / "keep.txt"
    target.write_text("do not replace")
    private_socket_path.symlink_to(target)
    with pytest.raises(ValueError):
        open_channel(private_socket_path)
    assert private_socket_path.is_symlink()
    assert target.read_text() == "do not replace"
    private_socket_path.unlink()
    link_dir = private_socket_path.parent / "alias"
    link_dir.symlink_to(private_socket_path.parent, target_is_directory=True)
    with pytest.raises(OSError):
        open_channel(link_dir / "socket")
    private_socket_path.parent.chmod(0o755)
    try:
        with pytest.raises(ValueError, match="0700"):
            open_channel(private_socket_path)
    finally:
        private_socket_path.parent.chmod(0o700)


def test_unix_channel_exact_frame_limit_and_one_shot():
    from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel
    left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    client, server = UnixSocketChannel(left), UnixSocketChannel(right, server=True)
    # Compact encoding is 8 bytes of syntax plus the string.
    message = {"x": "a" * (65536 - 8)}
    received = []
    receiver = threading.Thread(target=lambda: received.append(server.recv()))
    receiver.start()
    try:
        client.send(message)
        receiver.join(timeout=5)
        assert received == [message]
        server.send({"decision": "deny"})
        assert right.fileno() == -1
        assert client.recv() == {"decision": "deny"}
        assert left.fileno() == -1
        with pytest.raises(ValueError):
            client.send({})
        with pytest.raises(ValueError):
            server.recv()
    finally:
        client.close()
        server.close()
        receiver.join(timeout=5)


@pytest.mark.parametrize("body", [b'[]', b'{"x":NaN}', b'{"x":1,"x":2}', b'\xff'])
def test_unix_channel_rejects_nonplain_json(body):
    from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel
    left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    channel = UnixSocketChannel(left, server=True)
    try:
        right.sendall(struct.pack("!I", len(body)) + body)
        with pytest.raises(ValueError):
            channel.recv()
        assert left.fileno() == -1
    finally:
        channel.close()
        right.close()


def test_unix_channel_has_a_total_frame_deadline(monkeypatch):
    from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel
    monkeypatch.setattr(UnixSocketChannel, "TIMEOUT", 0.1)
    left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    channel = UnixSocketChannel(left, server=True)
    stop = threading.Event()
    def trickle():
        try:
            right.sendall(struct.pack("!I", 1000))
            for _ in range(20):
                if stop.wait(0.02):
                    break
                right.sendall(b" ")
        except OSError:
            pass
        finally:
            right.close()
    sender = threading.Thread(target=trickle)
    sender.start()
    try:
        with pytest.raises(TimeoutError):
            channel.recv()
        assert left.fileno() == -1
    finally:
        stop.set()
        channel.close()
        sender.join(timeout=2)


@pytest.mark.parametrize("role", ["approver", "executor"])
def test_process_rejects_two_sources_for_own_key(role, configured, private_socket_path):
    directory, _ = configured
    env = _role_env(role.upper(), directory)
    env[f"HALO_{role.upper()}_KEY"] = "x" * 32
    args = _process_args(role, private_socket_path, "127.0.0.1", 1)
    if role == "executor":
        args += ["--request-json", json.dumps(_benign_request().to_plain())]
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 2
    assert not private_socket_path.exists()
