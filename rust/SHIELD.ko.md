# HALO 보호막 후보와 평가

> 이 문서는 보호막 후보의 합성 평가 기록이다. 현재 실행·보안 게이트 판정은 [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)를 우선하며, 이 후보가 OS 샌드박스나 배포 승인을 제공하지는 않는다.

신뢰된 ACL 재검증을 실제 메모리 객체 읽기에 연결한 구현과 테스트 범위는 [ENFORCEMENT.ko.md](ENFORCEMENT.ko.md)에 있다. 점수 지표와 실행 권한은 별도 개념이다.

## Hybrid 추가 검증

`Shield::calibrate_hybrid`는 raw maximum과 centered maximum을 고정 1:1로 절충한다. 평가 데이터로 가중치를 조정하지 않는다. 기존 `calibrate`는 centered 모드를 유지한다. 모든 모드에서 누락·비유한 센서는 재검증으로 보낸다.

새 seed 5–9, 목표 FPR 1%, 표본 1만/집단에서 결과:

| 환경 | centered FPR / 최악군 탐지 | hybrid FPR / 최악군 탐지 |
|---|---:|---:|
| clean | 0.944% / 52.848% | 0.904% / 65.838% |
| correlated 최대 | 0% / 96.366% | 0.250% / 73.934% |
| heavy_tail 최대 | 14.492% / 56.570% | 14.516% / 68.174% |
| offset 최대 | 0.944% / 52.848% | 3.734% / 81.296% |

Hybrid는 clean 탐지 손실을 줄였지만 모든 도메인에서 우월하지 않다. 특히 offset 오탐 예산은 지키지 못한다. 센서 전손·복합 최대 강도에서는 두 모드 모두 정상·공격 전부 재검증하여 가용성 손실이 남는다. 검증 seed는 구현 선택에 사용하지 않았으며 결과 확인 후 추가 가중치 조정도 하지 않았다.

전체 실행은 seed 0–9로 기존 3,840행과 보호막 3모드의 1,440행을 생성한다. 위 표는 새 seed 5–9만 사용한다. 원시 결과: `rust/results/shield-hybrid-validation.json`. 이 문서 작성 당시 Rust 테스트 53개가 통과했으며, 현재 통계 워크스페이스 테스트는 57개가 통과한다.

```sh
rust/target/release/shift_bench --n 10000 --seeds 10 --output rust/results/shield-hybrid-validation.json
```

`halo_experiments::shield::Shield`는 네 센서 점수와 명시적 유효성 정보를 받아 Allow / Block / Revalidate를 반환하는 Rust 라이브러리다. OS 샌드박스나 실제 모델의 호출 경로에 자동 배포한 것은 아니다.

공통 오프셋과 상관 잡음의 영향을 줄이기 위해 `0.5 * max - 0.25 * middle_low - 0.25 * middle_high` 점수를 사용한다. 별도로 확인된 정상 표본으로 오탐 예산을 보정한다. 누락·NaN·무한대 입력은 Revalidate이며 호출자는 실행을 중지하고 독립 증거를 다시 얻어야 한다. 센서값 0은 유효하다.

Shift 벤치는 기존 1,920행과 별도로 두 후보의 480행을 `shield_rows`에 저장한다. 모든 정상·공격 집단에 allow/block/revalidate/total을 기록한다. 시뮬레이터의 강제 0 대입은 센서 누락 메타데이터로 변환하지만, 실제 호출자는 점수가 아닌 명시적 상태를 제공해야 한다.

- frozen_centered: 깨끗한 보정 데이터로 고정한 보호막 후보.
- trusted_refresh_centered: 독립적으로 확인된 정상 표본을 현재 도메인에서 추가로 확보할 수 있다는 가정의 비교 실험. 평가·공격 데이터는 보정에 사용하지 않는다. 기본 배포 정책이 아니다.

목표 FPR 1%, seed 5개, 교란 최대 강도에서 frozen_centered:

| 환경 | 정상 block | 정상 revalidate | 최악 공격군 block |
|---|---:|---:|---:|
| clean | 1.082% | 0% | 53.212% |
| offset | 1.082% | 0% | 53.212% |
| correlated | 0% | 0% | 96.852% |
| heavy_tail | 14.706% | 0% | 56.650% |
| sensor_loss | 0% | 100% | 0% |
| compound | 0% | 100% | 0% |

sensor_loss/compound 최대 강도에서 공격 자동 허용도 0%지만, 모든 정상 작업도 재검증으로 멈춘다. 이를 탐지율 100%라고 해석하지 않는다. trusted_refresh는 heavy_tail 오탐을 1.012%로 줄였으나 최악군 탐지도 0.962%로 떨어져, 오탐률만 보고 개선으로 채택할 수 없다. 복합 교란 및 공통 방향으로 모든 센서가 함께 상승하는 공격에 대한 일반적 보장은 없다.

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml --bin shift_bench
rust/target/release/shift_bench --n 10000 --seeds 5 --output rust/results/shield-evaluation.json
```

이 문서 작성 당시 전체 Rust 실험 테스트 52개가 통과했다. 현재 통계 워크스페이스 테스트는 57개가 통과한다. 원시 결과는 `rust/results/shield-evaluation.json`. 기존 `--fail-on-fpr`는 기존 baseline 행만 대상으로 하며 새 보호막의 합격 판정이 아니다.
