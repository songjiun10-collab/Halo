"""Round-9 isolated gateway exploit: fork double spend, cross-instance
capability use, and a corrected claim-once recheck.

Re-verified against the F03-fixed gateway.py (realm-identity sidecar).
Run with the repository .venv interpreter from the isolated copy. All
state lives in an isolated 0700 directory; the only registered tool is a
side-effect-free in-memory echo counter; no network listener is opened.

  P9-Ga. State-file fork, DB-only copy. Backups/rsync mirrors/Time Machine
         restores that copy the SQLite file but not the realm sidecar:
         the forked instance now REFUSES TO OPEN (fail-closed). Reported
         as HELD — this section crashed with ValueError before the
         open-refusal behavior existed.
  P9-Gb. State-file fork, full snapshot. DB + sidecar placed at the
         fork's computed realm name: the same capability then executes
         once per copy (DOUBLE SPEND). gateway.py documents this as a
         limit ("still a copy of the realm"); reported as the documented
         residual risk, not a defense failure.
  P9-H.  Cross-instance capability use. Instances with different approver
         keys mint different realm identities, so the second instance
         refuses to open a shared DB (fail-closed). Reported as HELD —
         this section also crashed before the open-refusal behavior.
  P9-F.  Corrected concurrency claim-once recheck. The V8 probe compared
         a global effect counter to 1 after earlier sections had already
         consumed effects. This recheck measures the per-round delta with
         a fresh state per round.

Exit code: 0 = every outcome matched its expectation (defenses held,
documented limits confirmed); 1 = unexpected breach. This is the standard
convention; the script's earlier inverted mapping (0 on breach) predates
the F03 fix that turned both fork vectors into open refusals.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import threading

from halo.gateway import Gateway, Rejected, Tool, _encode

STATE_DIR = os.path.join(
    "/var/folders/x0/gp37ndd96_ddxtf0fn0t6kk00000gn/T/opencode", "halo-iso-r9", "gw-r9")
DB_PATH = os.path.join(STATE_DIR, "g9.db")
A, B, E = "a" * 48, "b" * 48, "e" * 48

_effects = 0
_effect_lock = threading.Lock()


def make_tool():
    def execute(args):
        global _effects
        with _effect_lock:
            _effects += 1
        return {"echo": args}

    return {"echo": Tool("v1", lambda a: True, execute)}


def fresh(path=DB_PATH):
    if os.path.exists(path):
        os.remove(path)
    for name in os.listdir(STATE_DIR):
        if name.startswith(os.path.basename(path) + ".realm-"):
            os.remove(os.path.join(STATE_DIR, name))
    return Gateway(path, A, E, make_tool())


def approve(app, intent="intent"):
    return app.handle("/approve", A, {"tool": "echo", "args": {},
                                      "intent_id": intent})["token"]


def section(title):
    print(f"\n== {title} ==")


def _drop_sidecars(path):
    for name in os.listdir(STATE_DIR):
        if name.startswith(os.path.basename(path) + ".realm-"):
            os.remove(os.path.join(STATE_DIR, name))


def fork_db_only():
    """P9-Ga: DB-only copy (backup tools that miss the sidecar)."""
    section("P9-Ga state-file fork, DB-only copy (sidecar missing)")
    effects_before = _effects
    app = fresh()
    token = approve(app, intent="fork-victim")
    fork_path = os.path.join(STATE_DIR, "g9-fork.db")
    if os.path.exists(fork_path):
        os.remove(fork_path)
    _drop_sidecars(fork_path)
    shutil.copy2(DB_PATH, fork_path)
    try:
        forked = Gateway(fork_path, A, E, make_tool())
    except ValueError as exc:
        print(f"  forked instance refused to open: {exc}")
        print("  -> HELD (fail-closed open refusal; a DB-only copy cannot fork claim state)")
        return False
    args = {"tool": "echo", "args": {}, "token": token}
    try:
        r1 = app.handle("/execute", E, args)
        r2 = forked.handle("/execute", E, args)
    except Rejected as exc:
        print(f"  forked execute rejected: {exc}")
        print("  -> HELD")
        return False
    delta = _effects - effects_before
    print(f"  original copy execute -> {r1}")
    print(f"  forked copy  execute -> {r2}")
    print(f"  effects from ONE approval: {delta} "
          f"{'(DOUBLE SPEND: claim-once broken across file copies)'
            if delta > 1 else '(held)'}")
    return delta > 1


def fork_full_snapshot():
    """P9-Gb: full snapshot — DB + sidecar at the fork's computed realm name.

    gateway.py documents this as a limit ("still a copy of the realm").
    Expected outcome: DOUBLE SPEND (documented residual risk, not a
    defense failure); 'held' would be stronger than documented.
    """
    section("P9-Gb state-file fork, full snapshot (DB + sidecar at computed name)")
    effects_before = _effects
    app = fresh()
    with open(app._realm_sidecar_path()) as stream:
        secret = stream.read().strip()
    token = approve(app, intent="fork-snapshot")
    fork_path = os.path.join(STATE_DIR, "g9-fork2.db")
    if os.path.exists(fork_path):
        os.remove(fork_path)
    _drop_sidecars(fork_path)
    shutil.copy2(DB_PATH, fork_path)
    realm_fork = hashlib.sha256(_encode([fork_path, A, E])).hexdigest()
    fork_sidecar = fork_path + ".realm-" + hashlib.sha256(
        realm_fork.encode()).hexdigest() + ".id"
    with open(fork_sidecar, "w") as stream:
        stream.write(secret)
    os.chmod(fork_sidecar, 0o600)
    try:
        forked = Gateway(fork_path, A, E, make_tool())
    except ValueError as exc:
        print(f"  forked instance refused to open: {exc}")
        print("  -> HELD (stronger than the documented limit)")
        return "held"
    args = {"tool": "echo", "args": {}, "token": token}
    try:
        r1 = app.handle("/execute", E, args)
        r2 = forked.handle("/execute", E, args)
    except Rejected as exc:
        print(f"  forked execute rejected: {exc}")
        print("  -> HELD (capability binding rejected the fork)")
        return "held"
    delta = _effects - effects_before
    print(f"  original copy execute -> {r1}")
    print(f"  forked copy  execute -> {r2}")
    print(f"  effects from ONE approval: {delta} "
          f"{'(DOUBLE SPEND: documented limit confirmed live)'
            if delta > 1 else '(held: single effect)'}")
    return "double_spend" if delta > 1 else "held"


def cross_instance():
    """P9-H: cross-instance capability use (different approver keys, shared DB)."""
    section("P9-H cross-instance capability use (different approver keys, shared DB)")
    app_a = Gateway(DB_PATH, A, E, make_tool())
    try:
        app_b = Gateway(DB_PATH, B, E, make_tool())
    except ValueError as exc:
        print(f"  second instance refused to open: {exc}")
        print("  -> HELD (fail-closed; instances with different realm identities "
              "cannot share state)")
        return False
    token = approve(app_a, intent="cross-instance")
    args = {"tool": "echo", "args": {}, "token": token}
    try:
        r = app_b.handle("/execute", E, args)
        print(f"  token minted by instance A (approver key A) executed on "
              f"instance B (approver key B) -> {r}")
        print("  capability is NOT instance-bound: shared-state instances "
              "accept each other's grants")
        return True
    except Rejected as exc:
        print(f"  instance B rejected A's token ({exc})")
        return False


def claim_once_recheck():
    section("P9-F corrected concurrency claim-once recheck")
    rounds = 5
    workers = 64
    all_ok = True
    for round_no in range(rounds):
        effects_before = _effects
        app = fresh()
        token = approve(app, intent=f"race-{round_no}")
        statuses = [None] * workers
        barrier = threading.Barrier(workers)

        def worker(i):
            barrier.wait()
            raw = json.dumps({"tool": "echo", "args": {},
                              "token": token}).encode()
            statuses[i] = post_wsgi(app, raw)

        threads = [threading.Thread(target=worker, args=(i,))
                   for i in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        ok = sum(1 for s in statuses if s == "200 OK")
        delta = _effects - effects_before
        held = ok == 1 and delta == 1
        all_ok = all_ok and held
        print(f"  round {round_no + 1}: {workers} simultaneous executes -> "
              f"{ok} HTTP 200, {delta} effects "
              f"{'(held)' if held else '(BROKEN)'}")
    return all_ok


def post_wsgi(app, raw):
    import io

    env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/execute",
           "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json",
           "HTTP_AUTHORIZATION": "Bearer " + E, "wsgi.input": io.BytesIO(raw)}
    statuses = []
    b"".join(app(env, lambda s, h: statuses.append(s)))
    return statuses[0]


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    print("=== round-9 isolated gateway exploit "
          "(re-verified against F03-fixed gateway.py) ===")
    broke_db_only = fork_db_only()
    snapshot_result = fork_full_snapshot()
    broke_cross = cross_instance()
    claim_held = claim_once_recheck()

    print("\n== summary ==")
    print(f"  fork, DB-only copy:  "
          f"{'DOUBLE SPEND' if broke_db_only else 'held (fail-closed open refusal)'}")
    print(f"  fork, full snapshot: {snapshot_result}"
          f"{' (documented limit — gateway.py comment)'
            if snapshot_result == 'double_spend' else ''}")
    print(f"  cross-instance:      "
          f"{'accepted (NOT instance-bound)' if broke_cross else 'held (fail-closed open refusal)'}")
    print(f"  claim_once (delta-corrected): "
          f"{'held in all rounds' if claim_held else 'BROKEN in some round'}")

    unexpected = broke_db_only or broke_cross or not claim_held
    return 0 if not unexpected else 1


if __name__ == "__main__":
    raise SystemExit(main())
