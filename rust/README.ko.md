# HALO Rust 실행 코드

명시적 센서 유효성·재검증 판정을 추가한 보호막 후보의 API와 실험 한계는 [SHIELD.ko.md](SHIELD.ko.md)에 있다.

공개 WILDS·RobustBench의 평가 방법을 적용한 별도 [Shift Benchmark](SHIFT_BENCH.ko.md)는 보정·평가 데이터 분리, 복합 교란, 센서 손실, 최악 집단과 오탐률 이동을 평가한다. 실행 파일은 `shift_bench`다.

실험 E001, E001-B, E002, E003, E004, E005의 계산과 반복 실행을 Rust로 옮긴 워크스페이스다. 실행 중 Python·NumPy·pandas를 호출하지 않는다. 원본 Python과 저장된 연구 결과는 비교 기준으로 유지한다.

## 빌드와 실행

일반 Rust 환경에서는 저장소 루트에서 다음과 같이 실행한다.

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml
cargo test --locked --manifest-path rust/Cargo.toml
rust/target/release/halo-experiments e001 --json '{"seed":42,"n":10000,"corruption":0.05}'
rust/target/release/halo-experiments e004 --json '{"seed":7,"n":1000}' --output /tmp/e004-rust.json
rust/target/release/halo-experiments e005 --json '{"seed":42,"rounds":10,"population":1000}'
```

이 작업에서 설치한 로컬 툴체인은 `.venv/cargo`와 `.venv/rustup`에 있다. 전역 `cargo`가 없으면 위 `cargo` 명령 대신 아래 형식으로 실행한다.

```sh
RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  "$PWD/.venv/cargo/bin/cargo" build --release --locked --manifest-path rust/Cargo.toml
```

설정은 `--json` 문자열 또는 `--config` JSON 파일로 입력한다. 일반 실행의 `--output`은 JSON 파일 경로이며, `--sweep`의 `--output`은 결과 디렉터리다. 원본의 인자 이름을 사용하고 수치·범위 오류는 실패로 반환한다.

```sh
rust/target/release/halo-experiments e002 --sweep \
  --json '{"seeds":2,"n":1000}' --output rust/results/e002-smoke
rust/target/release/halo-experiments e003 --sweep \
  --json '{"seeds":2,"n":1000}' --output rust/results/e003-smoke
rust/target/release/parameter_stress --experiment all --n 1000 --output rust/results/parameter-stress.json
```

샘플 수를 지정하지 않은 sweep은 원본의 전체 기본 그리드를 사용한다. 기본 설정은 수천만 개의 샘플을 생성할 수 있다. 먼저 작은 `n`·`seeds`로 출력과 결과를 확인할 수 있다.

## 전환 범위

| Python 원본 | Rust 대응 | 포함 내용 |
|---|---|---|
| `experiments/e001_trusted_base` | `halo-experiments e001` | 메타데이터 오염, 정책 3종, sweep와 그래프 |
| `experiments/e001b_correlated_failure` | `halo-experiments e001b` | 상관 오류·독립 제3소스, 정책 4종, CSV·그래프 |
| `experiments/e002_shared_blind_spots` | `halo-experiments e002` | 점수 생성·통합 8종, 임계값·지표·sweep |
| `experiments/e003_verdict_freshness` | `halo-experiments e003` | 상태 변화·캐시 갱신 정책 5종, sweep |
| `experiments/e004_robust_evaluation` | `halo-experiments e004` | 가중 지표·임계값 선택 3종, 분포 이동 결과 |
| `experiments/e005_adaptive_evasion` | `halo-experiments e005` | 이진 피드백 적응, static/moving, 라운드 지표·sweep |
| 루트 `ultra_exploit_e001b.py`, `ultra_exploit_e002.py`, `ultra_exploit_e003.py` | `parameter_stress` | 합성 수치 파라미터 그리드 140개 |
| `artifacts/sandbox_benchmark/run_benchmark.py` | 기존 `rust_runner` crate | 기본 OS 격리 검사 9종, 정상 작업 3종 |

`run_exploits.py`와 `run_breakout.py`의 OS 확장 검사는 아직 Python이다. 해당 변환 담당 작업이 도구 보안 필터에서 중단됐다. 따라서 저장소의 모든 실행 코드가 Rust로 바뀌었다고 주장하지 않는다. 빈 `__init__.py`·pytest 경로 설정은 Rust 모듈·Cargo 테스트로 대체되는 언어별 구성이다.

기본 OS 격리 실행기의 빌드·재현 방법은 [별도 문서](../artifacts/sandbox_benchmark/RUST_RUNNER.ko.md)에 있다. 이 워크스페이스의 통계 실험 결과로 OS 격리가 검증되는 것은 아니다.

## 결과 해석과 비교

- 난수는 고정 seed의 Rust RNG를 사용한다. 같은 Rust 버전·lockfile·설정에서는 재현되지만 Python `random`이나 NumPy의 동일 seed와 샘플이 같지는 않다. 기존 결과 CSV를 새 난수 결과로 덮어쓰지 않는다.
- 모집단이 비어 정의되지 않는 비율은 JSON에서 `null`, CSV에서 `NaN`으로 표현한다. 이를 0% 오류로 해석하면 안 된다.
- Python으로 생성한 고정 입력 기준값 37개를 `tests/fixtures`에 보관한다. E002 점수 통합·분위수와 E004 지표·임계값 선택을 오차 `1e-12` 이내로 비교한다. 이 테스트는 Python 없이 실행된다.
- 그래프의 파일 형식은 SVG를 사용한다. 원본 matplotlib PNG와 픽셀 단위로 같은 그림을 목표로 하지 않는다.
- 파라미터 스트레스 실행기는 조건별 원시 측정값을 남긴다. 동일한 주변 오류율을 오류 상관관계의 증거로 해석하거나, 점수의 가중 평균을 TPR의 가중 평균과 같다고 가정하지 않는다.

모든 실험은 합성 입력에 대한 연구용 코드다. Rust 전환과 테스트 통과가 모델 안전성이나 완전 격리를 의미하지 않는다.

## 역사적 검증 기록 — 2026-09-14

추가 고부하 실행의 규모, 독립 수치 검증, 방어 성능의 한계와 과거 샌드박스 720회 결과는 [고부하 벤치마크 보고서](HARD_BENCH.ko.md)에 기록했다. 현재 6,180회 실행 기준은 `rust/results/attack-100-validated-20.json`과 [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)에 있다. `hard_bench`로 과거 설정을 재현할 수 있다.

- 당시 통계 워크스페이스 자동 테스트 57개와 OS 샌드박스 실행기 테스트 13개가 통과했다. 현재 재검증은 [2026-09-21 전체 검수 보고서](../docs/reviews/2026-09-21-review.ko.md)를 우선한다.
- 100개 공격 사례 검사는 `rust/results/attack-100-validated-20.json`을 기준으로 하며 clean-launch의 메타데이터 잔여 접근 9개 때문에 보안 게이트는 실패한다.
- release 빌드 성공. 모든 실험의 sweep을 seed 2개, 표본 1,000개로 실행했다. E005는 population 500, rounds 5로 실행했다. 원본 전체 표본 규모의 sweep을 모두 실행한 것은 아니다.
- 파라미터 스트레스 140개를 표본 1,000개로 실행해 정상 종료했다.

| 실험 | 원시 결과 행 수 | 요약 행 수 |
|---|---:|---:|
| E001 | 36 | 18 |
| E001-B | 160 | 240 |
| E002 | 96 | 18 |
| E003 | 240 | 72 |
| E004 | 6 | 3 |
| E005 | 4 | 2 |

검증 산출물은 로컬 `rust/results/verification/`에 있으며, 재생성 가능한 결과 디렉터리는 Git에서 제외한다. 원본 Python의 저장된 연구 결과는 Rust 난수 결과로 덮어쓰지 않는다.
