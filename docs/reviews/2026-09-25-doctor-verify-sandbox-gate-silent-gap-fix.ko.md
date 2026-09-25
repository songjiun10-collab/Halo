# halo/doctor.py — verify()의 sandbox security_gate 침묵 누락 수정 — 2026-09-25

Docker 개발 환경 추가분을 검토하던 중 발견한, `halo doctor verify`(검증
진입점) 자체의 별개 결함이다. Docker 파일들과는 무관하다.

## 근본 원인

`verify(root, scope)`는 `scope in ("sandbox", "all")`일 때만 security gate를
계산했는데, 그 조건이 **러너 바이너리가 이미 빌드되어 있을 때만** 게이트
항목을 만들었다:

```python
if scope in ("sandbox", "all") and runner_bin.is_file():
    gates.append(_report_security_gate(...))
```

바이너리가 아직 빌드되지 않은 상태(신규 체크아웃, `cargo build` 이전 등)에서
`verify --scope sandbox`를 실행하면 `security_gates`가 그냥 빈 배열 `[]`이
됐다 — "게이트를 확인했고 문제 없음"과 "게이트를 아예 확인하지 않음"을 구분할
방법이 없었다. 이 모듈은 다른 모든 곳에서 정반대 원칙을 지킨다 — 예를 들어
`rust-tests`/`sandbox-tests` 검사는 cargo나 manifest가 없으면 침묵하지 않고
`{"ok": None, "output": "not installed"}`를 명시적으로 낸다(모듈 docstring:
"환경 미설치는 실패가 아니라 not-installed로 보고한다"). security gate만 이
관례를 어기고 조용히 사라졌다.

부수 효과로, `print_verify`의 `"미빌드"` 라벨 분기는 실질적으로 도달 불가능한
죽은 코드였다 — `_report_security_gate`가 `command=None`으로 호출되는
경로(정확히 "미빌드"에 해당하는 경로)가 이 조건 때문에 한 번도 실행되지
않았기 때문이다.

## 수정

게이트 계산 조건에서 `runner_bin.is_file()`을 제거하고, 대신 바이너리가
없을 때 `command=None`을 넘겨 `_report_security_gate`가 이미 지원하는
"not built" 경로(`{"ok": None, "detail": "not built"}`)를 타도록 했다:

```python
if scope in ("sandbox", "all"):
    gates.append(_report_security_gate(
        "macOS 샌드박스 security_gate",
        [str(runner_bin), "--repeats", "1"] if runner_bin.is_file() else None,
        cwd=str(root)))
```

`ok = all(check["ok"] is not False for check in checks)`는 여전히 `checks`
만 보고 `gates`는 보지 않으므로, 이 수정은 "게이트 실패는 테스트 실패가
아니다"라는 기존 불변식을 바꾸지 않는다 — 게이트가 명시적으로 보고되게
만들 뿐이다.

## 검증

```
.venv/bin/python -m pytest tests/test_halo_doctor.py -q
# 15 passed (기존 13 + 신규 2, sandbox/all 파라미터화)

.venv/bin/python -m pytest -q
# 418 passed (기존 408 + 신규 10: 이 파일 2개 + evidence registry 전 수정분 포함 누계)

.venv/bin/python -m halo verify --scope sandbox
#   [통과] sandbox-tests: ...
# 보안 gate (별개): macOS 샌드박스 security_gate — 실패 gate
```

이 저장소의 러너 바이너리는 이미 빌드되어 있어 로컬에서는 "미빌드" 경로
자체보다 기존에 알려진 `security_gate=false` 결과(아래 범위 참고)가 그대로
드러났다 — 정확히 의도한 대로, 침묵하지 않고 보고된다. "미빌드" 라벨은
신규 테스트(`test_verify_reports_unbuilt_sandbox_gate_explicitly_not_silently`)
로 `tmp_path`(바이너리 없음)를 통해 직접 확인했다.

## 범위와 한계

- `security_gate=false` 자체는 이 수정으로 만들어진 문제가 아니다 —
  `docs/reviews/REPORT_STATUS.ko.md`에 이미 기록된 결과다: "Rust 샌드박스
  실행기: 14개 테스트 통과. 직접 309건 실행은 오류 0이지만
  `security_gate=false`이며 clean-launch에서 9개 메타데이터 접근이 남는다."
  이는 B1(새 격리 실행 환경이 필요한 환경/운영 한계)로 이미 분류된 항목이며,
  이번 수정의 목적은 그 결과를 절대 침묵시키지 않는 것이지 그 결과 자체를
  바꾸는 것이 아니다.
- doctor(diagnose) 쪽은 손대지 않았다 — `_rust_check`는 애초에 게이트가
  아니라 툴체인 존재 여부만 보고하므로 이 결함과 무관하다.

- [halo/doctor.py](../../halo/doctor.py)
- [tests/test_halo_doctor.py](../../tests/test_halo_doctor.py)
