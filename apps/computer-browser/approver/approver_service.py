"""Long-running approver for the computer-use browser (apps/computer-browser).

Holds no HTTP/Gateway keys. There is no third-party service authenticating
either end here -- only a private Unix socket between this process and the
Electron main process (the executor). Unlike E007's role keys (which prove a
distinct identity to a shared halo.gateway.Gateway), a bearer key added to
*this* channel would have nothing real to prove and would just be decorative
security theater. The actual boundary is: a separate OS process, holding no
Node/Electron code, reachable only through a socket in a 0700 directory owned
by this uid with symlinks rejected (see UnixSocketChannel below) -- and the
fact that judgment here is entirely deterministic and cannot be talked out of
its answer by anything the executor sends.

Judgment is entirely halo.policy.decide() + halo.safety_cases.evaluate_trace().
No free-form LLM call is anywhere in this path.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from experiments.e007_dual_agent_provenance_gate.channel import UnixSocketChannel  # noqa: E402
from halo.policy import decide  # noqa: E402
from halo.safety_cases import Event, evaluate_trace  # noqa: E402

VALID_ACTIONS = {"click", "type", "submit_form", "navigate", "download"}
VALID_SOURCES = {"user_prompt", "page_content"}
VALID_PROVENANCE = {"trusted", "untrusted"}

# halo.safety_cases's action vocabulary (KNOWN_BENIGN_ACTIONS / EXTERNAL_WRITE_
# ACTIONS / PRIVILEGED_ACTIONS) predates this app and has no browser-specific
# entries. An Event whose action falls outside that vocabulary always earns a
# MONITORING_GAP ("outside the known tool vocabulary"), and policy.decide()
# hard-denies on ANY MONITORING_GAP when effectful=True -- before the REVIEW
# branch is ever reached. Sending our wire-level action names straight
# through would therefore deny every single request, defeating the point of
# having ALLOW/REVIEW at all. This table maps each UI-facing action (kept as
# the wire-level `action` field, and shown as-is in the renderer's approval
# queue/timeline) onto the closest existing halo.safety_cases vocabulary
# entry actually used for the policy decision:
#
#   navigate/click/type -> "read": approximate. Halo's vocabulary has no
#     neutral "interact" bucket, so a click that itself changes state (a
#     "buy"/"delete"/"confirm" button) is NOT distinguished here from an
#     inert one (opening a link) -- both get "read"'s lenient treatment.
#     Refining this by button semantics (label/aria-role) is future work.
#   submit_form -> "post_web" + effect "external_write": an honest match --
#     Halo already has a category for exactly this. Because trusted_telemetry
#     is always False in this app (no independent execution channel exists
#     yet), evaluate_trace()'s "self-reported telemetry is not independent
#     execution authority" rule makes this ALWAYS deny, unconditionally, same
#     as E007's own documented fail-closed stance on effectful actions.
#   download -> left outside the known vocabulary on purpose: it always
#     denies too, matching ChatGPT Atlas's real-world decision to disallow
#     agent-initiated downloads outright rather than try to gate them.
_ACTION_MAPPING = {
    "navigate": ("read", None),
    "click": ("read", None),
    "type": ("read", None),
    "submit_form": ("post_web", "external_write"),
    "download": ("download", None),
}


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def build_event(request: dict) -> Event:
    _require(type(request) is dict, "request must be a plain object")
    action = request.get("action")
    _require(action in VALID_ACTIONS, f"unknown action: {action!r}")
    source = request.get("source")
    _require(source in VALID_SOURCES, f"unknown source: {source!r}")
    self_provenance = request.get("self_provenance")
    _require(self_provenance in VALID_PROVENANCE, f"unknown self_provenance: {self_provenance!r}")
    target_scope = request.get("target_scope")
    _require(target_scope is None or type(target_scope) is str, "target_scope must be a string or null")
    contains_secret = request.get("contains_secret", False)
    _require(type(contains_secret) is bool, "contains_secret must be a bool")
    origin = request.get("origin", "")
    summary = request.get("summary", "")
    _require(type(origin) is str and len(origin) <= 4096, "origin must be a bounded string")
    _require(type(summary) is str and len(summary) <= 4096, "summary must be a bounded string")

    halo_action, halo_effect = _ACTION_MAPPING[action]
    return Event(
        kind=action,
        provenance=self_provenance,
        action=halo_action,
        target_scope=target_scope,
        effect=halo_effect,
        contains_secret=contains_secret,
        telemetry_complete=True,
        approved=False,
        metadata={"origin": origin, "summary": summary, "ui_action": action},
    )


def host_provenance_for(request: dict) -> str:
    """The independent judgment this approver actually contributes.

    The executor's own self_provenance claim is never trusted as the sole
    authority for a decision -- that would just relocate E007's self-report
    problem here verbatim. Instead this is a fixed rule the executor cannot
    talk its way around: anything whose justification traces back to content
    the agent just read on a page is untrusted, full stop, regardless of what
    the executor claims about it. This is the exact shape of the Comet
    zero-click incident (see design doc) -- a page's content pretending to be
    a trusted instruction -- and it is caught by evaluate_trace()'s existing
    self-claim-vs-host-value disagreement check (MONITORING_GAP) with no new
    detection logic required here.
    """
    return "untrusted" if request.get("source") == "page_content" else "trusted"


def evaluate(request: dict) -> dict:
    try:
        event = build_event(request)
    except ValueError as error:
        return {"decision": "deny", "reasons": [str(error)]}
    findings = evaluate_trace([event], trusted_telemetry=False, host_provenance=host_provenance_for(request))
    result = decide(findings, effectful=True)
    return {"decision": result.decision.value, "reasons": list(result.reasons)}


def serve_forever(socket_path: Path) -> None:
    print("halo computer-use approver ready", flush=True)
    while True:
        try:
            with UnixSocketChannel.listen(socket_path) as channel:
                request = channel.recv()
                channel.send(evaluate(request))
        except (TimeoutError, OSError, ValueError) as error:
            # A listen() timeout (no client for 5s) or a malformed/truncated
            # exchange must not take the whole approver down -- go back to
            # waiting for the next request. See run_two_process_demo.py's own
            # loop discipline in E007 for the same fail-closed-but-don't-die
            # posture. A ValueError here (e.g. an unresolved symlinked temp
            # directory on macOS -- see main/index.js's realpathSync fix)
            # would otherwise loop silently forever with no visible symptom
            # except the executor's requests always timing out; print it so
            # a systemic misconfiguration is diagnosable, not silent.
            if not isinstance(error, TimeoutError):
                print(f"[approver] listen/recv/send failed: {error}", file=sys.stderr, flush=True)
            continue


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="Unix socket path; parent dir must be 0700, owned by this uid")
    args = parser.parse_args(argv)
    serve_forever(Path(args.socket))


if __name__ == "__main__":
    main()
