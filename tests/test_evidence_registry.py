"""증거 레지스트리 체커(tools/check_evidence_registry.py)의 fail-closed 동작 검사.

- valid 항목 → exit 0
- 해시가 바뀐 항목 → stale → exit 1 (발행 상태 소멸의 탐지)
- 파일이 없는 항목 → failed → exit 1
- 스키마 오류·레지스트리 부재 → exit 1 (fail-closed)
- unsupported 항목은 절대 블록하지 않는다
- 체커는 읽기 전용이다
- 시딩된 레지스트리는 검수 문서의 fingerprint 표를 그대로 보관한다
"""

import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECKER_PATH = REPO_ROOT / "tools" / "check_evidence_registry.py"
SEEDED_REGISTRY = REPO_ROOT / "docs" / "reviews" / "evidence_registry.json"
REVIEW_DOC = REPO_ROOT / "docs" / "reviews" / "2026-09-21-review.ko.md"
ERROR_PREFIX = "증거 레지스트리 오류"


@pytest.fixture(scope="module")
def checker_module():
    spec = importlib.util.spec_from_file_location("check_evidence_registry", CHECKER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_checker(registry_path, repo_root):
    """체커를 서브프로세스로 실행한다. --repo-root를 명시하므로 cwd와 무관하게 동작한다."""
    return subprocess.run(
        [
            sys.executable,
            str(CHECKER_PATH),
            "--registry",
            str(registry_path),
            "--repo-root",
            str(repo_root),
        ],
        capture_output=True,
        text=True,
    )


def parse_summary(stdout):
    """출력에서 JSON 요약 블록(첫 '{'로 시작하는 줄부터)을 파싱한다."""
    lines = stdout.splitlines()
    for position, line in enumerate(lines):
        if line.startswith("{"):
            return json.loads("\n".join(lines[position:]))
    raise AssertionError(f"JSON 요약이 출력에 없다: {stdout!r}")


def make_file(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = content if isinstance(content, bytes) else content.encode("utf-8")
    path.write_bytes(payload)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_entry(files, claim="테스트 주장", verdict="valid", **extra):
    entry = {
        "claim": claim,
        "recorded_fingerprints": files,
        "threat_model_scope": "테스트 범위",
        "verification_command": "true",
        "result_summary": "테스트",
        "verdict": verdict,
    }
    entry.update(extra)
    return entry


def write_registry(tmp_path, entries, **top_level):
    data = {"registry": "fixture", "schema_version": 1, "entries": entries}
    data.update(top_level)
    path = tmp_path / "registry.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 정상 동작
# ---------------------------------------------------------------------------


def test_valid_entry_exits_zero(tmp_path):
    digest = make_file(tmp_path / "src" / "module.py", "value = 1\n")
    registry = write_registry(tmp_path, [make_entry({"src/module.py": digest})])
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["ok"] is True
    assert summary["counts"]["valid"] == 1
    assert summary["counts"]["stale"] == 0
    entry = summary["entries"][0]
    assert entry["verdict"] == "valid"
    assert entry["stale_files"] == []
    assert entry["missing_files"] == []


def test_default_registry_path_and_repo_root_resolve_from_script(tmp_path):
    """인자 없이 실행하면 스크립트 위치 기준으로 실제 레지스트리를 읽는다 (cwd와 무관)."""
    proc = subprocess.run(
        [sys.executable, str(CHECKER_PATH)],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
    )
    assert proc.returncode in (0, 1)
    assert ERROR_PREFIX not in proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["total"] >= 4


# ---------------------------------------------------------------------------
# stale — 발행 상태 소멸의 탐지 (수용 조건)
# ---------------------------------------------------------------------------


def test_hash_change_marks_stale_and_blocks(tmp_path):
    digest = make_file(tmp_path / "src" / "module.py", "value = 1\n")
    registry = write_registry(tmp_path, [make_entry({"src/module.py": digest})])
    make_file(tmp_path / "src" / "module.py", "value = 2\n")  # 소스 변경 → 발행 상태 소멸
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 1
    summary = parse_summary(proc.stdout)
    assert summary["ok"] is False
    entry = summary["entries"][0]
    assert entry["verdict"] == "stale"
    assert entry["recorded_verdict"] == "valid"
    assert entry["stale_files"] == ["src/module.py"]
    assert summary["blocked_entries"] == [
        {
            "index": 0,
            "claim": "테스트 주장",
            "verdict": "stale",
            "stale_files": ["src/module.py"],
            "missing_files": [],
        }
    ]
    assert "src/module.py" in proc.stdout


def test_mixed_valid_and_stale_blocks_with_affected_entries_listed(tmp_path):
    good_digest = make_file(tmp_path / "src" / "kept.py", "value = 1\n")
    drift_digest = make_file(tmp_path / "src" / "drifted.py", "value = 1\n")
    registry = write_registry(
        tmp_path,
        [
            make_entry({"src/kept.py": good_digest}, claim="현재 검증"),
            make_entry({"src/drifted.py": drift_digest}, claim="과거 판정"),
        ],
    )
    make_file(tmp_path / "src" / "drifted.py", "value = 2\n")
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 1
    summary = parse_summary(proc.stdout)
    assert [item["index"] for item in summary["blocked_entries"]] == [1]
    assert summary["counts"]["valid"] == 1
    assert summary["counts"]["stale"] == 1


# ---------------------------------------------------------------------------
# failed — 근거 원자료 유실
# ---------------------------------------------------------------------------


def test_missing_file_marks_failed_and_blocks(tmp_path):
    digest = make_file(tmp_path / "src" / "kept.py", "value = 1\n")
    registry = write_registry(
        tmp_path,
        [make_entry({"src/kept.py": digest, "src/lost.py": "0" * 64})],
    )
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 1
    summary = parse_summary(proc.stdout)
    entry = summary["entries"][0]
    assert entry["verdict"] == "failed"
    assert entry["missing_files"] == ["src/lost.py"]
    assert summary["blocked_entries"][0]["verdict"] == "failed"


def test_missing_file_takes_precedence_over_hash_drift(tmp_path):
    registry = write_registry(
        tmp_path,
        [make_entry({"src/lost.py": "0" * 64, "src/drifted.py": "1" * 64})],
    )
    make_file(tmp_path / "src" / "drifted.py", "value = 2\n")
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 1
    summary = parse_summary(proc.stdout)
    assert summary["entries"][0]["verdict"] == "failed"


# ---------------------------------------------------------------------------
# unsupported — 연구 한계·과거 기록은 절대 블록하지 않는다
# ---------------------------------------------------------------------------


def test_unsupported_entry_never_blocks_even_with_hash_drift(tmp_path):
    digest = make_file(tmp_path / "artifacts" / "results.json", '{"old": true}\n')
    registry = write_registry(
        tmp_path,
        [make_entry({"artifacts/results.json": digest}, verdict="unsupported")],
    )
    make_file(tmp_path / "artifacts" / "results.json", '{"new": true}\n')
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["ok"] is True
    entry = summary["entries"][0]
    assert entry["verdict"] == "unsupported"
    assert entry["stale_files"] == ["artifacts/results.json"]
    assert summary["blocked_entries"] == []


def test_unsupported_entry_with_missing_file_never_blocks(tmp_path):
    registry = write_registry(
        tmp_path,
        [make_entry({"artifacts/gone.json": "0" * 64}, verdict="unsupported")],
    )
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["entries"][0]["verdict"] == "unsupported"
    assert summary["entries"][0]["missing_files"] == ["artifacts/gone.json"]


def test_unsupported_entry_with_empty_fingerprints_is_allowed(tmp_path):
    registry = write_registry(tmp_path, [make_entry({}, verdict="unsupported")])
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["counts"]["unsupported"] == 1


def test_mixed_valid_and_unsupported_exits_zero(tmp_path):
    digest = make_file(tmp_path / "src" / "module.py", "value = 1\n")
    registry = write_registry(
        tmp_path,
        [
            make_entry({"src/module.py": digest}, claim="현재 검증"),
            make_entry({}, claim="과거 기록", verdict="unsupported"),
        ],
    )
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["counts"] == {"valid": 1, "stale": 0, "failed": 0, "unsupported": 1}


# ---------------------------------------------------------------------------
# fail-closed — 결론을 유보할 수 없는 레지스트리는 막는다
# ---------------------------------------------------------------------------

MALFORMED_CASES = [
    ("json_parsing_failure", "{ 이것은 JSON이 아니다"),
    ("top_level_is_array", [make_entry({"a.py": "0" * 64})]),
    ("top_level_is_string", '"레지스트리"'),
    ("entries_key_missing", {"registry": "fixture"}),
    ("entries_not_a_list", {"entries": {"0": make_entry({})}}),
    ("entries_empty", {"entries": []}),
    ("entry_not_an_object", {"entries": ["문자열 항목"]}),
    ("claim_missing", {"entries": [{"recorded_fingerprints": {}, "verdict": "unsupported"}]}),
    ("claim_empty", {"entries": [make_entry({}, claim="  ")]}),
    (
        "recorded_fingerprints_missing",
        {"entries": [{"claim": "주장", "verdict": "unsupported"}]},
    ),
    (
        "recorded_fingerprints_not_an_object",
        {"entries": [{"claim": "주장", "recorded_fingerprints": ["a.py"], "verdict": "unsupported"}]},
    ),
    (
        "verdict_missing",
        {"entries": [{"claim": "주장", "recorded_fingerprints": {}}]},
    ),
    (
        "verdict_outside_enum",
        {"entries": [make_entry({"a.py": "0" * 64}, verdict="passing")]},
    ),
    (
        "fingerprint_truncated_to_63_chars",
        {"entries": [make_entry({"a.py": "0" * 63})]},
    ),
    (
        "fingerprint_not_hex",
        {"entries": [make_entry({"a.py": "z" * 64})]},
    ),
    (
        "unknown_field_in_entry",
        {"entries": [make_entry({"a.py": "0" * 64}, extra_field="x")]},
    ),
    (
        "valid_entry_without_attached_state",
        {"entries": [make_entry({}, claim="첨부 상태 없는 valid")]},
    ),
]


@pytest.mark.parametrize(
    "name,payload",
    MALFORMED_CASES,
    ids=[name for name, _ in MALFORMED_CASES],
)
def test_malformed_registry_fails_closed(tmp_path, name, payload):
    path = tmp_path / "registry.json"
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    proc = run_checker(path, tmp_path)
    assert proc.returncode == 1, proc.stdout
    assert ERROR_PREFIX in proc.stderr
    assert proc.stdout == ""


def test_missing_registry_file_fails_closed(tmp_path):
    proc = run_checker(tmp_path / "absent.json", tmp_path)
    assert proc.returncode == 1
    assert ERROR_PREFIX in proc.stderr
    assert "읽을 수 없다" in proc.stderr


# ---------------------------------------------------------------------------
# 읽기 전용
# ---------------------------------------------------------------------------


def test_checker_is_read_only(tmp_path):
    digest = make_file(tmp_path / "src" / "module.py", "value = 1\n")
    registry = write_registry(tmp_path, [make_entry({"src/module.py": digest})])

    def snapshot():
        return sorted(
            (str(p.relative_to(tmp_path)), p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in tmp_path.rglob("*")
            if p.is_file()
        )

    before = snapshot()
    proc = run_checker(registry, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert snapshot() == before


# ---------------------------------------------------------------------------
# 단위 수준 판정 규칙
# ---------------------------------------------------------------------------


def test_compute_verdict_unit_rules(checker_module):
    entry = make_entry({"a.py": "0" * 64})
    current = {"a.py": {"status": "ok", "recorded": "0" * 64, "current": "0" * 64, "match": True}}
    drifted = {"a.py": {"status": "ok", "recorded": "0" * 64, "current": "1" * 64, "match": False}}
    missing = {"a.py": {"status": "missing", "recorded": "0" * 64, "current": None, "match": False}}
    assert checker_module.compute_verdict(entry, current) == "valid"
    assert checker_module.compute_verdict(entry, drifted) == "stale"
    assert checker_module.compute_verdict(entry, missing) == "failed"
    stale_marked = make_entry({"a.py": "0" * 64}, verdict="stale")
    assert checker_module.compute_verdict(stale_marked, drifted) == "stale"
    unsupported = make_entry({"a.py": "0" * 64}, verdict="unsupported")
    assert checker_module.compute_verdict(unsupported, missing) == "unsupported"


def test_validate_entry_accepts_task_shape(checker_module):
    entry = {
        "claim": "현재 Python 회귀 260 통과 / 0 실패",
        "source_doc": "docs/reviews/2026-09-21-review.ko.md",
        "recorded_fingerprints": {"halo/gateway.py": "9553e299a0c362f0d4bfde7462a322dd8c85cc765b91e49528fe2e4e097a1743"},
        "threat_model_scope": "로컬 저장소 회귀",
        "verification_command": ".venv/bin/python -m pytest -q",
        "result_summary": "260 passed / 0 failed",
        "verdict": "valid",
    }
    assert checker_module.validate_entry(entry, 0) is entry


# ---------------------------------------------------------------------------
# 시딩된 레지스트리의 구조와 검수 문서 fingerprint 보관
# ---------------------------------------------------------------------------


def test_seeded_registry_preserves_review_doc_fingerprints(checker_module):
    """검수 문서의 fingerprint 표(수정 전 해시)를 레지스트리에 그대로 복사했는지 검사한다."""
    table = {}
    for line in REVIEW_DOC.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\| `([^`]+)` \| `([0-9a-f]{64})` \|$", line)
        if match:
            table[match.group(1)] = match.group(2)
    assert len(table) == 4

    data = json.loads(SEEDED_REGISTRY.read_text(encoding="utf-8"))
    review_entries = [
        entry
        for entry in data["entries"]
        if entry.get("source_doc") == "docs/reviews/2026-09-21-review.ko.md"
    ]
    assert len(review_entries) == 1
    assert review_entries[0]["recorded_fingerprints"] == table
    # 검수 문서의 스냅샷은 현재 트리의 수정보다 앞서므로 stale 기록이 맞다.
    assert review_entries[0]["verdict"] == "stale"


def test_seeded_registry_entries_are_well_formed(checker_module):
    data = json.loads(SEEDED_REGISTRY.read_text(encoding="utf-8"))
    assert isinstance(data.get("entries"), list) and data["entries"]
    for index, entry in enumerate(data["entries"]):
        checker_module.validate_entry(entry, index)  # 스키마 오류 시 예외
    claims = [entry["claim"] for entry in data["entries"]]
    assert any("260" in claim for claim in claims)
    assert any("E001-B" in claim and "E002" in claim for claim in claims)
    assert any("샌드박스" in claim for claim in claims)


def test_real_registry_check_runs_fail_closed_without_crashing():
    """실제 레지스트리 검사는 통과(0) 또는 정직한 차단(1)이며 크래시하지 않는다.

    동시 패치로 해시가 바뀌면 exit 1이 맞다 — 이 검사는 크래시와
    스키마 오류만 잡는다.
    """
    proc = run_checker(SEEDED_REGISTRY, REPO_ROOT)
    assert proc.returncode in (0, 1)
    assert ERROR_PREFIX not in proc.stderr
    summary = parse_summary(proc.stdout)
    assert summary["total"] >= 4
    assert summary["ok"] == (
        summary["counts"]["stale"] == 0 and summary["counts"]["failed"] == 0
    )
