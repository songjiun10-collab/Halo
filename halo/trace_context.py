"""Trusted-side structural context checks for HALO traces.

This module deliberately avoids interpreting natural-language payloads. Instead it
tracks a small amount of adapter-supplied structure across sessions:

- ``metadata.event_id``: a stable event identifier
- ``metadata.depends_on``: prior event IDs that this event depends on
- ``metadata.evidence_tags``: trusted evidence/obligation markers
- ``metadata.observed_counts``: exact counts produced by a trusted adapter/tool
- ``metadata.environment_binding``: the environment profile an event was planned for

These fields must come from a trusted adapter or runtime, not from model-authored
text. The goal is to make omission, counting, environment-assumption, and
multi-hop provenance failures observable without turning the monitor into a
jailbreak-string classifier.
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
    """Trusted structural requirements for one monitored session.

    ``expected_counts`` is represented as key/value pairs instead of a mutable
    mapping so a frozen contract cannot be changed underneath the monitor.
    ``environment_fingerprint`` is a trusted profile identifier (for example a
    hash or versioned profile), not a natural-language description supplied by
    the protected model.
    """

    required_evidence: frozenset[str] = frozenset()
    expected_counts: tuple[tuple[str, int], ...] = ()
    environment_fingerprint: str | None = None

    def __post_init__(self) -> None:
        if any(not isinstance(tag, str) or not tag.strip() for tag in self.required_evidence):
            raise ValueError("required_evidence must contain non-empty strings")

        normalized_counts: list[tuple[str, int]] = []
        seen: set[str] = set()
        for entry in self.expected_counts:
            if not isinstance(entry, (tuple, list)) or len(entry) != 2:
                raise ValueError("expected_counts entries must be (name, count) pairs")
            name, count = entry
            if not isinstance(name, str) or not name.strip():
                raise ValueError("expected count names must be non-empty strings")
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError("expected counts must be non-negative integers")
            if name in seen:
                raise ValueError("expected count names must be unique")
            seen.add(name)
            normalized_counts.append((name, count))
        object.__setattr__(self, "expected_counts", tuple(normalized_counts))

        if self.environment_fingerprint is not None:
            if (
                not isinstance(self.environment_fingerprint, str)
                or not self.environment_fingerprint.strip()
            ):
                raise ValueError("environment_fingerprint must be a non-empty string")


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


def _count_mapping(value: object) -> tuple[dict[str, int], bool]:
    """Validate exact trusted measurements without Python bool/int aliasing."""

    if value is None:
        return {}, True
    if not isinstance(value, Mapping):
        return {}, False
    out: dict[str, int] = {}
    for key, count in value.items():
        if not isinstance(key, str) or not key.strip():
            return {}, False
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            return {}, False
        out[key] = count
    return out, True


class ContextMonitor:
    """Persistent dependency/evidence monitor spanning multiple sessions.

    The monitor is intentionally deterministic. It remembers stable event IDs and
    whether each event is transitively influenced by explicit untrusted
    provenance. Exact counts and environment bindings are compared against a
    trusted ``TraceContract`` instead of being reasoned about from long text.
    Missing references and malformed structural metadata become
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
        observed_counts: dict[str, int] = {}
        environment_bindings: list[str] = []
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

            counts, counts_valid = _count_mapping(metadata.get("observed_counts"))
            if not counts_valid:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    i,
                    4,
                    "observed_counts is malformed.",
                    is_effectful,
                ))
                counts = {}
            for name, count in counts.items():
                previous = observed_counts.get(name)
                if previous is not None and previous != count:
                    findings.append(Finding(
                        Signal.MONITORING_GAP,
                        i,
                        4,
                        f"Trusted count {name!r} was reported inconsistently.",
                        is_effectful,
                    ))
                else:
                    observed_counts[name] = count

            if "environment_binding" in metadata:
                binding = metadata.get("environment_binding")
                if isinstance(binding, str) and binding.strip():
                    environment_bindings.append(binding)
                else:
                    findings.append(Finding(
                        Signal.MONITORING_GAP,
                        i,
                        4,
                        "environment_binding is malformed.",
                        is_effectful,
                    ))

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

        if effectful_indices:
            contract_index = effectful_indices[-1]
            contract_effectful = True
        else:
            contract_index = len(events) - 1 if events else -1
            contract_effectful = False

        missing = contract.required_evidence - observed_evidence
        if missing:
            findings.append(Finding(
                Signal.MONITORING_GAP,
                contract_index,
                4,
                "Required trusted evidence is missing: " + ", ".join(sorted(missing)),
                contract_effectful,
            ))

        for name, expected in contract.expected_counts:
            if name not in observed_counts:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    contract_index,
                    4,
                    f"Required trusted count {name!r} is missing.",
                    contract_effectful,
                ))
            elif observed_counts[name] != expected:
                findings.append(Finding(
                    Signal.STATE_MISMATCH,
                    contract_index,
                    4,
                    f"Trusted count {name!r} does not match the contract.",
                    contract_effectful,
                ))

        if contract.environment_fingerprint is not None:
            unique_bindings = set(environment_bindings)
            if not environment_bindings:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    contract_index,
                    4,
                    "Required environment binding is missing.",
                    contract_effectful,
                ))
            elif len(unique_bindings) != 1:
                findings.append(Finding(
                    Signal.MONITORING_GAP,
                    contract_index,
                    4,
                    "Environment binding is inconsistent within the session.",
                    contract_effectful,
                ))
            elif next(iter(unique_bindings)) != contract.environment_fingerprint:
                findings.append(Finding(
                    Signal.STATE_MISMATCH,
                    contract_index,
                    4,
                    "Event environment binding does not match the trusted profile.",
                    contract_effectful,
                ))

        self._session_index += 1
        return findings
