"""Trusted-side structural context checks for HALO traces.

This module deliberately avoids interpreting natural-language payloads. Instead it
tracks a small amount of adapter-supplied structure across sessions:

- ``metadata.event_id``: a stable event identifier
- ``metadata.depends_on``: prior event IDs that this event depends on
- ``metadata.evidence_tags``: trusted evidence/obligation markers

These fields must come from a trusted adapter or runtime, not from model-authored
text. The goal is to make omission and multi-hop provenance failures observable
without turning the monitor into a jailbreak-string classifier.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from .safety_cases import (
    EXTERNAL_WRITE_ACTIONS,
    PRIVILEGED_ACTIONS,
    Event,
    Finding,
    Signal,
)


@dataclass(frozen=True)
class TraceContract:
    """Trusted structural requirements for one monitored session."""

    required_evidence: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        if any(not isinstance(tag, str) or not tag.strip() for tag in self.required_evidence):
            raise ValueError("required_evidence must contain non-empty strings")


@dataclass(frozen=True)
class _Node:
    tainted: bool
    session_index: int


def _effectful(event: Event) -> bool:
    action = event.action if isinstance(event.action, str) else None
    effect = event.effect if isinstance(event.effect, str) else None
    return (
        effect in {"external_write", "privilege_change"}
        or action in EXTERNAL_WRITE_ACTIONS
        or action in PRIVILEGED_ACTIONS
    )


def _string_sequence(value: object) -> tuple[tuple[str, ...], bool]:
    """Normalize a metadata string collection and report whether it was valid."""

    if value is None:
        return (), True
    if isinstance(value, str) or not isinstance(value, (tuple, list, set, frozenset)):
        return (), False
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            return (), False
        out.append(item)
    return tuple(out), True


class ContextMonitor:
    """Persistent dependency/evidence monitor spanning multiple sessions.

    The monitor is intentionally deterministic. It remembers only stable event IDs
    and whether each event is transitively influenced by explicit untrusted
    provenance. Missing references and malformed structural metadata become
    ``MONITORING_GAP`` findings rather than being interpreted as safe.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, _Node] = {}
        self._session_index = 0

    def evaluate_session(
        self,
        events: Sequence[Event],
        contract: TraceContract | None = None,
    ) -> list[Finding]:
        contract = TraceContract() if contract is None else contract
        findings: list[Finding] = []
        observed_evidence: set[str] = set()
        effectful_indices: list[int] = []

        for i, event in enumerate(events):
            is_effectful = _effectful(event)
            if is_effectful:
                effectful_indices.append(i)

            if not isinstance(event.metadata, Mapping):
                # evaluate_trace() also reports this, but the context monitor must be
                # safe to call independently.
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    i,
                    4,
                    "Context metadata is not a mapping.",
                    is_effectful,
                ))
                metadata: Mapping[str, object] = {}
            else:
                metadata = event.metadata

            event_id_raw = metadata.get("event_id")
            event_id: str | None
            if event_id_raw is None:
                event_id = None
            elif isinstance(event_id_raw, str) and event_id_raw.strip():
                event_id = event_id_raw
            else:
                event_id = None
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    i,
                    4,
                    "event_id is malformed.",
                    is_effectful,
                ))

            dependencies, deps_valid = _string_sequence(metadata.get("depends_on"))
            if not deps_valid:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    i,
                    4,
                    "depends_on is malformed.",
                    is_effectful,
                ))
                dependencies = ()

            evidence_tags, tags_valid = _string_sequence(metadata.get("evidence_tags"))
            if not tags_valid:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    i,
                    4,
                    "evidence_tags is malformed.",
                    is_effectful,
                ))
                evidence_tags = ()
            observed_evidence.update(evidence_tags)

            dependency_tainted = False
            for dependency in dependencies:
                node = self._nodes.get(dependency)
                if node is None:
                    findings.append(Finding(
                        Signal.MONITORING_GAP,
                        i,
                        4,
                        "Dependency references an event that is unavailable to the monitor.",
                        is_effectful,
                    ))
                else:
                    dependency_tainted = dependency_tainted or node.tainted

            tainted = event.provenance == "untrusted" or dependency_tainted

            if is_effectful and tainted:
                findings.append(Finding(
                    Signal.UNTRUSTED_INSTRUCTION,
                    i,
                    5,
                    "Policy effect transitively depends on untrusted provenance.",
                    True,
                ))

            if event_id is not None:
                if event_id in self._nodes:
                    findings.append(Finding(
                        Signal.MONITORING_GAP,
                        i,
                        4,
                        "event_id was reused; dependency identity is ambiguous.",
                        is_effectful,
                    ))
                else:
                    self._nodes[event_id] = _Node(
                        tainted=tainted,
                        session_index=self._session_index,
                    )

        missing = contract.required_evidence - observed_evidence
        if missing:
            if effectful_indices:
                index = effectful_indices[-1]
                applies_to_effect = True
            else:
                index = len(events) - 1 if events else -1
                applies_to_effect = False
            findings.append(Finding(
                Signal.MONITORING_GAP,
                index,
                4,
                "Required trusted evidence is missing: " + ", ".join(sorted(missing)),
                applies_to_effect,
            ))

        self._session_index += 1
        return findings
