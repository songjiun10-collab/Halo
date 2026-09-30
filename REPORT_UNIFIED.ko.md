# HALO 통합 보안·권한 보고서

최종 갱신: 2026-09-21

> 현재 검수 기준: [2026-09-21 전체 검수 보고서](docs/reviews/2026-09-21-review.ko.md). 아래 역사적 수치와 과거 보고서의 “통과” 표현은 현재 작업트리의 보증으로 사용하지 않는다. 2026-09-21 수정 라운드 후 Python 회귀는 260개 통과·0개 실패이며 Rust 통계 워크스페이스와 CLI/reference 테스트도 통과했다.

이 문서는 HALO의 실험, 직접 공격, 샌드박스, 권한 게이트웨이 결과를 한
곳에서 확인하기 위한 기준 문서다. 개별 원본은 재현 근거로 보존하며,
서로 다른 실행 시점의 수치가 충돌하면 아래의 최신 검증 결과와 링크된
원자료를 우선한다. 이 문서는 완전한 격리나 침해 불가능성을 주장하지 않는다.

## 현재 판정

[보고서별 조치 원장](docs/reviews/REPORT_REMEDIATION.ko.md)에 32개 문서의 수정·재현·잔여 범위를 연결했다. trace 평가기는 이제 자기신고 승인을 기본 거부하고, critical finding과 효과 있는 작업의 불확실성은 fail-closed 처리한다. 이 변경도 OS 격리나 외부 불변 감사를 대신하지 않는다.

- Python 전체 회귀: 260개 통과 / 0개 실패
- 게이트웨이: 승인·실행·재생 거부·취소 경쟁·factory 재시작·실행 후 이중 오류를 회귀 검증했다. 과거 직접 공격 스크립트 전체를 다시 실행했다는 뜻은 아니다.
- macOS Seatbelt 직접 탐침: sysctl·네트워크·디렉터리 일부는 차단되지만
  Mach 호스트 정보와 마운트 정보 노출은 남음
- 외부 도구·인터넷 공개 배포: 연결하지 않음
- 수정 완료: SQLite 중첩 트랜잭션, 승인 INSERT 열 순서, factory 최초 시작, 실행 후 clock 오류 응답
- 운영 준비도: 미완료. TLS/proxy, 사용자 인증, 도구별 TOCTOU, 외부 감사,
  OS 격리, 장애 복구 검증이 남아 있음

## 권한 게이트웨이

[게이트웨이 구현](halo/gateway.py)은 승인자와 실행자 자격 증명을 분리하고,
정확한 도구·인자·버전에 짧은 capability를 묶는다. SQLite에 토큰 상태와
감사 단계를 기록하고 claim을 먼저 영속화한 뒤 도구를 호출한다. 알 수 없는
도구, 중복 JSON 키, 추가 필드, 만료·취소·재사용·도구 버전 변경은 거부한다.
실행 후 오류는 효과가 발생했을 수 있는 `503`으로 구분해 자동 재시도를
막는다. WSGI factory와 운영 전제는 [GATEWAY.ko.md](halo/GATEWAY.ko.md)에,
직접 공격 재현은 [HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md](halo/HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md)에 있다.

기본 등록 도구는 부작용 없는 SHA-256 계산뿐이다. 이 경계는 사용자 인증,
TLS, reverse proxy, 임의 코드 실행 방지, 분산 트랜잭션, OS sandbox를
제공하지 않는다. 실제 도구를 추가할 때는 도구별 범위·상태 재검사·자원
제한을 별도로 검증해야 한다.

## 직접 공격 결과

### 권한 입력과 provenance

사용자 명시 의도와 신뢰된 시스템 정책만 권한의 근거가 될 수 있다. 웹페이지,
이메일·문서, tool output, 다른 agent의 메시지는 DATA다. `trusted`,
`approved=True` 같은 본문 문자열을 승인으로 변환하면 안 된다. 기록 평가기
(`halo/safety_cases.py`)는 탐지기이며, 그 `ALLOW`를 capability로 직접 사용하지 않는다.

### OS 샌드박스

직접 프로브에서 차단된 경로: 숫자형 MIB sysctl, 프로세스 열거,
processor-set task 접근, launchd 접근, 인터페이스·라우팅 소켓,
홈 메타데이터와 디렉터리 열람.

탈출 또는 노출된 경로:

- `getmntinfo`: 호스트 마운트 목록과 볼륨 메타데이터 노출
- `mach_host_extended`/`mach_host_extras`: Darwin 커널 버전, 페이지 크기,
  CPU 정보 노출

`sem_open`은 처음 성공으로 보고됐으나 Darwin의 `SEM_FAILED=(-1)`를
ctypes `bool()`로 잘못 판정한 오류였다. 판정과 회귀 테스트를 수정한 뒤
강화 프로필에서 실제 `EPERM` 차단을 확인했다. `fsgetpath`는 잘못된 ctypes
fixture를 사용했으므로 차단으로 세지 않고 `unsupported`로 분류했다.

## 실험 결과의 의미

E001~E005는 합성 정책·메타데이터·모니터 점수에 대한 연구다. 상관된 오류는
중복 보호의 이점을 없애고, 숨은 공격군은 알고리즘 다양성 평가를 속일 수
있으며, 오래된 verdict는 상태 변화에 취약하다. 이 결과는 실제 frontier
모델이나 일반적 AI containment의 정량적 보증이 아니다.

관련 원자료와 역사적 스냅샷은 다음 문서에 연결돼 있다.

- [REPORT_INDEX.ko.md](REPORT_INDEX.ko.md): 최신 샌드박스 수치 기준점
- [HALO_EXPLOIT_V4_REPORT.md](HALO_EXPLOIT_V4_REPORT.md): 초기 종합 분석(역사적 스냅샷)
- [HALO_EXPLOIT_V5_DIRECT_REPORT.md](HALO_EXPLOIT_V5_DIRECT_REPORT.md): 직접 공격 기록
- [HALO_EXPLOIT_V1_DEEP_FINDINGS.md](HALO_EXPLOIT_V1_DEEP_FINDINGS.md), [HALO_EXPLOIT_V2_DEEP_FINDINGS.md](HALO_EXPLOIT_V2_DEEP_FINDINGS.md): HALO 정책 경계 탐침
- [artifacts/sandbox_benchmark/RUST_RUNNER.ko.md](artifacts/sandbox_benchmark/RUST_RUNNER.ko.md): Rust 실행기와 반복 수치
- [artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md](artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md): 탐침 판정 정정

## 전체 원본 병합 목록

아래 목록은 저장소에 존재하는 보안·공격·검증 보고서를 모두 포함한다.
통합 문서의 본문은 각 원본의 결론과 현재 유효성 범위를 요약하고, 원본
링크는 수치·실행 로그·세부 재현 절차의 보존 위치다. 원본과 통합 문서의
역사적 수치가 충돌하면 현재 체크아웃에서 다시 실행한 결과를 우선한다.

### 루트 분석·공격 보고서

- [HALO_EXPLOIT_V4_REPORT.md](HALO_EXPLOIT_V4_REPORT.md): 초기 E001~E005 종합 분석과 당시 완화 결과. 역사적 스냅샷.
- [HALO_EXPLOIT_V5_DIRECT_REPORT.md](HALO_EXPLOIT_V5_DIRECT_REPORT.md): HALO 코드 직접 공격과 경계 재현.
- [HALO_EXPLOIT_V6_DIRECT4_REPORT.md](HALO_EXPLOIT_V6_DIRECT4_REPORT.md): 직접 입력·정책 경계 후속 분석.
- [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](HALO_EXPLOIT_V3_DIRECT_FINDINGS.md): 직접 공격에서 확인된 입력·권한 결함.
- [HALO_EXPLOIT_V1_DEEP_FINDINGS.md](HALO_EXPLOIT_V1_DEEP_FINDINGS.md): safety case와 policy의 1차 깊은 탐침.
- [HALO_EXPLOIT_V2_DEEP_FINDINGS.md](HALO_EXPLOIT_V2_DEEP_FINDINGS.md): metadata subclass, generator 재사용, 비정상 평가 입력 후속 탐침.
- [HALO_EXPLOIT_V7_ULTRA_REPORT.md](HALO_EXPLOIT_V7_ULTRA_REPORT.md): 고강도 정책·실험 경계 탐침. 완전성 주장을 하지 않는다.
- [HALO_EXPLOIT_V8_ISOLATED_FINDINGS.md](HALO_EXPLOIT_V8_ISOLATED_FINDINGS.md): 격리 환경 게이트웨이 직접 탐침. DB 변조·동시성·파서 퍼징·타이밍 31개 확인 전부 방어, DB 쓰기 적은 신뢰 앵커로 재확인.

### 샌드박스·동적 검증 보고서

- [artifacts/sandbox_benchmark/REPORT.ko.md](artifacts/sandbox_benchmark/REPORT.ko.md): 초기 Seatbelt 비교 기준.
- [artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md](artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md): 샌드박스 공격 결과와 수정 전후 차이.
- [artifacts/sandbox_benchmark/HALO_SANDBOX_V1_DIRECT_ATTACK.ko.md](artifacts/sandbox_benchmark/HALO_SANDBOX_V1_DIRECT_ATTACK.ko.md): 단일 직접 공격 경로와 canary 결과.
- [artifacts/sandbox_benchmark/HALO_SANDBOX_V2_DYNAMIC_VERIFICATION.ko.md](artifacts/sandbox_benchmark/HALO_SANDBOX_V2_DYNAMIC_VERIFICATION.ko.md): 동적 실행 재검증과 잔여 노출.
- [artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md](artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md): Round-4 검증 기록.
- [artifacts/sandbox_benchmark/RUST_RUNNER.ko.md](artifacts/sandbox_benchmark/RUST_RUNNER.ko.md): Rust 100-case runner와 반복 결과.
- [artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md](artifacts/sandbox_benchmark/HALO_SANDBOX_V4_CORRECTIONS.ko.md): `SEM_FAILED` 오판과 잘못된 `fsgetpath` fixture 정정.
- [REPORT_INDEX.ko.md](REPORT_INDEX.ko.md): 최신 샌드박스 수치와 원자료 우선순위 기준.

### 권한·보호막 보고서

- [halo/AUTHORITY.ko.md](halo/AUTHORITY.ko.md): 호스트 소유 capability와 메모리 객체 경계.
- [halo/GATEWAY.ko.md](halo/GATEWAY.ko.md): WSGI 게이트웨이 운영 조건·API·장애 복구.
- [halo/HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md](halo/HALO_GATEWAY_V1_ATTACK_REVIEW.ko.md): 인증·토큰·재생·취소·감사 장애 공격 검토.
- [rust/ENFORCEMENT.ko.md](rust/ENFORCEMENT.ko.md): Rust 보호 객체 접근 계약과 신뢰 경계.
- [rust/SHIELD.ko.md](rust/SHIELD.ko.md): 보호막·검증기 가용성·ACL 회귀 실험.
- [rust/SANDBOX_BOUNDARY.ko.md](rust/SANDBOX_BOUNDARY.ko.md): Rust 실행기와 OS 격리 한계.
- [rust/ROW_AUDIT.ko.md](rust/ROW_AUDIT.ko.md): 행 단위 감사·증거 보존 규칙.

원본 파일은 통합 문서에 흡수됐다고 간주해 삭제하지 않는다. 원본 삭제는
재현 근거와 당시 환경을 잃게 하므로 별도 승인 없이는 수행하지 않는다.

## 재현 명령

```sh
.venv/bin/python -m pytest -q
.venv/bin/python -m pytest tests/test_gateway.py tests/test_gateway_adversarial.py tests/test_authority.py -q
```

macOS 직접 탐침은 다음 명령으로 실행한다. 결과에 `escaped`, `error`,
`unsupported`가 있으면 성공 게이트가 아니다.

```sh
.venv/bin/python artifacts/sandbox_benchmark/direct_escape_probe.py
.venv/bin/python artifacts/sandbox_benchmark/run_round5.py --repeats 1 --output /tmp/halo-round5.json
```

## 배포 전 남은 작업

실제 배포 전에는 인증된 사용자 의도 수신, TLS와 proxy 제한, 별도 서비스
사용자·프로세스, 외부 불변 감사 저장소, 도구별 원자적 상태 확인, 장애 후
효과 대조 절차, OS VM 수준 격리를 별도로 설계하고 검증해야 한다. 현재
문서와 테스트는 그 경계를 명시하며, 아직 완료됐다고 표시하지 않는다.
