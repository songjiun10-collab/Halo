from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .types import Action, Phase, Verdict


PolicyPredicate = Callable[[Action, Phase, Mapping[str, Any]], bool]


@dataclass(frozen=True, slots=True)
class PolicyRule:
    name: str
    effect: Verdict
    predicate: PolicyPredicate
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST})

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name:
            raise TypeError("policy rule name must be a non-empty string")
        if not isinstance(self.effect, Verdict):
            raise TypeError("policy rule effect must be a Verdict")
        if not callable(self.predicate):
            raise TypeError("policy rule predicate must be callable")
        if not isinstance(self.phases, frozenset) or not self.phases:
            raise TypeError("policy rule phases must be a non-empty frozenset")
        if any(not isinstance(phase, Phase) for phase in self.phases):
            raise TypeError("policy rule phases must contain only Phase values")


@dataclass(frozen=True, slots=True)
class PolicyResult:
    verdict: Verdict
    rule: str | None
    reason: str


class PolicyEngine:
    """Ordered rules with deny-overrides and default-deny semantics."""

    def __init__(self, rules: Iterable[PolicyRule] = ()):
        self._rules = tuple(rules)
        if any(not isinstance(rule, PolicyRule) for rule in self._rules):
            raise TypeError("rules must contain only PolicyRule values")
        names = [rule.name for rule in self._rules]
        if len(set(names)) != len(names):
            raise ValueError("policy rule names must be unique")

    def decide(self, action: Action, phase: Phase, telemetry: Mapping[str, Any]) -> PolicyResult:
        matched_allow: str | None = None
        for rule in self._rules:
            if phase not in rule.phases:
                continue
            try:
                matched = rule.predicate(action, phase, telemetry)
                if type(matched) is not bool:
                    raise TypeError("policy predicate must return bool")
            except Exception as exc:
                return PolicyResult(Verdict.DENY, rule.name, f"policy evaluation error: {type(exc).__name__}")
            if not matched:
                continue
            if rule.effect is Verdict.DENY:
                return PolicyResult(Verdict.DENY, rule.name, "explicit deny rule matched")
            if rule.effect is Verdict.ALLOW:
                matched_allow = matched_allow or rule.name
            else:
                return PolicyResult(Verdict.DENY, rule.name, "invalid policy effect")

        if matched_allow is not None:
            return PolicyResult(Verdict.ALLOW, matched_allow, "explicit allow rule matched")
        return PolicyResult(Verdict.DENY, None, "no allow rule matched")
