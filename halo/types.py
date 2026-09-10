from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping

from .canonical import freeze_json


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

    def __post_init__(self) -> None:
        for name in ("action_id", "subject", "operation", "resource"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value:
                raise TypeError(f"{name} must be a non-empty string")
        object.__setattr__(self, "attributes", freeze_json(self.attributes))


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
