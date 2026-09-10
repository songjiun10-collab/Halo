from __future__ import annotations

import pytest

from halo import (
    Action,
    HALOEnforcer,
    HashChainAuditLog,
    InvariantEngine,
    Phase,
    PolicyEngine,
    PolicyRule,
    TelemetryEnvelope,
    TelemetryVerifier,
    Verdict,
    capability_scope_invariant,
    control_provenance_invariant,
)
from halo.types import CheckStatus

KEY = b"extended-paper-telemetry"
AUDIT_KEY = b"extended-paper-audit"
SESSION = "extended-paper-session"
NOW = 1_900_000_000_000

# These are sanitized structural labels only. No exploit prompts or attack
# generation procedures are reproduced.
EXTENDED_ATTACK_FAMILIES = [
    ("memmorph_memory_tool_selection_hijack", "memory"),
    ("memorygraft_experience_imitation_poisoning", "memory"),
    ("audioagent_concurrent_audio_injection", "perception"),
    ("planflip_goal_substitution", "tool_output"),
    ("planflip_priority_inversion", "tool_output"),
    ("planflip_context_pollution", "tool_output"),
    ("planflip_role_confusion", "tool_output"),
    ("promptshield_ambient_command_source_ambiguity", "perception"),
]


def _action(action_id: str = "extended-case") -> Action:
    return Action(action_id, "agent", "read", "workspace", {})


def _payload() -> dict:
    return {
        "control_provenance": {
            "subject": ["runtime"],
            "operation": ["trusted_plan"],
            "resource": ["trusted_plan"],
        },
        "capability": {
            "subject": "agent",
            "operations": ["read"],
            "resources": ["workspace"],
        },
    }


def _engine() -> InvariantEngine:
    return InvariantEngine(
        [control_provenance_invariant(), capability_scope_invariant()]
    )


def _enforcer(tmp_path) -> HALOEnforcer:
    return HALOEnforcer(
        telemetry=TelemetryVerifier(
            {"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW
        ),
        invariants=_engine(),
        policy=PolicyEngine(
            [PolicyRule("allow_after_boundary", Verdict.ALLOW, lambda a, p, t: True)]
        ),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )


def _seal(action: Action, payload: dict) -> TelemetryEnvelope:
    return TelemetryEnvelope.seal(
        key=KEY,
        source="runtime",
        session_id=SESSION,
        sequence=0,
        phase=Phase.PRE,
        action_id=action.action_id,
        payload=payload,
        issued_at_ms=NOW,
    )


@pytest.mark.parametrize("family,origin", EXTENDED_ATTACK_FAMILIES)
def test_extended_family_cannot_become_control_authority(family: str, origin: str):
    payload = _payload()
    payload["attack_family"] = family
    payload["control_provenance"]["operation"] = [origin]
    result = _engine().evaluate(_action(), Phase.PRE, payload)[0]
    assert result.status is CheckStatus.FAIL, family


@pytest.mark.parametrize("family,origin", EXTENDED_ATTACK_FAMILIES)
def test_extended_family_data_is_not_overblocked(family: str, origin: str):
    payload = _payload()
    payload["untrusted_content"] = {
        "family": family,
        "origin": origin,
        "synthetic": True,
    }
    checks = _engine().evaluate(_action(), Phase.PRE, payload)
    assert all(check.status is CheckStatus.PASS for check in checks), family


@pytest.mark.parametrize("family,origin", EXTENDED_ATTACK_FAMILIES)
def test_extended_family_denied_end_to_end(tmp_path, family: str, origin: str):
    action = _action(action_id=f"extended-{family}")
    payload = _payload()
    payload["attack_family"] = family
    payload["control_provenance"]["operation"] = [origin]
    decision = _enforcer(tmp_path).pre(action, _seal(action, payload))
    assert decision.verdict is Verdict.DENY, family
    assert "provenance" in decision.reason
