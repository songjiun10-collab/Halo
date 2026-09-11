from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any

from .canonical import canonical_json
from .invariants import Invariant
from .provenance import DEFAULT_CONTROL_FIELDS, DEFAULT_TRUSTED_CONTROL_ORIGINS, Origin
from .types import Action, Phase


def _string_set(value: Any) -> frozenset[str] | None:
    if isinstance(value, str):
        return frozenset({value}) if value else None
    if not isinstance(value, (list, tuple, set, frozenset)) or not value:
        return None
    if not all(isinstance(item, str) and item for item in value):
        return None
    return frozenset(value)


def _origin_set(value: Any) -> frozenset[str] | None:
    raw = _string_set(value)
    if raw is None:
        return None
    out: set[str] = set()
    try:
        for item in raw:
            out.add(Origin(item).value)
    except ValueError:
        return None
    return frozenset(out)


def _trusted_origin_values(origins: Iterable[Origin | str]) -> frozenset[str]:
    out: set[str] = set()
    for origin in origins:
        out.add(origin.value if isinstance(origin, Origin) else Origin(origin).value)
    if not out:
        raise ValueError("at least one trusted origin is required")
    return frozenset(out)


def delegation_chain_invariant(
    *,
    name: str = "delegation_scope",
    telemetry_key: str = "delegation",
    max_depth: int = 8,
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    """Require delegation to monotonically narrow authority.

    The authenticated telemetry shape is::

        {
          "delegation": {
            "root_subject": "supervisor",
            "root_operations": ["read", "write"],
            "root_resources": ["workspace"],
            "chain": [
              {
                "delegator": "supervisor",
                "delegate": "worker",
                "operations": ["read"],
                "resources": ["workspace"]
              }
            ]
          }
        }

    Every hop must name the previous delegate as its delegator and may only
    narrow the operation/resource sets. The final delegate and scope must cover
    the concrete Action. Telemetry is assumed to be assigned/authenticated by
    trusted runtime instrumentation.
    """

    if type(max_depth) is not int or max_depth <= 0:
        raise ValueError("max_depth must be a positive integer")

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        raw = telemetry.get(telemetry_key)
        if not isinstance(raw, Mapping):
            return False
        root_subject = raw.get("root_subject")
        operations = _string_set(raw.get("root_operations"))
        resources = _string_set(raw.get("root_resources"))
        chain = raw.get("chain")
        if not isinstance(root_subject, str) or not root_subject:
            return False
        if operations is None or resources is None:
            return False
        if not isinstance(chain, (list, tuple)) or not chain or len(chain) > max_depth:
            return False

        expected_delegator = root_subject
        current_operations = operations
        current_resources = resources
        final_delegate = root_subject

        for hop in chain:
            if not isinstance(hop, Mapping):
                return False
            delegator = hop.get("delegator")
            delegate = hop.get("delegate")
            hop_operations = _string_set(hop.get("operations"))
            hop_resources = _string_set(hop.get("resources"))
            if delegator != expected_delegator:
                return False
            if not isinstance(delegate, str) or not delegate:
                return False
            if hop_operations is None or hop_resources is None:
                return False
            if not hop_operations.issubset(current_operations):
                return False
            if not hop_resources.issubset(current_resources):
                return False
            expected_delegator = delegate
            final_delegate = delegate
            current_operations = hop_operations
            current_resources = hop_resources

        return (
            final_delegate == action.subject
            and action.operation in current_operations
            and action.resource in current_resources
        )

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="delegation chain is malformed, amplified, or does not authorize the action",
    )


def origin_bound_authority_invariant(
    *,
    name: str = "origin_bound_authority",
    telemetry_key: str = "authority_lineage",
    fields: Iterable[str] = DEFAULT_CONTROL_FIELDS,
    allowed_origins: Iterable[Origin | str] = DEFAULT_TRUSTED_CONTROL_ORIGINS,
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    """Prevent authority laundering through later trusted-looking transforms.

    For each security-sensitive field, trusted instrumentation provides both
    root origins and current origins. Authority is accepted only when *both*
    sets remain within the configured trusted-origin set. Summarization, tool
    echo, corroboration, or memory retrieval therefore cannot erase an
    untrusted root merely by changing the current representation.
    """

    required_fields = tuple(fields)
    if not required_fields or any(not isinstance(field, str) or not field for field in required_fields):
        raise ValueError("at least one non-empty authority field is required")
    trusted = _trusted_origin_values(allowed_origins)

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        lineage = telemetry.get(telemetry_key)
        if not isinstance(lineage, Mapping):
            return False
        for field in required_fields:
            entry = lineage.get(field)
            if not isinstance(entry, Mapping):
                return False
            roots = _origin_set(entry.get("roots"))
            current = _origin_set(entry.get("current"))
            if roots is None or current is None:
                return False
            if not roots.issubset(trusted) or not current.issubset(trusted):
                return False
        return True

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="authority lineage contains an untrusted or malformed origin",
    )


def attribute_authorization_invariant(
    *,
    name: str = "attribute_authorization",
    telemetry_key: str = "attribute_authorization",
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    """Authorize concrete action argument values instead of tool access alone.

    Supported trusted constraint groups are ``exact``, ``allowed``,
    ``numeric_min`` and ``numeric_max``. Constraints apply to top-level
    ``Action.attributes`` keys and fail closed on missing or malformed values.
    Unknown constraint group names also fail closed so configuration typos do
    not silently weaken authorization.
    """

    supported_groups = frozenset({"exact", "allowed", "numeric_min", "numeric_max"})

    def same_value(left: Any, right: Any) -> bool:
        try:
            return canonical_json(left) == canonical_json(right)
        except (TypeError, ValueError):
            return False

    def number(value: Any) -> float | int | None:
        if type(value) not in (int, float):
            return None
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        raw = telemetry.get(telemetry_key)
        if not isinstance(raw, Mapping):
            return False
        if any(not isinstance(key, str) or key not in supported_groups for key in raw):
            return False

        groups = {key: raw.get(key) for key in supported_groups}
        if not any(isinstance(value, Mapping) and value for value in groups.values()):
            return False
        for value in groups.values():
            if value is not None and not isinstance(value, Mapping):
                return False

        exact = groups["exact"] or {}
        for key, expected in exact.items():
            if not isinstance(key, str) or key not in action.attributes:
                return False
            if not same_value(action.attributes[key], expected):
                return False

        allowed = groups["allowed"] or {}
        for key, candidates in allowed.items():
            if not isinstance(key, str) or key not in action.attributes:
                return False
            if not isinstance(candidates, (list, tuple)) or not candidates:
                return False
            if not any(same_value(action.attributes[key], candidate) for candidate in candidates):
                return False

        minimums = groups["numeric_min"] or {}
        maximums = groups["numeric_max"] or {}
        for key in set(minimums) | set(maximums):
            if not isinstance(key, str) or key not in action.attributes:
                return False
            observed = number(action.attributes[key])
            if observed is None:
                return False
            if key in minimums:
                minimum = number(minimums[key])
                if minimum is None or observed < minimum:
                    return False
            if key in maximums:
                maximum = number(maximums[key])
                if maximum is None or observed > maximum:
                    return False
        return True

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="concrete action attributes exceed authenticated authorization constraints",
    )


def information_flow_invariant(
    *,
    name: str = "information_flow",
    telemetry_key: str = "information_flow",
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST}),
) -> Invariant:
    """Restrict labeled data from flowing to unauthorized action resources.

    Trusted telemetry provides labels carried by the data used in the action and
    an allow-map from concrete resource/sink to labels permitted at that sink.
    Missing sink policy or malformed labels fail closed.
    """

    def predicate(action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> bool:
        raw = telemetry.get(telemetry_key)
        if not isinstance(raw, Mapping):
            return False
        labels = _string_set(raw.get("labels"))
        allow_by_sink = raw.get("allowed_labels_by_sink")
        if labels is None or not isinstance(allow_by_sink, Mapping):
            return False
        allowed = _string_set(allow_by_sink.get(action.resource))
        if allowed is None:
            return False
        return labels.issubset(allowed)

    return Invariant(
        name=name,
        predicate=predicate,
        phases=phases,
        failure_reason="information-flow labels are not authorized for the action resource",
    )
