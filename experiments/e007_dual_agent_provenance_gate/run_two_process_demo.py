"""Start separate approver/executor processes; never read either key file."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from ._process import parser
from .experiment import ApprovalRequest, EventClaim


def main(argv=None):
    cli = parser(__doc__)
    cli.add_argument("--approver-key-file", required=True)
    cli.add_argument("--executor-key-file", required=True)
    cli.add_argument("--provenance", choices=("trusted", "untrusted"), default="untrusted")
    cli.add_argument("--request-json", default=json.dumps(ApprovalRequest(
        tool="sha256", args={"text": "hello"}, intent_id="e007-two-process",
        events=(EventClaim(kind="tool", provenance="trusted", action="compute",
                           target_scope="local", declared_scope="local"),)).to_plain()))
    args = cli.parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    common = ["--socket", str(Path(args.socket).absolute()),
              "--gateway-host", args.gateway_host, "--gateway-port", str(args.gateway_port)]
    # Do not copy the parent's environment: it may carry both role credentials.
    def launch(role, key_file, extra):
        return subprocess.Popen(
            [sys.executable, "-m", f"experiments.e007_dual_agent_provenance_gate.{role}_process",
             *common, *extra], cwd=root,
            env={"PATH": os.defpath, f"HALO_{role.upper()}_KEY_FILE": str(Path(key_file).absolute())},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    approver = executor = None
    try:
        if os.path.lexists(args.socket):
            raise ValueError("socket path already exists")
        approver = launch("approver", args.approver_key_file, ["--provenance", args.provenance])
        deadline = time.monotonic() + 5
        while not os.path.lexists(args.socket):
            if approver.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("approver did not become ready")
            time.sleep(0.01)
        executor = launch("executor", args.executor_key_file, ["--request-json", args.request_json])
        output, _ = executor.communicate(timeout=15)
        approver.communicate(timeout=5)
        if approver.returncode != 0:
            raise RuntimeError("approver failed")
        print(output.rstrip())
        return executor.returncode if executor.returncode in (0, 1, 2) else 2
    except Exception:
        print(json.dumps({"error": "two-process exchange failed"}))
        return 2
    finally:
        for process in (executor, approver):
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
