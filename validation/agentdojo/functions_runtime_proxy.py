from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable

from .adapter import MediatedCallResult
from .runtime_gate import HALORuntimeGate


class HALODeniedError(RuntimeError):
    """Raised when HALO denies an AgentDojo function effect."""


ResultObserver = Callable[[MediatedCallResult], None]


class HALOFunctionsRuntimeProxy:
    """Drop-in mediation proxy for AgentDojo ``FunctionsRuntime``.

    AgentDojo's ``ToolsExecutor`` checks ``runtime.functions`` and then calls
    ``runtime.run_function(env, function, kwargs)``. This proxy preserves that contract
    while routing every concrete effect through ``HALORuntimeGate``.

    AgentDojo also permits a ``FunctionCall`` as an argument to another function. The
    stock runtime resolves those nested calls recursively through its own ``self``. A
    naive wrapper would therefore mediate only the outer call and let nested effects
    bypass HALO. This proxy resolves nested calls through *itself* first, so each nested
    effect receives a distinct HALO PRE decision before the outer call is attempted.

    Nested calls retain AgentDojo's eager semantics: an allowed nested side effect may
    occur before a later outer call is denied. HALO provides complete mediation here,
    not transactional rollback across a nested call tree.
    """

    def __init__(
        self,
        *,
        runtime: Any,
        gate: HALORuntimeGate,
        result_observer: ResultObserver | None = None,
    ) -> None:
        functions = getattr(runtime, "functions", None)
        if not isinstance(functions, Mapping):
            raise TypeError("runtime must expose a functions mapping")
        if not callable(getattr(runtime, "run_function", None)):
            raise TypeError("runtime must expose callable run_function")
        if result_observer is not None and not callable(result_observer):
            raise TypeError("result_observer must be callable")
        self._runtime = runtime
        self._gate = gate
        self._result_observer = result_observer

    @property
    def functions(self) -> Mapping[str, Any]:
        return self._runtime.functions

    def __repr__(self) -> str:
        return f"HALOFunctionsRuntimeProxy(runtime={self._runtime!r})"

    def update_functions(self, new_functions: dict[str, Any]) -> None:
        updater = getattr(self._runtime, "update_functions", None)
        if not callable(updater):
            raise TypeError("runtime must expose callable update_functions")
        updater(new_functions)

    def run_function(
        self,
        env: Any,
        function: str,
        kwargs: Mapping[str, Any],
        raise_on_error: bool = False,
    ) -> tuple[Any, str | None]:
        if not isinstance(kwargs, Mapping):
            exc = TypeError("function arguments must be a mapping")
            if raise_on_error:
                raise exc
            return "", f"TypeError: {exc}"

        try:
            resolved_kwargs = self._resolve_nested_calls(env, kwargs)
        except Exception as exc:
            if raise_on_error:
                raise
            return "", f"{type(exc).__name__}: {exc}"

        mediated = self._gate.run_function(
            self._runtime,
            env,
            function,
            resolved_kwargs,
            raise_on_error=raise_on_error,
        )
        if self._result_observer is not None:
            self._result_observer(mediated)

        if not mediated.executed:
            exc = HALODeniedError(mediated.decision.reason or "HALO denied tool execution")
            if raise_on_error:
                raise exc
            return "", f"HALODeniedError: {exc}"

        result = mediated.result
        if not isinstance(result, tuple) or len(result) != 2:
            exc = TypeError("AgentDojo runtime returned an invalid result shape")
            if raise_on_error:
                raise exc
            return "", f"TypeError: {exc}"
        return result

    def _resolve_nested_calls(self, env: Any, kwargs: Mapping[str, Any]) -> dict[str, Any]:
        try:
            from agentdojo.functions_runtime import FunctionCall
        except ImportError as exc:  # pragma: no cover - exercised by validation CI
            raise RuntimeError(
                "AgentDojo integration requires the pinned validation dependency"
            ) from exc

        resolved: dict[str, Any] = {}
        for name, value in kwargs.items():
            if isinstance(value, FunctionCall):
                nested_result, _ = self.run_function(
                    env,
                    value.function,
                    value.args,
                    raise_on_error=True,
                )
                resolved[name] = nested_result
            else:
                resolved[name] = value
        return resolved
