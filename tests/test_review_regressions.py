import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Signal, evaluate_trace


@pytest.mark.parametrize("effect", [[], {}])
def test_unhashable_effect_is_monitoring_gap_not_exception(effect):
    findings = evaluate_trace([
        Event(
            kind="tool",
            action="custom_action",
            effect=effect,  # type: ignore[arg-type]
            target_scope="external",
            declared_scope="external",
            approved=False,
        )
    ])

    gaps = [f for f in findings if f.signal is Signal.MONITORING_GAP]
    assert gaps
    assert any(f.effectful for f in gaps)
    assert decide(findings).decision is Decision.QUARANTINE


def test_invalid_kind_keeps_independently_classified_effect_attribution():
    findings = evaluate_trace([
        Event(
            kind="Tool",
            action="send_email",
            effect="external_write",
            target_scope="external",
            declared_scope="external",
            contains_secret=False,
            telemetry_complete=True,
            approved=True,
        )
    ])

    kind_gaps = [
        f
        for f in findings
        if f.signal is Signal.MONITORING_GAP
        and "Event kind" in f.reason
    ]
    assert len(kind_gaps) == 1
    assert kind_gaps[0].effectful is True
    assert decide(findings).decision is Decision.QUARANTINE
