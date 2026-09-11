from validation.agentdojo.runtime_gate import GateContext, HALORuntimeGate
from halo.types import EnforcementDecision, Phase, Verdict


class FakeRuntime:
    def __init__(self):
        self.calls = []

    def run_function(self, env, name, kwargs, raise_on_error=False):
        self.calls.append((env, name, dict(kwargs), raise_on_error))
        return {"ok": True}, None


class FakeBoundary:
    def __init__(self, verdict):
        self.verdict = verdict
        self.actions = []

    def execute(self, *, action, payload, effect):
        from validation.agentdojo.adapter import MediatedCallResult

        self.actions.append((action, payload))
        decision = EnforcementDecision(self.verdict, Phase.PRE, action.action_id, "test")
        if self.verdict is Verdict.DENY:
            return MediatedCallResult(decision, False)
        return MediatedCallResult(decision, True, effect())


def context():
    return GateContext(
        subject="benchmark-agent",
        resource_for_tool=lambda name, args: f"tool:{name}",
        payload_for_tool=lambda name, args: {"source": "agentdojo"},
    )


def test_denial_never_reaches_runtime():
    runtime = FakeRuntime()
    gate = HALORuntimeGate(boundary=FakeBoundary(Verdict.DENY), context=context())
    result = gate.run_function(runtime, object(), "send_message", {"recipient": "user"})
    assert not result.executed
    assert runtime.calls == []


def test_allow_executes_exactly_once_with_agentdojo_signature_and_snapshot():
    runtime = FakeRuntime()
    boundary = FakeBoundary(Verdict.ALLOW)
    gate = HALORuntimeGate(boundary=boundary, context=context())
    env = object()
    args = {"recipient": "user"}
    result = gate.run_function(runtime, env, "send_message", args, raise_on_error=True)
    args["recipient"] = "changed-after-call"
    assert result.executed
    assert result.result == ({"ok": True}, None)
    assert runtime.calls == [(env, "send_message", {"recipient": "user"}, True)]
    action, _ = boundary.actions[0]
    assert action.attributes["arguments"]["recipient"] == "user"


def test_malformed_runtime_arguments_and_raise_flag_fail_before_effect():
    gate = HALORuntimeGate(boundary=FakeBoundary(Verdict.ALLOW), context=context())
    try:
        gate.run_function(object(), None, "tool", {})
        assert False
    except TypeError:
        pass
    try:
        gate.run_function(FakeRuntime(), None, "tool", "not-a-map")
        assert False
    except TypeError:
        pass
    try:
        gate.run_function(FakeRuntime(), None, "tool", {}, raise_on_error=1)
        assert False
    except TypeError:
        pass
