from __future__ import annotations

from dataclasses import dataclass

from halo.types import Action, EnforcementDecision, Phase, Verdict
from validation.agentdojo.adapter import HALOEffectBoundary, action_from_tool_call


@dataclass
class FakeEnforcer:
    verdict: Verdict

    def pre(self, action, envelope):
        return EnforcementDecision(
            verdict=self.verdict,
            phase=Phase.PRE,
            action_id=action.action_id,
            reason="test",
        )


def telemetry_factory(action, *, phase, payload):
    return {"action_id": action.action_id, "phase": phase, "payload": payload}


def test_denial_cannot_fall_through_to_effect():
    called = []
    boundary = HALOEffectBoundary(
        enforcer=FakeEnforcer(Verdict.DENY), telemetry_factory=telemetry_factory
    )
    action = Action("a1", "agent", "send_email", "mailbox", {})

    result = boundary.execute(
        action=action,
        payload={},
        effect=lambda: called.append("executed"),
    )

    assert result.executed is False
    assert called == []


def test_allow_executes_effect_exactly_once():
    called = []
    boundary = HALOEffectBoundary(
        enforcer=FakeEnforcer(Verdict.ALLOW), telemetry_factory=telemetry_factory
    )
    action = Action("a2", "agent", "read_calendar", "calendar", {})

    result = boundary.execute(
        action=action,
        payload={},
        effect=lambda: called.append("executed") or 42,
    )

    assert result.executed is True
    assert result.result == 42
    assert called == ["executed"]
    assert result.overhead_ns >= 0


def test_tool_arguments_are_snapshotted_into_action():
    arguments = {"recipient": "user@example.invalid", "count": 1}
    action = action_from_tool_call(
        action_id="a3",
        subject="agent",
        tool_name="send_email",
        resource="mailbox",
        arguments=arguments,
    )
    arguments["count"] = 999

    assert action.attributes["arguments"]["count"] == 1


def test_non_mapping_tool_arguments_fail_closed_at_adapter_boundary():
    try:
        action_from_tool_call(
            action_id="a4",
            subject="agent",
            tool_name="tool",
            resource="resource",
            arguments=[("x", 1)],
        )
    except TypeError as exc:
        assert "mapping" in str(exc)
    else:
        raise AssertionError("non-mapping arguments must be rejected")
