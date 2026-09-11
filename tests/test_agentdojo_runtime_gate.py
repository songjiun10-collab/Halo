from validation.agentdojo.runtime_gate import GateContext, HALORuntimeGate
from halo.types import EnforcementDecision, Phase, Verdict


class FakeRuntime:
    def __init__(self):
        self.calls = []

    def run_function(self, name, **kwargs):
        self.calls.append((name, kwargs))
        return {"ok": True}


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
    result = gate.run_function(runtime, "send_message", {"recipient": "user"})
    assert not result.executed
    assert runtime.calls == []


def test_allow_executes_exactly_once_with_snapshotted_arguments():
    runtime = FakeRuntime()
    boundary = FakeBoundary(Verdict.ALLOW)
    gate = HALORuntimeGate(boundary=boundary, context=context())
    args = {"recipient": "user"}
    result = gate.run_function(runtime, "send_message", args)
    args["recipient"] = "changed-after-call"
    assert result.executed
    assert runtime.calls == [("send_message", {"recipient": "user"})]
    action, _ = boundary.actions[0]
    assert action.attributes["arguments"]["recipient"] == "user"


def test_malformed_runtime_and_arguments_fail_before_effect():
    gate = HALORuntimeGate(boundary=FakeBoundary(Verdict.ALLOW), context=context())
    try:
        gate.run_function(object(), "tool", {})
        assert False
    except TypeError:
        pass
    try:
        gate.run_function(FakeRuntime(), "tool", "not-a-map")
        assert False
    except TypeError:
        pass
