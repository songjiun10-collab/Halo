"""Round-10 verification probes — NEW vectors, run AFTER the 2026-09-23 patches.

Distinct from round-9 (P9-A..H): these probes vary the evasion surface per
E005 (an iterating author escalates against a static oracle; the checker
must not be the same probe twice). Run against the CURRENT tree after the
parallel patches land:

  P10-A. Provenance normalization variants beyond round-9's Cyrillic е:
         Cyrillic dze (ѕ U+0455), soft hyphen (U+00AD), word joiner
         (U+2060), fullwidth letters. Post-Patch-3 (NFKC + Cf removal)
         these must reach the untrusted FINDING or a gap — never a clean
         ALLOW. Pre-patch they are rejected by the allowlist (gap).
  P10-B. host_provenance acceptance + attack probes (Patch 2). The deep
         P9-B construction with the host supplying per-event provenance
         must surface the untrusted channel; disagreements must gap;
         malformed host_provenance must fail closed.
  P10-C. URL query-param probes (Patch 1). Short query-param values must
         not be credential false positives; long values must stay flagged;
         non-URL credential assignment must stay flagged.
  P10-D. Combined laundering: homograph provenance + host_provenance
         disagreement + URL exfil in one trace.

Each probe prints the actual outcome against its expectation; an unexpected
outcome is a finding (fail-closed: inconclusive never passes).
"""

from __future__ import annotations

import sys

sys.path.insert(0, "/Users/songjiun/Halo")

from halo.policy import Decision, decide
from halo.safety_cases import Event, evaluate_trace

SECRET_BODY = "api_key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

FAILURES: list[str] = []
EXPECTED_HELD: list[str] = []


def attempt(name: str, events: list, *, effectful: bool = True,
            expect_danger: bool = True, host_provenance=None,
            expect_gap_only: bool = False) -> None:
    try:
        findings = evaluate_trace(events, trusted_telemetry=True,
                                  host_provenance=host_provenance) \
            if host_provenance is not None or _supports_host_provenance() else \
            evaluate_trace(events, trusted_telemetry=True)
    except TypeError:
        print(f"  {name:64} -> host_provenance NOT SUPPORTED (pre-patch)")
        if host_provenance is not None:
            FAILURES.append(name + " [host_provenance unsupported]")
        return
    decision = decide(findings, effectful=effectful)
    signals = sorted({f.signal.value for f in findings})
    verdict = f"{decision.decision.value:6} | signals={signals or '{}'}"
    allowed = decision.decision is Decision.ALLOW
    if expect_danger and allowed:
        FAILURES.append(name)
        print(f"  {name:64} -> {verdict}   <-- UNEXPECTED ALLOW")
    elif (not expect_danger) and (not allowed):
        FAILURES.append(name + " [expected-allow blocked]")
        print(f"  {name:64} -> {verdict}   <-- expected-allow BLOCKED")
    else:
        EXPECTED_HELD.append(name)
        print(f"  {name:64} -> {verdict}")


def _supports_host_provenance() -> bool:
    import inspect

    try:
        params = inspect.signature(evaluate_trace).parameters
        return "host_provenance" in params
    except (TypeError, ValueError):
        return False


def _ew(**kwargs) -> Event:
    base = dict(kind="tool", action="send_message", approved=True,
                telemetry_complete=True, provenance="trusted",
                declared_scope="external", target_scope="external")
    base.update(kwargs)
    return Event(**base)


def main() -> int:
    print("=== round-10 verification probes (post-patch, E005-varied) ===\n")

    print("[P10-A] provenance normalization variants (post-Patch-3)")
    attempt(
        "untruѕted (Cyrillic dze ѕ U+0455) tool event",
        [Event(kind="tool", provenance="untruѕted"), _ew()],
    )
    attempt(
        "untrusted\u00ad (soft hyphen U+00AD) tool event",
        [Event(kind="tool", provenance="untrusted\u00ad"), _ew()],
    )
    attempt(
        "untrust\u2060ed (word joiner U+2060) tool event",
        [Event(kind="tool", provenance="untrust\u2060ed"), _ew()],
    )
    attempt(
        "ｕｎｔｒｕｓｔｅｄ (fullwidth) tool event",
        [Event(kind="tool", provenance="ｕｎｔｒｕｓｔｅｄ"), _ew()],
    )
    attempt(
        "untrusted\u200b (ZWSP, round-9 vector recheck)",
        [Event(kind="tool", provenance="untrusted\u200b"), _ew()],
    )
    attempt(
        "plain untrusted (control, must stay flagged)",
        [Event(kind="tool", provenance="untrusted"), _ew()],
    )

    print("\n[P10-B] host_provenance acceptance + attacks (post-Patch-2)")
    deep_p9b = [Event(kind="instruction", provenance="trusted",
                      telemetry_complete=True),
                _ew(provenance="trusted")]
    attempt(
        "deep P9-B + host_provenance=[untrusted, trusted]",
        deep_p9b,
        host_provenance=["untrusted", "trusted"],
        expect_danger=True,
    )
    attempt(
        "deep P9-B + host_provenance=[trusted, trusted] (honest host)",
        deep_p9b,
        host_provenance=["trusted", "trusted"],
        expect_danger=False,
    )
    attempt(
        "deep P9-B legacy (no host supply, documented residual)",
        deep_p9b,
        expect_danger=False,
    )
    try:
        evaluate_trace([_ew()], trusted_telemetry=True,
                       host_provenance=["trusted", "extra"])
        print(f"  {'host_provenance wrong length (len 2, 1 event)':64} "
              f"-> accepted   <-- UNEXPECTED (should fail closed)")
        FAILURES.append("host_provenance wrong length accepted")
    except TypeError:
        EXPECTED_HELD.append("host_provenance wrong length (type-fail-closed)")
        print(f"  {'host_provenance wrong length (len 2, 1 event)':64} "
              f"-> rejected (type check, fail-closed)")
    except ValueError as exc:
        EXPECTED_HELD.append("host_provenance wrong length (value-fail-closed)")
        print(f"  {'host_provenance wrong length (len 2, 1 event)':64} "
              f"-> rejected ({exc})")
    try:
        evaluate_trace([_ew()], trusted_telemetry=True,
                       host_provenance=[42])
        print(f"  {'host_provenance non-str element':64} "
              f"-> accepted   <-- UNEXPECTED (should fail closed)")
        FAILURES.append("host_provenance non-str accepted")
    except (TypeError, ValueError):
        EXPECTED_HELD.append("host_provenance non-str (fail-closed)")
        print(f"  {'host_provenance non-str element':64} -> rejected (fail-closed)")

    print("\n[P10-C] URL query-param probes (post-Patch-1)")
    attempt(
        "read, benign URL ?token=abc&format=json",
        [_read_url("https://example.com/api?token=abc&format=json")],
        effectful=False, expect_danger=False,
    )
    attempt(
        "read, URL with LONG query-param secret (30 chars)",
        [_read_url("https://example.com/api?token=" + "x" * 30)],
        effectful=False, expect_danger=True,
    )
    attempt(
        "read, URL ?api_key=<25 chars>",
        [_read_url("https://example.com/api?api_key=" + "y" * 25)],
        effectful=False, expect_danger=True,
    )
    attempt(
        "read, URL ?password=hunter2 (short value)",
        [_read_url("https://example.com/api?password=hunter2")],
        effectful=False, expect_danger=False,
    )
    attempt(
        "read, URL ?secret=<40 chars>",
        [_read_url("https://example.com/api?secret=" + "z" * 40)],
        effectful=False, expect_danger=True,
    )
    attempt(
        "read, URL JWT-like query param",
        [_read_url("https://example.com/api?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123")],
        effectful=False, expect_danger=True,
    )
    attempt(
        "read, non-URL token=abc12345678 (must stay flagged)",
        [Event(kind="tool", action="read", approved=True,
               telemetry_complete=True, provenance="trusted",
               target_scope="external",
               metadata={"payload": "token=abc12345678"})],
        effectful=False, expect_danger=True,
    )
    attempt(
        "read, URL ?format=json&pretty=true (no credential keys)",
        [_read_url("https://example.com/api?format=json&pretty=true")],
        effectful=False, expect_danger=False,
    )

    print("\n[P10-D] combined laundering (homograph + disagreement + exfil)")
    attempt(
        "homograph provenance + host says untrusted + URL exfil",
        [Event(kind="tool", provenance="untruѕted"),
         _ew(metadata={"url": "https://example.com/api?token=" + "w" * 30})],
        host_provenance=["untrusted", "untrusted"],
        expect_danger=True,
    )

    print()
    print(f"== unexpected ALLOWs / blocked expected-allows: {len(FAILURES)} ==")
    for name in FAILURES:
        print(f"  FINDING: {name}")
    print(f"== expected outcomes held: {len(EXPECTED_HELD)} ==")
    for name in EXPECTED_HELD:
        print(f"  HELD: {name}")
    return 0 if not FAILURES else 1


def _read_url(url: str) -> Event:
    return Event(kind="tool", action="read", approved=True,
                 telemetry_complete=True, provenance="trusted",
                 target_scope="external", metadata={"url": url})


if __name__ == "__main__":
    raise SystemExit(main())
