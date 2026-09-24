#!/usr/bin/env python3
"""HALO 증거 레지스트리 검사기 (fail-closed, 읽기 전용).

레지스트리의 각 항목에 기록된 recorded_fingerprints를 현재 작업트리의
SHA-256과 재계산해 판정을 정한다. 판정이 발행된 상태가 사라지면 stale로
탐지되고, 결론을 유보할 수 없는 레지스트리는 exit 1로 막는다.

판정 기준 (docs/reviews/evidence_registry.ko.md와 같다):

- valid:        등록된 모든 파일이 존재하고 기록된 해시와 모두 같다.
                판정이 발행된 상태가 아직 작업트리에 남아 있다는 뜻이다.
- stale:        등록된 파일 중 하나라도 해시가 다르다. 판정이 발행된 상태가
                사라졌다는 뜻이며 그 판정을 현재 보증으로 인용할 수 없다.
- failed:       등록된 파일이 존재하지 않는다. 근거 원자료가 유실된 상태다.
- unsupported:  연구 한계·과거 기록으로 표시한 항목이다. 현재 보증으로
                취급하지 않으며 해시가 바뀌어도 블록하지 않는다.

fail-closed 규칙:

- exit 0은 모든 항목이 valid 또는 명시적으로 unsupported일 때만이다.
- stale·failed가 하나라도 있으면 exit 1과 함께 해당 항목을 나열한다.
- 레지스트리 파일 부재, JSON 파싱 실패, entries 배열 부재·빈 배열,
  스키마 밖 항목(알 수 없는 필드, 잘못된 해시, enum 밖 verdict)도
  결론을 유보할 수 없으므로 exit 1로 막는다.

이 스크립트는 읽기 전용이다. 레지스트리 JSON 갱신은 재검증 후 별도의
명시적 단계(손으로 또는 스크립트)로 한다. 표준 라이브러리만 사용한다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

VERDICTS = ("valid", "stale", "failed", "unsupported")
BLOCKING_VERDICTS = ("stale", "failed")
REQUIRED_FIELDS = ("claim", "recorded_fingerprints", "verdict")
OPTIONAL_FIELDS = (
    "source_doc",
    "threat_model_scope",
    "verification_command",
    "result_summary",
    "notes",
    "recorded_at",
)
HASH_LENGTH = 64
HASH_HEX_DIGITS = frozenset("0123456789abcdef")


class RegistryError(Exception):
    """레지스트리 파일·항목의 구조적 문제. 결론을 유보할 수 없으므로 fail-closed다."""


def sha256_file(path):
    """파일의 SHA-256을 반환한다. 읽을 수 없으면 None을 반환한다 (failed로 처리)."""
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def load_registry(path):
    """레지스트리 JSON을 읽고 최상위 구조를 검증한다."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RegistryError(f"레지스트리 파일을 읽을 수 없다: {path} ({exc})") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RegistryError(
            f"레지스트리 JSON 파싱 실패: {path} ({exc.lineno}행 {exc.colno}열: {exc.msg})"
        ) from exc
    if not isinstance(data, dict):
        raise RegistryError(f"레지스트리 최상위는 객체여야 한다: {path}")
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise RegistryError(f"레지스트리에 entries 배열이 없다: {path}")
    if not entries:
        raise RegistryError(
            f"레지스트리 entries 배열이 비어 있다: {path} (증거가 없는 레지스트리는 fail-closed로 막는다)"
        )
    return data


def validate_entry(entry, index):
    """항목 하나의 구조를 검증한다. 문제가 있으면 RegistryError를 던진다."""
    where = f"entries[{index}]"
    if not isinstance(entry, dict):
        raise RegistryError(f"{where}: 항목은 객체여야 한다")
    missing = [field for field in REQUIRED_FIELDS if field not in entry]
    if missing:
        raise RegistryError(f"{where}: 필수 필드가 없다: {', '.join(missing)}")
    unknown = sorted(set(entry) - set(REQUIRED_FIELDS) - set(OPTIONAL_FIELDS))
    if unknown:
        raise RegistryError(
            f"{where}: 알 수 없는 필드가 있다: {', '.join(unknown)}"
            " (항목 구조는 docs/reviews/evidence_registry.ko.md를 따른다)"
        )

    claim = entry["claim"]
    if not isinstance(claim, str) or not claim.strip():
        raise RegistryError(f"{where}: claim은 비어 있지 않은 문자열이어야 한다")

    verdict = entry["verdict"]
    if not isinstance(verdict, str) or verdict not in VERDICTS:
        raise RegistryError(
            f"{where}: verdict는 {list(VERDICTS)} 중 하나여야 한다 (현재 값: {verdict!r})"
        )

    fingerprints = entry["recorded_fingerprints"]
    if not isinstance(fingerprints, dict):
        raise RegistryError(f"{where}: recorded_fingerprints는 객체여야 한다")
    for rel_path, recorded in fingerprints.items():
        if not isinstance(rel_path, str) or not rel_path.strip():
            raise RegistryError(f"{where}: fingerprint 경로는 비어 있지 않은 문자열이어야 한다")
        if not isinstance(recorded, str):
            raise RegistryError(f"{where}: {rel_path}의 fingerprint는 문자열이어야 한다")
        normalized = recorded.strip().lower()
        if len(normalized) != HASH_LENGTH or not set(normalized) <= HASH_HEX_DIGITS:
            raise RegistryError(
                f"{where}: {rel_path}의 fingerprint는 64자 SHA-256 hex여야 한다"
                f" (현재 {len(normalized)}자)"
            )

    for field in OPTIONAL_FIELDS:
        if field in entry and not isinstance(entry[field], str):
            raise RegistryError(f"{where}: {field}는 문자열이어야 한다")

    if verdict != "unsupported" and not fingerprints:
        raise RegistryError(
            f"{where}: verdict '{verdict}' 항목에는 recorded_fingerprints가 최소 1개 필요하다"
            " (첨부된 검증 상태가 없으면 unsupported로 기록해야 한다)"
        )
    return entry


def compute_file_states(entry, repo_root):
    """등록된 각 파일의 현재 SHA-256을 재계산한다."""
    states = {}
    for rel_path, recorded in entry["recorded_fingerprints"].items():
        expected = recorded.strip().lower()
        current = sha256_file(repo_root / rel_path)
        if current is None:
            states[rel_path] = {
                "status": "missing",
                "recorded": expected,
                "current": None,
                "match": False,
            }
        else:
            states[rel_path] = {
                "status": "ok",
                "recorded": expected,
                "current": current,
                "match": current == expected,
            }
    return states


def compute_verdict(entry, file_states):
    """파일 상태에서 현재 판정을 정한다.

    unsupported로 표시된 항목은 연구 한계·과거 기록이므로 현재 보증으로
    취급하지 않고 블록하지도 않는다. 해시는 참고용으로만 재계산한다.
    """
    if entry["verdict"] == "unsupported":
        return "unsupported"
    if any(state["status"] == "missing" for state in file_states.values()):
        return "failed"
    if any(not state["match"] for state in file_states.values()):
        return "stale"
    return "valid"


def check_registry(data, repo_root):
    """레지스트리 전체를 검사하고 요약 객체를 반환한다."""
    checked = []
    for index, raw_entry in enumerate(data["entries"]):
        entry = validate_entry(raw_entry, index)
        file_states = compute_file_states(entry, repo_root)
        verdict = compute_verdict(entry, file_states)
        stale_files = sorted(
            rel_path
            for rel_path, state in file_states.items()
            if state["status"] == "ok" and not state["match"]
        )
        missing_files = sorted(
            rel_path
            for rel_path, state in file_states.items()
            if state["status"] == "missing"
        )
        checked.append(
            {
                "index": index,
                "claim": entry["claim"],
                "source_doc": entry.get("source_doc"),
                "recorded_verdict": entry["verdict"],
                "verdict": verdict,
                "stale_files": stale_files,
                "missing_files": missing_files,
                "fingerprints_current": (
                    all(state["match"] for state in file_states.values())
                    if file_states
                    else None
                ),
                "file_states": file_states,
            }
        )

    counts = {
        verdict: sum(1 for item in checked if item["verdict"] == verdict)
        for verdict in VERDICTS
    }
    blocked = [item for item in checked if item["verdict"] in BLOCKING_VERDICTS]
    return {
        "registry": data.get("registry"),
        "schema_version": data.get("schema_version"),
        "repo_root": str(repo_root),
        "total": len(checked),
        "counts": counts,
        "ok": not blocked,
        "exit_code": 0 if not blocked else 1,
        "blocked_entries": [
            {
                "index": item["index"],
                "claim": item["claim"],
                "verdict": item["verdict"],
                "stale_files": item["stale_files"],
                "missing_files": item["missing_files"],
            }
            for item in blocked
        ],
        "entries": checked,
    }


def _display(text, width):
    """테이블 표시용으로 개행을 정리하고 너무 긴 문자열을 자른다."""
    text = " ".join(str(text).split())
    if len(text) <= width:
        return text
    return text[: width - 1] + "…"


def print_report(report, registry_label):
    """사람이 읽는 표와 JSON 요약을 stdout에 출력한다 (쓰기는 하지 않는다)."""
    print("증거 레지스트리 검사")
    print(f"레지스트리: {registry_label}")
    print(f"저장소 루트: {report['repo_root']}")
    print()
    header = f"{'#':<3} {'판정':<26} {'주장':<50} 변경된/없는 파일"
    print(header)
    print("-" * len(header))
    if not report["entries"]:
        print("(항목 없음)")
    for item in report["entries"]:
        verdict = item["verdict"]
        if verdict != item["recorded_verdict"]:
            verdict = f"{verdict} (기록: {item['recorded_verdict']})"
        changed = ", ".join(item["stale_files"] + item["missing_files"]) or "-"
        print(
            f"{item['index']:<3} {_display(verdict, 26):<26} "
            f"{_display(item['claim'], 50):<50} {_display(changed, 64)}"
        )
    counts = report["counts"]
    print()
    state = "통과 (exit 0)" if report["ok"] else "차단 (exit 1)"
    print(
        f"요약: 총 {report['total']}개 — valid {counts['valid']}, stale {counts['stale']}, "
        f"failed {counts['failed']}, unsupported {counts['unsupported']} — {state}"
    )
    if report["blocked_entries"]:
        listed = ", ".join(
            f"{item['index']}({item['verdict']})" for item in report["blocked_entries"]
        )
        print(f"차단 항목: {listed}")
    print()
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="HALO 증거 레지스트리 검사기 (fail-closed, 읽기 전용)",
    )
    parser.add_argument(
        "--registry",
        default="docs/reviews/evidence_registry.json",
        help="레지스트리 JSON 경로 (상대 경로는 저장소 루트 기준)",
    )
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parent.parent),
        help="fingerprint 상대 경로의 기준 디렉터리 (기본값: 이 스크립트 기준 저장소 루트)",
    )
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    registry_path = Path(args.registry)
    if not registry_path.is_absolute():
        registry_path = repo_root / registry_path

    try:
        data = load_registry(registry_path)
        report = check_registry(data, repo_root)
    except RegistryError as exc:
        print(f"증거 레지스트리 오류: {exc}", file=sys.stderr)
        return 1

    print_report(report, registry_path)
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
