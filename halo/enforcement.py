from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

from .audit import HashChainAuditLog
from .canonical import canonical_digest
from .invariants import InvariantEngine
from .policy import PolicyEngine
from .telemetry import TelemetryEnvelope, TelemetryVerifier
from .types import Action, CheckResult, CheckStatus, EnforcementDecision, Phase, Verdict


def _monotonic_ms() -> int:
    return time.monotonic_ns() // 1_000_000


@dataclass(slots=True)
class _LifecycleState:
    action_digest: str
    pre_allowed: bool = False
    live_checks: int = 0
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class HALOEnforcer:
    """Reference-monitor style enforcement core with bounded lifecycle state."""

    def __init__(
        self,
        *,
        telemetry: TelemetryVerifier,
        invariants: InvariantEngine,
        policy: PolicyEngine,
        audit: HashChainAuditLog,
        max_active_actions: int = 10_000,
        recent_action_capacity: int = 50_000,
        recent_action_ttl_ms: int = 300_000,
        clock_ms: Callable[[], int] = _monotonic_ms,
    ):
        if type(max_active_actions) is not int or max_active_actions <= 0:
            raise ValueError("max_active_actions must be a positive integer")
        if type(recent_action_capacity) is not int or recent_action_capacity <= 0:
            raise ValueError("recent_action_capacity must be a positive integer")
        if type(recent_action_ttl_ms) is not int or recent_action_ttl_ms <= 0:
            raise ValueError("recent_action_ttl_ms must be a positive integer")
        if not callable(clock_ms):
            raise TypeError("clock_ms must be callable")
        self._telemetry = telemetry
        self._invariants = invariants
        self._policy = policy
        self._audit = audit
        self._max_active_actions = max_active_actions
        self._recent_action_capacity = recent_action_capacity
        self._recent_action_ttl_ms = recent_action_ttl_ms
        self._clock_ms = clock_ms
        self._state: dict[str, _LifecycleState] = {}
        self._recent: OrderedDict[str, int] = OrderedDict()
        self._state_lock = threading.RLock()

    def pre(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        action_digest = self._action_digest(action)
        state = _LifecycleState(action_digest=action_digest)
        rejection: str | None = None
        reserved = False

        with self._state_lock:
            now = self._checked_clock()
            self._prune_recent_locked(now)
            if action.action_id in self._state or action.action_id in self._recent:
                rejection = "action_id already exists"
            elif len(self._state) >= self._max_active_actions:
                rejection = "active action capacity reached"
            else:
                # Acquire the per-action lock before publishing the state so a
                # concurrent LIVE/POST cannot observe a half-completed PRE.
                state.lock.acquire()
                self._state[action.action_id] = state
                reserved = True

        if rejection is not None:
            return self._commit(self._deny(action, Phase.PRE, rejection))

        try:
            decision = self._evaluate(action, Phase.PRE, telemetry)
            state.pre_allowed = decision.allowed
            if not decision.allowed:
                with self._state_lock:
                    if self._state.get(action.action_id) is state:
                        self._state.pop(action.action_id, None)
                    self._remember_recent_locked(action.action_id, self._checked_clock())
            return decision
        finally:
            if reserved:
                state.lock.release()

    def live(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        state = self._lookup_active(action.action_id)
        if state is None:
            return self._commit(self._deny(action, Phase.LIVE, "LIVE requires successful PRE"))
        with state.lock:
            with self._state_lock:
                active = self._state.get(action.action_id) is state and state.pre_allowed
            if not active:
                return self._commit(self._deny(action, Phase.LIVE, "LIVE requires successful PRE"))
            if state.action_digest != self._action_digest(action):
                return self._commit(self._deny(action, Phase.LIVE, "action changed after PRE"))
            decision = self._evaluate(action, Phase.LIVE, telemetry)
            if decision.allowed:
                state.live_checks += 1
            return decision

    def post(self, action: Action, telemetry: TelemetryEnvelope) -> EnforcementDecision:
        state = self._lookup_active(action.action_id)
        if state is None:
            reason = "action already closed" if self._is_recent(action.action_id) else "POST requires successful PRE"
            return self._commit(self._deny(action, Phase.POST, reason))
        with state.lock:
            with self._state_lock:
                active = self._state.get(action.action_id) is state and state.pre_allowed
                recent = action.action_id in self._recent
            if not active:
                reason = "action already closed" if recent else "POST requires successful PRE"
                return self._commit(self._deny(action, Phase.POST, reason))
            if state.action_digest != self._action_digest(action):
                decision = self._commit(self._deny(action, Phase.POST, "action changed after PRE"))
            else:
                decision = self._evaluate(action, Phase.POST, telemetry)
            with self._state_lock:
                if self._state.get(action.action_id) is state:
                    self._state.pop(action.action_id, None)
                self._remember_recent_locked(action.action_id, self._checked_clock())
            return decision

    def _lookup_active(self, action_id: str) -> _LifecycleState | None:
        with self._state_lock:
            self._prune_recent_locked(self._checked_clock())
            return self._state.get(action_id)

    def _is_recent(self, action_id: str) -> bool:
        with self._state_lock:
            self._prune_recent_locked(self._checked_clock())
            return action_id in self._recent

    def _remember_recent_locked(self, action_id: str, now: int) -> None:
        self._recent[action_id] = now
        self._recent.move_to_end(action_id)
        self._prune_recent_locked(now)
        while len(self._recent) > self._recent_action_capacity:
            self._recent.popitem(last=False)

    def _prune_recent_locked(self, now: int) -> None:
        cutoff = now - self._recent_action_ttl_ms
        while self._recent:
            _, seen = next(iter(self._recent.items()))
            if seen > cutoff:
                break
            self._recent.popitem(last=False)

    def _checked_clock(self) -> int:
        now = self._clock_ms()
        if type(now) is not int or now < 0:
            raise RuntimeError("enforcer clock returned invalid time")
        return now

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
                action=action,
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
        return self._commit(
            EnforcementDecision(
                verdict=policy.verdict,
                phase=phase,
                action_id=action.action_id,
                reason=policy.reason,
                checks=checks,
                policy_rule=policy.rule,
            )
        )

    @staticmethod
    def _action_digest(action: Action) -> str:
        return canonical_digest(action)

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
