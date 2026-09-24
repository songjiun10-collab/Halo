"""Regressions derived from the V1–V9 and deep round 2–5 reports.

These test detector defects separately from host authorization; a self-reported
approved flag must not make a trace into an execution capability.
"""
from dataclasses import replace

import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Finding, Signal, evaluate_trace, should_fail_closed, _scan_for_secrets


def write_event(**changes):
    return replace(Event(kind="tool", action="send_message", approved=True,
                         provenance="trusted", declared_scope="external",
                         target_scope="external"), **changes)


class Liar(str):
    def __hash__(self):
        return hash("local")

    def __eq__(self, other):
        return True

    def __ne__(self, other):
        return False


class Hidden(list):
    def __repr__(self):
        raise AssertionError("must not execute untrusted repr")


@pytest.mark.parametrize("changes", [
    {"target_scope": Liar("external")},
    {"metadata": {"state_version": Liar("changed"), "approved_state_version": "old"}},
    {"metadata": {"data_classification": Liar("secret")}},
    {"metadata": {"body": {"nested": Hidden(["secret"])}}},
    {"metadata": {b"api_key=ABCDEF0123456789012345": "value"}},
    {"metadata": {"body": b"api_key=ABCDEF0123456789012345"}},
    {"metadata": {"state_version": True, "approved_state_version": 1}},
])
def test_report_hostile_fields_fail_closed_without_callbacks(changes):
    findings = evaluate_trace([write_event(**changes)])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings).decision is Decision.DENY


def test_cyclic_metadata_is_rejected_without_recursing_forever():
    cycle = []
    cycle.append(cycle)
    findings = evaluate_trace([write_event(metadata={"body": cycle})])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}


def test_two_faced_trace_is_rejected_without_consumption():
    class TwoFaced(list):
        def __iter__(self):
            raise AssertionError("untrusted iterator executed")
    assert decide(evaluate_trace(TwoFaced())).decision is Decision.DENY


def test_reused_findings_generator_never_clears_a_denial():
    findings = (f for f in [Finding(Signal.SECRET_EGRESS, 0, 5, "blocked")])
    assert decide(findings).decision is Decision.DENY
    assert should_fail_closed(findings)


@pytest.mark.parametrize("signal", list(Signal))
def test_all_critical_findings_are_denied(signal):
    findings = [Finding(signal, 0, 5, "critical")]
    assert decide(findings, effectful=False).decision is Decision.DENY
    assert should_fail_closed(findings)


def test_default_policy_and_fail_closed_agree_on_missing_evidence():
    findings = [Finding(Signal.MONITORING_GAP, 0, 4, "missing")]
    assert decide(findings).decision is Decision.DENY
    assert should_fail_closed(findings)


@pytest.mark.parametrize("provenance", ["untrust\u0435d", "untrusted\u200b", "nonsense"])
def test_provenance_laundering_is_not_silently_cleared(provenance):
    findings = evaluate_trace([Event(kind="tool", provenance=provenance)])
    assert findings
    assert decide(findings).decision is Decision.DENY


def test_self_reported_approval_is_not_execution_authority():
    assert decide(evaluate_trace([write_event()])).decision is Decision.DENY


@pytest.mark.parametrize("text", [
    "sk-proj-" + "A1b2" * 12,
    "sk-svcacct-" + "A1b2" * 12,
    "sk-None-" + "A1b2" * 12,
    "github_pat_" + "A1b2" * 12,
    "aws_access_key_id=AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key=MYSECRETVALUE0123456789ABCDEFGHIJ",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "api_\u200bkey=" + "A" * 25,
    "sk-" + "\u200b".join("A" * 40),
])
def test_report_secret_formats_are_detected_independently_of_authority(text):
    assert _scan_for_secrets(text)


def test_probe_flag_requires_boolean_not_truthiness():
    findings = evaluate_trace([Event(kind="observation", metadata={"evaluation_probe": "0"})])
    assert Signal.EVAL_AWARENESS not in {f.signal for f in findings}
    assert Signal.MONITORING_GAP in {f.signal for f in findings}


@pytest.mark.parametrize("action", ["read", "compute"])
def test_benign_action_label_does_not_hide_external_secret_payload(action):
    findings = evaluate_trace([write_event(action=action, contains_secret=True,
                                metadata={"payload": "api_key=" + "a" * 40})])
    assert Signal.SECRET_EGRESS in {f.signal for f in findings}
    assert decide(findings).decision is Decision.DENY


@pytest.mark.parametrize("metadata", [
    {"api_key": "a" * 40},
    {"body": {"api_key": "a" * 40}},
    {"body": [{"password": "fixture-password"}]},
])
def test_structured_credential_labels_remain_bound_to_values(metadata):
    findings = evaluate_trace([write_event(metadata=metadata)], trusted_telemetry=True)
    assert Signal.SECRET_EGRESS in {f.signal for f in findings}
    assert decide(findings).decision is Decision.DENY
