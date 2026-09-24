"""Durable, role-separated tool gateway. Tools are trusted host adapters.

Never register eval/shell or let a request provide adapter code. OS containment
and atomic resource-state checks are responsibilities of each effectful adapter.
"""
from dataclasses import dataclass
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
import marshal
import os
import secrets
import sqlite3
import stat
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
    fingerprint: str = ""


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
    def __init__(self, path, approver_key: str, executor_key: str, tools: dict[str, Tool],
                 *, realm: str | None = None, clock=time.time,
                 mono_clock=time.monotonic, rollback_tolerance: float = 0.0):
        if (any(type(k) is not str or len(k) < 32 or not k.isascii()
                for k in (approver_key, executor_key)) or approver_key == executor_key):
            raise ValueError("distinct ASCII role secrets of at least 32 characters required")
        if any(type(t) is not Tool or not t.revision for t in tools.values()):
            raise ValueError("versioned trusted tool adapters required")
        self.path = str(path)
        if realm is None:
            realm = hashlib.sha256(_encode([self.path, approver_key, executor_key])).hexdigest()
        elif type(realm) is not str or not realm.strip():
            raise ValueError("realm must be a non-empty string when provided")
        self.realm = realm
        self._clock = clock
        self._mono_clock = mono_clock
        if (type(rollback_tolerance) not in (int, float)
                or not math.isfinite(rollback_tolerance) or rollback_tolerance < 0):
            raise ValueError("rollback_tolerance must be a finite non-negative number")
        self._rollback_tolerance = float(rollback_tolerance)
        self._keys = {"/approve": approver_key, "/revoke": approver_key, "/execute": executor_key}
        self._authority_identity = hashlib.sha256(_encode([approver_key, executor_key])).hexdigest()
        self._tools = dict(tools)
        self._realm_secret = self._load_or_create_realm_secret()
        self._prepare_database()
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS grants (token TEXT PRIMARY KEY, digest TEXT NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, time REAL NOT NULL, operation TEXT NOT NULL, phase TEXT NOT NULL, digest TEXT NOT NULL, intent TEXT NOT NULL)")
            self._migrate(db)

    def _prepare_database(self):
        # The containing directory is trusted host state. Create privately
        # before SQLite opens it; never chmod through an attacker-owned link.
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077):
                raise ValueError("database must be a private regular file owned by service user")
        finally:
            os.close(fd)

    def _realm_sidecar_path(self):
        tag = hashlib.sha256(self.realm.encode()).hexdigest()
        return self.path + ".realm-" + tag + ".id"

    @staticmethod
    def _read_realm_secret(sidecar):
        fd = os.open(sidecar, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="ascii") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size > 65):
                raise ValueError("realm identity must be a private regular file")
            value = stream.read(66).strip()
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("invalid realm identity file")
        return value

    def _load_or_create_realm_secret(self):
        # The realm secret intentionally lives outside the SQLite file. A
        # DB-only snapshot/backup therefore cannot mint or spend grants that
        # were bound to the original realm. A full directory snapshot that
        # copies this sidecar is still a copy of the realm (documented limit).
        sidecar = self._realm_sidecar_path()
        try:
            if os.path.lexists(sidecar):
                return self._read_realm_secret(sidecar)
            if os.path.lexists(self.path):
                raise ValueError(
                    "existing gateway state has no realm identity; refusing to open")
            value = secrets.token_hex(32)
            try:
                fd = os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return self._read_realm_secret(sidecar)
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            return value
        except OSError as exc:
            raise ValueError("realm identity unavailable") from exc

    def _migrate(self, db):
        columns = {row[1] for row in db.execute("PRAGMA table_info(grants)")}
        if "mono_deadline" not in columns:
            db.execute("ALTER TABLE grants ADD COLUMN mono_deadline REAL NOT NULL DEFAULT 0")

    def _check_clock_rollback(self, db):
        now = self._wall()
        row = db.execute("SELECT value FROM meta WHERE key='max_wall'").fetchone()
        if row is not None:
            previous = float(row[0])
            if now + self._rollback_tolerance < previous:
                raise Rejected("durable clock rollback detected")
            if now > previous:
                db.execute("UPDATE meta SET value=? WHERE key='max_wall'", (repr(now),))
        else:
            db.execute("INSERT INTO meta(key,value) VALUES('max_wall',?)", (repr(now),))

    def _wall(self):
        value = self._clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise Rejected("clock unavailable")
        return float(value)

    def _mono_now(self):
        value = self._mono_clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise Rejected("clock unavailable")
        return float(value)

    @staticmethod
    def _code_fingerprint(func):
        code = getattr(func, "__code__", None)
        if code is None:
            raise Rejected("non-function adapters require an explicit fingerprint")
        # marshal includes nested code/constants without repr's process-local
        # memory addresses. This is a code identity, not a dependency manifest:
        # hosts must bump revision/fingerprint for closure/global/config changes.
        defaults = _encode([func.__defaults__, func.__kwdefaults__])
        return hashlib.sha256(marshal.dumps(code) + defaults).hexdigest()

    def _adapter_fingerprint(self, tool):
        if type(tool.fingerprint) is str and tool.fingerprint:
            return tool.fingerprint
        return self._code_fingerprint(tool.validate) + self._code_fingerprint(tool.execute)

    @contextmanager
    def _db(self):
        # Each request gets its own connection; SQLite serializes claims across
        # processes. FULL durability requires a reliable local filesystem.
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                self._check_clock_rollback(db)
                yield db
        finally:
            db.close()

    def _audit(self, db, token_hash, phase, digest="", intent=""):
        db.execute("INSERT INTO audit(time,operation,phase,digest,intent) VALUES(?,?,?,?,?)",
                   (self._wall(), token_hash, phase, digest, intent))

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
                changed = db.execute("UPDATE grants SET state='revoked' WHERE token=? AND state='pending'", (token_hash,)).rowcount == 1
                self._audit(db, token_hash, "revoked" if changed else "revoke_not_applied")
            return {"revoked": changed}
        name, args = body["tool"], body["args"]
        tool = self._tools.get(name) if type(name) is str else None
        if tool is None or type(args) is not dict:
            raise Rejected("tool not allowed")
        digest = hashlib.sha256(_encode([name, tool.revision, self._adapter_fingerprint(tool), args,
                                         self._realm_secret, self._authority_identity])).hexdigest()
        if path == "/execute":
            token_hash = self._token_hash(body["token"])
            # Preflight before invoking an adapter; the atomic claim below
            # independently rechecks after validation to cover races/expiry.
            with self._db() as db:
                row = db.execute("SELECT digest,expires,state,mono_deadline FROM grants WHERE token=?", (token_hash,)).fetchone()
                if (row is None or row[0] != digest or row[1] <= self._wall()
                        or row[2] != "pending" or self._mono_now() >= row[3]):
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
                db.execute("UPDATE grants SET state='expired' WHERE state='pending' AND (expires<=? OR mono_deadline<=?)",
                           (self._wall(), self._mono_now()))
                if db.execute("SELECT COUNT(*) FROM grants WHERE state='pending'").fetchone()[0] >= 1024:
                    raise Rejected("pending grant capacity reached")
                db.execute("INSERT INTO grants(token,digest,expires,state,mono_deadline) VALUES(?,?,?,?,?)",
                           (token_hash, digest, self._wall() + 60, "pending", self._mono_now() + 60))
                self._audit(db, token_hash, "approved", digest, intent)
            return {"token": token, "expires_in": 60}
        token_hash = self._token_hash(body["token"])
        with self._db() as db:
            row = db.execute("SELECT digest,expires,state,mono_deadline FROM grants WHERE token=?", (token_hash,)).fetchone()
            if (row is None or row[0] != digest or row[1] <= self._wall()
                    or row[2] != "pending" or self._mono_now() >= row[3]):
                raise Rejected("capability absent, changed, expired or consumed")
            db.execute("UPDATE grants SET state='claimed' WHERE token=?", (token_hash,))
            self._audit(db, token_hash, "claimed", digest)
        # Durable consume BEFORE dispatch: crash leaves an uncertain claimed
        # operation, never an automatically retryable pending capability.
        try:
            result = tool.execute(args)
            result = json.loads(_encode(result))
        except Exception as exc:
            try:
                with self._db() as db:
                    self._audit(db, token_hash, "failed_or_uncertain", digest)
            except Exception as audit_exc:
                raise ExecutionUncertain(
                    "tool and failure recording failed; capability consumed, reconcile before retry"
                ) from audit_exc
            raise ExecutionUncertain("tool failed; capability consumed, reconcile before retry") from exc
        try:
            with self._db() as db:
                db.execute("UPDATE grants SET state='completed' WHERE token=?", (token_hash,))
                self._audit(db, token_hash, "completed", digest)
        except Exception as exc:
            raise ExecutionUncertain(
                "tool completed but completion audit is uncertain; reconcile before retry"
            ) from exc
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
            length = environ.get("CONTENT_LENGTH")
            if type(length) is not str or not length.isascii() or not length.isdecimal() or len(length) > 5:
                raise Rejected("invalid body length")
            size = int(length)
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
