# halo/gateway.py — clock 호출 예외 처리 수정 — 2026-09-25

`experiments/e006_fault_injection/README.ko.md`의 "발견 1"(mono clock 실패의
오류 처리 불일치, 중간 심각도, report-only — 실험은 gateway.py를 고치지
않는다고 명시)을 실제로 수정했다.

## 근본 원인

`halo/gateway.py`의 `_wall()`/`_mono_now()`는 각각:

```python
def _wall(self):
    value = self._clock()
    if type(value) not in (int, float) or not math.isfinite(value):
        raise Rejected("clock unavailable")
    return float(value)
```

clock 콜백이 **나쁜 값을 반환하는** 경우만 잡았다. clock 콜백 **호출 자체가
예외를 던지는** 경우(예: 실 OS에서 monotonic clock 소스가 사라지는 상황을
모델링한 `raise ValueError(...)`)는 `try/except` 없이 그대로
`handle()` 밖으로 전파됐다 — `Rejected`도 `ExecutionUncertain`도 아닌
raw 예외를 `.handle()`을 직접 쓰는 호출자가 받게 된다. `wall`/`mono` 두
메서드가 구조적으로 동일해서 실제로는 대칭적인 결함이었지만, E006의 시나리오
매트릭스가 mono 쪽만 골라 노출시켰다(wall clock을 raise하게 만드는
시나리오는 원래 없었다).

이 결함은 `Gateway.__init__`에도 영향을 준다 — 생성자가 `with self._db()`를
열 때 `_check_clock_rollback`이 즉시 `self._wall()`을 호출하므로, clock이
생성 시점부터 raise한다면 객체 생성 자체가 raw 예외로 실패했다.

## 수정

`_wall()`과 `_mono_now()` 양쪽에 clock 호출을 감싸는 `try/except`를 추가해
`Rejected("clock unavailable") from exc`로 정규화했다 — 기존에 "나쁜 값"
경로가 쓰던 것과 동일한 메시지, 동일한 예외 타입이다. 이 저장소의 다른 곳
(`tool.validate` 실패, `tool.execute` 실패)에 이미 쓰이는
`except Exception as exc: raise Rejected(...) from exc` 패턴을 그대로
따랐다.

- [halo/gateway.py](../../halo/gateway.py)

## 검증

```
.venv/bin/python -m pytest -q
# 401 passed (기존 399 + 신규 2)

.venv/bin/python experiments/e006_fault_injection/run_fault_injection.py
# clock_unavailable_before_claim: response_type "Rejected" (기존 uncaught:ValueError)
# report-only findings: 0 (기존 1)
```

신규 회귀 테스트 2종(`tests/test_gateway_adversarial.py`,
`test_raising_clock_callable_is_rejected_not_uncaught`, wall/mono 양쪽
파라미터화): 정상 동작 중인 Gateway를 만든 뒤 clock을 raise하도록 전환하고
`.handle()`을 직접 호출해 `type(exc) is Rejected`와 메시지를 확인한다 —
E006의 `ManualClock.mono_enabled = False` 패턴과 동일한 순서(먼저 생성,
나중에 고장)를 써서 생성자 경로가 아니라 정확히 이 finding이 가리키는
"런타임 중 clock 소실" 시나리오를 재현한다.

## 범위와 한계

- `experiments/e006_fault_injection/README.ko.md`의 2026-09-23 표는 그대로
  두고 아래에 후속 절만 추가했다(다른 실험 문서와 동일한 컨벤션) —
  `results/compact.csv`도 그날의 원자료로 보존, 재생성하지 않았다.
- 발견 2(marshal 기반 어댑터 지문이 로드 모드에 따라 달라지는 문제, 높음
  심각도)는 손대지 않았다. README에 적힌 대로 이건 지문 방식 자체(소스 해시
  기반으로 바꾸거나 명시적 fingerprint를 필수화)를 바꿔야 하는 별도 범위이고,
  이번 clock 수정과 무관하다.
- `Gateway.__call__`(WSGI 계층)은 이미 `except (Rejected, ValueError, ...)
  : 403`으로 raw `ValueError`도 우연히 잡고 있었다 — 이번 발견은 HTTP 경로가
  아니라 `.handle()`을 직접 쓰는 호출자(E006처럼)에게만 실제로 드러났다.
  이번 수정은 그 우연한 안전망에 의존하지 않고 올바른 계층(clock 호출 지점)
  에서 정규화하므로 두 경로 모두 일관된다.
