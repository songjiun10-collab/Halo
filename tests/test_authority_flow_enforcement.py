from __future__ import annotations

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
    attribute_authorization_invariant,
    delegation_chain_invariant,
    information_flow_invariant,
    origin_bound_authority_invariant,
)

KEY = b"authority-flow-telemetry"
AUDIT_KEY = b"authority-flow-audit"
SESSION = "authority-flow-session"
NOW = 1_900_000_000_000


def allow_rule() -> PolicyRule:
    return PolicyRule("allow_after_hard_boundaries", Verdict.ALLOW, lambda a, p, t: True)


def guard(tmp_path, invariant) -> HALOEnforcer:
    return HALOEnforcer(
        telemetry=TelemetryVerifier({"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW),
        invariants=InvariantEngine([invariant]),
        policy=PolicyEngine([allow_rule()]),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )


def seal(action: Action, payload: dict) -> TelemetryEnvelope:
    return TelemetryEnvelope.seal(
        key=KEY,
        source="runtime",
        session_id=SESSION,
        sequence=0,
        phase=Phase.PRE,
        action=action,
        payload=payload,
        issued_at_ms=NOW,
    )


def test_confused_deputy_scope_amplification_denied_end_to_end(tmp_path):
    current = Action("delegate-1", "worker", "delete", "workspace", {})
    payload = {
        "delegation": {
            "root_subject": "supervisor",
            "root_operations": ["read", "write"],
            "root_resources": ["workspace"],
            "chain": [
                {
                    "delegator": "supervisor",
                    "delegate": "worker",
                    "operations": ["read", "write"],
                    "resources": ["workspace"],
                }
            ],
        }
    }
    decision = guard(tmp_path, delegation_chain_invariant()).pre(current, seal(current, payload))
    assert decision.verdict is Verdict.DENY
    assert "delegation" in decision.reason


def test_concrete_argument_ceiling_denied_even_when_tool_policy_allows(tmp_path):
    current = Action("value-1", "worker", "send", "service", {"count": 11})
    payload = {"attribute_authorization": {"numeric_max": {"count": 10}}}
    decision = guard(tmp_path, attribute_authorization_invariant()).pre(current, seal(current, payload))
    assert decision.verdict is Verdict.DENY
    assert "attributes" in decision.reason


def test_origin_laundering_denied_end_to_end(tmp_path):
    current = Action("lineage-1", "worker", "read", "workspace", {})
    payload = {
        "authority_lineage": {
            "subject": {"roots": ["runtime"], "current": ["runtime"]},
            "operation": {"roots": ["external_data"], "current": ["trusted_plan"]},
            "resource": {"roots": ["trusted_plan"], "current": ["trusted_plan"]},
        }
    }
    decision = guard(tmp_path, origin_bound_authority_invariant()).pre(current, seal(current, payload))
    assert decision.verdict is Verdict.DENY
    assert "lineage" in decision.reason


def test_secret_label_cannot_flow_to_unauthorized_sink(tmp_path):
    current = Action("flow-1", "worker", "send", "external_sink", {})
    payload = {
        "information_flow": {
            "labels": ["secret"],
            "allowed_labels_by_sink": {
                "external_sink": ["public"],
                "workspace": ["public", "secret"],
            },
        }
    }
    decision = guard(tmp_path, information_flow_invariant()).pre(current, seal(current, payload))
    assert decision.verdict is Verdict.DENY
    assert "flow" in decision.reason
