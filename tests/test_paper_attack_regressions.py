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
)
from halo.provenance import (
    Origin,
    capability_scope_invariant,
    control_provenance_invariant,
)
from halo.types import CheckStatus


KEY = b"paper-regression-telemetry"
AUDIT_KEY = b"paper-regression-audit"
SESSION = "paper-regression-session"
NOW = 1_900_000_000_000


def _action(
    action_id: str = "paper-case",
    operation: str = "read",
    resource: str = "workspace",
) -> Action:
    return Action(action_id, "agent", operation, resource, {})


def _trusted_payload() -> dict:
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


def _evaluate(payload: dict, action: Action | None = None):
    engine = InvariantEngine(
        [control_provenance_invariant(), capability_scope_invariant()]
    )
    return engine.evaluate(action or _action(), Phase.PRE, payload)


def _enforcer(tmp_path):
    return HALOEnforcer(
        telemetry=TelemetryVerifier(
            {"runtime": KEY}, session_id=SESSION, clock_ms=lambda: NOW
        ),
        invariants=InvariantEngine(
            [control_provenance_invariant(), capability_scope_invariant()]
        ),
        policy=PolicyEngine(
            [
                PolicyRule(
                    "allow_if_boundary_passes",
                    Verdict.ALLOW,
                    lambda a, p, t: True,
                )
            ]
        ),
        audit=HashChainAuditLog(tmp_path / "audit.jsonl", key=AUDIT_KEY),
    )


def _sealed(action: Action, payload: dict) -> TelemetryEnvelope:
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


def test_trusted_control_and_capability_pass():
    assert all(c.status is CheckStatus.PASS for c in _evaluate(_trusted_payload()))


def test_untrusted_control_origins_fail_closed():
    for origin in [Origin.MODEL, Origin.TOOL_OUTPUT, Origin.EXTERNAL_DATA, Origin.MEMORY]:
        payload = _trusted_payload()
        payload["control_provenance"]["operation"] = [origin.value]
        checks = _evaluate(payload)
        assert checks[0].status is CheckStatus.FAIL


def test_mixed_trusted_and_untrusted_control_fails():
    payload = _trusted_payload()
    payload["control_provenance"]["resource"] = ["trusted_plan", "external_data"]
    assert _evaluate(payload)[0].status is CheckStatus.FAIL


def test_missing_or_unknown_provenance_fails():
    bad_values = [
        None,
        {},
        {"subject": ["runtime"], "operation": ["bogus"], "resource": ["trusted_plan"]},
    ]
    for value in bad_values:
        payload = _trusted_payload()
        if value is None:
            payload.pop("control_provenance")
        else:
            payload["control_provenance"] = value
        assert _evaluate(payload)[0].status is CheckStatus.FAIL


def test_capability_prevents_operation_escalation():
    assert (
        _evaluate(_trusted_payload(), _action(operation="delete"))[1].status
        is CheckStatus.FAIL
    )


def test_capability_prevents_resource_diversion():
    assert (
        _evaluate(_trusted_payload(), _action(resource="restricted_store"))[1].status
        is CheckStatus.FAIL
    )


def test_capability_prevents_subject_spoofing():
    payload = _trusted_payload()
    payload["capability"]["subject"] = "other-agent"
    assert _evaluate(payload)[1].status is CheckStatus.FAIL


def test_malformed_capability_fails_closed():
    bad_values = [
        None,
        {},
        {"subject": "agent", "operations": [], "resources": ["workspace"]},
    ]
    for capability in bad_values:
        payload = _trusted_payload()
        if capability is None:
            payload.pop("capability")
        else:
            payload["capability"] = capability
        assert _evaluate(payload)[1].status is CheckStatus.FAIL


# Sanitized structural regressions only. No exploit prompt is reproduced.
# Each family models where attacker-controlled influence originates.
PAPER_ATTACK_FAMILIES = [
    ("jailbroken_competing_objectives", "model"),
    ("gcg_adversarial_suffix", "model"),
    ("amplegcg_generated_suffixes", "model"),
    ("autodan_semantic_search", "model"),
    ("pair_iterative_refinement", "model"),
    ("tap_tree_search", "model"),
    ("many_shot_long_context", "model"),
    ("artprompt_representation_obfuscation", "model"),
    ("best_of_n_input_augmentation", "model"),
    ("deepinception_nested_scene", "model"),
    ("renellm_rewrite_and_nesting", "model"),
    ("flipattack_input_transformation", "model"),
    ("masterkey_automated_jailbreak", "model"),
    ("gptfuzzer_mutation_search", "model"),
    ("fuzzllm_combo_fuzzing", "model"),
    ("cognitive_overload", "model"),
    ("pap_persuasion", "model"),
    ("cipherchat_non_natural_encoding", "model"),
    ("crescendo_multiturn_escalation", "model"),
    ("direct_prompt_injection", "model"),
    ("indirect_prompt_injection", "external_data"),
    ("houyi_context_partition", "external_data"),
    ("bipia_data_instruction_confusion", "external_data"),
    ("instruction_hierarchy_low_privilege_override", "tool_output"),
    ("struq_data_channel_instruction", "external_data"),
    ("injecagent_tool_output_injection", "tool_output"),
    ("agentdojo_tool_output_injection", "tool_output"),
    ("asb_memory_poisoning", "memory"),
    ("asb_plan_backdoor", "model"),
    ("asb_mixed_attack", "external_data"),
]


@pytest.mark.parametrize("family,origin", PAPER_ATTACK_FAMILIES)
def test_paper_attack_family_cannot_become_trusted_control(
    family: str, origin: str
):
    payload = _trusted_payload()
    payload["attack_family"] = family
    payload["control_provenance"]["operation"] = [origin]
    result = InvariantEngine([control_provenance_invariant()]).evaluate(
        _action(), Phase.PRE, payload
    )[0]
    assert result.status is CheckStatus.FAIL, family


@pytest.mark.parametrize("family,origin", PAPER_ATTACK_FAMILIES)
def test_untrusted_content_is_not_overblocked_when_control_stays_trusted(
    family: str, origin: str
):
    payload = _trusted_payload()
    payload["untrusted_content"] = {
        "family": family,
        "origin": origin,
        "synthetic": True,
    }
    result = _evaluate(payload)
    assert all(check.status is CheckStatus.PASS for check in result), family


@pytest.mark.parametrize("family,origin", PAPER_ATTACK_FAMILIES)
def test_paper_attack_family_is_denied_end_to_end(
    tmp_path, family: str, origin: str
):
    action = _action(action_id=f"case-{family}")
    payload = _trusted_payload()
    payload["attack_family"] = family
    payload["control_provenance"]["operation"] = [origin]

    decision = _enforcer(tmp_path).pre(action, _sealed(action, payload))

    assert decision.verdict is Verdict.DENY, family
    assert "provenance" in decision.reason
