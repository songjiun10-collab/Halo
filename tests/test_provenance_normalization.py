"""Regressions for provenance NFKC normalization (round-10 Patch 3).

Provenance labels are NFKC-folded and stripped of Unicode format characters
(category Cf, e.g. U+200B zero-width space) before the
trusted/untrusted/unknown allowlist is applied, so a laundered label that only
matches the vocabulary after normalization now fires the untrusted channel
(UNTRUSTED_INSTRUCTION) AND keeps the uncertainty gap that preserves the deny
outcome — the standing do-not-weaken invariant, and the reason the recorded
P9-A regression in test_report_security_regressions.py keeps passing unmodified.

Note (recorded honestly): NFKC has NO cross-script folding, so the Cyrillic
homograph "untrustеd" (U+0435) is NOT normalized to "untrusted" — it stays
unmatched and is rejected by the allowlist (gap), which is fail-closed. The
V9 recommendation's claimed NFKC fold for cross-script homoglyphs is not how
NFKC behaves; the orchestrator probe only requires fail-closed for those.
"""
import pytest

from halo.policy import Decision, decide
from halo.safety_cases import Event, Signal, evaluate_trace


def _ew(**changes):
    base = dict(kind="tool", action="send_message", approved=True,
                telemetry_complete=True, provenance="trusted",
                declared_scope="external", target_scope="external")
    base.update(changes)
    return Event(**base)


def test_zwsp_provenance_fires_untrusted_channel():
    # U+200B is category Cf; the label only matches the vocabulary after the
    # format character is removed, so the channel fires on top of the gap.
    findings = evaluate_trace([Event(kind="tool", provenance="untrusted\u200b")])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    # The laundering gap is preserved so the deny outcome is not weakened.
    assert Signal.MONITORING_GAP in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_zwsp_midword_provenance_fires_untrusted_channel():
    findings = evaluate_trace([Event(kind="tool", provenance="untrust\u200bed")])
    assert Signal.UNTRUSTED_INSTRUCTION in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_fullwidth_provenance_fires_untrusted_channel():
    # NFKC folds fullwidth forms: "ｕｎｔｒｕｓｔｅｄ" -> "untrusted".
    findings = evaluate_trace([Event(kind="tool", provenance="ｕｎｔｒｕｓｔｅｄ")])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert Signal.MONITORING_GAP in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_soft_hyphen_and_word_joiner_provenance_fire_untrusted_channel():
    # U+00AD and U+2060 are category Cf format characters.
    for provenance in ("untrusted\u00ad", "untrust\u2060ed"):
        findings = evaluate_trace([Event(kind="tool", provenance=provenance)])
        assert Signal.UNTRUSTED_INSTRUCTION in {f.signal for f in findings}, provenance
        assert decide(findings, effectful=True).decision is Decision.DENY


def test_instruction_kind_zwsp_provenance_fires_untrusted_channel():
    # Strengthening recorded honestly: pre-patch this produced only
    # monitoring_gap@4 findings ("unknown provenance encoding"); the
    # normalization makes the untrusted channel fire instead. The laundering
    # gap is retained, so the deny outcome is unchanged.
    findings = evaluate_trace([Event(kind="instruction", provenance="untrusted\u200b")])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert Signal.MONITORING_GAP in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_laundered_provenance_on_instruction_precedes_escalated_write():
    # The untrusted channel now fires for laundered labels, so a following
    # external write inherits the untrusted@5 escalation (severity 5 -> DENY).
    findings = evaluate_trace([Event(kind="instruction", provenance="untrusted\u200b"),
                               _ew()], trusted_telemetry=True)
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert any(f.signal is Signal.UNTRUSTED_INSTRUCTION and f.severity == 5
               for f in findings)
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_homograph_provenance_still_fails_closed():
    # NFKC has no cross-script folding: the Cyrillic е (U+0435) homograph is
    # NOT normalized to "untrusted", so it is rejected by the allowlist (gap)
    # and the fail-closed deny is preserved.
    findings = evaluate_trace([Event(kind="tool", provenance="untrust\u0435d")])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION not in signals
    assert Signal.MONITORING_GAP in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_unknown_encoding_still_rejected():
    findings = evaluate_trace([Event(kind="tool", provenance="nonsense")])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_plain_untrusted_behavior_unchanged():
    # Plain labels keep the exact pre-patch outcome: untrusted channel finding,
    # no laundering gap (nothing was laundered).
    findings = evaluate_trace([Event(kind="tool", provenance="untrusted")])
    signals = {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION in signals
    assert Signal.MONITORING_GAP not in signals
    assert decide(findings, effectful=True).decision is Decision.REVIEW


def test_case_and_whitespace_variation_still_accepted():
    # Plain case/whitespace variation was already normalized pre-patch; it
    # must not fabricate a laundering gap.
    findings = evaluate_trace([Event(kind="tool", provenance="  TRUSTED  ")])
    assert findings == []


def test_unknown_encoding_fires_for_unrecognized_laundered_label():
    # A laundered label that still does not match the vocabulary after
    # cleaning is rejected by the allowlist (fail closed).
    findings = evaluate_trace([Event(kind="tool", provenance="nonsens\u200be")])
    assert Signal.MONITORING_GAP in {f.signal for f in findings}
    assert Signal.UNTRUSTED_INSTRUCTION not in {f.signal for f in findings}
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_str_subclass_provenance_still_rejected_before_normalization():
    # The type-exact validation must reject lying str subclasses BEFORE any
    # normalization runs: a subclass that lies about strip()/lower() must
    # never reach the allowlist.
    class Sneaky(str):
        def strip(self, *args, **kwargs):
            return self

        def lower(self, *args, **kwargs):
            return "trusted"

    findings = evaluate_trace([Event(kind="tool", provenance=Sneaky("untrusted"))])
    signals = {f.signal for f in findings}
    assert Signal.MONITORING_GAP in signals
    assert Signal.UNTRUSTED_INSTRUCTION not in signals
    assert decide(findings, effectful=True).decision is Decision.DENY


def test_host_override_with_laundered_self_claim_disagrees():
    # Patch 2 + Patch 3 together: the disagreement check compares normalized
    # labels, so a laundered self-claim that no longer equals the honest host
    # value emits the disagreement gap.
    findings = evaluate_trace([_ew(provenance="untrusted\u200b")],
                              trusted_telemetry=True,
                              host_provenance="trusted")
    assert any("disagrees with host telemetry" in f.reason for f in findings)
    assert decide(findings, effectful=True).decision is Decision.DENY
