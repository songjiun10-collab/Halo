"""Read-only review probes, apart from disposable SQLite fixtures.

Run from the repository with .venv/bin/python docs/reviews/2026-09-21-probes.py.
Rust comparisons use the debug binary built by the documented Cargo checks.
This prints observations; it is not a passing-security-gate test suite.
"""
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np
from halo.gateway import Gateway, Tool
from halo.gateway_app import create_app
from halo.policy import decide
from halo.safety_cases import Event, evaluate_trace
from experiments.e003_verdict_freshness.experiment import run as freshness
from experiments.e004_robust_evaluation.experiment import run as robust_run
from experiments.e004_robust_evaluation.experiment import select_robust_threshold

A, E = "a" * 48, "e" * 48  # Synthetic test credentials only.
observations = {}


def observe(call):
    try:
        return call()
    except Exception as exc:
        return {"exception": type(exc).__name__, "message": str(exc)}


def approve(gateway):
    return gateway.handle("/approve", A, {"tool": "t", "args": {}, "intent_id": "review"})


with tempfile.TemporaryDirectory(prefix="halo-review-factory-") as directory:
    with patch.dict(os.environ, {"HALO_STATE_DIR": directory,
                                 "HALO_APPROVER_KEY": A, "HALO_EXECUTOR_KEY": E}):
        def start_factory():
            create_app()
            return {"started": True}
        observations["fresh_factory"] = observe(start_factory)

with tempfile.TemporaryDirectory(prefix="halo-review-clock-") as directory:
    gateway = Gateway(Path(directory) / "g.db", A, E,
                      {"t": Tool("1", lambda args: True, lambda args: {})},
                      clock=lambda: 1000.0, mono_clock=lambda: 100.0)
    grant = approve(gateway)
    with sqlite3.connect(gateway.path) as db:
        observations["stored_grant_columns"] = db.execute(
            "SELECT typeof(state),state,typeof(mono_deadline),mono_deadline FROM grants"
        ).fetchall()
    observations["constant_clock_execution"] = observe(lambda: gateway.handle(
        "/execute", E, {"tool": "t", "args": {}, "token": grant["token"]}))
    gateway._clock = lambda: 1001.0
    observations["advancing_clock_revoke"] = observe(lambda: gateway.handle(
        "/revoke", A, {"token": grant["token"]}))

with tempfile.TemporaryDirectory(prefix="halo-review-post-effect-") as directory:
    now, effects = [1000.0], []

    def execute(args):
        effects.append("committed")
        now[0] = 999.0
        return {"ok": True}

    gateway = Gateway(Path(directory) / "g.db", A, E,
                      {"t": Tool("1", lambda args: True, execute)},
                      clock=lambda: now[0], mono_clock=lambda: 100.0)
    grant = approve(gateway)
    raw = json.dumps({"tool": "t", "args": {}, "token": grant["token"]}).encode()
    statuses = []
    env = {"REQUEST_METHOD": "POST", "PATH_INFO": "/execute",
           "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": "application/json",
           "HTTP_AUTHORIZATION": "Bearer " + E, "wsgi.input": io.BytesIO(raw)}
    body = b"".join(gateway(env, lambda status, headers: statuses.append(status)))
    observations["isolated_post_effect_clock_rollback"] = {
        "fixture_corrected": False, "status": statuses[0],
        "body": json.loads(body), "effects": effects}


def adapter(args):
    return 1


changed = types.FunctionType(adapter.__code__.replace(co_consts=(None, 2)), globals())
observations["fingerprint_constants"] = {
    "before": adapter({}), "after": changed({}),
    "same_fingerprint": Gateway._code_fingerprint(adapter) == Gateway._code_fingerprint(changed)}

result = robust_run(seed=7, n=1000)
observations["python_shifted_robust"] = {
    share: {"attack_tpr": result["shifted"][share]["robust_constrained"].attack_tpr,
            "group_tpr": result["shifted"][share]["robust_constrained"].group_tpr}
    for share in ("0.00", "1.00")}
observations["infeasible_robust_floor"] = observe(lambda: select_robust_threshold(
    np.array([0.0]), {"hard": np.array([0.1])}, np.array([0.5]),
    max_fpr=0.0, min_worst_group_tpr=0.9, min_any_group_tpr=0.9))

config = {"seed": 3, "delay_steps": 3, "volatility": 0.5, "n": 1000, "freshness_window": 5}
_, diagnostic = freshness(**config)
keys = ("adaptive_window_size", "progressive_revalidation_count")
observations["python_freshness"] = {key: diagnostic[key] for key in keys}
binary = ROOT / "rust/target/debug/halo-experiments"
if binary.is_file():
    rust = json.loads(subprocess.check_output(
        [str(binary), "e003", "--json", json.dumps(config)], text=True, timeout=30))
    observations["rust_freshness"] = {key: rust["diagnostics"][key] for key in keys}
    rust = json.loads(subprocess.check_output(
        [str(binary), "e004", "--json", '{"seed":7,"n":1000}'], text=True, timeout=30))
    observations["rust_shifted_robust"] = {
        share: rust["shifted"][share]["robust_constrained"] for share in ("0.00", "1.00")}
else:
    observations["rust"] = "not run: build the current debug binary first"


def evaluate(event):
    findings = evaluate_trace([event])
    return {"decision": decide(findings, effectful=True).decision.value,
            "signals": [finding.signal.value for finding in findings]}


observations["malformed_action"] = evaluate(Event(kind="tool", action=42, effect=42))
observations["null_metadata"] = observe(lambda: evaluate(
    Event(kind="tool", action="read", metadata=None)))
for label, metadata in (("digest_only", {"sha256": "a" * 64}),
                        ("digest_and_equation", {"sha256": "a" * 64, "note": "x=1"})):
    observations[label] = evaluate(Event(kind="tool", action="upload", approved=True,
                                         declared_scope="external", target_scope="external",
                                         metadata=metadata))

print(json.dumps(observations, ensure_ascii=False, indent=2, allow_nan=False))
