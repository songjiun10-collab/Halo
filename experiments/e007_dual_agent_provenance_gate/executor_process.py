"""Run one executor, holding only its own gateway credential (python -m)."""
import json
import sys

from ._process import parser, role_key
from .channel import UnixSocketChannel
from .experiment import ApprovalRequest, ExecutorAgent, GatewayClient, RequestDenied


def main(argv=None):
    cli = parser(__doc__)
    cli.add_argument("--request-json", required=True)
    args = cli.parse_args(argv)
    try:
        key = role_key("EXECUTOR")
    except (ValueError, OSError):
        print("invalid own-role key configuration or opposite role key environment", file=sys.stderr)
        return 2
    try:
        request = ApprovalRequest.from_plain(json.loads(args.request_json))
        gateway = GatewayClient(args.gateway_host, args.gateway_port, key)
        with UnixSocketChannel.connect(args.socket) as channel:
            result = ExecutorAgent(gateway, channel).run(request)
        print(json.dumps(result, allow_nan=False))
        return 0
    except RequestDenied as exc:
        print(json.dumps({"decision": exc.decision.value, "reasons": list(exc.reasons)}))
        return 1
    except Exception:
        print(json.dumps({"error": "executor exchange failed"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
