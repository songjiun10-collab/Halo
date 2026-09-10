from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .types import Action, CheckResult, CheckStatus, Phase


InvariantPredicate = Callable[[Action, Phase, Mapping[str, Any]], bool]


@dataclass(frozen=True, slots=True)
class Invariant:
    name: str
    predicate: InvariantPredicate
    phases: frozenset[Phase] = frozenset({Phase.PRE, Phase.LIVE, Phase.POST})
    failure_reason: str = "invariant violated"

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name:
            raise TypeError("invariant name must be a non-empty string")
        if not callable(self.predicate):
            raise TypeError("invariant predicate must be callable")
        if not isinstance(self.phases, frozenset) or not self.phases:
            raise TypeError("invariant phases must be a non-empty frozenset")
        if any(not isinstance(phase, Phase) for phase in self.phases):
            raise TypeError("invariant phases must contain only Phase values")
        if not isinstance(self.failure_reason, str) or not self.failure_reason:
            raise TypeError("invariant failure_reason must be a non-empty string")


class InvariantEngine:
    def __init__(self, invariants: Iterable[Invariant] = ()):
        self._invariants = tuple(invariants)
        if any(not isinstance(inv, Invariant) for inv in self._invariants):
            raise TypeError("invariants must contain only Invariant values")
        names = [inv.name for inv in self._invariants]
        if len(set(names)) != len(names):
            raise ValueError("invariant names must be unique")

    def evaluate(
        self,
        action: Action,
        phase: Phase,
        telemetry: Mapping[str, Any],
    ) -> tuple[CheckResult, ...]:
        results: list[CheckResult] = []
        for invariant in self._invariants:
            if phase not in invariant.phases:
                continue
            try:
                ok = invariant.predicate(action, phase, telemetry)
                if type(ok) is not bool:
                    raise TypeError("invariant predicate must return bool")
                results.append(
                    CheckResult(
                        name=invariant.name,
                        status=CheckStatus.PASS if ok else CheckStatus.FAIL,
                        reason="" if ok else invariant.failure_reason,
                    )
                )
            except Exception as exc:
                results.append(
                    CheckResult(
                        name=invariant.name,
                        status=CheckStatus.ERROR,
                        reason=f"invariant raised {type(exc).__name__}",
                    )
                )
        return tuple(results)
