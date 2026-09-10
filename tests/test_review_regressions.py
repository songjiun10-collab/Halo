from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from halo import (
    Action, HALOEnforcer, HashChainAuditLog, InvariantEngine, Phase,
    PolicyEngine, PolicyRule, TelemetryEnvelope, TelemetryVerifier, Verdict,
)
from halo.canonical import canonical_json

KEY = b"telemetry-secret"
AUDIT_KEY = b"audit-secret"
SESSION = "boot-session-A"
NOW = 1_900_000_000_000


def allow_rule():
    return PolicyRule("allow", Verdict.ALLOW, lambda a, p, t: True)


def envelope(
    action_id: str = "a1", *, seq: int = 0, phase: Phase = Phase.PRE,
    payload: dict | None = None, prev: str = "", session: str = SESSION,
    issued: int = NOW,
) -> TelemetryEnvelope:
    a = Action(action_id, "agent", "read", "workspace")
    return TelemetryEnvelope.seal(
        key=KEY, source="runtime", session_id=session, sequence=seq, phase=phase,
        action=a, payload=payload or {}, previous_digest=prev, issued_at_ms=issued,
    )


def enforcer(tmp_path, *, session: str = SESSION, clock=lambda: NOW):
    return HALOEnforcer(
        telemetry=TelemetryVerifier({"runtime": KEY}, session_id=session, clock_ms=clock),
        invariants=InvariantEngine(), policy=PolicyEngine([allow_rule()]),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )


def test_action_attributes_are_deep_frozen_snapshot():
    attrs = {"args": {"target": "safe"}, "items": [1, 2]}
    action = Action("a1", "agent", "write", "workspace", attrs)
    original_digest = HALOEnforcer._action_digest(action)
    attrs["args"]["target"] = "changed"
    attrs["items"].append(3)
    assert action.attributes["args"]["target"] == "safe"
    assert action.attributes["items"] == (1, 2)
    assert HALOEnforcer._action_digest(action) == original_digest
    with pytest.raises(TypeError):
        action.attributes["x"] = 1


def test_canonical_json_rejects_non_string_mapping_keys():
    with pytest.raises(TypeError):
        canonical_json({1: "trusted"})
    assert canonical_json({"1": "trusted"})


def test_old_session_envelope_rejected_after_restart(tmp_path):
    old = envelope(session="old-session")
    guard = enforcer(tmp_path, session="new-session")
    decision = guard.pre(Action("a1", "agent", "read", "workspace"), old)
    assert not decision.allowed
    assert "session mismatch" in decision.reason


def test_stale_and_future_telemetry_denied(tmp_path):
    action = Action("a1", "agent", "read", "workspace")
    stale = envelope(issued=NOW - 30_001)
    assert "expired" in enforcer(tmp_path).pre(action, stale).reason
    future_action = Action("a2", "agent", "read", "workspace")
    future = envelope(action_id="a2", issued=NOW + 5_001)
    assert "future" in enforcer(tmp_path / "future").pre(future_action, future).reason


def test_telemetry_payload_is_immutable_snapshot():
    payload = {"nested": {"role": "trusted"}}
    sealed = envelope(payload=payload)
    payload["nested"]["role"] = "attacker"
    assert sealed.payload["nested"]["role"] == "trusted"
    with pytest.raises(TypeError):
        sealed.payload["nested"]["role"] = "x"


def test_malformed_telemetry_verifier_error_becomes_deny(tmp_path):
    class BrokenVerifier:
        def verify(self, *args, **kwargs):
            raise TypeError("bad envelope")
    guard = HALOEnforcer(
        telemetry=BrokenVerifier(), invariants=InvariantEngine(), policy=PolicyEngine([allow_rule()]),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )
    decision = guard.pre(Action("a1", "agent", "read", "workspace"), object())
    assert not decision.allowed
    assert "telemetry verification error" in decision.reason


def test_invalid_policy_effect_rejected_at_construction():
    with pytest.raises(TypeError):
        PolicyRule("bad", "deny", lambda a, p, t: True)  # type: ignore[arg-type]


def test_two_audit_instances_refresh_head_under_lock(tmp_path):
    path = tmp_path / "audit.jsonl"
    first = HashChainAuditLog(path, key=AUDIT_KEY)
    second = HashChainAuditLog(path, key=AUDIT_KEY)
    r0 = first.append({"worker": 1})
    r1 = second.append({"worker": 2})
    assert r0.sequence == 0
    assert r1.sequence == 1
    assert r1.previous_hash == r0.record_hash
    ok, _, head, count = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert ok and count == 2 and head == r1.record_hash


def test_concurrent_audit_instances_serialize_appends(tmp_path):
    path = tmp_path / "audit.jsonl"
    logs = [HashChainAuditLog(path, key=AUDIT_KEY) for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(lambda item: item[1].append({"worker": item[0]}), enumerate(logs)))
    assert sorted(record.sequence for record in records) == [0, 1, 2, 3]
    ok, _, _, count = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert ok and count == 4


def test_replay_within_same_session_still_denied():
    verifier = TelemetryVerifier({"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW)
    a = Action("a1", "agent", "read", "workspace")
    sealed = envelope()
    assert verifier.verify(sealed, phase=Phase.PRE, action=a)[0]
    ok, reason = verifier.verify(sealed, phase=Phase.PRE, action=a)
    assert not ok
    assert "sequence" in reason
