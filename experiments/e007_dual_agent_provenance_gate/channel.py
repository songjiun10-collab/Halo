"""Carries only plain JSON (ApprovalRequest / ApprovalDecision payloads, as
produced by their to_plain()/from_plain() methods in experiment.py). Never
carries an approver or executor key -- each process loads its own role key
directly from its own HALO_*_KEY_FILE and never puts it on this channel.
"""
from __future__ import annotations

import queue
from typing import Protocol


class Channel(Protocol):
    def send(self, message: dict) -> None: ...
    def recv(self) -> dict: ...


class LoopbackChannel:
    """In-process pair: send() on one end enqueues for recv() on the other.

    Function-call-equivalent; used by unit tests and by any test where both
    agents run in the same process. Not a substitute for real process
    separation -- see UnixSocketChannel for the two-OS-process case.
    """

    def __init__(self, inbox: "queue.Queue[dict]", outbox: "queue.Queue[dict]"):
        self._inbox = inbox
        self._outbox = outbox

    @staticmethod
    def make_pair() -> tuple["LoopbackChannel", "LoopbackChannel"]:
        a_to_b: "queue.Queue[dict]" = queue.Queue()
        b_to_a: "queue.Queue[dict]" = queue.Queue()
        return LoopbackChannel(inbox=b_to_a, outbox=a_to_b), LoopbackChannel(inbox=a_to_b, outbox=b_to_a)

    def send(self, message: dict) -> None:
        if type(message) is not dict:
            raise TypeError("channel messages must be plain dicts")
        self._outbox.put(message)

    def recv(self) -> dict:
        return self._inbox.get(timeout=5)


# UnixSocketChannel (real two-OS-process transport: length-prefixed JSON
# framing over AF_UNIX, socket path under a private 0700 directory, symlinks
# rejected) is implemented separately -- see approver_process.py/
# executor_process.py/run_two_process_demo.py for the process pair that uses
# it, and tests/test_e007_dual_agent_provenance_gate.py for its adversarial
# coverage (oversized frame, truncated frame).


import json
import math
import os
from pathlib import Path
import socket
import stat
import struct
import time


class UnixSocketChannel:
    """One request/decision exchange; no key material belongs on this channel.

    The directory must belong to this uid and have exactly mode 0700.
    O_NOFOLLOW protects directory traversal; the socket itself is lstat-checked
    because Unix sockets cannot be opened as ordinary O_NOFOLLOW file handles.
    This is not isolation from malicious processes running under the same uid.
    """

    MAX_FRAME = 65536
    TIMEOUT = 5.0

    def __init__(self, connection: socket.socket, *, server: bool = False):
        self._socket = connection
        self._socket.settimeout(self.TIMEOUT)
        self._steps = ["recv", "send"] if server else ["send", "recv"]

    @staticmethod
    def _directory(path):
        path = Path(path)
        if ".." in path.parts or path.name in ("", ".", ".."):
            raise ValueError("invalid socket path")
        path = path.absolute()
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open("/", flags)
        try:
            # Reject symlinks in every component, not just the final directory.
            for component in path.parent.parts[1:]:
                next_fd = os.open(component, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.fstat(fd)
            if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
                raise ValueError("socket directory must be owned by this uid with mode 0700")
            UnixSocketChannel._check_directory(path, fd)
            return path, fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _check_directory(path, fd):
        pinned = os.fstat(fd)
        current = os.stat(path.parent, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (pinned.st_dev, pinned.st_ino):
            raise ValueError("socket directory changed")

    @staticmethod
    def listen(path) -> "UnixSocketChannel":
        path, directory = UnixSocketChannel._directory(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bound = None
        connection = None
        try:
            try:
                os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ValueError("socket path already exists (including symlinks)")
            listener.settimeout(UnixSocketChannel.TIMEOUT)
            listener.bind(str(path))
            bound = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            UnixSocketChannel._check_directory(path, directory)
            listener.listen(1)
            connection, _ = listener.accept()
            return UnixSocketChannel(connection, server=True)
        except BaseException:
            if connection is not None:
                connection.close()
            raise
        finally:
            listener.close()
            try:
                if bound is not None:
                    try:
                        current = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        if (current.st_dev, current.st_ino) == (bound.st_dev, bound.st_ino):
                            os.unlink(path.name, dir_fd=directory)
            finally:
                os.close(directory)

    @staticmethod
    def connect(path) -> "UnixSocketChannel":
        path, directory = UnixSocketChannel._directory(path)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            info = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("socket path must be an owned socket, not a symlink")
            UnixSocketChannel._check_directory(path, directory)
            connection.settimeout(UnixSocketChannel.TIMEOUT)
            connection.connect(str(path))
            UnixSocketChannel._check_directory(path, directory)
            return UnixSocketChannel(connection)
        except BaseException:
            connection.close()
            raise
        finally:
            os.close(directory)

    def close(self):
        self._steps.clear()
        self._socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _start(self, operation):
        if not self._steps or self._steps[0] != operation:
            self.close()
            raise ValueError("channel permits exactly one request/decision exchange")

    def _finish(self):
        self._steps.pop(0)
        if not self._steps:
            self.close()

    @staticmethod
    def _plain(value):
        if value is None or type(value) in (str, bool, int):
            return
        if type(value) is float and math.isfinite(value):
            return
        if type(value) is list:
            for item in value:
                UnixSocketChannel._plain(item)
            return
        if type(value) is dict and all(type(key) is str for key in value):
            for item in value.values():
                UnixSocketChannel._plain(item)
            return
        raise ValueError("channel accepts only plain finite JSON values")

    @staticmethod
    def _object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def send(self, message: dict) -> None:
        self._start("send")
        try:
            if type(message) is not dict:
                raise TypeError("channel messages must be plain dicts")
            self._plain(message)
            body = json.dumps(message, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if not 0 < len(body) <= self.MAX_FRAME:
                raise ValueError("JSON frame exceeds 65536 bytes")
            self._socket.settimeout(self.TIMEOUT)
            self._socket.sendall(struct.pack("!I", len(body)) + body)
            self._finish()
        except BaseException:
            self.close()
            raise

    def _read_exact(self, length, deadline):
        result = bytearray()
        while len(result) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("JSON frame deadline exceeded")
            self._socket.settimeout(remaining)
            chunk = self._socket.recv(length - len(result))
            if not chunk:
                raise EOFError("truncated JSON frame")
            result.extend(chunk)
        return bytes(result)

    def recv(self) -> dict:
        self._start("recv")
        try:
            deadline = time.monotonic() + self.TIMEOUT
            length, = struct.unpack("!I", self._read_exact(4, deadline))
            if not 0 < length <= self.MAX_FRAME:
                raise ValueError("invalid JSON frame length")
            message = json.loads(self._read_exact(length, deadline).decode("utf-8"),
                                 object_pairs_hook=self._object)
            if type(message) is not dict:
                raise ValueError("channel messages must be plain dicts")
            self._plain(message)
            self._finish()
            return message
        except BaseException:
            self.close()
            raise
