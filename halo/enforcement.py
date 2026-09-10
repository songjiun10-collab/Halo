from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .audit import HashChainAuditLog
from .canonical import canonical_json
from .invariants import InvariantEngine
from .policy import PolicyEngine
from .telemetry import TelemetryEnvelope, TelemetryVerifier
from .types import Action, CheckResult, CheckStatus, EnforcementDecision, Phase, Verdict


@dataclass(slots=True)
class _LifecycleState:
    action_digest: str
    pre_allowed: bool = False
    live_checks: int = 0
    closed: bool = False


class HALOEnforcer:
    """Reference-monitor style enforcement core.

    Every phase is mediated. Any telemetry, invariant, policy, lifecycle, or audit
    uncertainty becomes DENY. Deploy this component on the trusted side of the
    boundary and do not expose an alternate path to protected tools/resources.
    """

    def __init__(
        self,
        *,
        telemetry: TelemetryVerifier,
        invariants: InvariantEngine,
        policy: PolicyEngine,
        audit: HashChainAuditLog,
    ):
        self._telemetry = telemetry
        self._invariants = invariants
        self._policy = policy
        self._audit = audit
        self._state: dict[str, _LifecycleState] = {}

    def pre(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        if action.action_id in self._state:
            return self._commit(self._deny(action, Phase.PRE, "action_id already exists"))

        state = _LifecycleState(action_digest=self._action_digest(action))
        self._state[action.action_id] = state
        decision = self._evaluate(action, Phase.PRE, telemetry)
        state.pre_allowed = decision.allowed
        return decision

    def live(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        state = self._state.get(action.action_id)
        if state is None or not state.pre_allowed:
            return self._commit(self._deny(action, Phase.LIVE, "LIVE requires successful PRE"))
        if state.action_digest != self._action_digest(action):
            return self._commit(self._deny(action, Phase.LIVE, "action changed after PRE"))
        if state.closed:
            return self._commit(self._deny(action, Phase.LIVE, "action already closed"))

        decision = self._evaluate(action, Phase.LIVE, telemetry)
        if decision.allowed:
            state.live_checks += 1
        return decision

    def post(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        state = self._state.get(action.action_id)
        if state is None or not state.pre_allowed:
            return self._commit(self._deny(action, Phase.POST, "POST requires successful PRE"))
        if state.action_digest != self._action_digest(action):
            return self._commit(self._deny(action, Phase.POST, "action changed after PRE"))
        if state.closed:
            return self._commit(self._deny(action, Phase.POST, "action already closed"))

        decision = self._evaluate(action, Phase.POST, telemetry)
        state.closed = True
        return decision

    def _evaluate(
        self,
        action: Action,
        phase: Phase,
        telemetry: TelemetryEnvelope,
    ) -> EnforcementDecision:
        try:
            ok, telemetry_reason = self._telemetry.verify(
                telemetry,
                phase=phase,
                action_id=action.action_id,
            )
        except Exception as exc:
            ok = False
            telemetry_reason = f"telemetry verification error: {type(exc).__name__}"

        telemetry_check = CheckResult(
            name="telemetry_integrity",
            status=CheckStatus.PASS if ok else CheckStatus.FAIL,
            reason="" if ok else telemetry_reason,
        )
        if not ok:
            return self._commit(self._deny(action, phase, telemetry_reason, (telemetry_check,)))

        # TelemetryEnvelope freezes payloads on construction, so policy and
        # invariants evaluate exactly the authenticated snapshot.
        payload = telemetry.payload
        invariant_checks = self._invariants.evaluate(action, phase, payload)
        checks = (telemetry_check, *invariant_checks)
        bad = next(
            (check for check in invariant_checks if check.status is not CheckStatus.PASS),
            None,
        )
        if bad is not None:
            return self._commit(self._deny(action, phase, bad.reason or bad.name, checks))

        policy = self._policy.decide(action, phase, payload)
        decision = EnforcementDecision(
            verdict=policy.verdict,
            phase=phase,
            action_id=action.action_id,
            reason=policy.reason,
            checks=checks,
            policy_rule=policy.rule,
        )
        return self._commit(decision)

    @staticmethod
    def _action_digest(action: Action) -> str:
        return hashlib.sha256(canonical_json(action)).hexdigest()

    @staticmethod
    def _deny(
        action: Action,
        phase: Phase,
        reason: str,
        checks: tuple[CheckResult, ...] = (),
    ) -> EnforcementDecision:
        return EnforcementDecision(
            verdict=Verdict.DENY,
            phase=phase,
            action_id=action.action_id,
            reason=reason,
            checks=checks,
        )

    def _commit(self, decision: EnforcementDecision) -> EnforcementDecision:
        try:
            self._audit.append_decision(decision)
            return decision
        except Exception as exc:
            if decision.verdict is Verdict.DENY:
                return decision
            return EnforcementDecision(
                verdict=Verdict.DENY,
                phase=decision.phase,
                action_id=decision.action_id,
                reason=f"audit unavailable: {type(exc).__name__}",
                checks=decision.checks,
                policy_rule=decision.policy_rule,
            )
