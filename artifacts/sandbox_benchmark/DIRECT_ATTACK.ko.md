# HARDENED 샌드박스 직접 공격 실측 보고서 (Live Direct Attack)

> 2026-09-14의 호스트 직접 공격 기록이다. 아래의 호스트 식별자·경로 예시는 비식별화했다. 현재 샌드박스 기준 수치와 게이트는 [REPORT_INDEX.ko.md](../../REPORT_INDEX.ko.md)와 [최신 JSON](../../rust/results/attack-100-validated-20.json)을 우선한다.

2026-09-14, macOS 27.0 (Apple Silicon, arm64) / Python 3.12 환경에서 수행.
기존 고정 벤치마크 스위트(`run_exploits` / `run_breakout` / `run_round3`)를 실행하는 대신,
**HARDENED 프로파일 안에 직접 들어가 약 60종의 벡터를 실시간으로 실행**하여 판정한 실측 결과이다.

- 대상 프로파일: `run_exploits.hardened_profile` (deny default + Cellar/System/Library/usr/lib/usr/share/work + 5종 sysctl + 인터프리터 전용 exec + `deny process-info*`)
- 방어 부가: `RLIMIT_NPROC=1`, 클린 환경(`HOME`/`TMPDIR`=work), `close_fds=True, pass_fds=()`
- 표적 미끼: `<tmp>/outside/canary.txt` (랜덤 시크릿, sandbox 밖에 배치)
- 판정 기준: "탈출" = 카나리 파일 **내용** 획득, 또는 샌드박스 정책이 중재하지 않는 평면으로의 호스트 정보/자원 접근

---

## 1. 핵심 결과

| 구분 | 결과 |
| --- | --- |
| 카나리 파일 **내용** 탈취 | **실패 — 약 40종 파일 평면 벡터 전부 차단** |
| 정보/자원 탈출 평면 | **5개 평면 유출 확인** (아래 표) |
| 임의 코드 실행 / root 권한 획득 | 확인 안 됨 |

macOS 27의 seatbelt는 파일·네트워크·프로세스·신호·Mach 룩업 평면을 견고하게 중재하지만,
**IOKit(Mach 호스트 포트 경유), System V IPC 생성, 파일시스템 메타데이터, sysctl/Mach 호스트 통계** 평면은
프로파일의 `(deny default)`와 무관하게 열려 있다.

---

## 2. 유출(탈출) 평면 — 실증값

### 2.1 IOKit 레지스트리 — 호스트 하드웨어 식별 전부 유출
IOKit은 `IOServiceGetMatchingServices` 계열로 접근하며 seatbelt의 `mach-*` / `file-*` 규칙이 중재하지 않는다.
HARDENED 내부에서 그대로 열거·읽기가 가능했다.

| 항목 | 실측값 |
| --- | --- |
| Mac 시리얼 번호 | `<redacted>` |
| IOPlatformUUID | `<redacted>` |
| `gethostuuid()` | 동일 UUID가 반환됨(값은 비식별화) |
| 배터리 시리얼 | `<redacted>` |
| 이더넷 MAC | `<redacted>` |
| 보드 ID / 모델 | `<redacted>` / Apple Silicon Mac |
| 디스크 | 장치 식별자 비식별화, DiskImage 장치 열거 |
| 레지스트리 규모 | IOService 1,584개 노드 열거 |

### 2.2 Mach 호스트 포트 — 호스트 메모리/CPU 통계 유출
`mach_host_self()` + `host_statistics` / `host_statistics64` / `host_processor_info`가 정책 검사 없이 성공한다.
호스트 VM 정보(총/가용 메모리, 페이지 수 등)와 CPU 통계가 유출된다. `host_get_special_port`는 `KERN_NOT_SUPPORTED`로 차단됨.

### 2.3 OS·네트워크·파일 메타데이터 유출
| 채널 | 실측값 |
| --- | --- |
| 호스트네임 | `<redacted>.local` (`kern.hostname` allowlist 포함) |
| uname / 커널 | `Darwin 27.0.0 arm64`, 커널 빌드 문자열 |
| allowlist sysctl 5종 | `hw.machine`, `kern.hostname`, `kern.ostype`, `kern.osrelease`, `kern.version` |
| `/System/Library` 파일 내용 | `SystemVersion.plist`(빌드 ID), LaunchDaemons 목록 |
| 루트 디렉터리 목록 | `/` 전체 구조 (`(literal "/")` 읽기 허용) |
| 파일시스템 지오메트리 | `statvfs` / `getfsstat` — `/`, `/private/etc`, `/Users/...` 볼륨 블록 수 |
| `getloadavg` / `getlogin` | 로드 평균, `root`(제어 터미널 부재 시 기본값) |

### 2.4 System V IPC — 호스트 전역 객체 생성 + 영속 누수
`semget`이 반복적으로 성공한다(4회 연속 검증). `shmget`/`msgget`도 조건에 따라 성공.
핵심은 **정리(syscall)가 샌드박스에 의해 차단**된다는 점이다.

| syscall | 결과 |
| --- | --- |
| `semget(IPC_PRIVATE, 1, IPC_CREAT\|0600)` | 성공 (id 반환) |
| `shmget` / `msgget` (동일 플래그) | 조건부 성공 |
| `semop` / `msgsnd` / `msgrcv` / `semctl(RMID)` / `shmctl(RMID)` | 전부 EPERM 차단 |

그 결과 sandbox 안에서 만든 세마포어/큐/공유메모리가 **프로세스 종료 후에도 호스트에 남을 수 있다**.
외부에서 잔존 객체를 확인한 뒤 테스트 자원은 모두 정리했다.
이해 관계: (1) 호스트 전역 IPC 테이블 고갈 DoS, (2) 동일 UID의 다른 sandbox 인스턴스가 잔존 객체를 재사용할 수 있는 크로스-샌드박스 채널. `(deny default)`가 이 평면을 막지 못한다.

---

## 3. 차단 확인된 벡터 — 파일 평면은 견고

카나리 **내용** 읽기를 위한 시도 전부 차단(EPERM/EACCES). 상세:

| 범주 | 시도 벡터 |
| --- | --- |
| 직접/경로 변형 | 직접 read, `work/../outside` `..` 트래버설, `//`, `/./` 변형, 절대 경로, `/System/Volumes/Data` 별칭, `/System/Library/../../` prefix, `/.vol/<dev>/<inode>` |
| 링크/카피 | symlink(파일), symlink(dir), clonefile, hardlink(`link`/`linkat`), rename(`rename`/`renamex_np SWAP/EXCL`) |
| FD/디렉터리 | `openat`+`..`, `fchdir`+상대경로, 상속 FD 스캔(0~15, 없음), `/dev/fd` |
| 메타데이터 | `getattrlist`, `stat` (canary), readlink 루트 심링크 |
| 프로세스/메모리 | `task_for_pid`, `task_name_for_pid`, `proc_pidpath`, `proc_listallpids`, `proc_name`, KERN_FILE/KERN_PROC sysctl, `process-info*` |
| IPC/네트워크 | mach-lookup(`BOOTSTRAP_NOT_PRIVILEGED=1100`), UNIX/loopback 소켓, POSIX shm/sem(`shm_open`/`sem_open`), getifaddrs |
| 샌드박스 내부 재구성 | `sandbox_init` 재호출(허용 프로파일로 교체 시도 → SIGTRAP 종료), `sandbox_exec`(심볼 미노출) |
| 기타 | `/usr/share/zoneinfo`, `/usr/lib` 탈출 심링크 스캔(0건), identity lookup(`getpwuid` → "uid not found", Directory Services 차단) |

특히 기존에 회자되던 `(literal "/")` file-read-data의 재귀 읽기 퀴크는 macOS 27에서 수정되어
`/private/var/folders/...` 하위는 전부 EPERM으로 차단된다.

---

## 4. 함의

1. **호스트 식별 정찰은 확인한 범위에서 개방.** 시리얼/MAC/UUID/보드 ID/배터리 시리얼이 단일 IOKit 호출로 유출되어,
   신뢰할 수 없는 모델이 호스트를 고유하게 지문화하고 정밀 타깃 피싱에 활용할 수 있다.
2. **`(deny default)`는 커널 하위 시스템 전부를 덮지 않는다.** IOKit(host 포트), SysV IPC 생성은 중재 밖이다.
   프로파일 기반 차단만으로는 이 평면들을 폐쇄할 수 없다.
3. **SysV IPC 영속 객체는 정리 불가 결합으로 DoS/교차 채널 위험.** `IPC_RMID`가 샌드박스에 차단되므로
   매 실행이 호스트 IPC 테이블에 영속 흔적을 남긴다.
4. **카나리 파일 내용 격리는 현재 상태에서 유효.** 다만 이는 "파일 평면 한정" 성공이며, 전체 격리를 의미하지 않는다.

---

## 5. 권고사항

1. **IOKit/Mach 호스트 평면 차단**: 신뢰할 수 없는 모델 실행 시 별도 게스트/컨테이너를 사용하거나,
   프로파일에서 접근 가능한 Mach 호스트 포트 사용을 최소화한다. `sandbox-exec` 프로파일만으로는 이 평면을 닫을 수 없다.
2. **System V IPC 폐쇄**: `semget`/`shmget`/`msgget` 생성이 정책 밖이므로, 실행 전
   `(deny sysv-ipc*)` 또는 샌드박스 바깥에서의 RLIMIT·감사(audit)로 IPC 자원 생성을 제한하고
   실행 후 잔존 객체를 정리하는 회수 단계를 부모가 수행한다.
3. **호스트 식별 정보 최소화**: 시리얼/UUID/MAC 노출을 막으려면 IOKit 접근 자체를 게스트로 격리해야 한다.
   `(literal "/")` 읽기와 `kern.hostname` allowlist는 남은 정찰 경로이므로 제거가 가능한 게스트에서 제거한다.
4. **파일 평면 유지**: canary 내용 차단이 실측된 현재의 Cellar/System/Library/usr 읽기 스코프를 유지한다.
5. **SysV IPC 정리 회수**: 직접 공격 스위트 실행 후 `ipcrm -s/-q/-m` 회수 절차를 CI/스크립트에 포함한다.

---

## 6. 재현

직접 공격 프로브는 로컬에서만 실행한 임시 스크립트(`/tmp/halo-direct/`)로 저장소에 커밋하지 않았다.
재현이 필요하면 위 표의 syscall 시퀀스를 `run_exploits.hardened_profile` 아래에서 실행하면 된다.
관련 벤치마크 재현:

```sh
.venv/bin/python artifacts/sandbox_benchmark/run_exploits.py --repeats 5
.venv/bin/python artifacts/sandbox_benchmark/run_breakout.py --repeats 5
```

주의: `run_round3.py`의 기록된 `madness_results.json`은 argv 언패킹 버그로 전부 `launch_error`인 **stale 데이터**다
(현재 소스는 이미 3-튜플로 수정됨). 재실행 전 재기록해야 한다.
