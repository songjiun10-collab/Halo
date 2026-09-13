import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Signal, evaluate_trace


def _signals(event):
    return {finding.signal for finding in evaluate_trace([event])}


def test_effectful_action_requires_declared_scope():
    event = Event(
        kind="tool",
        action="send_email",
        target_scope="external",
        declared_scope=None,
        approved=True,
    )
    findings = evaluate_trace([event])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


@pytest.mark.parametrize("approved", ["false", "true", 0, 1, None])
def test_only_boolean_true_can_authorize_external_write(approved):
    event = Event(
        kind="tool",
        action="send_email",
        target_scope="external",
        declared_scope="external",
        approved=approved,
    )
    findings = evaluate_trace([event])
    signals = {f.signal for f in findings}
    assert Signal.MONITORING_GAP in signals
    assert Signal.UNEXPECTED_EXTERNAL_WRITE in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_normalized_privilege_effect_catches_action_alias():
    event = Event(
        kind="tool",
        action="invite_user",
        effect="privilege_change",
        target_scope="organization",
        declared_scope="organization",
        approved=False,
    )
    findings = evaluate_trace([event])
    assert Signal.PRIVILEGE_ESCALATION in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_privilege_change_requires_target_scope():
    event = Event(
        kind="tool",
        action="change_permissions",
        target_scope=None,
        declared_scope="workspace",
        approved=True,
    )
    findings = evaluate_trace([event])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


@pytest.mark.parametrize(
    "expected,observed",
    [
        (None, None),
        ("", ""),
        ("   ", "   "),
        ("expected", ""),
    ],
)
def test_artifact_digest_pair_must_be_nonempty(expected, observed):
    event = Event(
        kind="artifact",
        metadata={
            "expected_artifact_digest": expected,
            "artifact_digest": observed,
        },
    )
    assert Signal.ARTIFACT_MISMATCH in _signals(event)


@pytest.mark.parametrize(
    "field,value",
    [
        ("telemetry_complete", "false"),
        ("contains_secret", "false"),
    ],
)
def test_untyped_policy_boolean_fields_surface_monitoring_gap(field, value):
    kwargs = {
        "kind": "tool",
        "action": "send_email",
        "target_scope": "external",
        "declared_scope": "external",
        "approved": True,
    }
    kwargs[field] = value
    assert Signal.MONITORING_GAP in _signals(Event(**kwargs))
