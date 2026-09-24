"""E006 invariants as pytest tests: claim-once and no-wrong-rejection.

INV2 uses exact-type classification: halo.gateway.ExecutionUncertain extends
Rejected, so a post-dispatch failure surfaced as a PLAIN Rejected is a wrong
rejection; exact ExecutionUncertain is the documented contract.
"""
from __future__ import annotations

import sqlite3

import pytest

from halo.gateway import ExecutionUncertain, Gateway, Rejected, Tool

from experiments.e006_fault_injection.experiment import (
    APPROVER,
    EXECUTOR,
    ManualClock,
    _approve,
    _execute,
    _fresh_state,
    _open_gateway,
    _run_execute,
    _tool_spec,
)


def _echo_app(tmp_path, *, raise_before=False, raise_after=False, clock=None,
              tolerance=None):
    tool, spec = _tool_spec(raise_before=raise_before, raise_after=raise_after)
    _, db_path = _fresh_state(str(tmp_path), "g")
    app = _open_gateway(db_path, spec, clock=clock, tolerance=tolerance)
    # NOTE: a restarted Gateway must reuse the SAME spec (the same validate/
    # execute code objects) — a fresh lambda's fingerprint differs (marshal
    # includes the code object), so the digest check would reject the grant.
    return tool, app, db_path, spec


def test_claim_once_survives_worker_restart(tmp_path):
    tool, app, db_path, spec = _echo_app(tmp_path)
    token = _approve(app, "restart-before")
    restarted = Gateway(db_path, APPROVER, EXECUTOR, spec)
    _execute(restarted, token)
    assert tool.effects == 1  # 한 토큰의 효과가 최대 1회
    with pytest.raises(Rejected):
        _execute(restarted, token)
    assert tool.effects == 1


def test_claim_once_blocks_reexecution_after_completion(tmp_path):
    tool, app, db_path, spec = _echo_app(tmp_path)
    token = _approve(app, "restart-after")
    _execute(app, token)
    restarted = Gateway(db_path, APPROVER, EXECUTOR, spec)
    with pytest.raises(Rejected):
        _execute(restarted, token)
    assert tool.effects == 1  # 중복 효과 없음


def test_post_dispatch_adapter_failure_is_uncertain_not_rejected(tmp_path):
    tool, app, _, spec = _echo_app(tmp_path, raise_after=True)
    token = _approve(app, "ae-after")
    with pytest.raises(ExecutionUncertain) as excinfo:
        _execute(app, token)
    # exact type: not a plain Rejected (ExecutionUncertain extends Rejected)
    assert type(excinfo.value) is ExecutionUncertain
    assert tool.effects == 1  # 효과는 발생 — 클라이언트는 불확실 응답을 받아야 한다


def test_double_failure_still_uncertain(tmp_path):
    tool, app, _, spec = _echo_app(tmp_path, raise_after=True)
    token = _approve(app, "ae-double")
    with sqlite3.connect(app.path) as db:
        db.execute(
            "CREATE TRIGGER fail_uncertain_audit BEFORE INSERT ON audit "
            "WHEN NEW.phase='failed_or_uncertain' "
            "BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
    with pytest.raises(ExecutionUncertain) as excinfo:
        _execute(app, token)
    assert type(excinfo.value) is ExecutionUncertain
    assert tool.effects == 1


def test_post_dispatch_clock_rollback_is_uncertain_not_rejected(tmp_path):
    tool, _, _, _ = _echo_app(tmp_path)
    clock = ManualClock(wall=1000.0)
    _, db_path = _fresh_state(str(tmp_path), "ck2")

    class _RewindOnExecute:
        def __init__(self, inner, clock_obj):
            self._inner = inner
            self._clock = clock_obj

        def execute(self, args):
            self._clock.rewind(wall=100)
            return self._inner(args)

    spec = {"echo": Tool("v1", lambda a: True,
                         _RewindOnExecute(tool.execute, clock).execute)}
    app2 = _open_gateway(db_path, spec, clock=clock)
    token = _approve(app2, "ck-after")
    with pytest.raises(ExecutionUncertain) as excinfo:
        _execute(app2, token)
    assert type(excinfo.value) is ExecutionUncertain
    assert tool.effects == 1


def test_pre_dispatch_clock_rollback_is_rejected_without_effect(tmp_path):
    clock = ManualClock(wall=1000.0)
    tool, app, _, spec = _echo_app(tmp_path, clock=clock)
    token = _approve(app, "ck-before")
    clock.wall_value = 900.0  # rollback 100 below the approve-time watermark
    response = _run_execute(app, token)
    assert response == "Rejected"
    assert tool.effects == 0  # 효과 없음 — 사전 거부 (정확)


def test_db_only_copy_is_refused(tmp_path):
    import shutil

    tool, app, _, spec = _echo_app(tmp_path)
    _approve(app, "st-dbonly")
    fork_path = app.path + ".fork"
    shutil.copy2(app.path, fork_path)
    with pytest.raises(ValueError):
        Gateway(fork_path, APPROVER, EXECUTOR,
                {"echo": Tool("v1", lambda a: True, tool.execute)})


def test_forged_token_rejected_without_effect(tmp_path):
    tool, app, _, spec = _echo_app(tmp_path)
    response = _run_execute(app, "f" * 48 + "-not-a-real-token")
    assert response == "Rejected"
    assert tool.effects == 0  # 무승인 효과 없음


def test_full_suite_invariant_verdicts_hold():
    from experiments.e006_fault_injection.experiment import run

    summary, _ = run()
    invariants = summary["invariants"]
    assert invariants["INV1_claim_once"]["verdict"] == "held"
    assert invariants["INV2_no_wrong_rejection"]["verdict"] == "held"
    # B2 residuals must be listed, never hidden
    assert invariants["INV1_claim_once"]["b2_residuals"] == [
        "db_copy_full_snapshot", "db_restore_old_snapshot"]
