from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Any, Mapping

from .canonical import canonical_json
from .types import Phase


@dataclass(frozen=True, slots=True)
class TelemetryEnvelope:
    source: str
    sequence: int
    phase: Phase
    action_id: str
    payload: Mapping[str, Any]
    previous_digest: str
    digest: str
    mac: str

    @classmethod
    def seal(
        cls,
        *,
        key: bytes,
        source: str,
        sequence: int,
        phase: Phase,
        action_id: str,
        payload: Mapping[str, Any],
        previous_digest: str = "",
    ) -> "TelemetryEnvelope":
        if not key:
            raise ValueError("telemetry key must not be empty")
        if sequence < 0:
            raise ValueError("sequence must be non-negative")
        unsigned = {
            "source": source,
            "sequence": sequence,
            "phase": phase.value,
            "action_id": action_id,
            "payload": payload,
            "previous_digest": previous_digest,
        }
        digest = hashlib.sha256(canonical_json(unsigned)).hexdigest()
        mac = hmac.new(key, bytes.fromhex(digest), hashlib.sha256).hexdigest()
        return cls(
            source=source,
            sequence=sequence,
            phase=phase,
            action_id=action_id,
            payload=payload,
            previous_digest=previous_digest,
            digest=digest,
            mac=mac,
        )


class TelemetryVerifier:
    """Verify authenticity, action binding, ordering, replay and chain continuity."""

    def __init__(self, keys: Mapping[str, bytes]):
        if not keys:
            raise ValueError("at least one telemetry source key is required")
        self._keys = dict(keys)
        self._last: dict[str, tuple[int, str]] = {}

    def verify(self, envelope: TelemetryEnvelope, *, phase: Phase, action_id: str) -> tuple[bool, str]:
        key = self._keys.get(envelope.source)
        if key is None:
            return False, "unknown telemetry source"
        if envelope.phase is not phase:
            return False, "telemetry phase mismatch"
        if envelope.action_id != action_id:
            return False, "telemetry action binding mismatch"

        unsigned = {
            "source": envelope.source,
            "sequence": envelope.sequence,
            "phase": envelope.phase.value,
            "action_id": envelope.action_id,
            "payload": envelope.payload,
            "previous_digest": envelope.previous_digest,
        }
        expected_digest = hashlib.sha256(canonical_json(unsigned)).hexdigest()
        if not hmac.compare_digest(expected_digest, envelope.digest):
            return False, "telemetry digest mismatch"
        expected_mac = hmac.new(key, bytes.fromhex(expected_digest), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_mac, envelope.mac):
            return False, "telemetry authentication failed"

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
