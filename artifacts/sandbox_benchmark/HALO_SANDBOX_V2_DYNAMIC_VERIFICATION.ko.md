# HALO macOS 샌드박스 동적 검증 보고서 (2026-09-13)

> 2026-09-21 후속 상태: **미완료 / B1**. [보고서별 조치 원장](../../docs/reviews/REPORT_REMEDIATION.ko.md)에서 수정·재현과 잔여 범위를 구분한다. 아래 과거 수치는 현재의 전체 해결 판정이 아니다.

> 과거 실행의 고정 기록이다. 최신 100개 사례·20회 반복·보안 게이트 판정은 [REPORT_INDEX.ko.md](../../REPORT_INDEX.ko.md)와 [최신 JSON](../../rust/results/attack-100-validated-20.json)을 우선한다.

> 실제 `sandbox-exec` 프로세스 공격 기반 동적 검증. 합성 카나리·루프백 리스너·희생 프로세스만 사용하며 외부 시스템·실계정은 비대상이다. 벤치(하네스)가 아니라 OS 수준 격리 경계를 실프로세스로 공격했다.

## 실행 환경

- **일시:** 2026-09-13
- **플랫폼:** macOS (Apple Silicon) / Python 3.12
- **검증 명령:**
  ```sh
  .venv/bin/python -m pytest -q
  .venv/bin/python artifacts/sandbox_benchmark/run_benchmark.py --repeats 5
  .venv/bin/python artifacts/sandbox_benchmark/run_exploits.py --repeats 5
  .venv/bin/python artifacts/sandbox_benchmark/run_breakout.py --repeats 5
  .venv/bin/python artifacts/sandbox_benchmark/run_madness.py --repeats 5
  .venv/bin/python artifacts/sandbox_benchmark/run_round3.py --repeats 5
  ```
- **재현 결과 파일:** `results.json`, `exploit_results.json`, `breakout_results.json`, `madness_results.json`, `round3_results.json`

---

## 1. 회귀 테스트

- **159/159 통과** (입력 검증, 메트릭 경계, 샌드박스 워크스페이스, 보안 회귀)

---

## 2. 기본 I/O 격리 (run_benchmark)

고정 9종 공격 (절대/트래버설/심링크 읽기·쓰기, 자식 프로세스 읽기, TCP 루프백, 환경변수, 상속 FD) × 5회.

| 모드 | 정상 허용 | 공격 차단 | 공격 탈출 | 오류 |
| --- | ---: | ---: | ---: | ---: |
| unconfined_control | 15/15 | 0/45 | 45/45 | 0 |
| sandbox_inherited_capabilities | 15/15 | 35/45 | 10/45 | 0 |
| sandbox_clean_launch | 15/15 | **45/45** | 0/45 | 0 |

- 정상 동작은 전 모드 15/15 보존.
- **clean launch에서 기본 I/O 공격 전량 차단.** 상속 캐퍼빌리티(환경 시크릿·FD)는 10회 탈출 → 클린 런치의 필요성 재확인.

---

## 3. 고급 익스플로잇 5종 (run_exploits)

`sysctl_parent_env`, `metadata_fingerprint`, `homebrew_conf_read`, `system_recon`, `unbounded_fork` × 5회.

| 프로파일 | 탈출 | 차단 |
| --- | ---: | ---: |
| BASELINE | 25/25 | 0/25 |
| HARDENED | 0/25 | **25/25** |

- 과거 보고서의 5대 취약점이 모두 강화 프로파일에서 차단 확인.
- `sysctl_parent_env`: KERN_PROCARGS2 기반 부모 ARGV/ENV 탈취 → `deny process-info*`로 차단.
- `unbounded_fork`: RLIMIT_NPROC=1 (defense-in-depth) 적용.

---

## 4. 2라운드 브레이크아웃 9종 (run_breakout)

새 벡터: `hardlink_canary`, `signal_victim`, `signal_probe`, `mach_lookup`, `statfs_probe`, `rename_steal`, `reexec_canary`, `listdir_root`, `sysctl_hw_leak` × 5회.

| 프로파일 | 차단 | 탈출 |
| --- | ---: | ---: |
| BASELINE | 25/45 | 20/45 |
| HARDENED | 30/45 | **15/45** |

### HARDENED 잔존 탈출 (5회 전부 동일)

| 벡터 | 유형 |
| --- | --- |
| `statfs_probe` | 볼륨 레이아웃 노출 (statvfs) |
| `listdir_root` | 루트·/Users·홈 디렉터리 목록 노출 |
| `sysctl_hw_leak` | `hw.machine`/`kern.hostname` 등 호스트 핑거프린팅 |

- 하드링크·시그널·Mach 서비스·rename·reexec은 차단 (hardlink/rename은 외부 실측 검증 포함).
- 잔존 탈출은 **임의 코드 실행·파일 내용 유출이 아닌 호스트 메타데이터 노출**. 루트 리터럴과 hw sysctl은 런타임 로더가 요구하는 예외로, 단일 프로파일로 제거 시 Python 로더·`os.uname()` 초기화 실패 (RECHECK.ko.md와 동일 한계).

---

## 5. 매드니스 6종 (run_madness)

`ioregistry_enum`, `hw_machine`, `hw_model`, `kern_osversion`, `task_port`, `statfs_host` × 5회.

| 프로파일 | 차단 | 탈출 | 에러 |
| --- | ---: | ---: | ---: |
| BASELINE | 10/30 | 20/30 | 5 |
| HARDENED | 20/30 | **10/30** | 5 |

### HARDENED 잔존

- `ioregistry_enum` 5/5 탈출 — I/O 레지스트리 열거
- `hw_machine` 5/5 탈출 — 런타임 필수 sysctl 예외의 핑거프린팅 재사용
- `hw_model`·`kern_osversion`는 차단 전환 성공
- `task_port`·`statfs_host`는 오류(에러) 5회 — 차단 성공으로 판정하지 않음

---

## 6. 3라운드 9종 (run_round3)

`system_version_read`, `mach_host_statistics`, `sysctl_allowlist_scan`, `unix_socket_probe`, `sysv_ipc_probe`, `posix_shm_probe`, `identity_probe`, `metadata_boundary_map`, `memory_exhaust_bounded` × 5회.

| 프로파일 | 차단 | 탈출 |
| --- | ---: | ---: |
| PERMISSIVE | 0/45 | 45/45 |
| BASELINE | 15/45 | 30/45 |
| HARDENED | 20/45 | **25/45** |

### HARDENED 잔존 탈출 (각 5/5)

- `system_version_read` — 시스템 버전/빌드 읽기
- `mach_host_statistics` — 호스트 통계 (Mach)
- `sysv_ipc_probe` — SysV IPC 존재/접근 정찰
- `metadata_boundary_map` — 메타데이터 경계 맵핑
- `memory_exhaust_bounded` — 바운드 메모리 고갈 시도

### HARDENED 차단

- `sysctl_allowlist_scan`, `unix_socket_probe`, `posix_shm_probe`, `identity_probe`

---

## 7. 종합 판정

| 항목 | 결과 |
| --- | --- |
| 회귀 테스트 | 159/159 통과 |
| 기본 I/O (clean launch) | 45/45 차단 |
| 핵심 5대 익스플로잇 | 25/25 차단 |
| 2라운드 메타데이터 | 30/45 차단, 15/45 노출 |
| 매드니스 | 20/30 차단, 10/30 노출 |
| 3라운드 | 20/45 차단, 25/45 노출 |

### 미해결 노출 요약

1. **호스트 메타데이터/핑거프린트 경로** — `statfs_probe`, `listdir_root`, `sysctl_hw_leak`, `ioregistry_enum`, `hw_machine`, `system_version_read`, `mach_host_statistics`, `metadata_boundary_map`
2. **IPC 존재 정찰** — `sysv_ipc_probe`
3. **바운드 리소스 고갈** — `memory_exhaust_bounded` (완화 시도 차단됨)
4. **오류 미판정** — `task_port`, `statfs_host`는 차단으로 위장하지 않음

### 결론

- 임의 파일 내용 유출·임의 코드 실행·무제한 자원 고갈 경로는 해당 실행의 HARDENED 프로파일에서 **차단 상태**였다.
- 그러나 호스트 메타데이터 조회는 여전히 성공한다. 이는 RECHECK.ko.md의 미해결 범위와 정확히 일치하며, 루트 읽기 제거 시 Python 로더가 종료되고 `hw.machine`/`kern.hostname` 제거 시 `os.uname()`이 실패하는 macOS `sandbox-exec`의 구조적 한계 때문이다.
- 호스트 정보 비노출을 요구하는 실행은 별도 게스트(VM/컨테이너)에서 재검증해야 하며, 현재 호스트에서 "완전 격리"를 주장하지 않는다.
