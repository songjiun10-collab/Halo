"""Create development keys under a private directory without replacing old keys."""
import os
from pathlib import Path
import secrets
import stat

ROOT = Path(__file__).resolve().parents[1]


def initialize(directory=ROOT / ".docker-secrets"):
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Secret directory must be owned by you with mode 0700")
    paths = [directory / name for name in ("approver_key", "executor_key")]
    if any(path.exists() or path.is_symlink() for path in paths):
        raise FileExistsError("Keys already exist; existing keys were not replaced")
    for path in paths:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_hex(32) + "\n")
            # Compose bind-mounted file secrets preserve host ownership.
            # The private parent protects host access; container UID can read.
            os.fchmod(stream.fileno(), 0o444)


if __name__ == "__main__":
    initialize()
    print("Development role keys created in .docker-secrets (values hidden)")
