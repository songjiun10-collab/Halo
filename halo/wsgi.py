"""Production WSGI entrypoint for gunicorn. Not used by local dev (dev_server.py
serves this directly via wsgiref instead).

Sets the umask before any gateway file I/O happens (the sqlite file and realm-
secret sidecar are created as a side effect of building the app), matching
dev_server.main()'s behavior -- which application() alone does not provide,
and which gunicorn's own --umask flag does not cover (that flag only affects
the pidfile).

Exposes a plain top-level `application` object rather than relying on
gunicorn's module:factory() call syntax, so the umask is guaranteed to run
before the factory is invoked and the deployment shape stays conventional:

    gunicorn halo.wsgi:application --bind 0.0.0.0:8080 ...
"""
import os

os.umask(0o077)

from .dev_server import application as _build_application  # noqa: E402

application = _build_application()
