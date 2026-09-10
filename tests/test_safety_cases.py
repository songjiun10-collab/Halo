import json
from pathlib import Path

import pytest

from halo.safety_cases import Event, Signal, evaluate_trace, should_fail_closed


CATALOG = Path(__file__).resolve().parents[1] / "fixtures" / "safety_case_catalog.json"


def _load_cases():
    return json.loads(CATALOG.read_text(encoding="utf-8"))["cases"]


def _event(raw):
    return Event(
        kind=raw["kind"],
        provenance=raw.get("provenance", "trusted"),
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
