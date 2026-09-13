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


def decide(findings: Iterable[Finding], *, effectful: bool = False) -> PolicyResult:
    findings = tuple(findings)
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
    # be evaluated reliably; preserve the evidence and isolate the action instead
    # of interpreting missing telemetry as benign.
    if effectful and Signal.MONITORING_GAP in signals:
        return PolicyResult(
            Decision.QUARANTINE,
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
