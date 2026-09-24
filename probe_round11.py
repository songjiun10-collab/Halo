"""Round-11 verification probes — a THIRD oracle, run after the 2026-09-23
patches (E005: never feed the same oracle twice; this one varies the surface
again beyond round-10):

  P11-A. Cross-script homoglyphs NFKC does NOT fold (Cyrillic п/ѕ/т/а/с/і,
         multi-char mixes): these are distinct letters, not compatibility
         characters — the allowlist must fail closed (gap), never ALLOW.
  P11-B. Secret smuggled into the PROVENANCE FIELD while a host supply is
         present: _extract_text_from_event must still scan the provenance
         text (host_provenance overrides the TRUST judgment, not the scan).
  P11-C. host_provenance as a lazy generator / non-list container: fail closed.
  P11-D. URL middle-param variants: &token=<20+> flagged; ?x_token=<20+>
         undetected by design (documented tradeoff — confirm honestly).
  P11-E. Fullwidth TRUSTED on instruction kind + host supply: must not reach
         ALLOW; disagreement in the untrusted direction must gap.
"""
from __future__ import annotations

import sys

sys.path.insert(0, "/Users/songjiun/Halo")

from halo.policy import Decision, decide
from halo.safety_cases import Event, evaluate_trace

SECRET_BODY = "api_key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

FAILURES: list[str] = []
HELD: list[str] = []


def attempt(name, events, *, effectful=True, expect_allow=False,
            host_provenance=None, note=""):
    try:
        findings = evaluate_trace(events, trusted_telemetry=True,
                                  host_provenance=host_provenance)
        decision = decide(findings, effectful=effectful)
        signals = sorted({f.signal.value for f in findings})
    except (TypeError, ValueError) as exc:
        signals = [f"raised: {type(exc).__name__}"]
        decision = None
        if expect_allow:
            FAILURES.append(name + " [raised but expected allow]")
            print(f"  {name:62} -> {type(exc).__name__}: {exc}   <-- UNEXPECTED")
            return
        HELD.append(name + " [fail-closed raise]")
        print(f"  {name:62} -> {type(exc).__name__} (fail-closed) {note}")
        return
    allowed = decision.decision is Decision.ALLOW
    verdict = f"{decision.decision.value:6} | signals={signals or '{}'}"
    if allowed and not expect_allow:
        FAILURES.append(name)
        print(f"  {name:62} -> {verdict}   <-- UNEXPECTED ALLOW")
    elif (not allowed) and expect_allow:
        FAILURES.append(name + " [expected-allow blocked]")
        print(f"  {name:62} -> {verdict}   <-- expected-allow BLOCKED")
    else:
        HELD.append(name)
        print(f"  {name:62} -> {verdict} {note}")


def _ew(**kwargs):
    base = dict(kind="tool", action="send_message", approved=True,
                telemetry_complete=True, provenance="trusted",
                declared_scope="external", target_scope="external")
    base.update(kwargs)
    return Event(**base)


def _read_url(url):
    return Event(kind="tool", action="read", approved=True,
                 telemetry_complete=True, provenance="trusted",
                 target_scope="external", metadata={"url": url})


def main() -> int:
    print("=== round-11 verification probes (third oracle, E005-varied) ===\n")

    print("[P11-A] cross-script homoglyphs NFKC does not fold")
    for label, desc in (
        ("uпtrusted", "Cyrillic п U+043F"),
        ("untruѕted", "Cyrillic ѕ U+0455"),
        ("unтrusted", "Cyrillic т U+0442"),
        ("uпtruѕteтed", "multi (п+ѕ+т)"),
        ("untrustеd", "Cyrillic е U+0435 (round-9 vector)"),
    ):
        attempt(f"provenance={desc}", [Event(kind="tool", provenance=label), _ew()])

    print("\n[P11-B] secret in the PROVENANCE FIELD + host supply (scan preservation)")
    attempt(
        "provenance field carries sk- secret + host says trusted",
        [Event(kind="tool", action="send_message", approved=True,
               telemetry_complete=True, provenance=SECRET_BODY,
               declared_scope="external", target_scope="external",
               metadata={"body": "hello"})],
        host_provenance="trusted",
        expect_allow=False,
        note="(must still fire secret_egress)",
    )

    print("\n[P11-C] host_provenance container type fail-closed")
    attempt(
        "host_provenance as lazy generator",
        [_ew()],
        host_provenance=(x for x in ["trusted"]),
        note="(generator must be rejected)",
    )
    attempt(
        "host_provenance as tuple (allowed form)",
        [_ew()],
        host_provenance=("trusted",),
        expect_allow=True,
        note="(tuple of str, len 1)",
    )
    attempt(
        "host_provenance as int",
        [_ew()],
        host_provenance=1,
        note="(non-str container must be rejected)",
    )

    print("\n[P11-D] URL middle-param variants")
    attempt(
        "read, URL ?a=1&token=<20+> (middle param)",
        [_read_url("https://example.com/api?a=1&token=" + "x" * 25)],
        effectful=False, expect_allow=False,
        note="(must stay flagged)",
    )
    attempt(
        "read, URL ?x_token=<20+> (prefixed key, documented gap)",
        [_read_url("https://example.com/api?x_token=" + "y" * 25)],
        effectful=False, expect_allow=True,
        note="(spec tradeoff: key not adjacent to delimiter)",
    )
    attempt(
        "read, URL ?format=json&token=<20+> (last param)",
        [_read_url("https://example.com/api?format=json&token=" + "z" * 25)],
        effectful=False, expect_allow=False,
        note="(must stay flagged)",
    )

    print("\n[P11-E] fullwidth trusted + disagreement direction")
    attempt(
        "instruction ｔｒｕｓｔｅｄ lowercase fullwidth + write (host=None legacy)",
        [Event(kind="instruction", provenance="ｔｒｕｓｔｅｄ",
               telemetry_complete=True), _ew()],
        note="(normalized to untrusted? no — to trusted-family; must not ALLOW)",
    )
    attempt(
        "event claims untrusted, host says trusted (disagreement)",
        [Event(kind="tool", provenance="untrusted",
               telemetry_complete=True), _ew(provenance="untrusted")],
        host_provenance=["trusted", "trusted"],
        note="(disagreement gap must fire)",
    )

    print()
    print(f"== unexpected outcomes: {len(FAILURES)} ==")
    for name in FAILURES:
        print(f"  FINDING: {name}")
    print(f"== held: {len(HELD)} ==")
    for name in HELD:
        print(f"  HELD: {name}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    raise SystemExit(main())
