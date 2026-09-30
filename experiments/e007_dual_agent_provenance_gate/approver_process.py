"""Run one approver, holding only its own gateway credential (python -m)."""
import sys

from ._process import parser, role_key
from .channel import UnixSocketChannel
from .experiment import ApproverAgent, GatewayClient


def main(argv=None):
    cli = parser(__doc__)
    cli.add_argument("--provenance", choices=("trusted", "untrusted"), default="untrusted")
    args = cli.parse_args(argv)
    try:
        key = role_key("APPROVER")
    except (ValueError, OSError):
        print("invalid own-role key configuration or opposite role key environment", file=sys.stderr)
        return 2
    try:
        gateway = GatewayClient(args.gateway_host, args.gateway_port, key)
        agent = ApproverAgent(gateway, classify_provenance=lambda _request: args.provenance)
        with UnixSocketChannel.listen(args.socket) as channel:
            agent.serve_once(channel)
        return 0
    except Exception:
        # Protocol/HTTP errors can embed untrusted bodies; do not echo them.
        print("approver exchange failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
