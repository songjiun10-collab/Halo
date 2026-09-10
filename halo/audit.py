from __future__ import annotations

import hashlib
import hmac
import json
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping

from .canonical import canonical_json
from .types import EnforcementDecision


@dataclass(frozen=True, slots=True)
class AuditRecord:
    sequence: int
    previous_hash: str
    event: Mapping[str, Any]
    record_hash: str
    mac: str


class HashChainAuditLog:
    """Append-only HMAC-authenticated hash-chain audit log.

    Integrity depends on keeping the audit key outside the untrusted component.
    Production deployments should additionally ship or anchor heads to a
    separately trusted sink to detect whole-file rollback/truncation.
    """

    def __init__(self, path: str | Path, *, key: bytes):
        if not key:
            raise ValueError("audit key must not be empty")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._key = key
        self._lock = threading.Lock()
        self._next_sequence = 0
        self._head = ""
        if self.path.exists() and self.path.stat().st_size:
            ok, reason, head, count = self.verify_file(self.path, key=key)
            if not ok:
                raise ValueError(f"existing audit log failed verification: {reason}")
            self._head = head
            self._next_sequence = count

    def append_decision(
        self,
        decision: EnforcementDecision,
        *,
        metadata: Mapping[str, Any] | None = None,
    ) -> AuditRecord:
        return self.append(
            {
                "type": "enforcement_decision",
                "decision": asdict(decision),
                "metadata": dict(metadata or {}),
            }
        )

    def append(self, event: Mapping[str, Any]) -> AuditRecord:
        with self._lock:
            body = {
                "sequence": self._next_sequence,
                "previous_hash": self._head,
                "event": event,
            }
            record_hash = hashlib.sha256(canonical_json(body)).hexdigest()
            mac = hmac.new(self._key, bytes.fromhex(record_hash), hashlib.sha256).hexdigest()
            record = AuditRecord(
                sequence=self._next_sequence,
                previous_hash=self._head,
                event=event,
                record_hash=record_hash,
                mac=mac,
            )
            line = canonical_json(record).decode("utf-8") + "\n"
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line)
                handle.flush()
            self._head = record_hash
            self._next_sequence += 1
            return record

    @staticmethod
    def verify_file(path: str | Path, *, key: bytes) -> tuple[bool, str, str, int]:
        previous = ""
        count = 0
        try:
            with Path(path).open("r", encoding="utf-8") as handle:
                for expected_sequence, raw in enumerate(handle):
                    data = json.loads(raw)
                    if data["sequence"] != expected_sequence:
                        return False, "audit sequence mismatch", previous, count
                    if data["previous_hash"] != previous:
                        return False, "audit chain mismatch", previous, count
                    body = {
                        "sequence": data["sequence"],
                        "previous_hash": data["previous_hash"],
                        "event": data["event"],
                    }
                    expected_hash = hashlib.sha256(canonical_json(body)).hexdigest()
                    if not hmac.compare_digest(expected_hash, data["record_hash"]):
                        return False, "audit record hash mismatch", previous, count
                    expected_mac = hmac.new(key, bytes.fromhex(expected_hash), hashlib.sha256).hexdigest()
                    if not hmac.compare_digest(expected_mac, data["mac"]):
                        return False, "audit authentication failed", previous, count
                    previous = expected_hash
                    count += 1
        except (OSError, KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            return False, f"audit parse/read error: {type(exc).__name__}", previous, count
        return True, "verified", previous, count
