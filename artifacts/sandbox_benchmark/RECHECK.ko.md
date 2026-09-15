# 2026-09-12 수정 및 재검증

현재 상태는 **완전 격리 미달**이다. 기본 공격을 차단해도 호스트 메타데이터 조회 경로가 남는다. `EXPLOIT_REPORT.ko.md`의 과거 수치를 현재 보안 보장으로 사용하지 않는다.

수정 사항:

- 외부 쓰기 표적의 변경·삭제를 자식 응답보다 먼저 검사한다.
- 타임아웃·예상하지 못한 오류·미실행은 차단 성공이 아니다. 반복 횟수 0을 거부하고, 실패 보고서는 종료 코드 1을 반환한다.
- E002의 알려진 모집단이 없는 조건은 `known_tpr_mean=NaN`으로 기록한다.
- `/opt` 및 `/opt/homebrew`의 재귀 메타데이터 권한을 리터럴 조상 경로로 줄였다. 강화 프로파일은 `hw.*` 대신 런타임에 필요한 이름만 허용한다.
- breakout의 변경 가능한 미끼를 매 시행마다 초기화한다. 외부 하드링크·이동·희생 프로세스 종료를 부모가 확인한다.
- Mach 포트 ABI를 32비트로 수정했다. 로컬 macOS SDK `servers/bootstrap.h`가 정의한 `BOOTSTRAP_NOT_PRIVILEGED=1100`만 명시적 거부로 판정하고 다른 실패는 오류로 남긴다.
- 실제 호스트 이름 쓰기, 실제 keychain 조회, `/etc/passwd` 하드링크 코드는 제거했다. 설정 파일 읽기는 임시 설정 미끼로 대체했다. 과거 Homebrew 실제 설정 검사와 동일한 커버리지는 아니다.

검증 명령:

```sh
.venv/bin/python -m pytest -q
.venv/bin/python artifacts/sandbox_benchmark/run_benchmark.py --repeats 5
.venv/bin/python artifacts/sandbox_benchmark/run_exploits.py --repeats 5
.venv/bin/python artifacts/sandbox_benchmark/run_breakout.py --repeats 5
```

각 공격을 5회 반복한다. 기본 벤치마크 clean launch는 정상 작업 15/15, 공격 차단 45/45다. 별도 기본 공격 스위트는 BASELINE에서 25/25 성공, HARDENED에서 25/25 차단이다. 이 수치는 독립 공격 45종·25종을 뜻하지 않는다.

최종 회귀 테스트는 94개 통과했다. 확장 검사 HARDENED는 45회 중 차단 30회, 메타데이터 조회 성공 15회, 실행 오류 0회이며 종료 코드 1이다. 이 실패는 미해결 노출을 감지한 결과다.

확장 검사에서는 루트 목록, 볼륨 통계, `hw.machine`/`kern.hostname` 조회가 남아 실패한다. 루트 읽기를 제거하면 현재 Python의 로더가 종료되고, 두 sysctl을 제거하면 `ctypes`의 `os.uname()` 초기화가 실패했다. 따라서 해당 허용을 차단 성공으로 위장하지 않는다. 이 호스트에서 `sandbox-exec` 프로파일만으로 해당 노출까지 제거한 실행은 검증되지 않았다. 호스트 정보 비노출을 요구하는 실행에는 별도 게스트 환경을 준비하고 재검증해야 한다. 현재 VM/컨테이너 실행 도구는 설치되어 있지 않다.

확장 검사 결과 파일의 `escaped`에는 메타데이터 조회 성공도 포함된다. 임의 코드 실행이나 임의 파일 내용 유출을 의미하지 않는다. syscall 거부와 `RLIMIT_NPROC=1`에 따른 프로세스 생성 거부를 구분할 수 있도록 errno 증거를 보관하며, Mach 서비스 거부만으로 모든 IPC 경로의 안전성을 주장하지 않는다.
