from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from halo import (
    Action,
    HALOEnforcer,
    HashChainAuditLog,
    Invariant,
    InvariantEngine,
    Phase,
    PolicyEngine,
    PolicyRule,
    TelemetryEnvelope,
    TelemetryVerifier,
    Verdict,
    resource_binding_invariant,
)
from halo.canonical import canonical_json, freeze_json

KEY = b"telemetry-key"
AUDIT_KEY = b"audit-key"
SESSION = "session-A"
NOW = 1_900_000_000_000


def allow_rule():
    return PolicyRule("allow", Verdict.ALLOW, lambda a, p, t: True)


def seal(action: Action, *, seq=0, phase=Phase.PRE, prev="", source="runtime", key=KEY, payload=None):
    return TelemetryEnvelope.seal(
        key=key,
        source=source,
        session_id=SESSION,
        sequence=seq,
        phase=phase,
        action=action,
        payload=payload or {},
        previous_digest=prev,
        issued_at_ms=NOW,
    )


def make_guard(tmp_path, *, keys=None, **kwargs):
    return HALOEnforcer(
        telemetry=TelemetryVerifier(keys or {"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW),
        invariants=InvariantEngine(),
        policy=PolicyEngine([allow_rule()]),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
        **kwargs,
    )


def test_telemetry_binds_complete_action(tmp_path):
    benign = Action("same", "agent", "read", "workspace", {"scope": "public"})
    altered = Action("same", "agent", "delete", "workspace", {"scope": "public"})
    env = seal(benign)
    decision = make_guard(tmp_path).pre(altered, env)
    assert not decision.allowed
    assert "action digest mismatch" in decision.reason


def test_concurrent_pre_same_id_only_one_can_allow(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    class BlockingVerifier:
        def verify(self, envelope, *, phase, action):
            entered.set()
            release.wait(timeout=5)
            return True, "verified"

    guard = HALOEnforcer(
        telemetry=BlockingVerifier(),
        invariants=InvariantEngine(),
        policy=PolicyEngine([allow_rule()]),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )
    action = Action("dup", "agent", "read", "workspace")
    from types import SimpleNamespace
    dummy = SimpleNamespace(payload={})
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(guard.pre, action, dummy)
        assert entered.wait(timeout=2)
        second = pool.submit(guard.pre, action, dummy)
        second_result = second.result(timeout=2)
        release.set()
        first_result = first.result(timeout=2)
    assert sorted([first_result.allowed, second_result.allowed]) == [False, True]
    assert "already exists" in second_result.reason


def test_audit_event_is_snapshot(tmp_path):
    log = HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY)
    event = {"nested": {"value": "before"}, "items": [1, 2]}
    record = log.append(event)
    event["nested"]["value"] = "after"
    event["items"].append(3)
    assert record.event["nested"]["value"] == "before"
    assert record.event["items"] == (1, 2)
    ok, _, _, count = HashChainAuditLog.verify_file(log.path, key=AUDIT_KEY)
    assert ok and count == 1


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_authorization_values_rejected(value):
    with pytest.raises(TypeError):
        Action("a", "agent", "read", "workspace", {"x": value})
    with pytest.raises(TypeError):
        freeze_json({"x": value})
    with pytest.raises((TypeError, ValueError)):
        canonical_json({"x": value})


def test_lifecycle_state_is_bounded_and_completed_actions_are_released(tmp_path):
    guard = make_guard(
        tmp_path,
        max_active_actions=1,
        recent_action_capacity=2,
        recent_action_ttl_ms=100,
        clock_ms=lambda: 1000,
    )
    a1 = Action("a1", "agent", "read", "workspace")
    e0 = seal(a1)
    assert guard.pre(a1, e0).allowed

    a2 = Action("a2", "agent", "read", "workspace")
    e1 = seal(a2, seq=1, prev=e0.digest)
    d = guard.pre(a2, e1)
    assert not d.allowed and "capacity" in d.reason
    assert len(guard._state) == 1

    p = seal(a1, seq=1, phase=Phase.POST, prev=e0.digest)
    assert guard.post(a1, p).allowed
    assert len(guard._state) == 0
    assert len(guard._recent) <= 2


def test_empty_invariant_phase_set_rejected():
    with pytest.raises(TypeError):
        Invariant("never", lambda a, p, t: True, phases=frozenset())


def test_resource_digest_hex_case_is_equivalent():
    inv = resource_binding_invariant()
    action = Action("a", "agent", "read", "workspace")
    digest = "aB" * 32
    payload = {"resource_binding": {"approved_digest": digest.upper(), "observed_digest": digest.lower()}}
    result = InvariantEngine([inv]).evaluate(action, Phase.PRE, payload)[0]
    assert result.status.value == "pass"


def test_audit_append_does_not_full_scan_history(tmp_path, monkeypatch):
    log = HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY)
    log.append({"n": 1})
    monkeypatch.setattr(HashChainAuditLog, "_verify_physical_file", staticmethod(lambda *a, **k: (_ for _ in ()).throw(AssertionError("full scan"))))
    log.append({"n": 2})


def test_concurrent_replay_only_one_verifies():
    verifier = TelemetryVerifier({"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW)
    action = Action("a", "agent", "read", "workspace")
    env = seal(action)
    barrier = threading.Barrier(16)

    def check():
        barrier.wait()
        return verifier.verify(env, phase=Phase.PRE, action=action)[0]

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: check(), range(16)))
    assert sum(results) == 1


def test_fsync_failure_rolls_back_uncommitted_allow_record(tmp_path, monkeypatch):
    path = tmp_path / "audit.jsonl"
    log = HashChainAuditLog(path, key=AUDIT_KEY)
    original_fsync = os.fsync
    calls = {"n": 0}

    def fail_first(fd):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("simulated fsync failure")
        return original_fsync(fd)

    monkeypatch.setattr(os, "fsync", fail_first)
    with pytest.raises(OSError):
        log.append({"decision": "allow"})
    monkeypatch.setattr(os, "fsync", original_fsync)

    ok, reason, head, count = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert ok, reason
    assert count == 0 and head == ""
    assert path.read_bytes() == b""


def test_existing_authenticated_checkpoint_does_not_promote_uncommitted_tail(tmp_path):
    path = tmp_path / "audit.jsonl"
    log = HashChainAuditLog(path, key=AUDIT_KEY)
    first = log.append({"n": 1})
    committed_size = path.stat().st_size

    body = {"sequence": 1, "previous_hash": first.record_hash, "event": {"n": 999}}
    import hashlib, hmac
    rh = hashlib.sha256(canonical_json(body)).hexdigest()
    mac = hmac.new(AUDIT_KEY, bytes.fromhex(rh), hashlib.sha256).hexdigest()
    tail = canonical_json({**body, "record_hash": rh, "mac": mac}) + b"\n"
    with path.open("ab") as f:
        f.write(tail)
    assert path.stat().st_size > committed_size

    HashChainAuditLog(path, key=AUDIT_KEY)
    assert path.stat().st_size == committed_size
    ok, reason, head, count = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert ok, reason
    assert count == 1 and head == first.record_hash


def test_nonempty_log_without_committed_checkpoint_fails_closed(tmp_path):
    path = tmp_path / "audit.jsonl"
    path.write_text('{"looks":"valid-ish"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="missing committed checkpoint"):
        HashChainAuditLog(path, key=AUDIT_KEY)
