"""E007 -- dual-agent approve/execute over the real halo.gateway.Gateway HTTP API.

ApproverAgent's judgment is produced entirely by halo.safety_cases.evaluate_trace()
+ halo.policy.decide() -- never free-form model judgment. Neither agent talks to
halo.authority.Authority; halo.gateway.Gateway is the unmodified production
capability boundary being exercised. See README.ko.md for what this does and
does not demonstrate.
"""
from __future__ import annotations

import http.client
import json
from dataclasses import dataclass, field
from typing import Callable, Mapping, Sequence

from halo.policy import Decision, PolicyResult, decide
from halo.safety_cases import Event, Finding, evaluate_trace

from .channel import Channel


class ProtocolError(RuntimeError):
    """A cross-process message is malformed; never partially trust it."""


class RequestDenied(RuntimeError):
    """Raised by ExecutorAgent.run() on REVIEW/DENY/QUARANTINE. Carries the
    PolicyResult's decision and reasons verbatim -- never swallowed to a bool."""

    def __init__(self, decision: Decision, reasons: tuple[str, ...]):
        super().__init__(f"{decision.value}: {'; '.join(reasons) or 'no reasons given'}")
        self.decision = decision
        self.reasons = reasons


_EVENT_CLAIM_FIELDS = frozenset({
    "kind", "provenance", "action", "target_scope", "declared_scope", "effect",
    "contains_secret", "telemetry_complete", "approved", "metadata",
})
_EVENT_CLAIM_OPTIONAL_STR = ("action", "target_scope", "declared_scope", "effect")
_EVENT_CLAIM_BOOL = ("contains_secret", "telemetry_complete", "approved")


@dataclass(frozen=True)
class EventClaim:
    """One self-reported event exactly as the executor is willing to submit it
    over the wire. Plain-JSON-safe. ApproverAgent re-validates every field and
    constructs the real halo.safety_cases.Event itself -- this type never
    silently becomes an Event."""

    kind: str
    provenance: str
    action: str | None = None
    target_scope: str | None = None
    declared_scope: str | None = None
    effect: str | None = None
    contains_secret: bool = False
    telemetry_complete: bool = True
    approved: bool = False
    metadata: Mapping[str, object] = field(default_factory=dict)

    def to_plain(self) -> dict:
        return {
            "kind": self.kind, "provenance": self.provenance, "action": self.action,
            "target_scope": self.target_scope, "declared_scope": self.declared_scope,
            "effect": self.effect, "contains_secret": self.contains_secret,
            "telemetry_complete": self.telemetry_complete, "approved": self.approved,
            "metadata": dict(self.metadata),
        }

    @staticmethod
    def from_plain(value: object) -> "EventClaim":
        if type(value) is not dict or set(value) != _EVENT_CLAIM_FIELDS:
            raise ProtocolError("event claim must have exactly the expected fields")
        for name in ("kind", "provenance"):
            if type(value[name]) is not str:
                raise ProtocolError(f"event claim {name!r} must be a string")
        for name in _EVENT_CLAIM_OPTIONAL_STR:
            if value[name] is not None and type(value[name]) is not str:
                raise ProtocolError(f"event claim {name!r} must be a string or null")
        for name in _EVENT_CLAIM_BOOL:
            if type(value[name]) is not bool:
                raise ProtocolError(f"event claim {name!r} must be a boolean")
        if type(value["metadata"]) is not dict or any(type(k) is not str for k in value["metadata"]):
            raise ProtocolError("event claim metadata must be a plain string-keyed object")
        return EventClaim(**value)

    def to_event(self) -> Event:
        return Event(
            kind=self.kind, provenance=self.provenance, action=self.action,
            target_scope=self.target_scope, declared_scope=self.declared_scope,
            effect=self.effect, contains_secret=self.contains_secret,
            telemetry_complete=self.telemetry_complete, approved=self.approved,
            metadata=dict(self.metadata),
        )


MAX_EVENTS_PER_REQUEST = 64
_APPROVAL_REQUEST_FIELDS = frozenset({"tool", "args", "intent_id", "events"})
_APPROVAL_DECISION_FIELDS = frozenset({"decision", "reasons", "token", "expires_in"})


@dataclass(frozen=True)
class ApprovalRequest:
    """Crosses executor -> approver. No key material ever appears here."""

    tool: str
    args: dict
    intent_id: str
    events: tuple[EventClaim, ...]

    def to_plain(self) -> dict:
        return {
            "tool": self.tool, "args": self.args, "intent_id": self.intent_id,
            "events": [e.to_plain() for e in self.events],
        }

    @staticmethod
    def from_plain(value: object) -> "ApprovalRequest":
        if type(value) is not dict or set(value) != _APPROVAL_REQUEST_FIELDS:
            raise ProtocolError("approval request must have exactly the expected fields")
        if type(value["tool"]) is not str or not value["tool"]:
            raise ProtocolError("approval request tool must be a non-empty string")
        if type(value["args"]) is not dict:
            raise ProtocolError("approval request args must be an object")
        if type(value["intent_id"]) is not str or not value["intent_id"].strip():
            raise ProtocolError("approval request intent_id must be a non-empty string")
        events = value["events"]
        if type(events) is not list or not 0 < len(events) <= MAX_EVENTS_PER_REQUEST:
            raise ProtocolError(
                f"approval request events must be a list of 1..{MAX_EVENTS_PER_REQUEST} entries")
        return ApprovalRequest(
            tool=value["tool"], args=value["args"], intent_id=value["intent_id"],
            events=tuple(EventClaim.from_plain(e) for e in events))


@dataclass(frozen=True)
class ApprovalDecision:
    """Crosses approver -> executor. token is present iff decision is ALLOW."""

    decision: Decision
    reasons: tuple[str, ...]
    token: str | None = None
    expires_in: int | None = None

    def to_plain(self) -> dict:
        return {
            "decision": self.decision.value, "reasons": list(self.reasons),
            "token": self.token, "expires_in": self.expires_in,
        }

    @staticmethod
    def from_plain(value: object) -> "ApprovalDecision":
        if type(value) is not dict or set(value) != _APPROVAL_DECISION_FIELDS:
            raise ProtocolError("approval decision must have exactly the expected fields")
        if type(value["decision"]) is not str:
            raise ProtocolError("approval decision 'decision' must be a string")
        try:
            decision = Decision(value["decision"])
        except ValueError:
            raise ProtocolError("approval decision has an unknown decision value") from None
        reasons = value["reasons"]
        if type(reasons) is not list or any(type(r) is not str for r in reasons):
            raise ProtocolError("approval decision reasons must be a list of strings")
        token = value["token"]
        if token is not None and type(token) is not str:
            raise ProtocolError("approval decision token must be a string or null")
        expires_in = value["expires_in"]
        if expires_in is not None and type(expires_in) is not int:
            raise ProtocolError("approval decision expires_in must be an integer or null")
        if (token is None) == (decision is Decision.ALLOW):
            raise ProtocolError("token must be present if and only if decision is allow")
        return ApprovalDecision(decision=decision, reasons=tuple(reasons),
                                token=token, expires_in=expires_in)


class GatewayClient:
    """Stdlib http.client wrapper matching tools/docker_smoke.py's request() shape.

    Holding an approver-keyed or executor-keyed instance IS the role: nothing
    else about this class distinguishes the two, exactly like halo.gateway's
    own bearer-key role model.
    """

    def __init__(self, host: str, port: int, key: str, *, timeout: float = 5.0):
        if type(host) is not str or not host:
            raise ValueError("host must be a non-empty string")
        if type(port) is not int or not 0 < port < 65536:
            raise ValueError("port must be a valid TCP port")
        if type(key) is not str or not key:
            raise ValueError("key must be a non-empty string")
        self._host = host
        self._port = port
        self._key = key
        self._timeout = timeout

    def post(self, path: str, body: dict) -> tuple[int, dict]:
        connection = http.client.HTTPConnection(self._host, self._port, timeout=self._timeout)
        try:
            connection.request("POST", path, json.dumps(body),
                               {"Content-Type": "application/json",
                                "Authorization": "Bearer " + self._key})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def approve(self, tool: str, args: dict, intent_id: str) -> tuple[int, dict]:
        return self.post("/approve", {"tool": tool, "args": args, "intent_id": intent_id})

    def revoke(self, token: str) -> tuple[int, dict]:
        return self.post("/revoke", {"token": token})

    def execute(self, tool: str, args: dict, token: str) -> tuple[int, dict]:
        return self.post("/execute", {"tool": tool, "args": args, "token": token})


class ApproverAgent:
    """Host-side role. Holds an approver-keyed GatewayClient ONLY.

    classify_provenance is HOST-OWNED and is never derived from the request
    body -- it is the approver operator's own, independently-acquired
    classification of the requesting executor (e.g. a static per-deployment
    allowlist in this reference demo; see README.ko.md, "honest limits", for
    what a production implementation would need instead). Feeding it the
    executor's own self-report would defeat the purpose of this experiment.

    trusted_telemetry is always False: this reference demo has no
    independently-acquired telemetry channel, so any privileged/external-write
    claim is denied by construction regardless of host_provenance. This is a
    deliberate conservative default, not an oversight.
    """

    def __init__(self, gateway: GatewayClient,
                 classify_provenance: Callable[[ApprovalRequest], "str | Sequence[str]"],
                 *, effectful: bool = True):
        self._gateway = gateway
        self._classify_provenance = classify_provenance
        self._effectful = effectful

    def evaluate(self, request: ApprovalRequest) -> tuple[list[Finding], PolicyResult]:
        """Pure function, no I/O: never calls the gateway."""
        events = [claim.to_event() for claim in request.events]
        host_provenance = self._classify_provenance(request)
        findings = evaluate_trace(events, trusted_telemetry=False,
                                  host_provenance=host_provenance)
        result = decide(findings, effectful=self._effectful)
        return findings, result

    def decide_and_approve(self, request: ApprovalRequest) -> ApprovalDecision:
        _findings, result = self.evaluate(request)
        if result.decision is not Decision.ALLOW:
            return ApprovalDecision(decision=result.decision, reasons=result.reasons)
        status, body = self._gateway.approve(request.tool, request.args, request.intent_id)
        if status != 200 or "token" not in body:
            raise ProtocolError(f"gateway refused an approval the policy allowed: {status} {body}")
        return ApprovalDecision(decision=Decision.ALLOW, reasons=(),
                                token=body["token"], expires_in=body.get("expires_in"))

    def serve_once(self, channel: Channel) -> ApprovalDecision:
        """Receive exactly one ApprovalRequest, decide, send back the
        ApprovalDecision. The channel carries plain JSON only -- classify_
        provenance, findings, and the approver key never cross it."""
        request = ApprovalRequest.from_plain(channel.recv())
        decision = self.decide_and_approve(request)
        channel.send(decision.to_plain())
        return decision


class ExecutorAgent:
    """Host-side role. Holds an executor-keyed GatewayClient ONLY. This class
    has no code path that reads or accepts an approver key."""

    def __init__(self, gateway: GatewayClient, channel: Channel):
        self._gateway = gateway
        self._channel = channel

    def run(self, request: ApprovalRequest) -> dict:
        self._channel.send(request.to_plain())
        decision = ApprovalDecision.from_plain(self._channel.recv())
        if decision.decision is not Decision.ALLOW:
            raise RequestDenied(decision.decision, decision.reasons)
        status, result = self._gateway.execute(request.tool, request.args, decision.token)
        if status != 200:
            raise ProtocolError(f"execute failed after approval: {status} {result}")
        return result
