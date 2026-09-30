"""Regressions for the HOST-ONLY host_provenance override (round-10 Patch 2).

The trust label lived in the same attacker-controllable object as the data: a
trace in which every event self-claims provenance="trusted" reached ALLOW
(the deep P9-B residual). host_provenance moves the trust source to
host-acquired telemetry — overriding the self-asserted field for every trust
judgment — and emits a monitoring gap when the self-asserted provenance
disagrees with the host value (laundering detection).

Invalid host_provenance is a host-side contract violation and raises
ValueError, the pattern should_fail_closed uses for host-supplied arguments
(cf. the threshold check pinned by test_e004_strict.py); attacker-influenced
request fields keep the bounded-snapshot gap treatment instead.
"""
from dataclasses import replace

import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Signal, evaluate_trace


def deep_p9b_trace():
    """The deep P9-B construction: BOTH events self-claim trusted."""
    return [Event(kind="instruction", provenance="trusted", telemetry_complete=True),
            Event(kind="tool", action="send_message", approved=True,
                  telemetry_complete=True, provenance="trusted",
                  declared_scope="external", target_scope="external")]


def _ew(**changes):
    base = dict(kind="tool", action="send_message", approved=True,
                telemetry_complete=True, provenance="trusted",
                declared_scope="external", target_scope="external")
    base.update(changes)
    return Event(**base)


def test_deep_p9b_with_untrusted_host_instruction_is_not_allowed():
    # Host telemetry says the instruction came from an untrusted channel, so
    # the self-claimed "trusted" labels cannot reach ALLOW.
    findings = evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                              host_provenance=["untrusted", "trusted"])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert Signal.MONITORING_GAP in signals  # self-assertion disagreement
    assert decide(findings, effectful=True).decision is Decision.DENY
    # The untrusted@5 finding on the write denies even for non-effectful calls.
    assert decide(findings, effectful=False).decision is Decision.DENY


def test_deep_p9b_with_honest_host_is_allowed():
    # An honest host that agrees with the self-claims produces no findings.
    findings = evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                              host_provenance=["trusted", "trusted"])
    assert findings == []
    assert decide(findings, effectful=True).decision is Decision.ALLOW


def test_single_string_host_provenance_overrides_every_event():
    findings = evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                              host_provenance="untrusted")
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert Signal.MONITORING_GAP in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_disagreement_gap_is_reported_for_the_offending_event():
    trace = [Event(kind="instruction", provenance="trusted", telemetry_complete=True)]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="untrusted")
    assert any(f.signal is Signal.MONITORING_GAP and f.event_index == 0
               and "disagrees with host telemetry" in f.reason
               for f in findings)
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_no_disagreement_gap_for_honest_host():
    trace = [Event(kind="instruction", provenance="trusted", telemetry_complete=True)]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="trusted")
    assert findings == []


def test_case_variation_does_not_fabricate_disagreement_gap():
    # The disagreement check compares normalized labels: a host value that
    # differs only in case agrees with the self-claim and must not fabricate
    # a laundering gap.
    trace = [Event(kind="instruction", provenance="trusted", telemetry_complete=True)]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="TRUSTED")
    assert not any("disagrees with host telemetry" in f.reason for f in findings)


def test_empty_self_claim_does_not_count_as_disagreement():
    # An empty self-claimed label is not a disagreement (nothing was claimed),
    # and the host value legitimately overrides it as the trust source.
    trace = [Event(kind="instruction", provenance="", telemetry_complete=True)]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="trusted")
    assert not any("disagrees with host telemetry" in f.reason for f in findings)
    assert findings == []


def test_empty_provenance_without_host_supply_still_fails_closed():
    # Without a host supply the empty label is an unknown encoding -> gap.
    findings = evaluate_trace([Event(kind="instruction", provenance="")])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_host_unknown_provenance_on_policy_effect_fails_closed():
    # The host value overrides the self-asserted field: a host value of
    # "unknown" for an effectful event leaves the source unknown -> gap.
    trace = [_ew()]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="unknown")
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_host_invalid_label_fails_closed():
    trace = [Event(kind="tool", action="read", approved=True,
                   telemetry_complete=True, provenance="trusted",
                   target_scope="local")]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="banana")
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


@pytest.mark.parametrize("host", [
    42,
    True,
    {"trusted": True},
    ["trusted", 42],        # non-str element
    [None, "trusted"],      # non-str element
])
def test_invalid_host_provenance_type_fails_closed(host):
    with pytest.raises(ValueError):
        evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                       host_provenance=host)


@pytest.mark.parametrize("host,events", [
    (["trusted", "extra"], [_ew()]),      # len 2 for a 1-event trace
    (["trusted"], deep_p9b_trace()),      # len 1 for a 2-event trace
    (("trusted", "extra"), [_ew()]),      # tuple, wrong length
])
def test_wrong_length_host_provenance_fails_closed(host, events):
    with pytest.raises(ValueError):
        evaluate_trace(events, trusted_telemetry=True, host_provenance=host)


def test_host_provenance_str_subclass_is_rejected():
    # Type-exact validation: a str subclass is not a plain string and must be
    # rejected even though it is host-supplied.
    class HostLiar(str):
        pass

    with pytest.raises(ValueError):
        evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                       host_provenance=HostLiar("trusted"))


def test_host_provenance_list_subclass_is_rejected():
    class HostList(list):
        pass

    with pytest.raises(ValueError):
        evaluate_trace(deep_p9b_trace(), trusted_telemetry=True,
                       host_provenance=HostList(["trusted", "trusted"]))


def test_invalid_event_with_host_provenance_still_fails_closed():
    # A malformed event keeps its bounded-snapshot gap even when the host
    # supplies provenance for every position.
    trace = [Event(kind="instruction", provenance="trusted", telemetry_complete=True),
             "not-an-event"]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance=["trusted", "trusted"])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_trusted_telemetry_only_call_still_supported():
    # COMPAT (false_block_benchmark.py): evaluate_trace(events,
    # trusted_telemetry=True) without host_provenance keeps working, and the
    # host override must not change legacy results.
    trace = [Event(kind="tool", action="read", approved=True,
                   telemetry_complete=True, provenance="trusted",
                   target_scope="local", declared_scope="local")]
    assert evaluate_trace(trace, trusted_telemetry=True) == []
    assert evaluate_trace(trace, trusted_telemetry=True,
                          host_provenance="trusted") == []


def test_host_override_does_not_weaken_content_secret_scan():
    # The override moves trust judgments to the host value; the content-based
    # secret scan still inspects the event's own (attacker-controlled) text,
    # including a secret smuggled into the provenance field itself.
    trace = [_ew(provenance="api_key=" + "a" * 40)]
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance="trusted")
    assert Signal.SECRET_EGRESS in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_host_untrusted_write_follows_untrusted_instruction():
    # Per-event host values: the instruction is untrusted, the write trusted —
    # the write still inherits the untrusted-instruction escalation.
    trace = deep_p9b_trace()
    findings = evaluate_trace(trace, trusted_telemetry=True,
                              host_provenance=["untrusted", "trusted"])
    write_findings = [f for f in findings if f.event_index == 1]
    assert any(f.signal is Signal.UNTRUSTED_INSTRUCTION and f.severity == 5
               for f in write_findings)
