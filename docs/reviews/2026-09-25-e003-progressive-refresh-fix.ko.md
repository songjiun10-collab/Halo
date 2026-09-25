# E003 progressive_refresh — adaptive window aliasing 수정 — 2026-09-25

`docs/EVALUATION.md` §2.2의 미해결 취약점 #1(`progressive_refresh`가 window≥2 +
변동성 조합에서 실패, "parity 버그")을 재현하고 근본 원인을 찾아 수정했다.
E001-B/E002처럼 통계적으로 내재한 trade-off가 아니라, `adaptive_window()`의
floor 값이 잘못돼 있던 코드 결함이었다.

## 근본 원인

`experiments/e003_verdict_freshness/experiment.py`의
`adaptive_window(vol) = max(1, round(freshness_window * (1 - vol)))`은
계산값이 0이어도 항상 최소 1을 강제했다. `freshness_window=2`에서
`volatility≥0.75`이면 수식 자체는 0을 요구하는데도 window가 계속 1로
고정됐다.

window=1은 refresh 주기(`step - last_check > window`)를 2스텝마다로
만든다. `volatility=1.0`에서는 상태가 매 스텝 결정론적으로 반전(parity
flip, 주기 2)하므로, 2스텝마다 찍는 refresh는 항상 같은 위상(원래 상태)만
관측하고 실제로 반전된 현재 상태는 절대 보지 못한다. `delay_steps`가
홀수면 마지막 refresh 이후 정확히 1스텝이 남는데, 그 1스텝의 반전이
확정적이므로 캐시된 판정은 사용 시점의 진짜 상태와 항상 달랐다. 재현:

```
seed=42, n=200_000, freshness_window=2
delay=3, volatility=1.0 → progressive_refresh 실패율 53.77%
delay=1, volatility=0.8 → 54.95% / delay=1, volatility=0.9 → 54.80%
(문서의 "54.2%"와 동일한 현상, 정확한 수치는 seed/n 차이)
```

부수 효과: 같은 floor가 `freshness_window=0`을 명시해도 `progressive_refresh`가
1스텝 재사용을 계속했다 — `fixed_window_revalidation`은 올바르게
매 스텝 재검증했지만 `progressive_refresh`는 설정을 조용히 무시했다.

## 수정

floor를 1에서 0으로 낮췄다 — `adaptive_window`가 수식 그대로 0에
도달하면 매 스텝 재검증(사용 시점 재검증과 동일)한다.

- [experiments/e003_verdict_freshness/experiment.py](../../experiments/e003_verdict_freshness/experiment.py)
- [rust/halo-experiments/src/e003.rs](../../rust/halo-experiments/src/e003.rs) (`.max(1)` 제거,
  포팅 주석의 Python SHA-256 갱신)

**바꾸지 않은 것:** window가 수식대로 정당하게 1인 경우(예: `volatility=0.5`,
`freshness_window=2` → window=1)의 잔여 staleness 위험은 그대로 둔다. 이건
버그가 아니라 progressive_refresh가 매 스텝 검사 대신 지불하는 실제 비용이며,
[R3](REPORT_REMEDIATION.ko.md)가 이미 "비교군의 성질이며 감추지 않는다"고
명시한 그 trade-off다. 이번 수정 후에도 `volatility=0.5, delay_steps=3`은
여전히 24.8% 실패를 보인다(회귀 테스트로 고정) — 평가 기준을 바꿔 성공으로
만들지 않는다는 원칙을 따른다.

## 검증

```
.venv/bin/python -m pytest -q
# 395 passed (기존 392 + 신규 3)

.venv/bin/python -m pytest experiments/e003_verdict_freshness/tests/ -q
# 13 passed (기존 10 + 신규 3)

RUSTUP_HOME="$PWD/.venv/rustup" CARGO_HOME="$PWD/.venv/cargo" \
  .venv/cargo/bin/cargo test --locked --manifest-path rust/Cargo.toml
# 47 lib tests + 통합 테스트 전부 통과 (e003 7개, 신규 1개 포함)
```

신규 테스트 3종(Python)·1종(Rust, 두 시나리오 포함):

1. `volatility=1.0, delay_steps=3, freshness_window=2` → `adaptive_window_size==0`,
   `progressive_refresh`가 `use_time_revalidation`과 완전히 일치(실패율 0).
2. `freshness_window=0` → `progressive_refresh`도 매 스텝 재검증하여
   `use_time_revalidation`과 일치 (이전엔 1스텝 재사용을 계속함).
3. `volatility=0.5, delay_steps=3, freshness_window=2` (window=1이 수식대로
   정당한 경우) → 실패율이 여전히 0보다 큼. 수정이 의도된 trade-off까지
   지워버리지 않았는지 확인하는 회귀다.

기본 `run_sweep.py`가 쓰는 변동성(0.005–0.05)은 이 floor가 전혀 관여하지
않는 범위라서(계산값이 항상 2) 커밋된 `results/*.csv`는 영향받지 않는다 —
재생성하지 않았다.

## 범위와 한계

- 이 실험은 실제 방어 시스템이 아니라 합성 비교군이다. E003의 다른
  비교군(`cached_verdict`, `fixed_window_revalidation`, `adaptive_cached`)은
  손대지 않았다.
- `docs/EVALUATION.md` §2.2의 표는 2026-09-13~14 원자료 스냅샷이므로 고치지
  않았다 — 문서 서두가 이미 "현재 회귀와 잔여 한계는 공통 상태를 따른다"고
  명시한다. 이 파일이 그 공통 상태 갱신이다.
- `docs/reviews/evidence_registry.json`의 항목 1(`rust/halo-experiments/src/e003.rs`
  fingerprint 포함)은 이 수정 이전부터 이미 `stale`로 기록·재확인된 항목이다
  (해당 항목의 다른 파일들이 2026-09-23 패치로 먼저 바뀌었다). 이번 수정으로
  새로 stale이 된 항목은 없다 — `tools/check_evidence_registry.py` 결과는
  수정 전후 동일하게 valid 1 / stale 2 / unsupported 1이다. 레지스트리
  자체의 갱신은 별도의 명시적 재검증 단계로 남겨둔다.
- Rust는 이번에 `.venv/cargo/bin/cargo`로 실제 컴파일·테스트했다(이전
  세션 기록과 달리 이 환경에 로컬 cargo가 있었다).
