from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping

from .canonical import canonical_json, freeze_json
from .types import EnforcementDecision


@dataclass(frozen=True, slots=True)
class AuditRecord:
    sequence: int
    previous_hash: str
    event: Mapping[str, Any]
    record_hash: str
    mac: str


@dataclass(frozen=True, slots=True)
class _Checkpoint:
    count: int
    head: str
    file_size: int
    mac: str


@contextmanager
def _exclusive_process_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if os.name == "nt":  # pragma: no cover
            import msvcrt

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class HashChainAuditLog:
    """HMAC-authenticated hash-chain with an authenticated committed head.

    The sidecar checkpoint is the commit point. Historical verification is O(N)
    when explicitly requested or when opening an existing log; steady-state
    appends use the authenticated checkpoint and are O(1) in history length.
    """

    def __init__(self, path: str | Path, *, key: bytes):
        if not isinstance(key, bytes) or not key:
            raise ValueError("audit key must not be empty")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._checkpoint_path = self.path.with_name(self.path.name + ".head")
        self._key = key
        self._lock = threading.Lock()
        with self._lock, _exclusive_process_lock(self.path):
            self._initialize_checkpoint()

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
        event_snapshot = freeze_json(event)
        with self._lock, _exclusive_process_lock(self.path):
            checkpoint = self._load_checkpoint()
            self._reconcile_uncommitted_tail(checkpoint)

            body = {
                "sequence": checkpoint.count,
                "previous_hash": checkpoint.head,
                "event": event_snapshot,
            }
            record_hash = hashlib.sha256(canonical_json(body)).hexdigest()
            mac = hmac.new(self._key, bytes.fromhex(record_hash), hashlib.sha256).hexdigest()
            record = AuditRecord(
                sequence=checkpoint.count,
                previous_hash=checkpoint.head,
                event=event_snapshot,
                record_hash=record_hash,
                mac=mac,
            )
            line = canonical_json(record) + b"\n"
            start = checkpoint.file_size

            try:
                with self.path.open("r+b" if self.path.exists() else "w+b") as handle:
                    handle.seek(start)
                    handle.write(line)
                    handle.flush()
                    os.fsync(handle.fileno())
            except Exception:
                self._rollback_log(start)
                raise

            new_checkpoint = self._make_checkpoint(
                count=checkpoint.count + 1,
                head=record_hash,
                file_size=start + len(line),
            )
            try:
                self._write_checkpoint(new_checkpoint)
            except Exception:
                self._rollback_log(start)
                raise
            return record

    def _initialize_checkpoint(self) -> None:
        # If an authenticated checkpoint already exists, it defines the committed
        # prefix. Any bytes beyond it are an uncommitted tail from an interrupted
        # append and must never be promoted merely because they parse correctly.
        if self._checkpoint_path.exists():
            checkpoint = self._load_checkpoint()
            self._reconcile_uncommitted_tail(checkpoint)
            if checkpoint.file_size:
                ok, reason, head, count = self._verify_physical_file(self.path, key=self._key)
                if not ok:
                    raise ValueError(f"existing audit log failed verification: {reason}")
                if count != checkpoint.count or head != checkpoint.head:
                    raise ValueError("audit log does not match committed checkpoint")
            elif self.path.exists() and self.path.stat().st_size:
                raise ValueError("audit log does not match empty checkpoint")
            return

        if self.path.exists() and self.path.stat().st_size:
            # A non-empty log without its authenticated commit checkpoint is
            # ambiguous: it could be a legacy file, or uncommitted bytes left by
            # a failed append. Do not silently promote it.
            raise ValueError("non-empty audit log is missing committed checkpoint")

        self.path.touch(exist_ok=True)
        checkpoint = self._make_checkpoint(count=0, head="", file_size=0)
        self._write_checkpoint(checkpoint)

    def _make_checkpoint(self, *, count: int, head: str, file_size: int) -> _Checkpoint:
        body = {"count": count, "head": head, "file_size": file_size}
        digest = hashlib.sha256(canonical_json(body)).digest()
        mac = hmac.new(self._key, digest, hashlib.sha256).hexdigest()
        return _Checkpoint(count=count, head=head, file_size=file_size, mac=mac)

    def _load_checkpoint(self) -> _Checkpoint:
        try:
            data = json.loads(self._checkpoint_path.read_text(encoding="utf-8"))
            count = data["count"]
            head = data["head"]
            file_size = data["file_size"]
            mac = data["mac"]
            if type(count) is not int or count < 0 or type(file_size) is not int or file_size < 0:
                raise ValueError("invalid checkpoint counters")
            if not isinstance(head, str) or not isinstance(mac, str):
                raise ValueError("invalid checkpoint strings")
            if count == 0 and head:
                raise ValueError("empty checkpoint must have empty head")
            if count > 0:
                if len(head) != 64 or len(bytes.fromhex(head)) != 32:
                    raise ValueError("invalid checkpoint head")
            body = {"count": count, "head": head, "file_size": file_size}
            digest = hashlib.sha256(canonical_json(body)).digest()
            expected = hmac.new(self._key, digest, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, mac):
                raise ValueError("checkpoint authentication failed")
            return _Checkpoint(count=count, head=head, file_size=file_size, mac=mac)
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"audit checkpoint invalid: {type(exc).__name__}") from exc

    def _write_checkpoint(self, checkpoint: _Checkpoint) -> None:
        temp = self._checkpoint_path.with_name(
            f".{self._checkpoint_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with temp.open("wb") as handle:
                handle.write(canonical_json(checkpoint) + b"\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, self._checkpoint_path)
        finally:
            try:
                if temp.exists():
                    temp.unlink()
            except OSError:
                pass

    def _reconcile_uncommitted_tail(self, checkpoint: _Checkpoint) -> None:
        actual = self.path.stat().st_size if self.path.exists() else 0
        if actual < checkpoint.file_size:
            raise ValueError("audit log shorter than committed checkpoint")
        if actual > checkpoint.file_size:
            self._rollback_log(checkpoint.file_size)

    def _rollback_log(self, size: int) -> None:
        if not self.path.exists():
            return
        with self.path.open("r+b") as handle:
            handle.truncate(size)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                # The authenticated checkpoint still defines the committed prefix.
                pass

    @staticmethod
    def _verify_physical_file(path: str | Path, *, key: bytes) -> tuple[bool, str, str, int]:
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

    @staticmethod
    def verify_file(path: str | Path, *, key: bytes) -> tuple[bool, str, str, int]:
        path = Path(path)
        ok, reason, head, count = HashChainAuditLog._verify_physical_file(path, key=key)
        if not ok:
            return ok, reason, head, count

        checkpoint_path = path.with_name(path.name + ".head")
        if not checkpoint_path.exists():
            return False, "audit committed checkpoint missing", head, count
        if checkpoint_path.exists():
            try:
                data = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                body = {"count": data["count"], "head": data["head"], "file_size": data["file_size"]}
                digest = hashlib.sha256(canonical_json(body)).digest()
                expected = hmac.new(key, digest, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(expected, data["mac"]):
                    return False, "audit checkpoint authentication failed", head, count
                if data["count"] != count or data["head"] != head or data["file_size"] != path.stat().st_size:
                    return False, "audit checkpoint does not match physical log", head, count
            except (OSError, KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
                return False, f"audit checkpoint parse/read error: {type(exc).__name__}", head, count
        return True, "verified", head, count
