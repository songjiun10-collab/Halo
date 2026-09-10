from __future__ import annotations

import hashlib
import hmac
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .canonical import canonical_digest, canonical_json, freeze_json
from .types import Action, Phase


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _valid_sha256_hex(value: str) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    try:
        return len(bytes.fromhex(value)) == 32
    except ValueError:
        return False


@dataclass(frozen=True, slots=True)
class TelemetryEnvelope:
    source: str
    session_id: str
    sequence: int
    phase: Phase
    action_id: str
    action_digest: str
    issued_at_ms: int
    payload: Mapping[str, Any]
    previous_digest: str
    digest: str
    mac: str

    def __post_init__(self) -> None:
        for name in ("source", "session_id", "action_id"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value:
                raise TypeError(f"{name} must be a non-empty string")
        if not _valid_sha256_hex(self.action_digest):
            raise TypeError("action_digest must be a SHA-256 hex digest")
        if type(self.sequence) is not int or self.sequence < 0:
            raise TypeError("sequence must be a non-negative integer")
        if not isinstance(self.phase, Phase):
            raise TypeError("phase must be a Phase")
        if type(self.issued_at_ms) is not int or self.issued_at_ms < 0:
            raise TypeError("issued_at_ms must be a non-negative integer")
        for name in ("previous_digest", "digest", "mac"):
            if not isinstance(getattr(self, name), str):
                raise TypeError(f"{name} must be a string")
        object.__setattr__(self, "payload", freeze_json(self.payload))

    @classmethod
    def seal(
        cls,
        *,
        key: bytes,
        source: str,
        session_id: str,
        sequence: int,
        phase: Phase,
        action: Action,
        payload: Mapping[str, Any],
        previous_digest: str = "",
        issued_at_ms: int | None = None,
    ) -> "TelemetryEnvelope":
        if not isinstance(key, bytes) or not key:
            raise ValueError("telemetry key must not be empty")
        if not isinstance(action, Action):
            raise TypeError("action must be an Action")
        if issued_at_ms is None:
            issued_at_ms = _now_ms()
        frozen_payload = freeze_json(payload)
        action_hash = canonical_digest(action)
        unsigned = {
            "source": source,
            "session_id": session_id,
            "sequence": sequence,
            "phase": phase.value,
            "action_id": action.action_id,
            "action_digest": action_hash,
            "issued_at_ms": issued_at_ms,
            "payload": frozen_payload,
            "previous_digest": previous_digest,
        }
        digest = hashlib.sha256(canonical_json(unsigned)).hexdigest()
        mac = hmac.new(key, bytes.fromhex(digest), hashlib.sha256).hexdigest()
        return cls(
            source=source,
            session_id=session_id,
            sequence=sequence,
            phase=phase,
            action_id=action.action_id,
            action_digest=action_hash,
            issued_at_ms=issued_at_ms,
            payload=frozen_payload,
            previous_digest=previous_digest,
            digest=digest,
            mac=mac,
        )


class TelemetryVerifier:
    def __init__(
        self,
        keys: Mapping[str, bytes],
        *,
        session_id: str,
        max_age_ms: int = 30_000,
        max_future_skew_ms: int = 5_000,
        clock_ms: Callable[[], int] = _now_ms,
    ):
        if not keys:
            raise ValueError("at least one telemetry source key is required")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session_id must be a non-empty, non-reused string")
        if type(max_age_ms) is not int or max_age_ms <= 0:
            raise ValueError("max_age_ms must be a positive integer")
        if type(max_future_skew_ms) is not int or max_future_skew_ms < 0:
            raise ValueError("max_future_skew_ms must be a non-negative integer")
        if not callable(clock_ms):
            raise TypeError("clock_ms must be callable")
        checked_keys: dict[str, bytes] = {}
        for source, key in keys.items():
            if not isinstance(source, str) or not source:
                raise TypeError("telemetry source names must be non-empty strings")
            if not isinstance(key, bytes) or not key:
                raise TypeError("telemetry keys must be non-empty bytes")
            checked_keys[source] = key
        self._keys = checked_keys
        self._session_id = session_id
        self._max_age_ms = max_age_ms
        self._max_future_skew_ms = max_future_skew_ms
        self._clock_ms = clock_ms
        self._last: dict[str, tuple[int, str]] = {}
        self._replay_lock = threading.Lock()

    def verify(
        self,
        envelope: TelemetryEnvelope,
        *,
        phase: Phase,
        action: Action,
    ) -> tuple[bool, str]:
        try:
            if not isinstance(envelope, TelemetryEnvelope):
                return False, "malformed telemetry envelope"
            if not isinstance(phase, Phase) or not isinstance(action, Action):
                return False, "malformed telemetry verification context"
            key = self._keys.get(envelope.source)
            if key is None:
                return False, "unknown telemetry source"
            if envelope.session_id != self._session_id:
                return False, "telemetry session mismatch"
            if envelope.phase is not phase:
                return False, "telemetry phase mismatch"
            if envelope.action_id != action.action_id:
                return False, "telemetry action id mismatch"
            expected_action_digest = canonical_digest(action)
            if not hmac.compare_digest(envelope.action_digest, expected_action_digest):
                return False, "telemetry action digest mismatch"

            now = self._clock_ms()
            if type(now) is not int:
                return False, "telemetry clock returned invalid time"
            age = now - envelope.issued_at_ms
            if age > self._max_age_ms:
                return False, "telemetry expired"
            if age < -self._max_future_skew_ms:
                return False, "telemetry issued too far in the future"

            unsigned = {
                "source": envelope.source,
                "session_id": envelope.session_id,
                "sequence": envelope.sequence,
                "phase": envelope.phase.value,
                "action_id": envelope.action_id,
                "action_digest": envelope.action_digest,
                "issued_at_ms": envelope.issued_at_ms,
                "payload": envelope.payload,
                "previous_digest": envelope.previous_digest,
            }
            expected_digest = hashlib.sha256(canonical_json(unsigned)).hexdigest()
            if not hmac.compare_digest(expected_digest, envelope.digest):
                return False, "telemetry digest mismatch"
            expected_mac = hmac.new(key, bytes.fromhex(expected_digest), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected_mac, envelope.mac):
                return False, "telemetry authentication failed"

            with self._replay_lock:
                last = self._last.get(envelope.source)
                if last is None:
                    if envelope.sequence != 0:
                        return False, "first telemetry sequence must be zero"
                    if envelope.previous_digest:
                        return False, "first telemetry envelope must not have a previous digest"
                else:
                    last_sequence, last_digest = last
                    if envelope.sequence != last_sequence + 1:
                        return False, "telemetry sequence is not contiguous"
                    if envelope.previous_digest != last_digest:
                        return False, "telemetry chain mismatch"
                self._last[envelope.source] = (envelope.sequence, envelope.digest)
            return True, "verified"
        except Exception as exc:
            return False, f"malformed telemetry: {type(exc).__name__}"
