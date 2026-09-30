"""Local development WSGI server. Not an Internet-facing production server."""

import argparse
import json
import os
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, make_server

from .gateway_app import create_app


def load_role_keys():
    """Load bounded ASCII secrets; never print their values on failure."""
    for name in ("HALO_APPROVER_KEY", "HALO_EXECUTOR_KEY"):
        location = os.environ.get(name + "_FILE")
        if location is not None:
            if name in os.environ:
                raise ValueError(f"Set only {name} or {name}_FILE")
            with Path(location).open("rb") as stream:
                raw = stream.read(257)
            if len(raw) > 256:
                raise ValueError(f"{name}_FILE is too large")
            try:
                key = raw.decode("ascii").rstrip("\r\n")
            except UnicodeError:
                raise ValueError(f"{name}_FILE must contain ASCII") from None
            if len(key) < 32 or not all(33 <= ord(c) <= 126 for c in key):
                raise ValueError(f"{name}_FILE must contain a printable key of at least 32 characters")
            os.environ[name] = key


def application():
    load_role_keys()
    gateway = create_app()

    def dispatch(environ, start_response):
        if environ.get("PATH_INFO") == "/healthz" and environ.get("REQUEST_METHOD") == "GET":
            body = json.dumps({"status": "ready", "mode": "development"}).encode()
            start_response("200 OK", [("Content-Type", "application/json"),
                                      ("Cache-Control", "no-store"),
                                      ("Content-Length", str(len(body)))])
            return [body]
        return gateway(environ, start_response)

    return dispatch


class QuietHandler(WSGIRequestHandler):
    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def log_message(self, format, *args):
        # Default request logs contain arbitrary paths/query strings.
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)
    os.umask(0o077)
    app = application()
    with make_server(args.host, args.port, app, handler_class=QuietHandler) as server:
        print("HALO development gateway ready", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
