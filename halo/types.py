from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class Phase(str, Enum):
    PRE = "pre"
    LIVE = "live"
    POST = "post"


class Verdict(str, Enum):
    ALLOW = "allow"
    DENY = "deny"


class CheckStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class Action:
    action_id: str
    subject: str
    operation: str
    resource: str
    attributes: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    status: CheckStatus
    reason: str = ""


@dataclass(frozen=True, slots=True)
class EnforcementDecision:
    verdict: Verdict
    phase: Phase
    action_id: str
    reason: str
    checks: tuple[CheckResult, ...] = ()
    policy_rule: str | None = None

    @property
    def allowed(self) -> bool:
        return self.verdict is Verdict.ALLOW
