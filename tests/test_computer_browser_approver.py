import socket
import sys
import tempfile
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "computer-browser" / "approver"))
import approver_service as svc  # noqa: E402
from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel


def _request(action="navigate", source="user_prompt", self_provenance="trusted", **overrides):
    base = {
        "request_id": "r1",
        "action": action,
        "origin": "https://example.com",
        "summary": "test action",
        "self_provenance": self_provenance,
        "source": source,
        "target_scope": "external",
        "contains_secret": False,
    }
    base.update(overrides)
    return base


def test_host_provenance_for_trusts_only_user_prompt():
    assert svc.host_provenance_for({"source": "user_prompt"}) == "trusted"
    assert svc.host_provenance_for({"source": "page_content"}) == "untrusted"
    assert svc.host_provenance_for({}) == "trusted"


@pytest.mark.parametrize("field,value", [
    ("action", "eval"),
    ("source", "bogus"),
    ("self_provenance", "maybe"),
    ("target_scope", 5),
    ("contains_secret", "yes"),
])
def test_build_event_rejects_malformed_fields(field, value):
    with pytest.raises(ValueError):
        svc.build_event(_request(**{field: value}))


def test_build_event_maps_ui_action_onto_halo_vocabulary_and_keeps_ui_action_in_metadata():
    event = svc.build_event(_request(action="submit_form"))
    assert event.action == "post_web"
    assert event.effect == "external_write"
    assert event.metadata["ui_action"] == "submit_form"


@pytest.mark.parametrize("action", ["navigate", "click", "type"])
def test_benign_action_from_user_prompt_with_agreeing_provenance_allows(action):
    result = svc.evaluate(_request(action=action, source="user_prompt", self_provenance="trusted"))
    assert result["decision"] == "allow"


@pytest.mark.parametrize("action", ["navigate", "click", "type"])
def test_honest_untrusted_page_content_goes_to_review_not_silently_allow_or_deny(action):
    result = svc.evaluate(_request(action=action, source="page_content", self_provenance="untrusted"))
    assert result["decision"] == "review"
    assert result["reasons"]


@pytest.mark.parametrize("action", ["navigate", "click", "type"])
def test_lying_about_page_content_provenance_is_denied_not_allowed(action):
    # This is the Comet-incident shape: content read from a page claims to be
    # a trusted instruction. The self-claim disagrees with the independently
    # applied host rule (page_content -> untrusted), which must deny, not
    # merely queue for review.
    result = svc.evaluate(_request(action=action, source="page_content", self_provenance="trusted"))
    assert result["decision"] == "deny"


def test_naive_approver_that_trusted_the_self_report_would_have_allowed():
    # Control case proving the mismatch check is load-bearing: without an
    # independent host_provenance override, evaluate_trace has nothing to
    # disagree with the self-claim, so the same lie would sail through.
    from halo.policy import decide
    from halo.safety_cases import evaluate_trace

    event = svc.build_event(_request(action="navigate", source="page_content", self_provenance="trusted"))
    findings = evaluate_trace([event], trusted_telemetry=False, host_provenance=None)
    naive = decide(findings, effectful=True)
    assert naive.decision.value == "allow"


def test_submit_form_always_denies_without_independent_telemetry():
    for source, self_provenance in (("user_prompt", "trusted"), ("page_content", "untrusted")):
        result = svc.evaluate(_request(action="submit_form", source=source, self_provenance=self_provenance))
        assert result["decision"] == "deny"


def test_download_always_denies_outside_known_vocabulary():
    result = svc.evaluate(_request(action="download", source="user_prompt", self_provenance="trusted"))
    assert result["decision"] == "deny"


@pytest.fixture
def private_socket_path():
    # macOS sockaddr_un has a short path limit; pytest's own tmp_path lives
    # too deep under /private/var/folders/..., so use /tmp directly and
    # canonicalize its symlink, matching tests/test_e007_dual_agent_provenance_gate.py.
    with tempfile.TemporaryDirectory(prefix="halo-browser-approver-", dir="/tmp") as directory:
        path = Path(directory).resolve()
        path.chmod(0o700)
        yield path / "approver.sock"


def test_serve_forever_answers_one_real_exchange_over_the_socket(private_socket_path):
    def run_one_iteration():
        with UnixSocketChannel.listen(private_socket_path) as channel:
            request = channel.recv()
            channel.send(svc.evaluate(request))

    server = threading.Thread(target=run_one_iteration, daemon=True)
    server.start()
    # UnixSocketChannel.listen() creates the socket file itself; poll briefly
    # rather than sleeping a fixed guess.
    for _ in range(200):
        if private_socket_path.exists():
            break
        threading.Event().wait(0.01)
    channel = UnixSocketChannel.connect(private_socket_path)
    channel.send(_request(action="navigate", source="user_prompt", self_provenance="trusted"))
    response = channel.recv()
    server.join(timeout=5)
    assert response["decision"] == "allow"


def test_serve_forever_rejects_oversized_frame_without_crashing(private_socket_path):
    def run_one_iteration():
        try:
            with UnixSocketChannel.listen(private_socket_path) as channel:
                channel.recv()
                channel.send({"decision": "deny", "reasons": ["unreachable"]})
        except (TimeoutError, OSError, ValueError):
            pass

    server = threading.Thread(target=run_one_iteration, daemon=True)
    server.start()
    for _ in range(200):
        if private_socket_path.exists():
            break
        threading.Event().wait(0.01)
    raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    raw.settimeout(2)
    raw.connect(str(private_socket_path))
    raw.sendall((70000).to_bytes(4, "big") + b"x")
    raw.close()
    server.join(timeout=5)
