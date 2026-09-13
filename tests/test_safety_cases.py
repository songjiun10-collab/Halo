import json
from pathlib import Path

import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Signal, evaluate_trace, should_fail_closed


CATALOG = Path(__file__).resolve().parents[1] / "fixtures" / "safety_case_catalog.json"


def _load_cases():
    return json.loads(CATALOG.read_text(encoding="utf-8"))["cases"]


def _event(raw):
    return Event(
        kind=raw["kind"],
        provenance=raw.get("provenance", "unknown"),
        action=raw.get("action"),
        target_scope=raw.get("target_scope"),
        declared_scope=raw.get("declared_scope"),
        effect=raw.get("effect"),
        contains_secret=raw.get("contains_secret", False),
        telemetry_complete=raw.get("telemetry_complete", True),
        approved=raw.get("approved", False),
        metadata=raw.get("metadata", {}),
    )


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["id"])
def test_case_catalog(case):
    findings = evaluate_trace([_event(e) for e in case["events"]])
    observed = {f.signal.value for f in findings}

    for expected in case["expect_signals"]:
        assert expected in observed

    assert should_fail_closed(findings) is case["expect_fail_closed"]


def test_surface_form_does_not_change_provenance_rule():
    plain = [
        Event(kind="instruction", provenance="untrusted"),
        Event(
            kind="tool",
            action="send_message",
            target_scope="external",
            declared_scope="local",
            approved=False,
        ),
    ]
    transformed = [
        Event(
            kind="instruction",
            provenance="untrusted",
            metadata={"representation_shift": True},
        ),
        plain[1],
    ]

    plain_signals = {f.signal for f in evaluate_trace(plain)}
    transformed_signals = {f.signal for f in evaluate_trace(transformed)}

    assert Signal.UNTRUSTED_INSTRUCTION in plain_signals
    assert Signal.UNTRUSTED_INSTRUCTION in transformed_signals
    assert should_fail_closed(evaluate_trace(plain))
    assert should_fail_closed(evaluate_trace(transformed))


def test_trusted_benign_local_action_is_not_blocked():
    trace = [
        Event(kind="instruction", provenance="trusted"),
        Event(
            kind="tool",
            action="read",
            target_scope="local",
            declared_scope="local",
            approved=True,
        ),
    ]
    findings = evaluate_trace(trace)
    assert findings == []
    assert not should_fail_closed(findings)


def test_authorized_secret_egress_uses_independent_approval_path():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="send_email",
            target_scope="external",
            declared_scope="external",
            contains_secret=True,
            approved=True,
        )
    ])
    assert Signal.SECRET_EGRESS not in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.ALLOW


def test_unapproved_secret_egress_is_still_denied():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="send_email",
            target_scope="external",
            declared_scope="external",
            contains_secret=True,
            approved=False,
        )
    ])
    assert Signal.SECRET_EGRESS in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_missing_external_write_scope_fails_closed_via_monitoring_gap():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="send_email",
            target_scope=None,
            declared_scope="external",
            approved=True,
        )
    ])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


def test_unapproved_classified_write_requires_approval_in_workspace():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="upload",
            target_scope="workspace",
            declared_scope="workspace",
            approved=False,
        )
    ])
    assert Signal.UNEXPECTED_EXTERNAL_WRITE in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_normalized_effect_classifies_external_write_alias():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="create_issue",
            effect="external_write",
            target_scope="external",
            declared_scope="external",
            approved=False,
        )
    ])
    assert Signal.UNEXPECTED_EXTERNAL_WRITE in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_expected_artifact_digest_requires_observed_digest():
    findings = evaluate_trace([
        Event(
            kind="artifact",
            metadata={"expected_artifact_digest": "expected"},
        )
    ])
    assert Signal.ARTIFACT_MISMATCH in {f.signal for f in findings}
    assert should_fail_closed(findings)


def test_empty_expected_digest_does_not_disable_artifact_validation():
    findings = evaluate_trace([
        Event(
            kind="artifact",
            metadata={"expected_artifact_digest": "", "artifact_digest": "changed"},
        )
    ])
    assert Signal.ARTIFACT_MISMATCH in {f.signal for f in findings}


def test_stale_state_denial_beats_monitoring_quarantine():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="upload",
            target_scope=None,
            approved=True,
            metadata={"approved_state_version": 1, "state_version": 2},
        )
    ])
    signals = {f.signal for f in findings}
    assert Signal.MONITORING_GAP in signals
    assert Signal.STATE_MISMATCH in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


@pytest.mark.parametrize(
    "metadata",
    [
        {"approved_state_version": 1},
        {"state_version": 1},
        {"approved_state_version": 1, "state_version": None},
    ],
)
def test_incomplete_state_version_pair_is_monitoring_gap(metadata):
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="send_email",
            target_scope="external",
            declared_scope="external",
            approved=True,
            metadata=metadata,
        )
    ])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


@pytest.mark.parametrize(
    "event",
    [
        Event(kind="instruction"),
        Event(kind="instruction", provenance="unknown"),
        Event(kind="instruction", provenance="invalid"),
    ],
)
def test_unknown_or_missing_instruction_provenance_is_not_allowed(event):
    findings = evaluate_trace([event])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=False).decision is Decision.REVIEW


@pytest.mark.parametrize(
    "declared,target",
    [
        ("opaque_custom", "external"),
        ("workspace", "opaque_custom"),
        (123, "workspace"),
    ],
)
def test_unknown_or_invalid_scope_is_policy_uncertainty(declared, target):
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="upload",
            target_scope=target,
            declared_scope=declared,
            approved=True,
        )
    ])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


@pytest.mark.parametrize(
    "contains_secret,classification",
    [
        (False, "secret"),
        (True, "public"),
        (False, "mystery"),
        (False, 7),
    ],
)
def test_inconsistent_or_invalid_data_classification_is_not_silently_allowed(
    contains_secret, classification
):
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="upload",
            target_scope="external",
            declared_scope="external",
            contains_secret=contains_secret,
            approved=True,
            metadata={"data_classification": classification},
        )
    ])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE
