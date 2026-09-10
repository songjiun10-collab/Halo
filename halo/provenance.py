from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, Mapping

from .invariants import Invariant
from .types import Action, Phase


class Origin(str, Enum):
    """Trusted-runtime provenance labels.

    Labels must be assigned by trusted instrumentation, never accepted from
    model-generated text as assertions about its own trust.
    """

    RUNTIME = "runtime"
    USER_INTENT = "user_intent"
    TRUSTED_PLAN = "trusted_plan"
    MODEL = "model"
    TOOL_OUTPUT = "tool_output"
    EXTERNAL_DATA = "external_data"
    MEMORY = "memory"


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
    """Require security-sensitive control fields to come only from trusted origins.

    ``telemetry_key`` is expected to be produced by trusted runtime
    instrumentation and authenticated by HALO telemetry. Missing, malformed,
    unknown, mixed, or untrusted provenance fails closed.
    """

    required_fields = tuple(fields)
    allowed = _origin_values(allowed_origins)

    if not required_fields or any(not field for field in required_fields):
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
    """Require the authenticated runtime capability to authorize the action."""

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
        scope = CapabilityScope(subject, operations, resources)
        return scope.allows(action)

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="action exceeds authenticated capability scope",
    )
