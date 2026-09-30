"""Push this Mac's current public IP to DuckDNS. Stdlib only.

Reads the token from a private (0600) local file rather than embedding it in
this script or in the launchd job definition, matching
tools/init_docker_secrets.py's secret-handling convention. Never prints the
token or logs the update URL (it contains the token as a query parameter).
"""
import os
import stat
import sys
import urllib.request
from pathlib import Path

CONFIG_DIR = Path.home() / ".duckdns"
TOKEN_FILE = CONFIG_DIR / "token"
DOMAIN_FILE = CONFIG_DIR / "domain"


def _read_private_file(path, max_bytes=256):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"{path} must be a private regular file (mode 0600) owned by you")
    with path.open("r", encoding="ascii") as stream:
        value = stream.read(max_bytes + 1)
    if len(value) > max_bytes:
        raise ValueError(f"{path} is unexpectedly large")
    return value.strip()


def update(domain, token, timeout=10):
    url = "https://www.duckdns.org/update?domains=" + domain + "&token=" + token + "&ip="
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode("ascii", "replace").strip()


def main():
    domain = _read_private_file(DOMAIN_FILE)
    token = _read_private_file(TOKEN_FILE)
    result = update(domain, token)
    if result != "OK":
        print("DuckDNS update failed (response was not OK)", file=sys.stderr)
        sys.exit(1)
    print("DuckDNS update OK")


if __name__ == "__main__":
    main()
