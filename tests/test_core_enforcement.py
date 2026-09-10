from __future__ import annotations

import json
from dataclasses import replace

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
)


KEY = b"telemetry-secret"
AUDIT_KEY = b"audit-secret"


def action(action_id: str = "a1") -> Action:
    return Action(action_id, "agent", "write", "workspace", {"tenant": "demo"})


def env(
    seq: int,
    phase: Phase,
    action_id: str,
    payload: dict,
    prev: str = "",
) -> TelemetryEnvelope:
    return TelemetryEnvelope.seal(
        key=KEY,
        source="runtime",
        sequence=seq,
        phase=phase,
        action_id=action_id,
        payload=payload,
        previous_digest=prev,
    )


def make_enforcer(tmp_path, *, invariants=(), rules=()):
    return HALOEnforcer(
        telemetry=TelemetryVerifier({"runtime": KEY}),
        invariants=InvariantEngine(invariants),
        policy=PolicyEngine(rules),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )


def allow_rule():
    return PolicyRule(
        "allow_workspace",
        Verdict.ALLOW,
        lambda a, p, t: a.resource == "workspace",
    )


def test_default_deny(tmp_path):
    guard = make_enforcer(tmp_path)
    d = guard.pre(action(), env(0, Phase.PRE, "a1", {}))
    assert d.verdict is Verdict.DENY
    assert d.reason == "no allow rule matched"


def test_valid_pre_live_post_lifecycle(tmp_path):
    guard = make_enforcer(tmp_path, rules=[allow_rule()])
    e0 = env(0, Phase.PRE, "a1", {"ok": True})
    assert guard.pre(action(), e0).allowed
    e1 = env(1, Phase.LIVE, "a1", {"ok": True}, e0.digest)
    assert guard.live(action(), e1).allowed
    e2 = env(2, Phase.POST, "a1", {"ok": True}, e1.digest)
    assert guard.post(action(), e2).allowed


def test_live_without_pre_is_denied(tmp_path):
    guard = make_enforcer(tmp_path, rules=[allow_rule()])
    d = guard.live(action(), env(0, Phase.LIVE, "a1", {}))
    assert not d.allowed
    assert "PRE" in d.reason


def test_telemetry_tampering_is_denied(tmp_path):
    guard = make_enforcer(tmp_path, rules=[allow_rule()])
    sealed = env(0, Phase.PRE, "a1", {"risk": 0})
    tampered = replace(sealed, payload={"risk": 99})
    d = guard.pre(action(), tampered)
    assert not d.allowed
    assert "digest" in d.reason


def test_telemetry_replay_is_denied(tmp_path):
    guard = make_enforcer(tmp_path, rules=[allow_rule()])
    first = env(0, Phase.PRE, "a1", {})
    assert guard.pre(action(), first).allowed
    replay_for_live = replace(first, phase=Phase.LIVE)
    d = guard.live(action(), replay_for_live)
    assert not d.allowed


def test_invariant_failure_is_denied(tmp_path):
    invariant = Invariant(
        "budget",
        lambda a, p, t: t["spent"] <= t["limit"],
        failure_reason="budget exceeded",
    )
    guard = make_enforcer(tmp_path, invariants=[invariant], rules=[allow_rule()])
    d = guard.pre(
        action(),
        env(0, Phase.PRE, "a1", {"spent": 11, "limit": 10}),
    )
    assert not d.allowed
    assert d.reason == "budget exceeded"


def test_invariant_exception_fails_closed(tmp_path):
    invariant = Invariant("broken", lambda a, p, t: 1 / 0)
    guard = make_enforcer(tmp_path, invariants=[invariant], rules=[allow_rule()])
    d = guard.pre(action(), env(0, Phase.PRE, "a1", {}))
    assert not d.allowed
    assert "ZeroDivisionError" in d.reason


def test_policy_exception_fails_closed(tmp_path):
    broken = PolicyRule("broken", Verdict.ALLOW, lambda a, p, t: t["missing"])
    guard = make_enforcer(tmp_path, rules=[broken])
    d = guard.pre(action(), env(0, Phase.PRE, "a1", {}))
    assert not d.allowed
    assert "policy evaluation error" in d.reason


def test_explicit_deny_overrides_allow(tmp_path):
    rules = [
        allow_rule(),
        PolicyRule(
            "deny_sensitive",
            Verdict.DENY,
            lambda a, p, t: bool(t.get("sensitive")),
        ),
    ]
    guard = make_enforcer(tmp_path, rules=rules)
    d = guard.pre(
        action(),
        env(0, Phase.PRE, "a1", {"sensitive": True}),
    )
    assert not d.allowed
    assert d.policy_rule == "deny_sensitive"


def test_audit_log_detects_tampering(tmp_path):
    log = HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY)
    log.append({"event": "one"})
    log.append({"event": "two"})
    path = tmp_path / "audit.jsonl"
    rows = path.read_text(encoding="utf-8").splitlines()
    altered = json.loads(rows[0])
    altered["event"] = {"event": "changed"}
    rows[0] = json.dumps(altered, separators=(",", ":"), sort_keys=True)
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    ok, reason, _, _ = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert not ok
    assert "hash" in reason or "authentication" in reason


def test_existing_valid_audit_log_resumes_chain(tmp_path):
    path = tmp_path / "audit.jsonl"
    log = HashChainAuditLog(path, key=AUDIT_KEY)
    first = log.append({"event": 1})
    log2 = HashChainAuditLog(path, key=AUDIT_KEY)
    second = log2.append({"event": 2})
    assert second.sequence == 1
    assert second.previous_hash == first.record_hash
    ok, _, head, count = HashChainAuditLog.verify_file(path, key=AUDIT_KEY)
    assert ok and count == 2 and head == second.record_hash


def test_action_cannot_change_after_pre(tmp_path):
    guard = make_enforcer(tmp_path, rules=[allow_rule()])
    e0 = env(0, Phase.PRE, "a1", {})
    assert guard.pre(action(), e0).allowed
    changed = Action(
        "a1",
        "agent",
        "delete",
        "other-resource",
        {"tenant": "demo"},
    )
    e1 = env(1, Phase.LIVE, "a1", {}, e0.digest)
    d = guard.live(changed, e1)
    assert not d.allowed
    assert "changed after PRE" in d.reason


def test_audit_failure_converts_allow_to_deny(tmp_path):
    class BrokenAudit:
        def append_decision(self, decision):
            raise OSError("sink unavailable")

    guard = HALOEnforcer(
        telemetry=TelemetryVerifier({"runtime": KEY}),
        invariants=InvariantEngine(),
        policy=PolicyEngine([allow_rule()]),
        audit=BrokenAudit(),
    )
    d = guard.pre(action(), env(0, Phase.PRE, "a1", {}))
    assert not d.allowed
    assert "audit unavailable" in d.reason


def test_denied_action_id_is_reserved(tmp_path):
    guard = make_enforcer(tmp_path)
    e0 = env(0, Phase.PRE, "a1", {})
    assert not guard.pre(action(), e0).allowed
    retry = guard.pre(action(), e0)
    assert not retry.allowed
    assert retry.reason == "action_id already exists"
