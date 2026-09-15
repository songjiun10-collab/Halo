# HALO 통합 보안·권한 보고서

최종 갱신: 2026-09-15

이 문서는 HALO의 실험, 직접 공격, 샌드박스, 권한 게이트웨이 결과를 한
곳에서 확인하기 위한 기준 문서다. 개별 원본은 재현 근거로 보존하며,
서로 다른 실행 시점의 수치가 충돌하면 아래의 최신 검증 결과와 링크된
원자료를 우선한다. 이 문서는 완전한 격리나 침해 불가능성을 주장하지 않는다.

## 현재 판정

- Python 전체 회귀: 183개 이상 통과(게이트웨이·권한 경계 포함)
- 게이트웨이 직접 공격: 인증 우회, 위조 capability 실행, 재생, 취소 경쟁,
  감사 장애 경계를 재현하고 수정 후 통과
- macOS Seatbelt 직접 탐침: sysctl·네트워크·디렉터리 일부는 차단되지만
  Mach 호스트 정보와 마운트 정보 노출은 남음
- 외부 도구·인터넷 공개 배포: 연결하지 않음
- 운영 준비도: 미완료. TLS/proxy, 사용자 인증, 도구별 TOCTOU, 외부 감사,
  OS 격리, 장애 복구 검증이 남아 있음

## 권한 게이트웨이

[게이트웨이 구현](halo/gateway.py)은 승인자와 실행자 자격 증명을 분리하고,
정확한 도구·인자·버전에 짧은 capability를 묶는다. SQLite에 토큰 상태와
감사 단계를 기록하고 claim을 먼저 영속화한 뒤 도구를 호출한다. 알 수 없는
도구, 중복 JSON 키, 추가 필드, 만료·취소·재사용·도구 버전 변경은 거부한다.
실행 후 오류는 효과가 발생했을 수 있는 `503`으로 구분해 자동 재시도를
막는다. WSGI factory와 운영 전제는 [GATEWAY.ko.md](halo/GATEWAY.ko.md)에,
직접 공격 재현은 [GATEWAY_ATTACK_REVIEW.ko.md](halo/GATEWAY_ATTACK_REVIEW.ko.md)에 있다.

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
- [EXPLOIT_REPORT.md](EXPLOIT_REPORT.md): 초기 종합 분석(역사적 스냅샷)
- [EXPLOIT_REPORT_DIRECT.md](EXPLOIT_REPORT_DIRECT.md): 직접 공격 기록
- [DEEP_EXPLOIT_FINDINGS.md](DEEP_EXPLOIT_FINDINGS.md), [DEEP_EXPLOIT_FINDINGS_2.md](DEEP_EXPLOIT_FINDINGS_2.md): HALO 정책 경계 탐침
- [artifacts/sandbox_benchmark/RUST_RUNNER.ko.md](artifacts/sandbox_benchmark/RUST_RUNNER.ko.md): Rust 실행기와 반복 수치
- [artifacts/sandbox_benchmark/CORRECTIONS.ko.md](artifacts/sandbox_benchmark/CORRECTIONS.ko.md): 탐침 판정 정정

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
