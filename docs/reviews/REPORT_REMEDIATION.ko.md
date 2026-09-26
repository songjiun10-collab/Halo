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

2026-09-25 후속 5: [tools/check_evidence_registry.py fingerprint 경로 탈출 수정](2026-09-25-evidence-registry-path-confinement-fix.ko.md).
`recorded_fingerprints`의 경로 키가 검증 없이 `repo_root / rel_path`로
결합되어, 절대경로(pathlib join이 repo_root를 버림)나 `..` 상위 탈출로
`repo_root` 밖 임의 파일을 해시해 리포트에 노출할 수 있었다 — `halo doctor
verify`가 항상 실행하는 검증 진입점의 실제 코드 결함. `validate_entry`에서
두 경우 모두 다른 스키마 위반과 동일하게 fail-closed(exit 1)로 차단하도록
수정. Python 408개 통과.

2026-09-25 후속 6: [halo doctor verify()의 sandbox security_gate 침묵 누락 수정](2026-09-25-doctor-verify-sandbox-gate-silent-gap-fix.ko.md).
`verify --scope sandbox/all`에서 러너 바이너리가 아직 빌드되지 않았으면
`security_gates`가 조용히 빈 배열이 되어 "확인 안 함"과 "문제 없음"을
구분할 수 없었다 — 이 모듈의 다른 곳(rust-tests/sandbox-tests)이 지키는
"환경 미설치는 not-installed로 명시 보고" 관례를 게이트만 어겼다. 항상
게이트 항목을 내도록 수정(바이너리 없으면 `{"ok": None, "detail": "not
built"}`). `security_gate=false` 자체는 이미 문서화된 B1 환경 한계이며 이
수정으로 바뀌지 않는다. Python 418개 통과.

2026-09-26 후속: [macOS 샌드박스 clean-launch 메타데이터 잔여 사례 9→3건 축소](../../artifacts/sandbox_benchmark/RUST_RUNNER.ko.md).
`rust_runner`의 sandbox-exec 프로파일을 `file-read-data`/`file-read-metadata`로
분리해 `/`에 대한 metadata 허용을 제거하고 outside 경로의 metadata read를
명시적으로 deny했다. 판정기도 강화해 `metadata_chdir`이 실제로 canary를
읽는지 확인하고(단순 syscall 성공만으로 escaped 처리하지 않음),
`getcwd`/`getpid`/`access("/", F_OK)`처럼 민감하지 않은 자기 프로세스 정보는
새 `informational` 분류로 분리했다 — 이 분류는 판정 게이트를 통과시키지
않는다. 그 결과 root `fstatat`/`lstat` 2건은 실제로 차단되고, 3건은
informational로 재분류됐다. 실제 `--repeats 1` 실행으로 clean-launch 잔여
사례가 9건에서 3건(`statvfs`/`statfs`/`pathconf`, 여전히 escaped)으로 줄었음을
확인했다 — `security_gate.passed`는 여전히 `false`이며 통합 테스트
(`tests/runner.rs`)가 이를 명시적으로 단언한다. B1(별도 격리 환경 필요) 자체를
해결했다고 주장하지 않는다. Rust 16개 + Python 418개 통과.

2026-09-26 후속 2: [macOS 샌드박스 clean-launch 잔여 3건(statvfs/statfs/
pathconf) 추가 수정 — 9→3→0](../../artifacts/sandbox_benchmark/RUST_RUNNER.ko.md).
위 9→3 축소 이후 남은 세 호출은 경로 기반 `file-read-metadata` deny로는
막히지 않았다 — Seatbelt의 vnode metadata 필터가 애초에 이 syscall들의
mount/파일시스템 수준 조회를 다루지 않기 때문이다. 프로파일에 `(deny
syscall-unix (syscall-number SYS_statfs SYS_statfs64 SYS_fstatfs
SYS_fstatfs64 SYS_pathconf SYS_fpathconf))`를 추가해 경로·파일서술자
인자와 무관하게 syscall 번호 단위로 차단했다(`statvfs`류는 libc 내부에서
`statfs`류로 구현되어 함께 막힌다). 새 회귀 테스트로 파일서술자 기반
변형까지 `sandbox-exec` 자식 프로세스 안에서 재실행해 `EPERM`을 직접
확인했다. 이 기기의 실제 `sandbox-exec`로 재검증한 결과 clean-launch는
차단 97·정보성 3·허용 3(escaped 0)이 됐고 `security_gate.passed=true`,
`residual_cases=[]`다 — B1이 이 러너의 고정 100개 probe 범위 안에서는
더 이상 열려 있지 않다. 이 러너가 검사하는 시행에 한정된 결과이며 완전한
호스트 메타데이터 기밀성을 주장하지 않는다. Rust 17개 + Python 418개
통과.

2026-09-26 후속 3: [Docker 게이트웨이 이미지에 Claude Code CLI·guard-hook·
사고 스킬 내장](2026-09-26-docker-embed-claude-cli-hook-skills.ko.md).
버그 수정이 아니라 사용자가 명시적으로 요청한 기능 추가 — 게이트웨이
컨테이너 안에서 작업할 때 호스트와 동일한 안전 후크·스킬을 쓸 수 있도록
Dockerfile 빌드 단계에 Node.js·Claude Code CLI·`songjiun10-collab/hook`
플러그인·`songjiun10-collab/Senior-thinking-skills`를 추가했다. `halo`
사용자를 `--no-create-home`에서 `--create-home`으로 바꿔 `$HOME`이 없어
플러그인 설정이 깨지는 문제를 먼저 막았다. **미검증**: 로컬에 Docker
데몬이 없어 실제 빌드로 확인하지 못했다 — `claude plugin` CLI의 정확한
비대화형 인자 계약이 특히 불확실하다. 게이트웨이 런타임 자체는 건드리지
않아 Python 418개는 이 변경과 무관하다.

2026-09-26 후속 4: [macOS 샌드박스 판정기의 정보성(informational) 분류 허위
PASS 보완](../../artifacts/sandbox_benchmark/RUST_RUNNER.ko.md). 자기 신고
`status="ok"`만으로 `metadata_getpid`/`metadata_getcwd`/`metadata_access_parent`를
무조건 informational로 분류했던 지점을 강화 — PID는 부모가 실제로 생성한
child PID와, cwd는 부모가 지정한 work 경로와 일치해야 informational로
인정하고, 불일치·누락·잘못된 타입은 `error`로 분류한다. `report_passes()`도
`attacks_informational` 필드가 음이 아닌 정수인지, 반복당 지정된 3개 사례
수를 초과하지 않는지 검증해, 조작되거나 잘못된 요약이 임의의 escaped/blocked
공격을 informational로 둔갑시켜 게이트를 통과시키는 경로를 막았다. 이는
판정기 자체의 허위 PASS를 막는 보완이며 새로운 OS 권한 탈출을 발견했다는
의미는 아니다 — `security_gate.passed`가 검사하는 실제 샌드박스 경계는
바뀌지 않았다. Rust 18개(단위 16 + 통합 2) 통과, `cargo clippy --all-targets
-- -D warnings` 통과. 이 변경은 Python 코드를 건드리지 않는다.

2026-09-26 후속 5: [E007 — AI 전용 승인자/실행자 분리 게이트웨이 접근 모델](../../experiments/e007_dual_agent_provenance_gate/README.ko.md).
사용자가 "헤일로는 이제 AI만을 위한 공간"이라는 방향을 밝히고 게이트웨이
접근 모델의 재설계를 요청했다. `halo/authority.py`·`halo/gateway.py`·
`halo/gateway_app.py`·`halo/dev_server.py`는 전혀 수정하지 않고, 승인자·
실행자 역할을 각자 자신의 게이트웨이 키만 쥔 별도 OS 프로세스로 실행하는
새 참조 구현(`experiments/e007_dual_agent_provenance_gate/`)을 추가했다.
승인 판단은 전적으로 기존 `halo.policy.decide()` + `halo.safety_cases
.evaluate_trace()`가 내리며(자유 형식 LLM 판단 없음), 실행자가 자기 신고
provenance를 `"trusted"`로 주장해도 승인자가 독립적으로 분류한
`host_provenance`가 이를 잡아내 거부하는, 이 저장소의 기존 P9-B2
provenance-laundering 패턴을 승인/실행 경계에서 재현·검증했다(대조군으로
"자기 신고를 그대로 믿었다면 ALLOW였을 것"도 같은 스위트에서 직접 증명).
Claude가 핵심 로직(`experiment.py`, `channel.py`의 `Channel`/
`LoopbackChannel`)과 그 단위·HTTP 종단 간 테스트를, Codex가 실제 2-프로세스
배관(`UnixSocketChannel`, `approver_process.py`/`executor_process.py`/
`run_two_process_demo.py`와 그 테스트)을 나눠 작업했다. Python 464개(신규
46개) 통과. `intent_id`는 여전히 추적용 식별자일 뿐이며, 이 실험은 프로덕션
`Authority`/`Gateway`가 요구하는 "호스트가 인증한 사용자 의도" 요건을
대체하지 않는다 — README의 "정직한 한계" 참고.

2026-09-26 후속 6: [Mac을 서버로 게이트웨이 인터넷 공개 1단계 — 프로덕션
서버 + TLS + DDNS](DEPLOY.ko.md). 사용자가 실제 게이트웨이를 인터넷에
공개하기를 요청했고, 프로덕션 서버·TLS를 먼저 갖추는 방안(권장)과 이
Mac을 로컬 호스트로 쓰는 방안, 무료 동적 DNS(DuckDNS)를 확인받았다.
`halo/authority.py`·`halo/gateway.py`·`halo/gateway_app.py`·
`halo/dev_server.py`는 전혀 수정하지 않고, 새 `halo/wsgi.py`(umask 설정 후
`dev_server.application()`을 감싸는 최소 엔트리포인트)를 추가해 개발용
`wsgiref`를 gunicorn으로 교체했다. `compose.prod.yaml` 오버레이가 기존
`compose.yaml`의 하드닝(read_only, cap_drop, 시크릿, 헬스체크, 네트워크)을
재선언 없이 그대로 유지한 채 `command`만 gunicorn 호출로 바꾼다. TLS는
호스트 네이티브 Caddy가 담당하며, 1단계 `deploy/Caddyfile`은 공개 라우트가
아직 없으므로 모든 경로를 404로 응답한다 — `/approve`·`/execute`·
`/revoke`·`/healthz`는 여전히 loopback 전용이다. `tools/duckdns_update.py`
(stdlib만 사용, 0600 파일에서만 토큰을 읽고 symlink는 거부)와 launchd
plist 템플릿으로 DNS 갱신을 자동화했다. 인증 없는 공개 API 래퍼
(`halo/public_api.py`, 요청마다 fsync 디스크 쓰기 3회에 회전 없는 audit
테이블이라는 실제 남용 벡터)는 설계만 해두고 이번 배치에 구현하지
않았다 — 별도 승인 필요. Python 9개 신규(`test_wsgi.py`, `test_duckdns_update.py`)
포함 473개 통과. **미검증**: 이 세션에는 Docker 데몬도 대상 라우터·macOS
시스템 설정 접근도 없어, 실제 `docker compose -f compose.yaml -f
compose.prod.yaml up` + Caddy + DuckDNS + launchd 전체 배포 경로는
사용자가 자신의 Mac·네트워크에서 직접 확인해야 한다 — `docs/DEPLOY.ko.md`의
"정직한 한계"·"사용자가 직접 해야 하는 것" 참고. `halo/GATEWAY.ko.md`의
"인터넷 공개 운영 준비 완료로 판정하지 않는다"는 이 배포 이후에도
바뀌지 않는다.

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
