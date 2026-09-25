#!/usr/bin/env python3
"""HALO doctor + verify: 단일 검증 진입점 (리뷰 문서 개선 #5).

doctor(diagnose)는 환경·증거 레지스트리·state 권한·결과 유무·toolchain을
설명 가능한 출력으로 보여준다. verify는 스코프의 테스트와 증거 레지스트리를
실행하고 **테스트 통과와 보안 gate 결과를 별개의 결과로** 게시한다 (저장소의
기존 규율: "runner 자체 테스트의 성공과 security_gate=false를 별개의 결과로
게시한다"). 환경 미설치는 실패가 아니라 not-installed로 보고한다 (저장소
선례: "환경 미설치를 Rust 코드 실패로 세지 않았다").

fail-closed: launch 오류·timeout·알 수 없는 스코프·실패한 검사는 통과로
통과되지 않는다. 검사 결과의 ok는 False일 때만 실패고, None(정보/not-installed)
은 실패로 세지 않는다.

exit code:
- 0: 요청한 검사가 전부 통과 (또는 not-installed/정보).
     보안 gate 결과는 별개 줄로 게시되고 exit에 합산되지 않는다.
- 1: 검사 하나라도 실패.
- 2: 사용 오류 (알 수 없는 스코프 등).

이 모듈은 저장소 상태에 대해 읽기 전용이다 (pytest/cargo subprocess 제외).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCOPES = ("python", "rust", "sandbox", "all")

# gateway DB가 요구하는 스키마 (halo/gateway.py의 CREATE TABLE + _migrate)
EXPECTED_SCHEMA = {
    "meta": {"key", "value"},
    "grants": {"token", "digest", "expires", "state", "mono_deadline"},
    "audit": {"seq", "time", "operation", "phase", "digest", "intent"},
}


# --- check runner -----------------------------------------------------------

def run_check(name, command, root=None, env=None):
    """명령을 root에서 실행하고 결과를 설명과 함께 반환한다 (fail-closed).

    launch 오류와 timeout은 예외로 통과시키지 않고 ok=False, returncode=None
    으로 반환한다. output에는 stdout과 stderr가 모두 들어간다. env가 None이면
    현재 프로세스 환경을 그대로 물려받는다(subprocess.run 기본 동작).
    """
    try:
        proc = subprocess.run(command, cwd=str(root) if root is not None else None,
                              capture_output=True, text=True, timeout=600, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"name": name, "ok": False, "returncode": None,
                "output": f"launch failed: {type(exc).__name__}"}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"name": name, "ok": proc.returncode == 0,
            "returncode": proc.returncode, "output": output}


# --- diagnose (doctor) ------------------------------------------------------

def _python_check(root):
    interpreter = sys.version.split()[0]
    ok = sys.version_info >= (3, 11)
    venv = Path(root) / ".venv"
    output = (f"python {interpreter} (권장 3.11+); .venv "
              f"{'있음' if venv.is_dir() else '없음 (정보성)'}")
    return {"name": "python", "ok": ok, "returncode": None, "output": output}


def _evidence_check(root):
    """증거 레지스트리 검사: 검사기를 항상 실행한다 (fail-closed).

    레지스트리 부재·malformed·stale은 검사기가 보고한다 — doctor가 미리
    판정하지 않는다. 검사기가 없는 저장소는 launch 실패로 ok=False다.
    """
    root = Path(root)
    registry = root / "docs" / "reviews" / "evidence_registry.json"
    checker = root / "tools" / "check_evidence_registry.py"
    result = run_check("evidence",
                       [sys.executable, str(checker), "--registry", str(registry),
                        "--repo-root", str(root)], root)
    lines = (result["output"] or "").strip().splitlines()
    summary_line = next((line for line in lines if line.startswith("요약")),
                        (result["output"] or "증거 레지스트리 검사기 없음")[:120])
    return {"name": "evidence", "ok": result["ok"],
            "returncode": result.get("returncode"), "output": summary_line}


def _state_dir_check(root):
    state_dir = os.environ.get("HALO_STATE_DIR")
    if state_dir is None:
        return {"name": "HALO_STATE_DIR", "ok": None, "returncode": None,
                "output": "미설정 — gateway는 기본 state 위치를 쓴다; 운영 배포 시 "
                          "0700 디렉터리로 설정해야 한다"}
    path = Path(state_dir)
    if not path.is_dir():
        return {"name": "HALO_STATE_DIR", "ok": False, "returncode": None,
                "output": f"{state_dir} — 디렉터리가 존재하지 않는다"}
    mode = path.stat().st_mode & 0o777
    ok = mode == 0o700
    return {"name": "HALO_STATE_DIR", "ok": ok, "returncode": None,
            "output": f"{state_dir} — mode {oct(mode)} "
                      f"({'0700 요구 충족' if ok else '0700 요구 미충족'})"}


def _results_check(root):
    root = Path(root)
    experiments = root / "experiments"
    present = sorted(d.parent.name for d in experiments.glob("*/results")
                     if d.is_dir())
    return {"name": "experiment-results", "ok": len(present) > 0,
            "returncode": None,
            "output": f"{len(present)}개 실험의 results/ 존재: "
                      f"{', '.join(present) or '(없음)'}"}


def _rust_check(root):
    root = Path(root)
    cargo = root / ".venv" / "cargo" / "bin" / "cargo"
    if not cargo.is_file():
        return {"name": "rust-toolchain", "ok": None, "returncode": None,
                "output": "not-installed — 환경 미설치는 코드 실패가 아니다 "
                          "(저장소 선례); .venv/cargo 또는 PATH의 cargo로 검증 가능"}
    return {"name": "rust-toolchain", "ok": True, "returncode": None,
            "output": f"{cargo} 존재"}


def diagnose(root=None):
    """환경·증거·상태를 검사하고 {"ok", "checks"} 보고서를 반환한다.

    검사 순서: python → evidence(레지스트리) → state dir → results → rust.
    증거 레지스트리는 두 번째 검사다 — 판정과 근거의 연결이 환경 검사만큼
    기본이라는 뜻이다.
    """
    root = Path(root) if root is not None else REPO_ROOT
    checks = [
        _python_check(root),
        _evidence_check(root),
        _state_dir_check(root),
        _results_check(root),
        _rust_check(root),
    ]
    ok = all(check["ok"] is not False for check in checks)
    return {"ok": ok, "checks": checks}


def print_diagnose(report):
    print("=== halo doctor ===")
    for check in report["checks"]:
        if check["ok"] is True:
            state = "통과"
        elif check["ok"] is False:
            state = "실패"
        else:
            state = "정보"
        print(f"  [{state}] {check['name']}: {check['output']}")
    failed = [c["name"] for c in report["checks"] if c["ok"] is False]
    print()
    print(f"요약: {len(report['checks'])}개 검사 — 실패 {len(failed)}개"
          + (f": {', '.join(failed)}" if failed else " — 전부 통과 또는 정보"))


# --- verify -----------------------------------------------------------------

def _pytest_check(root):
    return run_check("pytest", [sys.executable, "-m", "pytest", "-q"], root)


def _report_security_gate(label, command, cwd=None):
    """보안 gate 결과를 계산해 반환한다 (테스트 결과와 별개, ok가 아니어도 테스트
    실패가 아니다). 출력하지 않는다 — print_verify가 --json과 분리해 게시한다."""
    if command is None:
        return {"label": label, "ok": None, "detail": "not built"}
    try:
        proc = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                              timeout=600)
        gate_false = proc.returncode != 0
        return {"label": label, "ok": not gate_false,
                "detail": f"exit {proc.returncode}"}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"label": label, "ok": None, "detail": str(exc)}


def verify(root=None, scope="python"):
    """스코프의 테스트 + 증거 레지스트리를 실행하고 {"ok", "checks",
    "security_gates"} 보고서를 반환한다. 출력하지 않는다(diagnose처럼 순수
    계산) — 호출자(main)가 print_verify 또는 json.dumps로 게시 형식을
    고른다. 기본 스코프(python)는 pytest와 증거 레지스트리 두 검사다.
    rust/sandbox는 확장 검사이고, 보안 gate는 항상 검사 결과와 별개다.
    """
    root = Path(root) if root is not None else REPO_ROOT
    if scope not in SCOPES:
        raise ValueError(f"알 수 없는 스코프 {scope!r} — 유효한 스코프: {', '.join(SCOPES)}")

    checks = []
    if scope in ("python", "all"):
        checks.append(_pytest_check(root))
    # 증거 레지스트리는 모든 스코프에서 실행한다 — 판정과 근거의 연결이
    # 테스트만큼 기본이다.
    checks.append(_evidence_check(root))
    if scope in ("rust", "all"):
        cargo = root / ".venv" / "cargo" / "bin" / "cargo"
        if not cargo.is_file():
            checks.append({"name": "rust-tests", "ok": None, "returncode": None,
                           "output": "not installed"})
        else:
            env = dict(os.environ, RUSTUP_HOME=str(root / ".venv" / "rustup"),
                       CARGO_HOME=str(root / ".venv" / "cargo"))
            checks.append(run_check("rust-tests",
                                    [str(cargo), "test", "--locked",
                                     "--manifest-path", "rust/Cargo.toml"], root, env=env))
    if scope in ("sandbox", "all"):
        runner_manifest = root / "artifacts" / "sandbox_benchmark" / "rust_runner" / "Cargo.toml"
        cargo = root / ".venv" / "cargo" / "bin" / "cargo"
        if not runner_manifest.is_file():
            checks.append({"name": "sandbox-tests", "ok": None, "returncode": None,
                           "output": "runner manifest missing"})
        elif not cargo.is_file():
            checks.append({"name": "sandbox-tests", "ok": None, "returncode": None,
                           "output": "not installed"})
        else:
            env = dict(os.environ, RUSTUP_HOME=str(root / ".venv" / "rustup"),
                       CARGO_HOME=str(root / ".venv" / "cargo"))
            checks.append(run_check("sandbox-tests",
                                    [str(cargo), "test", "--locked",
                                     "--manifest-path",
                                     str(runner_manifest.relative_to(root))], root, env=env))

    gates = []
    runner_bin = (root / "artifacts" / "sandbox_benchmark" / "rust_runner"
                  / "target" / "debug" / "halo-sandbox-runner")
    if scope in ("sandbox", "all"):
        # Always emit a gate row for a requested sandbox scope, even when the
        # runner binary is not built — an absent gates entry is indistinguishable
        # from "checked and fine", contradicting this module's own not-installed
        # reporting convention (see rust-tests/sandbox-tests above).
        gates.append(_report_security_gate(
            "macOS 샌드박스 security_gate",
            [str(runner_bin), "--repeats", "1"] if runner_bin.is_file() else None,
            cwd=str(root)))

    ok = all(check["ok"] is not False for check in checks)
    return {"ok": ok, "checks": checks, "security_gates": gates}


def print_verify(report):
    checks = report["checks"]
    for check in checks:
        state = "통과" if check["ok"] is True else ("실패" if check["ok"] is False else "정보")
        detail = (check.get("output") or "").strip().splitlines()
        summary = detail[-1] if detail else check.get("output", "")
        print(f"  [{state}] {check['name']}: {summary}")
    failed = [c["name"] for c in checks if c["ok"] is False]
    print()
    print(f"테스트 요약: {len(checks)}개 — 실패 {len(failed)}개"
          + (f": {', '.join(failed)}" if failed else " — 전부 통과 또는 not-installed"))
    for gate in report["security_gates"]:
        state = "실패 gate" if gate["ok"] is False else ("통과" if gate["ok"] else "미빌드")
        print(f"보안 gate (별개): {gate['label']} — {state}")
    print("보안 gate는 테스트 결과와 별개다 — gate 실패는 운영 준비도 항목이지 "
          "테스트 실패가 아니다.")


# --- CLI --------------------------------------------------------------------

def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="HALO doctor + verify 진입점")
    sub = parser.add_subparsers(dest="command")
    doctor_parser = sub.add_parser("doctor", help="환경·증거·상태 검사")
    doctor_parser.add_argument("--json", action="store_true",
                               help="보고서를 JSON으로 출력한다")
    doctor_parser.add_argument("--root", default=None,
                               help="저장소 루트 (기본값: 이 모듈 기준)")
    verify_parser = sub.add_parser("verify", help="스코프별 테스트 + 보안 gate")
    verify_parser.add_argument("--scope", default="python",
                               help="python|rust|sandbox|all")
    verify_parser.add_argument("--json", action="store_true",
                               help="보고서를 JSON으로 출력한다")
    verify_parser.add_argument("--root", default=None,
                               help="저장소 루트 (기본값: 이 모듈 기준)")
    args = parser.parse_args(argv)

    if args.command == "doctor":
        report = diagnose() if args.root is None else diagnose(args.root)
        if args.json:
            print(json.dumps(report, ensure_ascii=False))
        else:
            print_diagnose(report)
        return 0 if report["ok"] else 1
    if args.command == "verify":
        try:
            report = verify(args.root, scope=args.scope)
        except ValueError as exc:
            print(f"증거 검증 오류: {exc}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(report, ensure_ascii=False))
        else:
            print_verify(report)
        return 0 if report["ok"] else 1
    # 서브커맨드 없으면 doctor를 기본 실행한다 (신입 기여자의 최초 진입점).
    report = diagnose()
    print_diagnose(report)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
