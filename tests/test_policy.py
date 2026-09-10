from halo.policy import Decision, decide
from halo.safety_cases import Event, evaluate_trace


def test_secret_egress_denied():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="send_email",
            target_scope="external",
            declared_scope="workspace",
            contains_secret=True,
            approved=False,
        )
    ])
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_effectful_telemetry_gap_quarantined():
    findings = evaluate_trace([
        Event(kind="tool", telemetry_complete=False)
    ])
    assert decide(findings, effectful=True).decision is Decision.QUARANTINE


def test_non_effectful_telemetry_gap_reviewed():
    findings = evaluate_trace([
        Event(kind="observation", telemetry_complete=False)
    ])
    assert decide(findings, effectful=False).decision is Decision.REVIEW


def test_stale_effectful_approval_denied():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="upload",
            approved=True,
            metadata={"approved_state_version": 1, "state_version": 2},
        )
    ])
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_clean_trace_allowed():
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="read",
            target_scope="local",
            declared_scope="local",
            approved=True,
        )
    ])
    assert decide(findings).decision is Decision.ALLOW
