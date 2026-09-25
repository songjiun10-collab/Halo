# 보고서 전수 조치 원장 — 2026-09-21

2026-09-23 후속: [doctor/verify CLI 구현 및 현재 검증](2026-09-23-doctor-cli.ko.md).
Python 383개 통과. 과거 증거 2개가 stale이므로 통합 verify는 exit 1이다.

2026-09-25 후속: [E003 progressive_refresh adaptive window 수정](2026-09-25-e003-progressive-refresh-fix.ko.md).
아래 R3의 "미해결 취약점 #1"(EVALUATION.md 표) 중 floor 로직 결함이던 부분을
수정했다 — 통계적 trade-off 부분은 그대로 유지. Python 395개 통과.
증거 레지스트리 상태는 변경 없음(valid 1 / stale 2 / unsupported 1).

2026-09-25 후속 2: [halo doctor/verify 버그 2건 수정](2026-09-25-doctor-verify-fixes.ko.md).
`verify --scope rust/sandbox/all`이 env 누락으로 항상 실패하던 문제와
`verify --json`이 순수 JSON을 내지 않던 문제. 2026-09-23-doctor-cli.ko.md의
"CLI 회귀 포함 전체 pytest 383 통과"는 `--scope python`만 검증된 것이었다 —
rust/sandbox 스코프는 이번에 처음 실제로 통과 확인. Python 399개 통과.

2026-09-25 후속 3: [halo/gateway.py clock 호출 예외 처리 수정](2026-09-25-e006-mono-clock-fix.ko.md).
E006 fault-injection의 "발견 1"(mono clock 실패 시 raw ValueError가
handle()을 뚫고 나감, report-only로 기록되고 gateway.py는 안 고쳐진 상태였음)을
실제로 수정 — wall/mono 양쪽 다 clock 호출 자체가 raise하는 경우를
`Rejected("clock unavailable")`로 정규화. 발견 2(marshal 지문 불안정)는
별도 범위로 남김. Python 401개 통과.

2026-09-25 후속 4: [halo/gateway.py 어댑터 지문의 로드 모드 불안정성 수정](2026-09-25-e006-fingerprint-fix.ko.md).
E006 fault-injection의 "발견 2"(marshal 기반 어댑터 지문이 fresh-compile과
`.pyc` 캐시 로드 사이에서 달라져 유효한 capability가 거짓 거부될 수 있음,
높음 심각도, report-only로 기록되고 gateway 수정은 별도 범위로 남겨져
있었음)를 실제로 수정 — `_code_fingerprint`가 코드 객체를 통째로
marshal하는 대신 반복 상수의 백레퍼런스 문제가 생길 수 없는 평탄한 필드
튜플(`_canonical_code`)로 분해한 뒤 marshal한다. 서브프로세스 기반 재현으로
구버전의 불안정성을 재확인했고, 동일 스크립트로 되돌린 코드에서 신규 회귀
테스트가 실패함을 확인한 뒤 수정판에서 통과함을 확인했다. Python 402개 통과.

전체 요청은 아직 **미완료**다. 재현된 로컬 코드 결함은 아래와 같이 수정했으나,
B1(새 격리 실행 환경)과 B2(신뢰 영역 밖의 감사·복구)는 별도의 환경/운영 작업이다.
연구에서 의도적으로 측정하는 실패율을 0으로 바꾸거나, 보안 게이트를 완화하지 않았다.

## 판정 기준

- **수정·재현 / 회귀:** 현재 코드의 실행 결과로 확인한 해당 결함·경계만 의미한다.
- **연구 한계:** 합성 비교군의 실제 실패/trade-off다. 버그 수정으로 제거한 척하지 않는다.
- **혼합:** 해당 보고서의 일부만 코드 수정으로 닫혔다. 나머지는 명시한 B/R 항목이다.
- **과거 기록:** 당시 원자료를 보존한다. 같은 규모·모든 공격을 새로 실행했다는 뜻이 아니다.
- 전체 테스트 통과나 탐지기의 ALLOW는 실제 실행 capability/운영 배포 승인과 다르다.

## 보고서별 처리 상태

| 원문 | 지적 범위 | 상태 | 조치·한계 |
|---|---|---|---|
| [HALO_EXPLOIT_V1_DEEP_FINDINGS.md](../../HALO_EXPLOIT_V1_DEEP_FINDINGS.md) | D1–D5 | 수정·재현 | critical severity, 기본 effectful, API 일치, 자기신고 승인 거부 |
| [HALO_EXPLOIT_V2_DEEP_FINDINGS.md](../../HALO_EXPLOIT_V2_DEEP_FINDINGS.md) | N1–N4 | 수정·재현 | plain schema, iterable 재사용 거부, Boolean probe |
| [DEEP_EXPLOIT_FINDINGS_3.md](../../DEEP_EXPLOIT_FINDINGS_3.md) | Z/P/U/N2b | 수정·재현 | effect-only 자기승인 및 중첩 객체 우회 거부 |
| [DEEP_EXPLOIT_FINDINGS_4.md](../../DEEP_EXPLOIT_FINDINGS_4.md) | X/S1–S5/C | 수정·재현 | Unicode format 문자 검사, 문자열/컨테이너 subclass 거부 |
| [DEEP_EXPLOIT_FINDINGS_4B.md](../../DEEP_EXPLOIT_FINDINGS_4B.md) | G1–G4/G6 | 수정·재현 | known provenance, snapshot, 비교·repr·반복자 callback 거부 |
| [DEEP_EXPLOIT_FINDINGS_5.md](../../DEEP_EXPLOIT_FINDINGS_5.md) | G1–G3 | 수정·재현 | 보고된 8종 credential 형식, truthiness 및 iteration 예외 |
| [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) | trace 1a–1f; E001B–E005 | 혼합 | trace 수정, E004 strict; 실험 한계는 아래 R1–R4 |
| [HALO_EXPLOIT_V4_REPORT.md](../../HALO_EXPLOIT_V4_REPORT.md) | 직접 공격 round 1–6 및 실험 | 혼합 | trace·E004 수정, E003 false claim 정정, 비교군/분포 한계 보존 |
| [HALO_EXPLOIT_V5_DIRECT_REPORT.md](../../HALO_EXPLOIT_V5_DIRECT_REPORT.md) | E001B/E002/E003 | 연구 한계 | 고오류율·저FPR·freshness 재사용의 trade-off; R1–R3 |
| [HALO_EXPLOIT_V6_DIRECT4_REPORT.md](../../HALO_EXPLOIT_V6_DIRECT4_REPORT.md) | A–F | 수정·재현 | scope/effect 타입, bytes 거부, 자기신고 상태·digest의 비권한화 |
| [HALO_EXPLOIT_V7_ULTRA_REPORT.md](../../HALO_EXPLOIT_V7_ULTRA_REPORT.md) | E001B/E002/E003 극한값 | 연구 한계 | 안전성 보장이 아닌 합성 비교군; R1–R3 |
| [HALO_EXPLOIT_V8_ISOLATED_FINDINGS.md](../../HALO_EXPLOIT_V8_ISOLATED_FINDINGS.md) | gateway 31 checks | 혼합 | 현행 schema 회귀로 parser·capacity·claim 검사; 관리자 변조/감사 삭제는 B2 |
| [HALO_EXPLOIT_V9_ISOLATED_FINDINGS.ko.md](../../HALO_EXPLOIT_V9_ISOLATED_FINDINGS.ko.md) | P9-A–H | 혼합 | A–E trace 수정; G DB-only 복제 거부, H 명시 realm 키 바인딩; full snapshot은 B2; 양쪽 자기주장 trusted 허용은 2026-09-22 잔여 |
| [halo/HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md](../../halo/HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md) | 인증·preflight·실행후·취소 | 수정·회귀 | 기존 회귀 및 실행+감사 이중 실패·재생 거부 |
| [artifacts/sandbox_benchmark/REPORT.ko.md](../../artifacts/sandbox_benchmark/REPORT.ko.md) | 기본 I/O 및 실험 수정 | 과거 기록 / B1 | 원자료 보존; 현행 pytest 및 Rust runner 회귀와 분리 |
| [artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md](../../artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md) | sysctl/metadata/config/exec/fork | 혼합 / B1 | 후속 runner 회귀 보유; 전 metadata 비노출 미달 |
| [artifacts/sandbox_benchmark/RECHECK.ko.md](../../artifacts/sandbox_benchmark/RECHECK.ko.md) | 9종 확장 / ABI / errno | 혼합 / B1 | 판정 오류 수정은 회귀 대상; 당시 VM 미설치 문구는 역사적 상태 |
| [artifacts/sandbox_benchmark/RUST_RUNNER.ko.md](../../artifacts/sandbox_benchmark/RUST_RUNNER.ko.md) | Rust runner | 회귀 / B1 | 14개 테스트; 309건 실행의 실패 gate를 정직하게 유지 |
| [artifacts/sandbox_benchmark/HALO_SANDBOX_V1_DIRECT_ATTACK.ko.md](../../artifacts/sandbox_benchmark/HALO_SANDBOX_V1_DIRECT_ATTACK.ko.md) | IOKit/Mach/IPC/metadata | 미완료 / B1 | 호스트 정보 비노출을 네이티브 Seatbelt만으로 보증하지 않음 |
| [artifacts/sandbox_benchmark/HALO_SANDBOX_V2_DYNAMIC_VERIFICATION.ko.md](../../artifacts/sandbox_benchmark/HALO_SANDBOX_V2_DYNAMIC_VERIFICATION.ko.md) | round 2–3 노출 | 미완료 / B1 | 과거 대규모 탐침 전부를 이번에 재실행한 것은 아님 |
| [artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md](../../artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md) | access/getfsstat/runtime/Mach | 미완료 / B1 | runtime 내용 차단과 metadata 노출을 구분 |
| [artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md](../../artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md) | sem_open/fsgetpath 판정 | 정정 보존 / B1 | unsupported는 차단 성공 아님; Mach·mount 노출 잔여 |
| [rust/ROW_AUDIT.ko.md](../../rust/ROW_AUDIT.ko.md) | 수치 오버플로·상쇄 및 행 감사 | 회귀 / 연구 한계 | Rust 수치 회귀 통과; 1,920행 sweep 전부를 새로 실행하지 않음 |
| [rust/SHIFT_BENCH.ko.md](../../rust/SHIFT_BENCH.ko.md) | 분포 이동·오탐 budget | 연구 한계 | FPR 초과는 수치 오류와 별개; 기대 성능을 임의로 올리지 않음 |
| [rust/HARD_BENCH.ko.md](../../rust/HARD_BENCH.ko.md) | 부하·불변식·sandbox | 과거 기록 / B1 | 회귀는 재실행; 과거 전체 규모 benchmark는 보존 |
| [rust/SHIELD.ko.md](../../rust/SHIELD.ko.md) | centered/hybrid/센서 손실 | 연구 한계 | Revalidate는 중지/새 증거 요구, detection=100%가 아님 |
| [rust/ENFORCEMENT.ko.md](../../rust/ENFORCEMENT.ko.md) | 실제 객체 접근 ACL | 회귀 | Rust protected_store 재검증·불확실시 접근 거부 테스트 |
| [rust/SANDBOX_BOUNDARY.ko.md](../../rust/SANDBOX_BOUNDARY.ko.md) | 9개 metadata 잔여 | 미완료 / B1 | 작업 환경 변경 필요; 게이트는 실패 유지 |
| [halo/AUTHORITY.ko.md](../../halo/AUTHORITY.ko.md) | host authority / 메모리 backend | 회귀 | 위조·stale·cross-instance·경합·감사 실패 회귀 |
| [halo/GATEWAY.ko.md](../../halo/GATEWAY.ko.md) | 운영 인계 | 혼합 / B2 | 코드/계약 갱신; TLS·외부 감사·복구는 미배포 |
| [docs/EVALUATION.md](../../docs/EVALUATION.md) | 집계·원문 매핑·PoC 결론 | 정정 | 현재/과거 분리; unsupported 완전 우회 결론 철회 |
| [docs/reviews/2026-09-21-review.ko.md](../../docs/reviews/2026-09-21-review.ko.md) | F01–F13 | 수정 / CI 미확인 | 기존 보완과 이번 추가 회귀; 원격 CI 미실행 |

## 공통 원인별 수정 근거

- **M1 객체/타입 경계:** 정확한 Event·list/tuple·JSON 데이터만 bounded snapshot으로 복사.
  중첩 subclass/bytes/비문자 키/순환/과도한 깊이·크기/비유한 값을 fail-closed 처리한다.
  공격자 repr/eq/iterator 호출로 감사와 판단이 달라지는 경로를 막는다.
- **M2 판정 일치:** severity=5는 항상 DENY, 기본 effectful=True,
  should_fail_closed는 같은 denial 규칙을 사용한다. 소모성 iterator 재사용은 거부한다.
- **M3 권한:** 외부 효과의 자기신고 approved=True는 기본 거부.
  trusted_telemetry=True는 호스트가 보증한 모의 telemetry에만 쓰며 실제 실행권한이 아니다.
  Gateway/Authority의 capability·상태 검증은 여전히 필요하다.
- **M4 비밀 탐지:** 보고된 segmented credential/PEM/AWS/GitHub 형식과 제로폭 분할,
  benign action으로 위장한 external secret 데이터 경로를 검사한다.
  unknown/암호화된 모든 secret을 완전 검출한다는 보장은 없다.
- **G1 게이트웨이:** strict ASCII Content-Length, 명시 realm에서도 역할 키 identity 바인딩,
  private regular sidecar·symlink 거부, DB-only fork 거부, 현재 schema의 capacity/expiry 회귀.
- **E4 robust:** 최소 TPR/FPR 제약을 조용히 완화하지 않고 infeasible 오류 반환.
  shifted mixture는 실제 비중으로 계산한다.

직접 근거: [trace/policy 회귀](../../tests/test_report_security_regressions.py),
[gateway 회귀](../../tests/test_report_gateway_regressions.py),
[실험 주장 재검증](../../tests/test_report_experiment_claims.py),
[실행 기록](2026-09-21-report-rechecks.json).

## R1–R4: 실험 주장 정정과 유지할 비교군

- **R1 E001-B:** 높은 오류율/상관에서 실패하는 것은 연구 대상이다.
  correlation_aware는 rho를 온라인 추정하는 알고리즘이 아니라 고정 source-3 corroboration 규칙이다.
  미사용 adaptive_redundant를 제거했다. 이 Boolean write 정책에서 두 소스가 모두 허용하면
  관련 metadata도 일치하므로 “추가 불일치 write 허용” 주장은 프로브의 0건 결과와 모순된다.
- **R2 E002:** conservative_max는 separately calibrated max_pool scale control이다.
  추가 안전 마진/독립 방어라는 설명을 철회했다. 낮은 FPR budget의 TPR 저하는 실제 trade-off다.
- **R3 E003:** 읽기 위주 “완전 우회” PoC는 실제 unsafe_allowed=0이었다.
  현재 production run을 호출하는 재검증기로 교체했다. 20개 조건에서 adaptive/use-time
  breach cell=0, progressive=11이었다. progressive의 허용된 reuse 기간 내 stale 위험은
  비교군의 성질이며 감추지 않는다. 읽기가 안전하다는 합성 정의는 실제 기밀성을 증명하지 않는다.
  **2026-09-25 후속:** 그 11건 중 `volatility≥0.75` 부근에서 나타난 실패는 trade-off가
  아니라 `adaptive_window()` floor 버그(항상 최소 1을 강제해 고변동성에서 refresh
  주기가 상태의 parity와 aliasing됨)였다. floor를 0으로 낮춰 수정했고, 수식대로
  정당하게 window=1인 나머지 경우의 stale 위험은 그대로 유지했다.
  [상세](2026-09-25-e003-progressive-refresh-fix.ko.md).
- **R4 E005/Shield:** moving-target의 큰 분산, sensor-loss의 전부 Revalidate,
  shift에서 FPR 예산 초과는 잔여 연구 한계다. 출력 이름·평가 기준을 바꿔 성공으로 만들지 않는다.

## B1: OS 격리 — 미완료

현재 Seatbelt 100-case 실행에서는 clean-launch의 metadata 잔여 9개로 gate=false다.
14개 runner 테스트는 이 실패를 정확히 보고하는 검사까지 포함한다.
기존 VM `halo-secure`는 중지 상태이며 설정상 홈 디렉터리 공유가 있으므로
“호스트 파일 비노출” 환경으로 간주하지 않는다. 읽기 전용 확인만 했고 VM을 시작하거나
설정을 바꾸지 않았다. Wasmtime 설치 존재도 네이티브 실행기 격리의 완료 증거가 아니다.

별도의 홈 공유·외부 네트워크 없는 실행 환경을 구성하고, 정상 작업·metadata·파일·network·IPC·
자원 제한을 그 경계에서 다시 검증해야 한다. 사용자에게 새 전용 VM 구성 범위를 질문한 상태다.
기존 host benchmark의 실패 gate는 새 backend가 생겨도 소급하여 통과로 바꾸지 않는다.

## B2: 운영 신뢰 영역 — 미완료

DB 및 realm identity까지 복제한 전체 snapshot의 anti-rollback/double-spend,
서비스 관리자에 의한 DB·감사 삭제 방지는 동일 호스트의 SQLite만으로 보장하지 않는다.
DB-only 복사 거부와 role-key binding은 이 위협의 완전 해결이 아니다.
별도 신뢰 영역의 불변 감사/권한 ledger, 복구 시 pending grant 폐기·효과 대조,
사용자 인증·TLS·proxy 및 도구별 원자적 상태검사가 필요하다.
외부 서버·계정·네트워크 배포는 이번 작업에서 수행하지 않았다.

## 2026-09-22 독립 재검증 — 신규 발견과 도구 갱신

서브에이전트 없이 로컬에서만 실행한 독립 재검증 결과다. 라운드9 익스플로이트를
현재 트리 기준으로 재구축한 격리 사본에서 재실행했고, benign·악성 양쪽 비용을
함께 측정하는 벤치마크를 추가했다.

- 실행: `pytest` 260 통과 / 0 실패. 라운드9 익스플로이트 재실행 — 모니터 경로
  10/10 방어, 게이트웨이 fork DB-only 복사 거부·교차 인스턴스 거부·claim-once
  5회 유지. 최강 fork 프로브(sidecar를 계산된 이름으로까지 복제) → double spend
  실제 발생 — `gateway.py`의 documented limit 주석과 B2 문서와 일치.
- 신규 도구: `false_block_benchmark.py`(benign 10/11 통과, 확인된 false block
  1개, 악성 벡터 9/9 방어), `gateway_round9.py`를 F03 수정 후 동작에 맞게 갱신
  (열기 거부를 HELD로 보고, full snapshot 섹션 추가, 표준 exit code로 변경).
- 신규 발견 (P9-B2, 잔여): 두 이벤트가 모두 `provenance="trusted"`를 자기주장하면
  `trusted_telemetry=True`에서 untrusted 채널이 소멸하고 ALLOW에 도달한다.
  V9 권고 #2(호스트 주입 provenance)가 코드에 미구현이라는 뜻이다. 영향은
  bounded다 — 평가기의 ALLOW는 capability가 아니고, host-only 스위치 계약상
  독립 telemetry를 보증한 호스트가 공격자 영향 provenance를 그대로 Event에
  통과시킬 때만 발화한다. 위 표의 "A–E trace 수정"은 V9 기록 구성(write
  provenance unknown)에 한정된다.
- 신규 발견 (false block, 잔여): external 스코프 read의 URL 쿼리 스트링
  (`?token=abc&format=json`)이 `credential_assignment` 패턴으로 오탐되어
  secret_egress@5 → DENY다. F10의 base64 marker 수정이 sha256 해시는 커버했지만
  URL 쿼리 파라미터는 커버하지 않는다. benign 통과율 10/11(90.9%)의 유일한
  false block이다.

## 검증 방법

`.venv/bin/python -m pytest -q`와 Rust 두 workspace의 locked tests,
현재 모듈을 import하는 legacy trace 공격 10개 및 structural round6,
E003 실제 함수 재검증을 실행했다.
legacy 스크립트 일부는 “우회 없음”일 때 exit=1이므로 JSON은 종료 코드와 출력 판정을 함께 저장한다.
안전하지 않은 고정 경로 삭제/낡은 SQLite 열 개수를 사용하는 V8/V9 gateway 스크립트를
그대로 실행하지 않고 임시 디렉터리 기반 현행 schema 회귀로 대체했다.
모든 역사적 sweep·플랫폼·공격군의 전수 재실행이라고 주장하지 않는다.
2026-09-22 재검증은 현재 트리 기준으로 재구축한 격리 사본에서 라운드9 스크립트와
`false_block_benchmark.py`를 실행했다.
