"""Minimal containment policy over findings from :mod:`halo.safety_cases`.

The policy is deliberately small and inspectable. It separates *detection* from
*enforcement* so future experiments can measure the safety/usefulness tradeoff
instead of hiding it inside one classifier score.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable

from .safety_cases import Finding, Signal


class Decision(str, Enum):
    ALLOW = "allow"
    REVIEW = "review"
    DENY = "deny"
    QUARANTINE = "quarantine"


@dataclass(frozen=True)
class PolicyResult:
    decision: Decision
    reasons: tuple[str, ...]


def decide(findings: Iterable[Finding], *, effectful: bool = True) -> PolicyResult:
    # Single-use/lazy or overridden iterables must not clear on a second use.
    if type(findings) not in (list, tuple) or type(effectful) is not bool or len(findings) > 100000:
        return PolicyResult(Decision.DENY, ("A bounded plain findings snapshot is required.",))
    findings = tuple(findings)
    if any(type(f) is not Finding or type(f.signal) is not Signal
           or type(f.severity) is not int or not 1 <= f.severity <= 5
           or type(f.reason) is not str or type(f.event_index) is not int for f in findings):
        return PolicyResult(Decision.DENY, ("Invalid finding cannot establish safety.",))
    if any(f.severity == 5 for f in findings):
        return PolicyResult(Decision.DENY, tuple(f.reason for f in findings if f.severity == 5))
    signals = {f.signal for f in findings}

    hard_denies = {
        Signal.PRIVILEGE_ESCALATION,
        Signal.SECRET_EGRESS,
        Signal.UNEXPECTED_EXTERNAL_WRITE,
        Signal.ARTIFACT_MISMATCH,
    }

    if signals & hard_denies:
        return PolicyResult(
            Decision.DENY,
            tuple(f.reason for f in findings if f.signal in hard_denies),
        )

    # A stale approval on an effectful action is stricter than a telemetry
    # quarantine. If findings overlap, the strongest applicable decision wins.
    if effectful and Signal.STATE_MISMATCH in signals:
        return PolicyResult(
            Decision.DENY,
            ("Effect-time state no longer matches the state that was approved.",),
        )

    # Missing observability plus an effectful action means the safety claim cannot
    # be evaluated reliably; deny the action rather than quarantining.
    if effectful and Signal.MONITORING_GAP in signals:
        return PolicyResult(
            Decision.DENY,
            ("Effectful action cannot be authorized with incomplete telemetry.",),
        )

    review_signals = {
        Signal.UNTRUSTED_INSTRUCTION,
        Signal.SCOPE_EXPANSION,
        Signal.MONITORING_GAP,
        Signal.STATE_MISMATCH,
        Signal.EVAL_AWARENESS,
    }
    if signals & review_signals:
        return PolicyResult(
            Decision.REVIEW,
            tuple(f.reason for f in findings if f.signal in review_signals),
        )

    return PolicyResult(Decision.ALLOW, ())
