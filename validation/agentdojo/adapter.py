from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter_ns
from typing import Any, Callable, Mapping, Protocol

from halo.types import Action, EnforcementDecision, Verdict


class TelemetryFactory(Protocol):
    def __call__(self, action: Action, *, phase: str, payload: Mapping[str, Any]) -> Any: ...


@dataclass(frozen=True, slots=True)
class MediatedCallResult:
    decision: EnforcementDecision
    executed: bool
    result: Any = None
    overhead_ns: int = 0


class HALOEffectBoundary:
    """Benchmark adapter that keeps HALO immediately in front of a real tool effect.

    The benchmark/model may propose an arbitrary call, but only this adapter owns the
    callable that performs the side effect. A PRE denial therefore cannot accidentally
    fall through into tool execution. The adapter intentionally contains no attack or
    benchmark-result logic.
    """

    def __init__(self, *, enforcer: Any, telemetry_factory: TelemetryFactory):
        self._enforcer = enforcer
        self._telemetry_factory = telemetry_factory

    def execute(
        self,
        *,
        action: Action,
        payload: Mapping[str, Any],
        effect: Callable[[], Any],
    ) -> MediatedCallResult:
        if not callable(effect):
            raise TypeError("effect must be callable")

        envelope = self._telemetry_factory(action, phase="pre", payload=payload)
        started = perf_counter_ns()
        decision = self._enforcer.pre(action, envelope)
        overhead_ns = perf_counter_ns() - started

        if decision.verdict is not Verdict.ALLOW:
            return MediatedCallResult(
                decision=decision,
                executed=False,
                overhead_ns=overhead_ns,
            )

        # The effect is deliberately invoked only after the committed PRE ALLOW.
        result = effect()
        return MediatedCallResult(
            decision=decision,
            executed=True,
            result=result,
            overhead_ns=overhead_ns,
        )


def action_from_tool_call(
    *,
    action_id: str,
    subject: str,
    tool_name: str,
    resource: str,
    arguments: Mapping[str, Any],
) -> Action:
    """Normalize a benchmark tool call into HALO's immutable authorization object."""
    if not isinstance(arguments, Mapping):
        raise TypeError("tool arguments must be a mapping")
    return Action(
        action_id=action_id,
        subject=subject,
        operation=tool_name,
        resource=resource,
        attributes={"arguments": arguments},
    )
