from __future__ import annotations

from dataclasses import dataclass
from itertools import count
from typing import Any, Callable, Mapping

from .adapter import HALOEffectBoundary, MediatedCallResult, action_from_tool_call


@dataclass(frozen=True, slots=True)
class GateContext:
    subject: str
    resource_for_tool: Callable[[str, Mapping[str, Any]], str]
    payload_for_tool: Callable[[str, Mapping[str, Any]], Mapping[str, Any]]


class HALORuntimeGate:
    """Small integration seam for AgentDojo-style function runtimes.

    The wrapped runtime remains responsible for resolving and invoking tools. This gate
    owns the final call into that runtime, so no protected tool effect can occur before
    HALO PRE returns an audited ALLOW. It is deliberately independent of benchmark
    attacks, task labels, and observed scores.
    """

    def __init__(self, *, boundary: HALOEffectBoundary, context: GateContext):
        self._boundary = boundary
        self._context = context
        self._sequence = count(1)

    def run_function(
        self,
        runtime: Any,
        function_name: str,
        function_args: Mapping[str, Any],
    ) -> MediatedCallResult:
        if not isinstance(function_name, str) or not function_name:
            raise TypeError("function_name must be a non-empty string")
        if not isinstance(function_args, Mapping):
            raise TypeError("function_args must be a mapping")
        run_function = getattr(runtime, "run_function", None)
        if not callable(run_function):
            raise TypeError("runtime must expose callable run_function")

        # Snapshot before authorization so caller mutation cannot change the effect.
        args = dict(function_args)
        resource = self._context.resource_for_tool(function_name, args)
        payload = self._context.payload_for_tool(function_name, args)
        if not isinstance(resource, str) or not resource:
            raise TypeError("resource resolver must return a non-empty string")
        if not isinstance(payload, Mapping):
            raise TypeError("payload resolver must return a mapping")

        action = action_from_tool_call(
            action_id=f"agentdojo-{next(self._sequence)}",
            subject=self._context.subject,
            tool_name=function_name,
            resource=resource,
            arguments=args,
        )
        return self._boundary.execute(
            action=action,
            payload=payload,
            effect=lambda: run_function(function_name, **args),
        )
