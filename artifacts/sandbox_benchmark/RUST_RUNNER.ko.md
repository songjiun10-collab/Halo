# Rust 실행기

> 2026-09-21 후속 상태: **회귀 / B1**. [보고서별 조치 원장](../../docs/reviews/REPORT_REMEDIATION.ko.md)에서 수정·재현과 잔여 범위를 구분한다. 아래 과거 수치는 현재의 전체 해결 판정이 아니다.

`rust_runner`는 Python payload를 호출하지 않고 Rust 바이너리가 미끼 생성, `sandbox-exec` 실행, 결과 판정을 직접 수행한다. macOS 전용이며 `serde_json`(구조화된 결과), `libc`(실제 FD 읽기와 상속), `tempfile`(실패 시에도 임시 디렉터리 정리)을 사용한다. 의존성 버전은 `Cargo.lock`에 고정한다.

```sh
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  "$PWD/.venv/cargo/bin/cargo" build --locked --manifest-path artifacts/sandbox_benchmark/rust_runner/Cargo.toml
artifacts/sandbox_benchmark/rust_runner/target/debug/halo-sandbox-runner \
  --repeats 5 --output artifacts/sandbox_benchmark/rust_results.json

RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  "$PWD/.venv/cargo/bin/cargo" test --locked --manifest-path artifacts/sandbox_benchmark/rust_runner/Cargo.toml
```

현재 100개 사례 전체 재현:

```sh
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  "$PWD/.venv/cargo/bin/cargo" build --release --locked --manifest-path artifacts/sandbox_benchmark/rust_runner/Cargo.toml
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  artifacts/sandbox_benchmark/rust_runner/target/release/halo-sandbox-runner \
  --repeats 20 --output rust/results/attack-100-validated-20.json
```

기존 프로젝트 로컬 Rust 설치가 없는 환경에서는 일반 `cargo`로 같은 manifest를 빌드하면 된다. `RUSTUP_HOME`·`CARGO_HOME` 설정은 이 작업에서 `.venv` 안에 설치한 툴체인을 선택하는 용도다.

검사 조건은 세 가지다. 샌드박스 없는 대조군, 환경변수·미끼 FD를 상속한 샌드박스, 환경을 정리하고 FD를 전달하지 않는 샌드박스를 비교한다. 정상 작업 3종과 공격 100종을 각 조건에서 반복한다. `--repeats 20`은 총 6,180회다.

2026-09-12 재검증 결과:

| 조건 | 정상 작업 성공 | 공격 성공 | 공격 차단 | 오류 |
|---|---:|---:|---:|---:|
| unconfined_control | 15/15 | 45/45 | 0/45 | 0 |
| sandbox_inherited_capabilities | 15/15 | 10/45 | 35/45 | 0 |
| sandbox_clean_launch | 15/15 | 0/45 | 45/45 | 0 |

상속 조건의 성공 10회는 환경변수·미끼 FD를 각 5회 읽은 결과다. 실제 파일에 대한 `pread`로 확인하며 고정 errno를 반환하지 않는다. 모든 임시 미끼는 실행 종료 후 제거됐다.

수정한 판정은 JSON 필드의 정확한 값, 정상 작업의 기대값, OS 오류, 프로세스 종료 상태를 구분한다. 외부 파일 변경·삭제는 자식의 성공 여부보다 먼저 확인한다. 타임아웃·크래시·잘못된 출력은 오류로 집계한다. 정상 작업 실패, 대조군의 공격 실패, clean launch의 차단 실패가 있으면 종료 코드 1이다. 잘못된 CLI 인자는 panic 없이 종료 코드 2다.

Rust 런타임 초기화에는 `hw.pagesize`와 `hw.pagesize_compat` 조회를 허용했다. 2026-09-26 프로파일을 `file-read-data`와 `file-read-metadata`로 분리했다. `/`는 loader 시작에 필요한 data 허용만 남겼고, root metadata 허용은 제거했다. 완전히 `/` 권한을 제거하면 정상 작업을 포함해 sandbox child 시작이 실패했다. 이 호스트의 `/System/Library/Sandbox/Profiles/dyld-support.sb`는 libignition이 `openat(2)`의 기준 FD로 쓰기 위해 `/`를 연다고 명시한다. 이 문서 근거와 직접 실행 결과가 root data 허용을 유지하는 이유다.

2026-09-26 syscall 필터 추가 후 `--repeats 1` 실제 실행은 309 시행, 오류 0, 종료 코드 0이다. clean launch 정상 작업 3/3, 공격 판정은 차단 97·민감한 접근 성공 0·정보성 결과 3이며 `security_gate.passed=true`, `residual_cases=[]`다. root `fstatat`/`lstat`은 차단됐고, `access("/", F_OK)`는 root 존재만 반환해 정보성으로 분리했다. `getcwd`는 실행기가 전달한 work 경로, `getpid`는 호출 프로세스의 PID라 정보성으로 집계한다. `chdir`만 성공하는 것과 달리 그 뒤 canary를 읽는 결합 probe는 차단된다. 이 세 정보성 분류와 결합 probe는 앞선 변경에서 도입됐으며 이번 syscall 수정에서는 판정기를 변경하지 않았다.

잔존했던 `statvfs`, `statfs`, `pathconf`는 outside fixture의 파일시스템 통계와 최대 이름 길이를 반환했다. 경로의 `file-read-metadata` deny만으로는 차단되지 않았다. Apple 공개 [XNU 소스](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_syscalls.c)에서 `statfs64`는 mount 검사 경로를, `pathconf`는 `vn_pathconf` 경로를 사용한다. [Apple libc 소스](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/emulated/statvfs.c)의 `statvfs`는 `statfs` 결과를 변환한다. 공개 소스는 실행 중인 커널 바이너리와 동일하다고 가정하지 않으며, 실제 차단 여부는 이 호스트에서 별도 검증했다.

프로파일에 `deny syscall-unix`를 추가해 `SYS_statfs`, `SYS_statfs64`, `SYS_fstatfs`, `SYS_fstatfs64`, `SYS_pathconf`, `SYS_fpathconf`를 차단했다. 세 원래 probe 모두 실제 `EPERM`을 반환한다. 별도 프로세스 회귀 테스트는 허용된 work 파일의 FD로 `fstatfs`, `fstatvfs`, `fpathconf`를 호출해 대조군 성공과 sandbox의 `EPERM`을 확인한다. 이 규칙은 경로와 무관하므로 허용된 work 파일의 통계 조회도 제한한다. 정상 계산·파일 읽기·쓰기는 모두 유지됐다. 기존 문서의 “이 세 사례에는 VM이 필요하다”는 결론은 syscall 필터 검토가 빠진 과도한 결론이어서 정정한다.

검증 호스트는 macOS Darwin 27.0.0 arm64다. syscall 필터는 Apple의 private SBPL 인터페이스이므로 다른 macOS 버전에서는 실제 실행으로 지원 여부를 확인해야 한다. 이번 통과는 고정된 100개 probe 범위의 결과이며, 모든 호스트 메타데이터의 기밀성이나 임의 코드의 완전한 격리를 증명하지 않는다. 상속 모드에서는 여전히 공격 4개가 성공하므로 clean launch의 환경·FD 정리가 필요하다.

판정기는 canary 본문 읽기와 outside 경로의 실제 통계 반환을 `escaped`, 권한 오류를 `blocked`, 민감하지 않은 자기 프로세스 정보를 `informational`로 구분한다. 결과 요약에는 세 분류를 모두 포함하며, 이 정보성 분류가 민감한 세 통계 누출을 통과로 바꾸지는 않는다.

2026-09-26 후속 판정 보완: 정보성 probe도 `status="ok"`만으로 통과하지 않는다. PID는 부모가 생성한 child PID와, cwd는 부모가 지정한 work 경로와 일치해야 하며 root 존재 결과는 정확한 표식을 요구한다. 값 누락·잘못된 타입·다른 PID/경로는 `error`다. 정보성 집계 필드가 존재하면 음이 아닌 정수여야 하고 반복당 지정된 3개 사례 수를 초과할 수 없다. 필드가 없던 구형 보고서는 0으로 처리한다. 잘못된 정보성 결과와 모든 공격을 정보성으로 바꾼 요약이 기존 코드에서 통과함을 회귀 테스트로 재현한 뒤 차단했다. 이는 검증기의 허위 PASS 보완이며 새로운 OS 권한 탈출을 발견했다는 의미는 아니다.

추가 점검에서 자손이 출력 파이프를 유지하면 타임아웃을 넘기는 오류와 출력 잘림·모순 집계의 성공 판정을 수정했다. 파이프를 비차단 방식으로 읽고, 종료 전용 프로세스 그룹의 자손을 정리한 후 부모를 회수한다. 부모 종료 후에도 파이프가 열려 있으면 기한을 적용하며 스트림별 64 KiB 초과는 오류다. 별도 세션으로 탈출한 임의 자손까지 제어한다는 보장은 아니다.

자동 테스트 18개(단위 16개, CLI 및 실제 격리 통합 2개)와 `rust/Cargo.toml`의 테스트 59개가 통과했다. 기존 `report_passes` 관련 회귀 테스트도 유지했고, `cargo clippy --all-targets -- -D warnings`도 통과했다. `rust/results/attack-100-validated-20.json`은 2026-09-26 프로파일·판정 수정 이전 원자료로 clean-launch의 메타데이터 잔여 사례 9개가 기록돼 있다. 과거 스냅샷을 현재 결과로 덮어쓰지 않는다.
