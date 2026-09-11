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
    """Final effect gate for an AgentDojo ``FunctionsRuntime`` call.

    The wrapped runtime keeps validation/dependency/error semantics, but the call into
    ``runtime.run_function`` is owned by this gate and happens only after HALO PRE has
    returned an audited ALLOW. Attack labels and benchmark outcomes are intentionally
    absent from this layer.
    """

    def __init__(self, *, boundary: HALOEffectBoundary, context: GateContext):
        self._boundary = boundary
        self._context = context
        self._sequence = count(1)

    def run_function(
        self,
        runtime: Any,
        env: Any,
        function_name: str,
        function_args: Mapping[str, Any],
        *,
        raise_on_error: bool = False,
    ) -> MediatedCallResult:
        if not isinstance(function_name, str) or not function_name:
            raise TypeError("function_name must be a non-empty string")
        if not isinstance(function_args, Mapping):
            raise TypeError("function_args must be a mapping")
        if type(raise_on_error) is not bool:
            raise TypeError("raise_on_error must be a bool")
        run_function = getattr(runtime, "run_function", None)
        if not callable(run_function):
            raise TypeError("runtime must expose callable run_function")

        # Snapshot before authorization so later mutation of a model-produced mapping
        # cannot change the effect after the authorization decision was made.
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
            effect=lambda: run_function(
                env,
                function_name,
                args,
                raise_on_error=raise_on_error,
            ),
        )
