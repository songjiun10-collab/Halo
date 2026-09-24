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

Rust 런타임 초기화에는 `hw.pagesize`와 `hw.pagesize_compat` 조회를 허용했다. 파일 내용·경로 우회는 차단했지만 clean-launch에서 9개 메타데이터 사례가 성공한다. 이번 결과는 100개 API·경로 사례의 반복 검증이며 완전한 호스트 기밀성의 보장이 아니다.

추가 점검에서 자손이 출력 파이프를 유지하면 타임아웃을 넘기는 오류와 출력 잘림·모순 집계의 성공 판정을 수정했다. 파이프를 비차단 방식으로 읽고, 종료 전용 프로세스 그룹의 자손을 정리한 후 부모를 회수한다. 부모 종료 후에도 파이프가 열려 있으면 기한을 적용하며 스트림별 64 KiB 초과는 오류다. 별도 세션으로 탈출한 임의 자손까지 제어한다는 보장은 아니다.

자동 테스트 13개(단위 11개, CLI 및 실제 격리 통합 2개)가 통과했다. `cargo clippy --all-targets -- -D warnings`도 통과했다. 최신 100개 사례 결과는 `rust/results/attack-100-validated-20.json`이며 clean-launch의 메타데이터 잔여 사례 9개가 기록돼 있다.
