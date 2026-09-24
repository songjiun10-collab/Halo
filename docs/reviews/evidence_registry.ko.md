# 증거 레지스트리 — 판정과 발행 상태의 연결 — 2026-09-23

각 검증 결과(claim)를 그 결과가 발행된 상태(작업트리 해시·실행 명령·위협 모델 범위)에
연결해서, 발행 당시 상태가 사라지면 판정이 조용히 남지 않고 **stale로 탐지되게** 한다.
이 문서는 [2026-09-21 전체 검수 보고서](2026-09-21-review.ko.md) 개선 제안 #1의 구현이며,
[보고서 전수 조치 원장](REPORT_REMEDIATION.ko.md)의 판정 기준 스타일을 따른다.

## 레지스트리 항목 구조

레지스트리 JSON(`docs/reviews/evidence_registry.json`)의 최상위는 객체이고
`entries` 배열에 아래 구조의 항목을 넣는다.

```json
{
  "claim": "현재 Python 회귀 260 통과 / 0 실패",
  "source_doc": "REPORT_UNIFIED.ko.md",
  "recorded_fingerprints": {"halo/gateway.py": "a6fca5…"},
  "threat_model_scope": "로컬 저장소 회귀…",
  "verification_command": ".venv/bin/python -m pytest -q",
  "result_summary": "260 passed / 0 failed",
  "verdict": "valid"
}
```

- `claim` / `recorded_fingerprints` / `verdict`는 필수다. 나머지는 선택 메타데이터다
  (`source_doc`, `threat_model_scope`, `verification_command`, `result_summary`, `notes`, `recorded_at`).
- `recorded_fingerprints`는 저장소 루트 기준 상대 경로 → 기록 시점 SHA-256(64자 hex)의 대응이다.
- 스키마 밖 필드, 64자가 아니거나 hex가 아닌 fingerprint, enum 밖 `verdict`는
  체커가 오류로 처리한다(fail-closed). 잘린 해시도 오류다 — 조용히 stale로 보고하지 않는다.
- 기록 시점에 파일이 없어 fingerprint를 남길 수 없었다면 그 항목은 `unsupported`로
  기록하거나 등록하지 않는다. 첨부된 검증 상태 없이 `valid`로 기록하는 것은 오류다.

## 판정 기준

원장의 판정 기준(수정·재현 / 연구 한계 / 혼합 / 과거 기록)에 대응하는 기계 검사 가능한 형태다.

- **valid:** 등록된 모든 파일이 존재하고 기록된 해시와 현재 SHA-256이 모두 같다.
  판정이 발행된 상태가 아직 작업트리에 남아 있다는 뜻이다. README의 현재 수치처럼
  재검증된 주장도 이 상태로 둔다.
- **stale:** 등록된 파일 중 하나라도 해시가 다르다. 판정이 발행된 상태가 사라졌다는 뜻이며,
  그 판정을 현재 보증으로 인용할 수 없다. 관련 재현·회귀를 다시 실행하고 레지스트리를
  갱신할 때까지 유지된다. 소스 한 줄 변경이 예전 통과 판정을 stale로 바꾸는 것이
  첫 수용 조건이다.
- **failed:** 등록된 파일이 존재하지 않는다. 근거 원자료가 유실된 상태다.
- **unsupported:** 연구 한계·과거 기록으로 표시한 항목이다. 현재 보증으로 취급하지 않으며,
  해시가 바뀌어도 블록하지 않는다(원자료 보존 목적). 합성 실험의 trade-off,
  과거 benchmark 원자료가 여기 해당한다.

체커는 항목에 기록된 `verdict`를 발행 시점의 기록으로 보고, 현재 판정을 재계산한다.
`unsupported`로 표시된 항목만 현재 판정에 관계없이 그 상태를 유지한다.

## fail-closed 규칙

체커(`tools/check_evidence_registry.py`)는 표준 라이브러리만 사용하고 어떤 파일도 쓰지 않는다.

- **exit 0은 모든 항목이 `valid` 또는 명시적으로 `unsupported`일 때만이다.**
- `stale`·`failed`가 하나라도 있으면 exit 1과 함께 해당 항목(주장, 판정, 변경된 파일)을 나열한다.
- 레지스트리 파일이 없거나, JSON 파싱이 실패하거나, `entries` 배열이 없거나 비어 있거나,
  항목 구조가 스키마와 다르면 결론을 유보할 수 없으므로 **exit 1(fail-closed)로 막는다.**
  증거가 없거나 판독 불가능한 레지스트리는 통과로 취급하지 않는다.
- 레지스트리 JSON 갱신은 재검증 후 별도의 명시적 단계(손으로 또는 스크립트)로 하며,
  체커는 읽기만 한다. 체커가 판정을 자동 갱신하지 않는다 — 갱신은 기록 행위다.

실행:

```sh
.venv/bin/python tools/check_evidence_registry.py --registry docs/reviews/evidence_registry.json
```

`--repo-root`의 기본값은 이 스크립트 기준 저장소 루트라서 저장소 어디서 실행해도
fingerprint를 올바르게 풀 수 있다. 출력은 사람이 읽는 표와 JSON 요약이다.

## 시딩된 항목 — 2026-09-23 (패치 전)

2026-09-23에 당시 작업트리에서 계산한 해시로 4개 항목을 시딩했다.
**이 시딩은 동시 패치가 착지하기 전 시점이다.** `halo/safety_cases.py`, `halo/policy.py` 등의
수정이 진행 중이므로, 첫 패치 후 검사는 해당 항목의 판정을 stale로 바꿀 것이며 — 이것이
수용 조건의 정상 동작이다 — 오케스트레이터가 재검증하고 레지스트리를 갱신할 때까지
stale가 유지된다.

| # | 주장 | 발행 문서 | verdict(기록) | 비고 |
|---|---|---|---|---|
| 0 | 현재 Python 회귀 260 통과 / 0 실패 | [REPORT_UNIFIED.ko.md](../../REPORT_UNIFIED.ko.md) | valid | 게이트웨이 소스·테스트 5개 파일의 시딩 시점 해시. 패치 착지 시 stale 예상 |
| 1 | 2026-09-21 검수 보고서의 판정(F01–F13, 수정 전 수치) | [2026-09-21-review.ko.md](2026-09-21-review.ko.md) | stale | 문서의 fingerprint는 수정 전 해시다. 현재 트리는 수정되었으므로 stale가 맞다 |
| 2 | E001-B/E002 README 합성 실험 수치(2026-09-22 재검증) | [README.md](../../README.md) | valid | 합성 실험 주장(연구 한계)이며 모델 containment 보장이 아니다 |
| 3 | 샌드박스 벤치마크 results.json(2026-09-13 실행) | [REPORT.ko.md](../../artifacts/sandbox_benchmark/REPORT.ko.md) | unsupported | 과거 기록. unsupported는 차단 성공이 아니다 |

- 항목 1의 fingerprint는 검수 문서의 표에 적힌 수정 전 해시 4개
  (`halo/gateway.py`, `halo/safety_cases.py`, `experiments/e004_robust_evaluation/experiment.py`,
  `rust/halo-experiments/src/e003.rs`)를 그대로 복사했다. 발행된 스냅샷은 사라졌으므로
  재검증으로 소급해 valid로 바꾸지 않는다 — 새 검증은 이 레지스트리의 새 항목으로 기록한다.
- 항목 2의 README 수치는 2026-09-22 독립 재검증 기준이며, 합성 비교군의 trade-off다.
  이 레지스트리의 `valid`는 "해시가 현재 작업트리와 일치한다"는 뜻이지 합성 실험을
  실제 격리 보장으로 승격하지 않는다.
- 항목 3은 현재 100-case 벤치마크(B1)와 별개의 2026-09-13 원자료다. 체커는 이 항목을
  블록하지 않지만, JSON 요약의 `fingerprints_current`로 원자료가 아직 그 상태인지는 볼 수 있다.
- `README`·통합 보고서가 이 레지스트리에서 현재 상태를 읽도록 연결하는 것은 이번 범위 밖이다.
  해당 문서들은 동시 수정 중이므로 별도 단계로 연결해야 한다.

## 역사적 수치에 관하여

이 레지스트리와 그 판정도 발행 시점의 작업트리에 한정된다. 역사적 수치는 현재
작업트리의 보증으로 사용하지 않는다. 전체 테스트 통과나 탐지기의 ALLOW는 실제
실행 capability·운영 배포 승인과 다르며, 운영 격리(B1)와 외부 신뢰 영역(B2)은 별도의
환경·운영 작업이다.
