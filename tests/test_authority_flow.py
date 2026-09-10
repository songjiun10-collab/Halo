from __future__ import annotations

from halo import Action, InvariantEngine, Phase
from halo.authority import (
    attribute_authorization_invariant,
    delegation_chain_invariant,
    information_flow_invariant,
    origin_bound_authority_invariant,
)
from halo.types import CheckStatus


def action(
    *,
    subject: str = "worker",
    operation: str = "read",
    resource: str = "workspace",
    attributes: dict | None = None,
) -> Action:
    return Action("authority-case", subject, operation, resource, attributes or {})


def result(invariant, payload: dict, *, current: Action | None = None):
    return InvariantEngine([invariant]).evaluate(
        current or action(), Phase.PRE, payload
    )[0]


def delegation_payload() -> dict:
    return {
        "delegation": {
            "root_subject": "supervisor",
            "root_operations": ["read", "write"],
            "root_resources": ["workspace", "archive"],
            "chain": [
                {
                    "delegator": "supervisor",
                    "delegate": "planner",
                    "operations": ["read", "write"],
                    "resources": ["workspace"],
                },
                {
                    "delegator": "planner",
                    "delegate": "worker",
                    "operations": ["read"],
                    "resources": ["workspace"],
                },
            ],
        }
    }


def lineage_payload() -> dict:
    return {
        "authority_lineage": {
            "subject": {"roots": ["runtime"], "current": ["runtime"]},
            "operation": {"roots": ["user_intent"], "current": ["trusted_plan"]},
            "resource": {"roots": ["trusted_plan"], "current": ["trusted_plan"]},
        }
    }


def test_delegation_valid_narrowing_passes():
    check = result(delegation_chain_invariant(), delegation_payload())
    assert check.status is CheckStatus.PASS


def test_delegation_cannot_amplify_operation_scope():
    payload = delegation_payload()
    payload["delegation"]["chain"][1]["operations"] = ["read", "delete"]
    assert result(delegation_chain_invariant(), payload).status is CheckStatus.FAIL


def test_delegation_cannot_amplify_resource_scope():
    payload = delegation_payload()
    payload["delegation"]["chain"][1]["resources"] = ["workspace", "secrets"]
    assert result(delegation_chain_invariant(), payload).status is CheckStatus.FAIL


def test_delegation_chain_identity_must_be_contiguous():
    payload = delegation_payload()
    payload["delegation"]["chain"][1]["delegator"] = "different-agent"
    assert result(delegation_chain_invariant(), payload).status is CheckStatus.FAIL


def test_delegation_final_delegate_must_match_action_subject():
    payload = delegation_payload()
    changed = action(subject="other-worker")
    assert result(delegation_chain_invariant(), payload, current=changed).status is CheckStatus.FAIL


def test_delegation_final_scope_must_cover_concrete_action():
    payload = delegation_payload()
    changed = action(operation="write")
    assert result(delegation_chain_invariant(), payload, current=changed).status is CheckStatus.FAIL


def test_delegation_depth_is_bounded():
    payload = delegation_payload()
    invariant = delegation_chain_invariant(max_depth=1)
    assert result(invariant, payload).status is CheckStatus.FAIL


def test_delegation_malformed_or_empty_chain_fails_closed():
    for chain in ([], [{"delegate": "worker"}], "worker"):
        payload = delegation_payload()
        payload["delegation"]["chain"] = chain
        assert result(delegation_chain_invariant(), payload).status is CheckStatus.FAIL


def test_origin_bound_trusted_lineage_passes():
    assert result(origin_bound_authority_invariant(), lineage_payload()).status is CheckStatus.PASS


def test_origin_laundering_untrusted_root_fails_even_if_current_looks_trusted():
    payload = lineage_payload()
    payload["authority_lineage"]["operation"] = {
        "roots": ["external_data"],
        "current": ["trusted_plan"],
    }
    assert result(origin_bound_authority_invariant(), payload).status is CheckStatus.FAIL


def test_origin_laundering_trusted_root_to_untrusted_current_fails():
    payload = lineage_payload()
    payload["authority_lineage"]["operation"] = {
        "roots": ["user_intent"],
        "current": ["tool_output"],
    }
    assert result(origin_bound_authority_invariant(), payload).status is CheckStatus.FAIL


def test_origin_lineage_missing_field_fails_closed():
    payload = lineage_payload()
    del payload["authority_lineage"]["resource"]
    assert result(origin_bound_authority_invariant(), payload).status is CheckStatus.FAIL


def test_attribute_exact_constraint_passes_and_mismatch_fails():
    invariant = attribute_authorization_invariant()
    payload = {"attribute_authorization": {"exact": {"tenant": "demo"}}}
    assert result(invariant, payload, current=action(attributes={"tenant": "demo"})).status is CheckStatus.PASS
    assert result(invariant, payload, current=action(attributes={"tenant": "other"})).status is CheckStatus.FAIL


def test_attribute_allowed_values_are_per_call_authorization():
    payload = {
        "attribute_authorization": {
            "allowed": {"mode": ["read_only", "preview"]}
        }
    }
    invariant = attribute_authorization_invariant()
    assert result(invariant, payload, current=action(attributes={"mode": "preview"})).status is CheckStatus.PASS
    assert result(invariant, payload, current=action(attributes={"mode": "execute"})).status is CheckStatus.FAIL


def test_attribute_numeric_ceiling_and_floor():
    payload = {
        "attribute_authorization": {
            "numeric_min": {"count": 1},
            "numeric_max": {"count": 10},
        }
    }
    invariant = attribute_authorization_invariant()
    assert result(invariant, payload, current=action(attributes={"count": 5})).status is CheckStatus.PASS
    assert result(invariant, payload, current=action(attributes={"count": 11})).status is CheckStatus.FAIL
    assert result(invariant, payload, current=action(attributes={"count": 0})).status is CheckStatus.FAIL


def test_attribute_boolean_is_not_accepted_as_numeric_authority():
    payload = {"attribute_authorization": {"numeric_max": {"count": 1}}}
    check = result(
        attribute_authorization_invariant(),
        payload,
        current=action(attributes={"count": True}),
    )
    assert check.status is CheckStatus.FAIL


def test_empty_or_malformed_attribute_authorization_fails_closed():
    invariant = attribute_authorization_invariant()
    for raw in ({}, {"exact": {}}, {"allowed": "preview"}):
        assert result(invariant, {"attribute_authorization": raw}, current=action(attributes={"x": 1})).status is CheckStatus.FAIL


def test_information_flow_allows_labels_authorized_for_sink():
    payload = {
        "information_flow": {
            "labels": ["public", "workspace_internal"],
            "allowed_labels_by_sink": {
                "workspace": ["public", "workspace_internal", "secret"]
            },
        }
    }
    assert result(information_flow_invariant(), payload).status is CheckStatus.PASS


def test_information_flow_blocks_label_not_authorized_for_sink():
    payload = {
        "information_flow": {
            "labels": ["secret"],
            "allowed_labels_by_sink": {"workspace": ["public"]},
        }
    }
    assert result(information_flow_invariant(), payload).status is CheckStatus.FAIL


def test_information_flow_missing_sink_policy_fails_closed():
    payload = {
        "information_flow": {
            "labels": ["secret"],
            "allowed_labels_by_sink": {"archive": ["secret"]},
        }
    }
    assert result(information_flow_invariant(), payload).status is CheckStatus.FAIL
