"""Shared CLI configuration; call before opening any channel."""
import argparse
import os

from halo.dev_server import load_role_keys


def parser(description):
    result = argparse.ArgumentParser(description=description)
    result.add_argument("--socket", required=True)
    result.add_argument("--gateway-host", default="127.0.0.1")
    result.add_argument("--gateway-port", type=int, default=8080)
    return result


def role_key(role):
    opposite = "EXECUTOR" if role == "APPROVER" else "APPROVER"
    if any(f"HALO_{opposite}_KEY{suffix}" in os.environ for suffix in ("", "_FILE")):
        raise ValueError("opposite role key environment is forbidden")
    name = f"HALO_{role}_KEY"
    if (name in os.environ) == (name + "_FILE" in os.environ):
        raise ValueError("exactly one own-role KEY or KEY_FILE is required")
    # The opposite role was rejected before this two-role loader is called.
    # Thus it can only open this process's own role file.
    load_role_keys()
    key = os.environ[name]
    if not 32 <= len(key) <= 256 or not all(33 <= ord(c) <= 126 for c in key):
        raise ValueError("own-role key must be 32..256 printable ASCII characters")
    return key
