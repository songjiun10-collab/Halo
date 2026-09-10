from __future__ import annotations

from halo.invariants import InvariantEngine
from halo.provenance import (
    Origin,
    capability_scope_invariant,
    control_provenance_invariant,
)
from halo.types import Action, CheckStatus, Phase


def _action(operation: str = "read", resource: str = "workspace") -> Action:
    return Action("paper-case", "agent", operation, resource, {})


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
    checks = _evaluate(_trusted_payload(), _action("delete", "workspace"))
    assert checks[1].status is CheckStatus.FAIL


def test_capability_prevents_resource_diversion():
    checks = _evaluate(_trusted_payload(), _action("read", "restricted_store"))
    assert checks[1].status is CheckStatus.FAIL


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


# These are sanitized structural regressions, not reproductions of exploit
# prompts. They model only the trust transition that matters to HALO.
PAPER_ATTACK_FAMILIES = [
    ("jailbroken_competing_objectives", "model"),
    ("gcg_adversarial_suffix", "model"),
    ("autodan_semantic_search", "model"),
    ("pair_iterative_refinement", "model"),
    ("tap_tree_search", "model"),
    ("many_shot_long_context", "model"),
    ("artprompt_representation_obfuscation", "model"),
    ("best_of_n_input_augmentation", "model"),
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


def test_paper_attack_families_cannot_become_trusted_control():
    engine = InvariantEngine([control_provenance_invariant()])
    for family, origin in PAPER_ATTACK_FAMILIES:
        payload = _trusted_payload()
        payload["attack_family"] = family
        payload["control_provenance"]["operation"] = [origin]
        result = engine.evaluate(_action(), Phase.PRE, payload)[0]
        assert result.status is CheckStatus.FAIL, family


def test_untrusted_content_is_allowed_when_it_does_not_influence_control():
    engine = InvariantEngine(
        [control_provenance_invariant(), capability_scope_invariant()]
    )
    for family, _ in PAPER_ATTACK_FAMILIES:
        payload = _trusted_payload()
        payload["untrusted_content"] = {"family": family, "synthetic": True}
        result = engine.evaluate(_action(), Phase.PRE, payload)
        assert all(check.status is CheckStatus.PASS for check in result), family
