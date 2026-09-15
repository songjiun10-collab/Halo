"""Host-owned authority boundary; never expose approve/revoke to model tools.

This reference backend confines effects to pre-existing in-memory objects. It
does not sandbox arbitrary Python or provide authentication for a remote API.
"""
from dataclasses import dataclass
import math
import secrets
import threading
import time
from typing import Callable


class Denied(RuntimeError):
    pass


class AuditAfterCommitError(RuntimeError):
    """Effect committed but result audit failed: do not retry the effect."""


@dataclass(frozen=True)
class Request:
    action: str
    target: str
    payload: bytes


@dataclass(frozen=True)
class AuditRecord:
    phase: str
    intent_id: str
    operation_id: str
    action: str
    target: str


@dataclass(frozen=True)
class _Grant:
    request: Request
    intent_id: str
    version: int
    deadline: float
    operation_id: str


class MemorySandbox:
    """Fixed object set, bounded writes, no filesystem/network/process API.

    replace() is a trusted administrative operation. All accesses share a lock,
    so the version check and write cannot be separated by another mutation.
    """
    def __init__(self, objects: dict[str, bytes], *, max_bytes: int = 65536):
        if type(max_bytes) is not int or max_bytes < 1:
            raise ValueError("invalid byte limit")
        if type(objects) is not dict or any(type(k) is not str or type(v) is not bytes or len(v) > max_bytes for k, v in objects.items()):
            raise ValueError("invalid initial objects")
        self._objects = dict(objects)
        self._versions = dict.fromkeys(objects, 0)
        self._max_bytes = max_bytes
        self._lock = threading.RLock()

    def validate(self, request: Request) -> int:
        with self._lock:
            if (type(request) is not Request or type(request.action) is not str
                    or type(request.target) is not str or type(request.payload) is not bytes
                    or request.action != "write" or request.target not in self._objects
                    or len(request.payload) > self._max_bytes):
                raise Denied("request outside sandbox capability")
            return self._versions[request.target]

    def read(self, target: str) -> bytes:
        with self._lock:
            return self._objects[target]

    def replace(self, target: str, payload: bytes) -> None:
        with self._lock:
            self.validate(Request("write", target, payload))
            self._objects[target] = payload
            self._versions[target] += 1

    def commit(self, request: Request, version: int) -> None:
        with self._lock:
            if self.validate(request) != version:
                raise Denied("approved object state changed")
            self.replace(request.target, request.payload)


class Authority:
    """Trusted host component, not an object given to untrusted code.

    The host authenticates explicit intent before calling approve(). Policy,
    audit and clock are trusted dependencies. Data strings cannot mint grants.
    execute() is the sole model-facing operation; never deserialize a Grant.
    """
    def __init__(self, sandbox: MemorySandbox, policy: Callable[[Request], bool],
                 audit: Callable[[AuditRecord], None], *, clock=time.monotonic,
                 max_pending: int = 1024):
        if type(max_pending) is not int or max_pending < 1:
            raise ValueError("invalid capability limit")
        self._max_pending = max_pending
        self._halted = False
        self._sandbox = sandbox
        self._policy = policy
        self._audit = audit
        self._clock = clock
        self._grants: dict[str, _Grant] = {}
        self._lock = threading.RLock()

    def _check_policy(self, request: Request) -> None:
        try:
            allowed = self._policy(request)
        except Exception as exc:
            raise Denied("policy unavailable") from exc
        if allowed is not True:
            raise Denied("policy did not explicitly allow")

    def _now(self) -> float:
        try:
            value = self._clock()
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError("invalid clock")
            return value
        except Exception as exc:
            raise Denied("clock unavailable") from exc

    def approve(self, request: Request, *, intent_id: str, ttl: float) -> str:
        with self._lock:
            if self._halted:
                raise Denied("authority halted after audit loss")
            now = self._now()
            self._grants = {k: v for k, v in self._grants.items() if v.deadline > now}
            if len(self._grants) >= self._max_pending:
                raise Denied("capability capacity reached")
            if type(intent_id) is not str or not intent_id.strip():
                raise Denied("explicit host intent required")
            if type(ttl) not in (int, float) or not math.isfinite(ttl) or not 0 < ttl <= 300:
                raise Denied("invalid capability lifetime")
            version = self._sandbox.validate(request)
            self._check_policy(request)
            token = secrets.token_urlsafe(32)
            grant = _Grant(request, intent_id, version, self._now() + ttl, secrets.token_hex(16))
            self._record("approved", grant)
            self._grants[token] = grant
            return token

    def revoke(self, token: str) -> None:
        with self._lock:
            self._grants.pop(token, None)

    def _record(self, phase: str, grant: _Grant) -> None:
        try:
            self._audit(AuditRecord(phase, grant.intent_id, grant.operation_id,
                                    grant.request.action, grant.request.target))
        except Exception as exc:
            raise Denied("audit unavailable") from exc

    def execute(self, token: str, request: Request) -> None:
        with self._lock:
            if self._halted:
                raise Denied("authority halted after audit loss")
            self._sandbox.validate(request)
            grant = self._grants.get(token) if type(token) is str else None
            if grant is None or grant.request != request:
                raise Denied("no matching host-issued capability")
            if self._now() >= grant.deadline:
                self._grants.pop(token, None)
                raise Denied("capability expired")
            self._check_policy(request)
            self._record("intent", grant)
            # Recheck after potentially slow policy/audit callbacks. Consume
            # before commit so errors or concurrent retries cannot repeat effects.
            if self._now() >= grant.deadline or self._grants.get(token) is not grant:
                raise Denied("capability expired or revoked during validation")
            del self._grants[token]
            self._sandbox.commit(request, grant.version)
            try:
                self._record("committed", grant)
            except Denied as exc:
                self._halted = True
                raise AuditAfterCommitError("effect committed; audit result unavailable") from exc
