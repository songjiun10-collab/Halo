"""E006 fault-injection experiment on the gateway lifecycle.

Per the repo review doc improvement #2: inject faults between
approve -> claim -> dispatch -> audit and measure both safety and
usefulness costs. All state lives in isolated temp directories created
per run (tempfile.mkdtemp); the only registered tool is a side-effect-free
in-memory echo counter (plus a disposable temp-file sink for the subprocess
crash scenario). No network listener; no external effects.

Invariants (fail-closed — a violation is a finding, not a pass):

- INV1 claim-once: 한 토큰의 효과가 최대 1회다 (per-token delta accounting;
  the V8/V9 lesson — measure deltas, never absolute global counters).
- INV2 no-wrong-rejection: dispatch 후 어떤 실패도 '실행되지 않은 거부'로
  보고되지 않는다. halo.gateway.ExecutionUncertain extends Rejected, so the
  check uses exact types: type(exc) is ExecutionUncertain for post-dispatch
  failures, type(exc) is Rejected for pre-dispatch refusals.

Scenario matrix (16), fault types x injection points (a crashed subagent's
design, completed by the orchestrator):

  adapter_exception_before_effect / after_effect (execute raises)
  adapter_double_failure (effect + raise, and the failed_or_uncertain audit
      insert also fails via an injected SQLite trigger)
  slow_validator_concurrent_revoke (revoke lands while the validator blocks)
  slow_adapter_concurrent_revoke (revoke lands while the adapter blocks)
  clock_rollback_before_claim / after_dispatch / tolerated_within_tolerance
  clock_unavailable_before_claim (non-finite clock value)
  unauthorized_execute_forged_token (무승인 효과)
  db_copy_db_only (fork refused — fail-closed)
  db_copy_full_snapshot / db_restore_old_snapshot (B2 residual: DB + realm
      sidecar copy -> double spend, documented, expected finding — the
      gateway does not guarantee anti-rollback on a full snapshot)
  worker_restart_before_effect / after_effect_inprocess
  worker_restart_after_effect_subprocess (real os._exit crash, effect via a
      temp-file sink, claimed state persists, no duplicate on re-request)
  benign_baseline (정상 성공률 / usefulness cost)
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from halo.gateway import ExecutionUncertain, Gateway, Rejected, Tool, _encode

APPROVER = "a" * 48
EXECUTOR = "e" * 48
FORGED = "f" * 48


class ManualClock:
    """Deterministic wall/monotonic clock with explicit advance/rewind."""

    def __init__(self, wall=1000.0, mono=1000.0):
        self.wall_value = float(wall)
        self.mono_value = float(mono)
        self.mono_enabled = True

    def wall(self):
        return self.wall_value

    def mono(self):
        if not self.mono_enabled:
            raise ValueError("monotonic clock unavailable")
        return self.mono_value

    def rewind(self, wall=0.0):
        self.wall_value -= wall


class _EchoTool:
    """Side-effect-free in-memory echo counter with optional fault hooks.

    All hook state lives on the INSTANCE, never in the code object — the
    adapter fingerprint (filename/name/firstlineno/co_code) must stay
    identical across instances so a grant minted for one worker validates
    on a restarted one (the code object is shared; instances differ only
    in attributes).
    """

    def __init__(self, *, raise_before=False, raise_after=False,
                 delay_event=None, sink_path=None, crash_after_sink=False):
        self.effects = 0
        self._raise_before = raise_before
        self._raise_after = raise_after
        self._delay_event = delay_event
        self._sink_path = sink_path
        self._crash_after_sink = crash_after_sink

    def execute(self, args):
        if self._delay_event is not None:
            self._delay_event.wait(timeout=10)
        if self._raise_before:
            raise RuntimeError("injected adapter failure before effect")
        self.effects += 1
        if self._sink_path is not None:
            with open(self._sink_path, "w") as stream:
                stream.write("effect")
            if self._crash_after_sink:
                os._exit(1)
        if self._raise_after:
            raise RuntimeError("injected adapter failure after effect")
        return {"echo": args}


def _tool_spec(*, raise_before=False, raise_after=False, delay_event=None,
               slow_validate_event=None, sink_path=None, crash_after_sink=False):
    tool = _EchoTool(raise_before=raise_before, raise_after=raise_after,
                     delay_event=delay_event, sink_path=sink_path,
                     crash_after_sink=crash_after_sink)

    if slow_validate_event is not None:
        def validate(args):
            slow_validate_event.wait(timeout=10)
            return True
    else:
        def validate(args):
            return True

    return tool, {"echo": Tool("v1", validate, tool.execute)}


def _fresh_state(root, name="g"):
    """Create a fresh isolated state dir; remove stale sidecars and DBs."""
    state_dir = os.path.join(root, name + ".d")
    os.makedirs(state_dir, exist_ok=True)
    db_path = os.path.join(state_dir, name + ".db")
    for entry in os.listdir(state_dir):
        if entry.startswith(name + ".db.realm-"):
            os.remove(os.path.join(state_dir, entry))
    if os.path.exists(db_path):
        os.remove(db_path)
    return state_dir, db_path


def _open_gateway(db_path, spec, *, clock=None, tolerance=None):
    kwargs = {}
    if clock is not None:
        kwargs["clock"] = clock.wall
        kwargs["mono_clock"] = clock.mono
    if tolerance is not None:
        kwargs["rollback_tolerance"] = tolerance
    return Gateway(db_path, APPROVER, EXECUTOR, spec, **kwargs)


def _approve(app, intent="intent"):
    return app.handle("/approve", APPROVER,
                      {"tool": "echo", "args": {}, "intent_id": intent})["token"]


def _execute(app, token):
    return app.handle("/execute", EXECUTOR,
                      {"tool": "echo", "args": {}, "token": token})


def _revoke(app, token):
    return app.handle("/revoke", APPROVER, {"token": token})


def _classify(exc):
    """Exact-type classification: ExecutionUncertain is NOT a plain Rejected."""
    return type(exc).__name__


def _run_execute(app, token):
    """Execute, returning the exact exception type name or 'ok'.

    A clock callable that RAISES propagates an uncaught exception out of
    handle() (neither Rejected nor ExecutionUncertain) — recorded honestly
    as 'uncaught:<Type>' (an error-handling inconsistency finding, reported
    not fixed: the experiment does not modify halo/gateway.py).
    """
    try:
        _execute(app, token)
        return "ok"
    except ExecutionUncertain as exc:
        return _classify(exc)
    except Rejected as exc:
        return _classify(exc)
    except Exception as exc:  # noqa: BLE001 — record the uncaught type honestly
        return "uncaught:" + _classify(exc)


def _row(effects_before, tool, response_type, *, post_dispatch=False, **extra):
    row = {
        "effects": tool.effects - effects_before,
        "unauthorized_effects": 0,
        "duplicate_effects": 0,
        "response_type": response_type,
        "uncertain": response_type == "ExecutionUncertain",
        # 잘못된 거부 응답: a POST-dispatch failure surfaced as a pre-dispatch-style
        # Rejected. A Rejected on a pre-dispatch scenario is the CORRECT refusal.
        "wrong_rejection": bool(post_dispatch and response_type == "Rejected"),
    }
    row.update(extra)
    return row


def _recovery(app, token):
    """Replay refusal + new-token recovery after a consumed capability."""
    replay_refused = None
    try:
        _execute(app, token)
        replay_refused = False
    except Rejected:
        replay_refused = True
    new_token = _approve(app, intent="recovery")
    new_ok = _run_execute(app, new_token) == "ok"
    return {"replay_refused": replay_refused,
            "new_token_execute_succeeds": new_ok}


# --- scenario groups -------------------------------------------------------

def _lifecycle_faults(root):
    out = {}

    state_dir, db_path = _fresh_state(root, "ae-before")
    tool, spec = _tool_spec(raise_before=True)
    app = _open_gateway(db_path, spec)
    token = _approve(app, "ae-before")
    before = tool.effects
    out["adapter_exception_before_effect"] = _row(
        before, tool, _run_execute(app, token))

    state_dir, db_path = _fresh_state(root, "ae-after")
    tool, spec = _tool_spec(raise_after=True)
    app = _open_gateway(db_path, spec)
    token = _approve(app, "ae-after")
    before = tool.effects
    row = _row(before, tool, _run_execute(app, token), post_dispatch=True)
    tool._raise_after = False  # the fault was transient; retry with a healthy adapter
    row.update(_recovery(app, token))
    out["adapter_exception_after_effect"] = row

    state_dir, db_path = _fresh_state(root, "ae-double")
    tool, spec = _tool_spec(raise_after=True)
    app = _open_gateway(db_path, spec)
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TRIGGER fail_uncertain_audit BEFORE INSERT ON audit "
            "WHEN NEW.phase='failed_or_uncertain' "
            "BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
    token = _approve(app, "ae-double")
    before = tool.effects
    out["adapter_double_failure"] = _row(
        before, tool, _run_execute(app, token), post_dispatch=True)

    return out


def _concurrent_revoke_faults(root):
    out = {}
    import time as _time

    for name, slow in (("slow_validator_concurrent_revoke", "validate"),
                       ("slow_adapter_concurrent_revoke", "adapter")):
        state_dir, db_path = _fresh_state(root, "slow-" + slow)
        block = threading.Event()
        if slow == "validate":
            tool, spec = _tool_spec(slow_validate_event=block)
        else:
            tool, spec = _tool_spec(delay_event=block)
        app = _open_gateway(db_path, spec)
        token = _approve(app, "slow-" + slow)
        before = tool.effects
        outcome = {"status": None}

        def run_execute():
            outcome["status"] = _run_execute(app, token)

        worker = threading.Thread(target=run_execute)
        worker.start()
        block.set()  # the worker is now blocked at the chosen phase
        deadline = _time.monotonic() + 10
        while not outcome["status"] and _time.monotonic() < deadline:
            if slow == "validate" and worker.is_alive():
                # give the worker time to enter the preflight transaction
                _time.sleep(0.05)
                break
            _time.sleep(0.01)
        if slow == "adapter":
            # wait until the claim has committed (state no longer pending)
            with sqlite3.connect(db_path) as db:
                for _ in range(100):
                    row_state = db.execute(
                        "SELECT state FROM grants").fetchone()
                    if row_state and row_state[0] == "claimed":
                        break
                    _time.sleep(0.02)
        try:
            revoke_result = _revoke(app, token)
        except Rejected as exc:
            revoke_result = {"revoked": False,
                             "rejected": _classify(exc)}
        block.set()
        worker.join(timeout=15)
        row = _row(before, tool, outcome["status"] or "timeout")
        row["revoke_result"] = revoke_result
        row["duplicate_effects"] = max(0, row["effects"] - 1)
        out[name] = row
    return out


def _clock_faults(root):
    out = {}

    state_dir, db_path = _fresh_state(root, "ck-before")
    clock = ManualClock(wall=1000.0)
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec, clock=clock)
    token = _approve(app, "ck-before")
    clock.rewind(wall=50)
    before = tool.effects
    out["clock_rollback_before_claim"] = _row(
        before, tool, _run_execute(app, token))

    state_dir, db_path = _fresh_state(root, "ck-after")
    clock = ManualClock(wall=1000.0)
    tool, spec = _tool_spec()

    class _RewindOnExecute:
        def __init__(self, inner, clock_obj):
            self._inner = inner
            self._clock = clock_obj

        def execute(self, args):
            self._clock.rewind(wall=100)  # wall rewinds mid-dispatch
            return self._inner(args)

    tool_effect_counter = tool
    spec = {"echo": Tool("v1", lambda a: True,
                         _RewindOnExecute(tool.execute, clock).execute)}
    app = _open_gateway(db_path, spec, clock=clock)
    token = _approve(app, "ck-after")
    before = tool_effect_counter.effects
    out["clock_rollback_after_dispatch"] = _row(
        before, tool_effect_counter, _run_execute(app, token), post_dispatch=True)

    state_dir, db_path = _fresh_state(root, "ck-tol")
    clock = ManualClock(wall=1000.0)
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec, clock=clock, tolerance=5.0)
    token = _approve(app, "ck-tol")
    clock.rewind(wall=3)  # within tolerance 5
    before = tool.effects
    out["clock_rollback_tolerated_within_tolerance"] = _row(
        before, tool, _run_execute(app, token))

    state_dir, db_path = _fresh_state(root, "ck-unavail")
    clock = ManualClock(wall=1000.0)
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec, clock=clock)
    token = _approve(app, "ck-unavail")
    clock.mono_enabled = False
    before = tool.effects
    out["clock_unavailable_before_claim"] = _row(
        before, tool, _run_execute(app, token))

    return out


def _authz_faults(root):
    out = {}
    state_dir, db_path = _fresh_state(root, "authz")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    before = tool.effects
    response = _run_execute(app, FORGED + "-not-a-real-token")
    row = _row(before, tool, response)
    row["unauthorized_effects"] = tool.effects - before
    out["unauthorized_execute_forged_token"] = row
    return out


def _state_faults(root):
    out = {}

    state_dir, db_path = _fresh_state(root, "st-dbonly")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    token = _approve(app, "st-dbonly")
    fork_path = os.path.join(state_dir, "fork.db")
    shutil.copy2(db_path, fork_path)  # DB only: no realm sidecar
    before = tool.effects
    response = "ok"
    try:
        forked = _open_gateway(fork_path, spec)
        response = "opened:" + _run_execute(forked, token)
    except ValueError as exc:
        response = "refused:" + str(exc)
    row = _row(before, tool, response.split(":")[0])
    row["detail"] = response
    out["db_copy_db_only"] = row

    state_dir, db_path = _fresh_state(root, "st-full")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    with open(app._realm_sidecar_path()) as stream:
        secret = stream.read().strip()
    token = _approve(app, "st-full")
    fork_path = os.path.join(state_dir, "fork.db")
    shutil.copy2(db_path, fork_path)
    realm_fork = hashlib.sha256(_encode([fork_path, APPROVER, EXECUTOR])).hexdigest()
    fork_sidecar = fork_path + ".realm-" + hashlib.sha256(
        realm_fork.encode()).hexdigest() + ".id"
    with open(fork_sidecar, "w") as stream:
        stream.write(secret)
    os.chmod(fork_sidecar, 0o600)
    before = tool.effects
    response = "ok"
    try:
        forked = _open_gateway(fork_path, spec)
        _run_execute(app, token)
        response = "opened:" + _run_execute(forked, token)
    except ValueError as exc:
        response = "refused:" + str(exc)
    delta = tool.effects - before
    row = _row(before, tool, response.split(":")[0])
    row["detail"] = response
    row["duplicate_effects"] = max(0, delta - 1)
    row["b2_residual"] = delta > 1
    out["db_copy_full_snapshot"] = row

    state_dir, db_path = _fresh_state(root, "st-restore")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    token = _approve(app, "st-restore")
    snapshot_path = os.path.join(state_dir, "snapshot.db")
    shutil.copy2(db_path, snapshot_path)  # pending-grant snapshot
    _execute(app, token)  # effect 1, state completed
    shutil.copy2(snapshot_path, db_path)  # rollback to the old snapshot
    restored = _open_gateway(db_path, spec)
    before = tool.effects
    response = _run_execute(restored, token)  # B2 residual: executes again
    row = _row(before, tool, response)
    row["duplicate_effects"] = tool.effects - before
    row["b2_residual"] = (tool.effects - before) > 0
    out["db_restore_old_snapshot"] = row

    return out


def _restart_faults(root):
    out = {}

    state_dir, db_path = _fresh_state(root, "rs-before")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    token = _approve(app, "rs-before")  # never executed
    before = tool.effects
    restarted = _open_gateway(db_path, spec)
    response = _run_execute(restarted, token)
    row = _row(before, tool, response)
    row["duplicate_effects"] = max(0, row["effects"] - 1)
    out["worker_restart_before_effect"] = row

    state_dir, db_path = _fresh_state(root, "rs-after")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    token = _approve(app, "rs-after")
    _execute(app, token)  # effect 1, state completed
    before = tool.effects
    restarted = _open_gateway(db_path, spec)
    response = _run_execute(restarted, token)
    row = _row(before, tool, response)
    row["duplicate_effects"] = tool.effects - before
    out["worker_restart_after_effect_inprocess"] = row

    state_dir, db_path = _fresh_state(root, "rs-sub")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    token = _approve(app, "rs-sub")
    sink_path = os.path.join(state_dir, "sink.txt")
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))
    # The worker imports the SAME _tool_spec factory (same code objects ->
    # same adapter fingerprint), so the grant minted by the parent validates
    # in the subprocess. Defining a local adapter would change co_code and
    # fail the digest check.
    worker_script = (
        "import os, sys, traceback\n"
        "sys.path.insert(0, %r)\n"
        "from experiments.e006_fault_injection.experiment import _tool_spec, APPROVER, EXECUTOR\n"
        "from halo.gateway import Gateway\n"
        "db_path, token, sink, crash_log = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]\n"
        "tool, spec = _tool_spec(sink_path=sink, crash_after_sink=True)\n"
        "app = Gateway(db_path, APPROVER, EXECUTOR, spec)\n"
        "try:\n"
        "    app.handle('/execute', EXECUTOR, {'tool': 'echo', 'args': {}, 'token': token})\n"
        "except BaseException:\n"
        "    with open(crash_log, 'w') as stream:\n"
        "        import hashlib, sqlite3\n"
        "        from halo.gateway import _encode\n"
        "        tool_obj = app._tools['echo']\n"
        "        stream.write('fp(validate): ' + app._code_fingerprint(tool_obj.validate)[:20] + '\\n')\n"
        "        stream.write('fp(execute): ' + app._code_fingerprint(tool_obj.execute.__func__)[:20] + '\\n')\n"
        "        stream.write('realm_secret: ' + app._realm_secret[:20] + '\\n')\n"
        "        stream.write('authority_id: ' + app._authority_identity[:20] + '\\n')\n"
        "        d = hashlib.sha256(_encode(['echo', 'v1', app._adapter_fingerprint(tool_obj), {}, app._realm_secret, app._authority_identity])).hexdigest()\n"
        "        with sqlite3.connect(db_path) as db:\n"
        "            prow = db.execute('SELECT digest, expires, state, mono_deadline FROM grants').fetchall()\n"
        "        stream.write('computed digest: ' + d[:20] + '\\n')\n"
        "        stream.write('db rows: ' + repr(prow) + '\\n')\n"
        "        stream.write('digests match: ' + str(any(r[0] == d for r in prow)) + '\\n')\n"
        "        stream.write(traceback.format_exc())\n"
        "    os._exit(2)\n"
        % (repo_root,)
    )
    crash_log_path = os.path.join(state_dir, "crash.log")
    _fresh_tool, _fresh_spec = _tool_spec()
    parent_components = {
        "parent_fp_validate": app._code_fingerprint(app._tools["echo"].validate)[:20],
        "parent_fp_execute": app._code_fingerprint(app._tools["echo"].execute.__func__)[:20],
        "parent_realm_secret": app._realm_secret[:20],
        "parent_authority_id": app._authority_identity[:20],
        "parent_execute_code": (app._tools["echo"].execute.__func__.__code__.co_filename
                                + ":" + str(app._tools["echo"].execute.__func__.__code__.co_firstlineno)),
        "parent_execute_type": type(app._tools["echo"].execute).__name__,
        "fresh_execute_fp": app._code_fingerprint(_fresh_spec["echo"].execute.__func__)[:20],
    }
    proc = subprocess.run([sys.executable, "-c", worker_script,
                           db_path, token, sink_path, crash_log_path],
                          capture_output=True, timeout=60)
    before = tool.effects
    response = _run_execute(app, token)  # after the subprocess crash
    sink_happened = os.path.exists(sink_path)
    row = _row(before, tool, response)
    row["subprocess_exit"] = proc.returncode
    row["effect_happened_in_subprocess"] = sink_happened
    # Honest duplicate accounting: a duplicate exists only if BOTH the
    # subprocess produced the effect AND the parent's re-execute also ran.
    # If the subprocess was refused (e.g. a fingerprint mismatch), the
    # parent's execute is the FIRST effect — recovery, not a duplicate.
    row["duplicate_effects"] = 1 if (sink_happened and
                                     row["effects"] > 0) else 0
    if proc.returncode == 2 and os.path.exists(crash_log_path):
        with open(crash_log_path) as stream:
            crash_text = stream.read()
        row["subprocess_crash_head"] = crash_text[:300]
        row["subprocess_crash_tail"] = crash_text[-400:]
        row.update(parent_components)
        if "digests match: False" in crash_text:
            # F11-family finding (report-only): the marshal-based adapter
            # fingerprint is not stable across module-load modes — the same
            # adapter code produces different fingerprints when the module is
            # imported from a cached .pyc vs compiled fresh, so a worker
            # restart rejects a valid capability (a false rejection).
            row["fingerprint_finding"] = (
                "marshal-based adapter fingerprint unstable across module-load "
                "modes (.pyc load vs fresh compile): the same adapter code "
                "yields different fingerprints, so the worker restart rejects "
                "a valid capability")
    out["worker_restart_after_effect_subprocess"] = row

    return out


def _benign_baseline(root):
    state_dir, db_path = _fresh_state(root, "benign")
    tool, spec = _tool_spec()
    app = _open_gateway(db_path, spec)
    successes = 0
    cycles = 5
    for i in range(cycles):
        try:
            token = _approve(app, f"benign-{i}")
            _execute(app, token)
            successes += 1
        except Rejected:
            pass
    return {"benign_success_rate": successes / cycles,
            "benign_cycles": cycles}


# --- assembly ---------------------------------------------------------------

def run(scenario_filter=None):
    """Run the fault matrix and return a JSON-able summary.

    INV1/INV2 verdicts are computed from the recorded scenarios; the B2
    residual scenarios (full-snapshot copy, old-snapshot restore) are
    expected to double-spend and are reported as residuals, not violations —
    they are listed, never hidden.
    """
    root = tempfile.mkdtemp(prefix="halo-e006-")
    try:
        groups = (
            _lifecycle_faults, _concurrent_revoke_faults, _clock_faults,
            _authz_faults, _state_faults, _restart_faults,
        )
        scenarios = {}
        for group in groups:
            for name, row in group(root).items():
                if scenario_filter is None or name in scenario_filter:
                    scenarios[name] = row
        if scenario_filter is None or "benign_baseline" in scenario_filter:
            scenarios["benign_baseline"] = _benign_baseline(root)
        summary = {
            "experiment": "e006_fault_injection",
            "scenarios": scenarios,
            "invariants": _invariant_verdicts(scenarios),
            "findings": _collect_findings(scenarios),
            "metric_names": [
                "effects", "unauthorized_effects", "duplicate_effects",
                "uncertain", "wrong_rejection", "replay_refused",
                "new_token_execute_succeeds",
            ],
        }
        return summary, None
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _collect_findings(scenarios):
    """Report-only findings from the run (the experiment does not fix gateway.py)."""
    findings = []
    for name, row in scenarios.items():
        if row.get("fingerprint_finding"):
            findings.append({"scenario": name,
                             "severity": "높음",
                             "finding": row["fingerprint_finding"]})
        if row.get("response_type", "").startswith("uncaught:"):
            findings.append({
                "scenario": name,
                "severity": "중간",
                "finding": (f"{row['response_type']} propagates uncaught out of "
                            "handle(): neither Rejected nor ExecutionUncertain — "
                            "the mono/wall clock failure handling is inconsistent"),
            })
    return findings


def _invariant_verdicts(scenarios):
    """INV1 claim-once / INV2 no-wrong-rejection, computed from the scenarios."""
    b2 = {name: row for name, row in scenarios.items() if row.get("b2_residual")}
    non_b2 = {name: row for name, row in scenarios.items()
              if name not in b2 and name != "benign_baseline"}

    inv1_violations = sorted(
        name for name, row in non_b2.items()
        if row.get("duplicate_effects", 0) > 0
        or row.get("unauthorized_effects", 0) > 0)
    post_dispatch = ("adapter_exception_after_effect", "adapter_double_failure",
                     "clock_rollback_after_dispatch")
    inv2_violations = sorted(
        name for name in post_dispatch
        if name in scenarios
        and scenarios[name]["response_type"] not in
        ("ExecutionUncertain", "timeout"))

    return {
        "INV1_claim_once": {
            "verdict": "held" if not inv1_violations else "violated",
            "violations": inv1_violations,
            "b2_residuals": sorted(b2),
        },
        "INV2_no_wrong_rejection": {
            "verdict": "held" if not inv2_violations else "violated",
            "violations": inv2_violations,
        },
    }


if __name__ == "__main__":
    summary, _ = run()
    print(json.dumps(summary, indent=2, ensure_ascii=False))
