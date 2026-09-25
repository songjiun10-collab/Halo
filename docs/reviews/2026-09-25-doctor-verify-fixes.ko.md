# halo doctor/verify — 두 가지 버그 수정 — 2026-09-25

`halo/doctor.py`(2026-09-23 Agent C 크래시 후 재기동으로 작성됨)를 직접
실행하며 검토하다가 두 가지 실제 버그를 찾아 수정했다. 둘 다 통계적
trade-off가 아니라 도구 자체의 결함이었다.

## 버그 1 — `verify --scope rust/sandbox/all`이 항상 실패한다

`verify()`는 `RUSTUP_HOME`/`CARGO_HOME`을 가리키는 `env` 딕셔너리를
만들어놓고 `run_check()`에 전달하지 않았다(`run_check()`에 애초에 `env`
파라미터가 없었다). 이 저장소의 `.venv/cargo/bin/cargo`는 rustup shim이라
`RUSTUP_HOME`/`CARGO_HOME`이 이 저장소 전용 경로를 가리키지 않으면 `rustc`를
찾지 못해 즉시 실패한다. 재현:

```
$ unset RUSTUP_HOME CARGO_HOME
$ .venv/bin/python -m halo verify --scope rust
  [실패] rust-tests: error: could not execute process `rustc -vV` (never executed)
```

즉 앞선 세션 기록(`docs/reviews/2026-09-23-doctor-cli.ko.md`)의 "CLI 회귀
포함 전체 pytest: 383 통과"는 `--scope python`만 실행한 결과였고, rust/sandbox
스코프는 애초에 한 번도 성공적으로 검증되지 않았다 — 도구가 있다는 사실과
그 도구가 옳게 동작한다는 사실을 혼동한 사례다.

**수정:** `run_check()`에 `env` 파라미터를 추가하고 `subprocess.run`에
전달, `verify()`의 rust/sandbox 분기가 이미 만들어둔 `env`를 실제로
넘기도록 고쳤다.

```
$ unset RUSTUP_HOME CARGO_HOME
$ .venv/bin/python -m halo verify --scope all
  [통과] pytest: 399 passed in 18.27s
  [실패] evidence: ... (기존에 알려진 stale, 무관)
  [통과] rust-tests: ...
  [통과] sandbox-tests: ...
보안 gate (별개): macOS 샌드박스 security_gate — 실패 gate
```

(`security_gate` 실패는 [기존에 문서화된](../../REPORT_INDEX.ko.md)
clean-launch 잔여 메타데이터 노출이며 이번 수정과 무관하다 — 이 도구의
"테스트 결과와 보안 gate를 분리해 보고한다"는 설계가 정확히 그 구분을
보여준다.)

## 버그 2 — `verify --json`이 순수 JSON을 내지 않는다

`verify()`와 `_report_security_gate()`가 결과를 계산하면서 동시에
`print()`로 human-readable 줄을 직접 찍었다. `main()`은 그 뒤에 다시
`json.dumps(report)`를 출력했으므로, `--json`을 줘도 실제로는
"human 텍스트 여러 줄 + JSON 한 줄"이 섞여 나왔다 — 이 CLI 자신의 문서
(`docs/reviews/2026-09-23-doctor-cli.ko.md`)가 명시한 "`--json`은 ...
단일 JSON 객체로 반환한다"는 계약을 어기고 있었다. `doctor` 서브커맨드는
`diagnose()`가 순수 계산이고 `print_diagnose()`가 별도라서 애초에 이 문제가
없었다 — `verify()`만 그 패턴에서 벗어나 있었다.

재현(수정 전):

```
$ halo verify --scope python --json
  [통과] pytest: ...
  [실패] evidence: ...

테스트 요약: ...
보안 gate는 테스트 결과와 별개다 ...
{"ok": false, "checks": [...], "security_gates": []}
```

`json.loads()`로 이 전체 stdout을 파싱하면 실패한다 — 자동화/다른 에이전트가
이 출력을 그대로 소비할 수 없었다.

**수정:** `verify()`와 `_report_security_gate()`에서 모든 `print()`를
제거해 `diagnose()`처럼 순수 계산 함수로 만들고, 그 출력을 재현하는
`print_verify(report)`를 새로 분리했다. `main()`은 `--json`이면
`json.dumps`만, 아니면 `print_verify`만 호출한다(`doctor` 서브커맨드와
동일한 구조).

## 검증

```
.venv/bin/python -m pytest -q
# 399 passed (기존 395 + 신규 4)

.venv/bin/python -m pytest tests/test_halo_doctor.py -q
# 13 passed (기존 9 + 신규 4)
```

신규 회귀 테스트 4종:

1. `run_check`이 `env`를 `subprocess.run`에 실제로 전달하는지.
2. `verify(scope="rust"/"sandbox")`가 `RUSTUP_HOME`/`CARGO_HOME`이 든
   `env`를 cargo 호출에 실제로 넘기는지(양쪽 스코프 모두).
3. `verify()` 직접 호출이 아무것도 출력하지 않는지(`diagnose()`와 동등).
4. `main(["verify", "--json"])`의 stdout이 정확히 한 줄이고 `json.loads`로
   파싱 가능한지.

수동 검증: 이 세션에 있는 실제 `.venv/cargo`로 `unset RUSTUP_HOME
CARGO_HOME` 상태에서 `--scope rust`, `--scope sandbox`, `--scope all`을
모두 human-readable과 `--json` 양쪽으로 실행해 확인했다(위 출력 참고).

## 범위와 한계

- `evidence` 검사의 stale 2건은 이 수정과 무관한 기존 상태다
  ([2026-09-25-e003-progressive-refresh-fix.ko.md](2026-09-25-e003-progressive-refresh-fix.ko.md)와
  동일한 pre-existing stale entries).
- `security_gate` 실패(clean-launch 메타데이터 잔여 9건)는 B1 항목이며
  이 도구 수정으로 해결되지 않는다 — `verify`가 그 사실을 gate로 정직하게
  보고하게 된 것이 이번 수정의 요점이다.
- doctor/verify의 다른 검사(python, HALO_STATE_DIR, results, rust-toolchain
  존재 확인)는 손대지 않았다.
