"""WSGI deployment factory. Configuration is supplied by the trusted host."""
import hashlib
import os
from pathlib import Path

from .gateway import Gateway, Tool


def create_app():
    directory = Path(os.environ["HALO_STATE_DIR"])
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ValueError("HALO_STATE_DIR must be an existing private absolute directory")
    stat = directory.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise ValueError("state directory must be owned by service user with mode 0700")
    path = directory / "gateway.sqlite3"
    if path.exists() or path.is_symlink():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("database must be private to service user")
        finally:
            os.close(fd)
    # Built-in demonstration has no file/network/process capability.
    tools = {"sha256": Tool("1", lambda a: set(a) == {"text"}
             and type(a["text"]) is str and len(a["text"]) <= 8192,
             lambda a: {"sha256": hashlib.sha256(a["text"].encode()).hexdigest()})}
    app = Gateway(path, os.environ["HALO_APPROVER_KEY"], os.environ["HALO_EXECUTOR_KEY"], tools)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("database must be private to service user")
    return app
