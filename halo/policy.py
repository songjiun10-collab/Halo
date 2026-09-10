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


@dataclass(frozen=True, slots=True)
class PolicyResult:
    verdict: Verdict
    rule: str | None
    reason: str


class PolicyEngine:
    """Ordered rules with deny-overrides and default-deny semantics."""

    def __init__(self, rules: Iterable[PolicyRule] = ()):
        self._rules = tuple(rules)
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
            matched_allow = matched_allow or rule.name

        if matched_allow is not None:
            return PolicyResult(Verdict.ALLOW, matched_allow, "explicit allow rule matched")
        return PolicyResult(Verdict.DENY, None, "no allow rule matched")
