# 보고서 폴더 공통 상태

기준일: 2026-09-21

> **전 보고서 후속 라운드:** [32개 보고서 조치 원장](REPORT_REMEDIATION.ko.md)과 [재실행 기록](2026-09-21-report-rechecks.json)을 우선한다. 전체 요청은 OS 격리·외부 감사/복구가 남아 미완료다. 아래 F01–F13 표만으로 모든 보고서가 해결됐다고 읽지 않는다.

이 디렉터리와 저장소의 개별 공격·벤치마크 보고서는 작성 당시의 원자료를 보존한다. 보고서 안의 과거 테스트 수치와 “통과”, “완전 해결”, “0% 실패” 표현은 현재 체크아웃의 상태를 뜻하지 않는다.

현재 검수 결과는 [2026-09-21 전체 검수 보고서](2026-09-21-review.ko.md)를 기준으로 한다. 이 문서는 2026-09-21 수정 라운드 후 상태를 반영한다.

- Python: **260개 통과 / 0개 실패**.
- Rust 통계: **총 58개 통과** (라이브러리 46개 + 나머지 12개).
- Rust 샌드박스 실행기: 14개 테스트 통과. 직접 309건 실행은 오류 0이지만 `security_gate=false`이며 clean-launch에서 9개 메타데이터 접근이 남는다.
- 게이트웨이 승인·factory·clock 불확실 응답, E003 양언어 freshness, E004 shifted mixture 집계, trace malformed 입력, secret scanner 해시 오탐, adapter fingerprint를 수정하고 회귀를 추가했다.
- 보고서 집계에서 현재 수치와 역사적 수치를 섞지 않는다. 숫자는 실행 명령, revision, 실행 시각, 결과 파일과 함께 기록한다.
- `docs/EVALUATION.md`, `REPORT_INDEX.ko.md`, `REPORT_UNIFIED.ko.md`가 현재 상태 요약의 진입점이다.

보고서 전체를 다시 갱신할 때는 원자료 본문을 덮어쓰지 않고, 각 문서의 기준일·실행 환경·역사적 범위를 유지한다. 새로운 결과가 기존 주장을 반증하면 현재 요약에 반영하고 해당 원자료는 stale로 표시한다.

## 이전 F01–F13 보완 라운드와 증거

2026-09-21 로컬 작업트리 검증이다. 기준 HEAD는 `170587b`이며 미커밋 변경을 포함한다. 이전 185개 Python 통과 기록을 이번 208개 결과로 대체한다. security-review-by-halo의 실행 증거 원칙에 따라 새 경계 테스트에서 먼저 7개 실패를 재현한 뒤 수정했다.

| 항목 | 조치 및 검증 | 남은 범위 |
|---|---|---|
| F01–F04 gateway | 시계 검사·claim의 트랜잭션 직렬화, INSERT 수정, 0600 최초 DB 생성, dangling symlink 거부, factory 재시작·재생 거부, 실행과 감사의 이중 실패에도 503 유지 | 외부 효과와 DB의 원자적 커밋·운영 복구는 보장하지 않음 |
| F05–F06 E004 | 실제 mixture 집계, 모든 혼합비의 대수적 불변식 검증, Python/Rust 모두 제약 미충족 시 오류 | 과거 제약을 자동 완화한 결과는 유효한 constrained 결과로 재사용하지 않음 |
| F07–F08 E003 | Python reference의 ties-to-even을 Rust와 통일, 1.5/2.5/3.5 경계·재검증 횟수 검사 | 양언어 난수열 자체는 동일하지 않음 |
| F09–F10 trace/scanner | malformed 입력 거부, 해시가 다른 토큰의 base64 문자를 빌리는 오탐 방지, 따옴표·구두점 안의 후보 검출 회귀 | 휴리스틱 탐지가 실제 비밀 탐지의 완전성을 증명하지 않음 |
| F11 adapter identity | 중첩 코드·상수·기본 인자 fingerprint와 독립 프로세스 안정성 검사 | closure·전역·외부 의존성 변경은 호스트가 revision/fingerprint 갱신해야 함 |
| F12 CI | Ubuntu/macOS Python·Rust, macOS runner, develop push 포함 | 설정 추가 완료; 원격 GitHub Actions 실행은 미확인 |
| F13 문서 | 현재/역사적 판정 분리, 잘못 연결된 보고서 교정, 로컬 Markdown 대상 검사 추가 | 외부 URL·heading anchor 및 역사적 공격 전체 재실행은 포함하지 않음 |

재현 명령(저장소 루트):

```sh
.venv/bin/python -m pytest tests experiments -q
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  .venv/cargo/bin/cargo test --locked --manifest-path rust/Cargo.toml
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  .venv/cargo/bin/cargo test --locked --manifest-path artifacts/sandbox_benchmark/rust_runner/Cargo.toml
.venv/bin/python docs/reviews/2026-09-21-probes.py
git diff --check
```

probe 확인값: 최초 factory 시작 성공, DB state=`pending` 및 실수 deadline, 실행 후 clock rollback은 503, 불가능한 robust floor는 `ValueError`, freshness window=5/volatility=0.5/delay=3은 양언어 모두 window=2·재검증=1이다. hard-family 비중 100%에서 aggregate=hard TPR: Python 0.616, Rust 0.597이다(각 구현의 난수열 차이).

샌드박스 실행기 14개 테스트의 통과는 보안 게이트 통과가 아니다. 통합 테스트가 309건 실행과 잔여 접근을 실패로 보고하는 동작을 검사한다. clean-launch의 9개 metadata 잔여 사례와 운영 배포 제한은 유지하며, 모든 과거 보고서의 결함이 해결됐다고 선언하지 않는다. 커밋·푸시·배포는 하지 않았다.

## 전 보고서 후속 라운드

Python 회귀는 260개 통과다. 이전 208개에서 52개를 추가했다. trace schema·중첩 객체·severity/API 일치·자기신고 승인·secret 형식/구조화된 key-value·gateway parser/realm/fork/capacity 경계를 추가 검증했다. 정상 로컬 읽기 및 명시적으로 host-attested한 모의 telemetry 대조군을 유지한다.

기존 trace 공격 10개 재실행에서 우회 ALLOW·크래시·under-block 집계는 0이었다(각 스크립트가 출력하는 항목 기준). 일부 legacy 스크립트는 우회가 없을 때 exit=1이며 이것을 테스트 실패나 보안 성공의 단독 근거로 사용하지 않는다. structural round6의 정책 우회도 차단했고 실험 alias/trade-off를 코드 침해로 오표기하던 설명을 정정했다. E003 PoC의 고정 “완전 우회” 결론을 제거하고 실제 production run 20개 조건을 출력한다.

이번 API tightening: evaluate_trace는 기본적으로 effectful 자기신고 승인을 인정하지 않고, decide/should_fail_closed는 기본 effectful=True다. 모의 호스트 telemetry의 명시적 opt-in과 binary/subclass/iterator 입력의 거부 계약은 CASE_BASED_REGRESSIONS에 기록했다.
