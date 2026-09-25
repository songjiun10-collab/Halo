# tools/check_evidence_registry.py — fingerprint 경로 탈출 수정 — 2026-09-25

## 근본 원인

`compute_file_states(entry, repo_root)`는 각 등록 항목의 `recorded_fingerprints`
키(`rel_path`)를 검증 없이 그대로 `repo_root / rel_path`로 결합해 해시를
재계산했다:

```python
current = sha256_file(repo_root / rel_path)
```

`pathlib.Path.__truediv__`는 오른쪽 피연산자가 절대경로면 왼쪽을 완전히
버린다 — `Path("/repo") / "/etc/hosts"`는 `Path("/etc/hosts")`가 된다.
`validate_entry`는 `rel_path`가 "비어 있지 않은 문자열"인지만 검사했고,
절대경로 여부나 `..` 상위 디렉터리 참조는 전혀 걸러내지 않았다. 그 결과
레지스트리 JSON에 절대경로나 `../` 시퀀스를 넣으면 `repo_root` 밖 임의
파일을 해시해 그 결과(`current` 해시값, `match` 여부)를 리포트 JSON에
그대로 노출시킬 수 있었다 — 이 검사기 자신의 설계 원칙("읽기 전용",
"repo_root 기준")과 저장소 전반의 파라노이드 검증 관례(토큰 길이/ASCII
검사, 스키마 밖 필드 차단 등)에 어긋나는 구멍이었다.

`halo doctor verify`(모든 스코프)가 이 검사기를 서브프로세스로 항상
실행하므로, 이 결함은 검증 진입점의 신뢰 사슬에 있는 실제 코드 결함이다
(합성 실험의 의도된 연구 결과가 아니다).

## 재현

```
$ cat repro.json
{"registry":"repro","schema_version":1,"entries":[{"claim":"path escape repro",
  "recorded_fingerprints":{"/etc/hosts":"00...0"},"verdict":"valid"}]}
$ .venv/bin/python tools/check_evidence_registry.py --registry repro.json --repo-root /Users/songjiun/Halo
...
"file_states": {
  "/etc/hosts": {
    "status": "ok",
    "recorded": "00...0",
    "current": "c7dd0e2ed261ce76d76f852596c5b54026b9a894fa481381ffd399b556c0e2da",
    "match": false
  }
}
```

`/etc/hosts`가 실제로 읽혀 SHA-256이 계산되고 리포트에 노출됐다. `../../../../etc/hosts`
형태의 상대경로 탈출도 동일하게 통과했다.

## 수정

`validate_entry`에서 각 `rel_path`를 스키마 검증 단계에서 거부한다 — 다른
구조적 위반(알 수 없는 필드, 잘못된 해시 형식 등)과 동일하게 `RegistryError`를
던져 레지스트리 전체를 fail-closed(exit 1)로 막는다:

```python
if Path(rel_path).is_absolute() or ".." in Path(rel_path).parts:
    raise RegistryError(
        f"{where}: fingerprint 경로는 저장소 루트 안의 상대 경로여야 한다"
        f" (허용되지 않음: {rel_path!r})"
    )
```

파일시스템에 접근하지 않는 순수 어휘적(lexical) 검사만 사용한다 — 이
검사기는 "읽기 전용"을 표방하므로, `.resolve()`로 심볼릭 링크를 따라가며
확인하는 대신 절대경로와 `..` 컴포넌트를 구조적으로 거부하는 편이 이
파일의 기존 스타일(다른 필드들도 전부 어휘적/타입 검사)과 일관된다.

## 검증

```
.venv/bin/python -m pytest tests/test_evidence_registry.py -q
# 40 passed (기존 34 + 신규 6: malformed 케이스 3개 + validate_entry 단위 테스트 3개)

.venv/bin/python -m pytest -q
# 408 passed (기존 402 + 신규 6)

# 수정 전 재현 스크립트 재실행 → 이제 fail-closed로 차단됨:
증거 레지스트리 오류: entries[0]: fingerprint 경로는 저장소 루트 안의 상대 경로여야 한다 (허용되지 않음: '/etc/hosts')
```

신규 회귀 테스트:
- `tests/test_evidence_registry.py`의 `MALFORMED_CASES`에 절대경로/상위
  탈출/경로 중간 `..` 3가지 케이스 추가 — 기존 `test_malformed_registry_fails_closed`
  파라미터화 테스트가 자동으로 exit 1과 빈 stdout(리포트 미출력 = 탈출
  파일의 해시가 출력에 노출되지 않음)을 검증한다.
- `test_validate_entry_rejects_paths_outside_repo_root`: `validate_entry`를
  직접 호출해 세 가지 탈출 경로 각각에 대해 `RegistryError`가 발생하고
  메시지에 해당 경로가 포함됨을 확인한다.

## 범위와 한계

- 현재 시딩된 `docs/reviews/evidence_registry.json`에는 절대경로나 `..`를
  포함한 항목이 없음을 확인했다 — 이 수정 전에도 실제로 악용된 적은 없다.
  `halo doctor verify` 재실행 결과(`valid 1 / stale 2 / unsupported 1`,
  exit 1)는 이 수정 전후 동일하다 — 기존에 알려진 stale 2건(과거 리뷰
  문서의 사전 수정 해시 스냅샷)은 이 수정과 무관한, 이미 문서화된 상태다.
- `.resolve()` 기반 심볼릭 링크 추적까지는 다루지 않는다 — 저장소 내부의
  상대경로 자체가 저장소 밖을 가리키는 심볼릭 링크인 극단적 케이스는
  범위 밖이다. 이 검사기가 다루는 위협은 레지스트리 JSON에 기록된 경로
  문자열 자체의 탈출이며, 저장소 내 기존 파일의 무결성은 별도 관심사다.

- [tools/check_evidence_registry.py](../../tools/check_evidence_registry.py)
- [tests/test_evidence_registry.py](../../tests/test_evidence_registry.py)
