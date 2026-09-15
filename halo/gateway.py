"""Durable, role-separated tool gateway. Tools are trusted host adapters.

Never register eval/shell or let a request provide adapter code. OS containment
and atomic resource-state checks are responsibilities of each effectful adapter.
"""
from dataclasses import dataclass
from contextlib import contextmanager
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from typing import Callable


class Rejected(RuntimeError):
    pass


class ExecutionUncertain(Rejected):
    """Dispatch occurred; reconcile effects before issuing any replacement grant."""


@dataclass(frozen=True)
class Tool:
    revision: str
    validate: Callable[[dict], bool]
    execute: Callable[[dict], dict]


def _encode(value):
    try:
        data = json.dumps(value, sort_keys=True, separators=(",", ":"),
                          allow_nan=False, ensure_ascii=True).encode()
    except (TypeError, ValueError, RecursionError) as exc:
        raise Rejected("invalid JSON value") from exc
    if len(data) > 65536:
        raise Rejected("request too large")
    return data


class Gateway:
    def __init__(self, path, approver_key: str, executor_key: str, tools: dict[str, Tool]):
        if (any(type(k) is not str or len(k) < 32 or not k.isascii()
                for k in (approver_key, executor_key)) or approver_key == executor_key):
            raise ValueError("distinct ASCII role secrets of at least 32 characters required")
        if any(type(t) is not Tool or not t.revision for t in tools.values()):
            raise ValueError("versioned trusted tool adapters required")
        self.path = str(path)
        self._keys = {"/approve": approver_key, "/revoke": approver_key, "/execute": executor_key}
        self._tools = dict(tools)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS grants (token TEXT PRIMARY KEY, digest TEXT NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, time REAL NOT NULL, operation TEXT NOT NULL, phase TEXT NOT NULL, digest TEXT NOT NULL, intent TEXT NOT NULL)")

    @contextmanager
    def _db(self):
        # Each request gets its own connection; SQLite serializes claims across
        # processes. FULL durability requires a reliable local filesystem.
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _audit(self, db, token_hash, phase, digest="", intent=""):
        db.execute("INSERT INTO audit(time,operation,phase,digest,intent) VALUES(?,?,?,?,?)",
                   (time.time(), token_hash, phase, digest, intent))

    def _authenticate(self, path, key):
        expected = self._keys.get(path) if type(path) is str else None
        if (expected is None or type(key) is not str or not key.isascii()
                or not hmac.compare_digest(key, expected)):
            raise Rejected("unauthorized")

    def handle(self, path, key, body):
        self._authenticate(path, key)
        if type(body) is not dict:
            raise Rejected("object required")
        # Take an immutable-by-ownership JSON snapshot before validation.
        body = json.loads(_encode(body))
        required = {"/approve": {"tool", "args", "intent_id"},
                    "/execute": {"tool", "args", "token"}, "/revoke": {"token"}}[path]
        if set(body) != required:
            raise Rejected("unexpected or missing fields")
        if path == "/revoke":
            token_hash = self._token_hash(body["token"])
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                changed = db.execute("UPDATE grants SET state='revoked' WHERE token=? AND state='pending'", (token_hash,)).rowcount == 1
                self._audit(db, token_hash, "revoked" if changed else "revoke_not_applied")
            return {"revoked": changed}
        name, args = body["tool"], body["args"]
        tool = self._tools.get(name) if type(name) is str else None
        if tool is None or type(args) is not dict:
            raise Rejected("tool not allowed")
        digest = hashlib.sha256(_encode([name, tool.revision, args])).hexdigest()
        if path == "/execute":
            token_hash = self._token_hash(body["token"])
            # Preflight before invoking an adapter; the atomic claim below
            # independently rechecks after validation to cover races/expiry.
            with self._db() as db:
                row = db.execute("SELECT digest,expires,state FROM grants WHERE token=?", (token_hash,)).fetchone()
                if row is None or row[0] != digest or row[1] <= time.time() or row[2] != "pending":
                    raise Rejected("capability absent, changed, expired or consumed")
        try:
            valid = tool.validate(json.loads(_encode(args)))
        except Exception as exc:
            raise Rejected("validator unavailable") from exc
        if valid is not True:
            raise Rejected("arguments not allowed")
        if path == "/approve":
            intent = body["intent_id"]
            if type(intent) is not str or not intent.strip() or len(intent) > 256:
                raise Rejected("explicit intent required")
            token = secrets.token_urlsafe(32)
            token_hash = self._token_hash(token)
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE grants SET state='expired' WHERE state='pending' AND expires<=?", (time.time(),))
                if db.execute("SELECT COUNT(*) FROM grants WHERE state='pending'").fetchone()[0] >= 1024:
                    raise Rejected("pending grant capacity reached")
                db.execute("INSERT INTO grants VALUES(?,?,?,'pending')", (token_hash, digest, time.time() + 60))
                self._audit(db, token_hash, "approved", digest, intent)
            return {"token": token, "expires_in": 60}
        token_hash = self._token_hash(body["token"])
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,expires,state FROM grants WHERE token=?", (token_hash,)).fetchone()
            if row is None or row[0] != digest or row[1] <= time.time() or row[2] != "pending":
                raise Rejected("capability absent, changed, expired or consumed")
            db.execute("UPDATE grants SET state='claimed' WHERE token=?", (token_hash,))
            self._audit(db, token_hash, "claimed", digest)
        # Durable consume BEFORE dispatch: crash leaves an uncertain claimed
        # operation, never an automatically retryable pending capability.
        try:
            result = tool.execute(args)
            result = json.loads(_encode(result))
        except Exception as exc:
            with self._db() as db:
                self._audit(db, token_hash, "failed_or_uncertain", digest)
            raise ExecutionUncertain("tool failed; capability consumed, reconcile before retry") from exc
        with self._db() as db:
            db.execute("UPDATE grants SET state='completed' WHERE token=?", (token_hash,))
            self._audit(db, token_hash, "completed", digest)
        return result

    @staticmethod
    def _token_hash(token):
        if type(token) is not str or not 1 <= len(token) <= 128 or not token.isascii():
            raise Rejected("invalid capability")
        return hashlib.sha256(token.encode()).hexdigest()

    def __call__(self, environ, start_response):
        try:
            if environ.get("REQUEST_METHOD") != "POST":
                raise Rejected("POST required")
            size = int(environ.get("CONTENT_LENGTH", "0"))
            if not 0 < size <= 65536:
                raise Rejected("invalid body length")
            if environ.get("CONTENT_TYPE", "").split(";")[0] != "application/json":
                raise Rejected("JSON required")
            auth = environ.get("HTTP_AUTHORIZATION", "")
            if not auth.startswith("Bearer "):
                raise Rejected("authentication required")
            self._authenticate(environ.get("PATH_INFO"), auth[7:])
            def unique(pairs):
                out = {}
                for k, v in pairs:
                    if k in out:
                        raise Rejected("duplicate JSON field")
                    out[k] = v
                return out
            raw = environ["wsgi.input"].read(size)
            if len(raw) != size:
                raise Rejected("truncated body")
            body = json.loads(raw, object_pairs_hook=unique)
            result = self.handle(environ.get("PATH_INFO"), auth[7:], body)
            status = "200 OK"
        except ExecutionUncertain:
            status, result = "503 Service Unavailable", {"error": "execution uncertain; reconcile before retry"}
        except (Rejected, ValueError, UnicodeError, RecursionError):
            status, result = "403 Forbidden", {"error": "request rejected"}
        except Exception:
            # No stack trace, args, credential or SQLite details in responses.
            status, result = "503 Service Unavailable", {"error": "unavailable; reconcile execution before retry"}
        output = _encode(result)
        start_response(status, [("Content-Type", "application/json"),
                                ("Cache-Control", "no-store"),
                                ("Content-Length", str(len(output)))])
        return [output]
