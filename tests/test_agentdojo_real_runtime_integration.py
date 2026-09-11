import pytest

pytest.importorskip("agentdojo")

from agentdojo.functions_runtime import FunctionCall, FunctionsRuntime, make_function

from halo.types import EnforcementDecision, Phase, Verdict
from validation.agentdojo.adapter import MediatedCallResult
from validation.agentdojo.functions_runtime_proxy import HALOFunctionsRuntimeProxy
from validation.agentdojo.runtime_gate import GateContext, HALORuntimeGate


class SelectiveBoundary:
    def __init__(self, denied_operations=()):
        self.denied_operations = frozenset(denied_operations)
        self.actions = []

    def execute(self, *, action, payload, effect):
        self.actions.append((action, payload))
        verdict = Verdict.DENY if action.operation in self.denied_operations else Verdict.ALLOW
        decision = EnforcementDecision(verdict, Phase.PRE, action.action_id, "test-policy")
        if verdict is Verdict.DENY:
            return MediatedCallResult(decision=decision, executed=False)
        return MediatedCallResult(decision=decision, executed=True, result=effect())


def make_proxy(boundary, effects):
    def record(value: str) -> str:
        """Record a value.

        :param value: Value to record.
        """
        effects.append(("record", value))
        return f"recorded:{value}"

    def combine(left: str, right: str) -> str:
        """Combine two strings.

        :param left: Left string.
        :param right: Right string.
        """
        effects.append(("combine", left, right))
        return f"{left}|{right}"

    runtime = FunctionsRuntime([make_function(record), make_function(combine)])
    gate = HALORuntimeGate(
        boundary=boundary,
        context=GateContext(
            subject="benchmark-agent",
            resource_for_tool=lambda name, args: f"tool:{name}",
            payload_for_tool=lambda name, args: {"source": "agentdojo"},
        ),
    )
    return HALOFunctionsRuntimeProxy(runtime=runtime, gate=gate)


def test_real_agentdojo_runtime_contract_is_preserved():
    effects = []
    boundary = SelectiveBoundary()
    proxy = make_proxy(boundary, effects)

    result, error = proxy.run_function(None, "record", {"value": "hello"})

    assert error is None
    assert result == "recorded:hello"
    assert effects == [("record", "hello")]
    assert [action.operation for action, _ in boundary.actions] == ["record"]


def test_nested_function_call_is_mediated_before_outer_effect():
    effects = []
    boundary = SelectiveBoundary()
    proxy = make_proxy(boundary, effects)

    result, error = proxy.run_function(
        None,
        "combine",
        {
            "left": FunctionCall(function="record", args={"value": "nested"}),
            "right": "tail",
        },
    )

    assert error is None
    assert result == "recorded:nested|tail"
    assert effects == [
        ("record", "nested"),
        ("combine", "recorded:nested", "tail"),
    ]
    assert [action.operation for action, _ in boundary.actions] == ["record", "combine"]


def test_denied_nested_call_cannot_bypass_halo_or_reach_outer_effect():
    effects = []
    boundary = SelectiveBoundary(denied_operations={"record"})
    proxy = make_proxy(boundary, effects)

    result, error = proxy.run_function(
        None,
        "combine",
        {
            "left": FunctionCall(function="record", args={"value": "blocked"}),
            "right": "tail",
        },
    )

    assert result == ""
    assert error is not None and error.startswith("HALODeniedError:")
    assert effects == []
    assert [action.operation for action, _ in boundary.actions] == ["record"]
