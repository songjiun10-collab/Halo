from __future__ import annotations

import hmac
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, Mapping

from .invariants import Invariant
from .types import Action, Phase


class Origin(str, Enum):
    RUNTIME = "runtime"
    USER_INTENT = "user_intent"
    TRUSTED_PLAN = "trusted_plan"
    MODEL = "model"
    TOOL_OUTPUT = "tool_output"
    EXTERNAL_DATA = "external_data"
    MEMORY = "memory"
    RETRIEVAL = "retrieval"
    MCP_DESCRIPTOR = "mcp_descriptor"
    PEER_AGENT = "peer_agent"
    PERCEPTION = "perception"


DEFAULT_TRUSTED_CONTROL_ORIGINS = frozenset(
    {Origin.RUNTIME, Origin.USER_INTENT, Origin.TRUSTED_PLAN}
)
DEFAULT_CONTROL_FIELDS = ("subject", "operation", "resource")


def _origin_values(origins: Iterable[Origin | str]) -> frozenset[str]:
    out: set[str] = set()
    for origin in origins:
        out.add(origin.value if isinstance(origin, Origin) else Origin(origin).value)
    return frozenset(out)


def _string_set(value: Any) -> frozenset[str] | None:
    if isinstance(value, str):
        return frozenset({value})
    if not isinstance(value, (list, tuple, set, frozenset)):
        return None
    if not value or not all(isinstance(item, str) for item in value):
        return None
    return frozenset(value)


def control_provenance_invariant(
    *,
    name: str = "trusted_control_provenance",
    telemetry_key: str = "control_provenance",
    fields: Iterable[str] = DEFAULT_CONTROL_FIELDS,
    allowed_origins: Iterable[Origin | str] = DEFAULT_TRUSTED_CONTROL_ORIGINS,
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    required_fields = tuple(fields)
    allowed = _origin_values(allowed_origins)
    if not required_fields or any(not isinstance(field, str) or not field for field in required_fields):
        raise ValueError("at least one non-empty control field is required")
    if not allowed:
        raise ValueError("at least one trusted control origin is required")

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        provenance = telemetry.get(telemetry_key)
        if not isinstance(provenance, Mapping):
            return False
        for field in required_fields:
            sources = _string_set(provenance.get(field))
            if sources is None:
                return False
            try:
                normalised = _origin_values(sources)
            except ValueError:
                return False
            if not normalised.issubset(allowed):
                return False
        return True

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="control provenance is missing, malformed, or untrusted",
    )


@dataclass(frozen=True, slots=True)
class CapabilityScope:
    subject: str
    operations: frozenset[str]
    resources: frozenset[str]

    def allows(self, action: Action) -> bool:
        return (
            self.subject == action.subject
            and action.operation in self.operations
            and action.resource in self.resources
        )


def capability_scope_invariant(
    *,
    name: str = "capability_scope",
    telemetry_key: str = "capability",
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        raw = telemetry.get(telemetry_key)
        if not isinstance(raw, Mapping):
            return False
        subject = raw.get("subject")
        operations = _string_set(raw.get("operations"))
        resources = _string_set(raw.get("resources"))
        if not isinstance(subject, str) or operations is None or resources is None:
            return False
        if not subject or not operations or not resources:
            return False
        return CapabilityScope(subject, operations, resources).allows(action)

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="action exceeds authenticated capability scope",
    )


def resource_binding_invariant(
    *,
    name: str = "resource_digest_binding",
    telemetry_key: str = "resource_binding",
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    def decode_digest(value: Any) -> bytes | None:
        if not isinstance(value, str) or len(value) != 64:
            return None
        try:
            decoded = bytes.fromhex(value)
        except ValueError:
            return None
        return decoded if len(decoded) == 32 else None

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        raw = telemetry.get(telemetry_key)
        if not isinstance(raw, Mapping):
            return False
        approved = decode_digest(raw.get("approved_digest"))
        observed = decode_digest(raw.get("observed_digest"))
        if approved is None or observed is None:
            return False
        return hmac.compare_digest(approved, observed)

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="resource descriptor binding changed or is malformed",
    )
