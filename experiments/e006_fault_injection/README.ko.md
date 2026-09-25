# E006 — 승인부터 효과 대조까지의 장애 주입 실험

최종 갱신: 2026-09-23

> 이 문서는 완전한 격리나 침해 불가능성을 주장하지 않는다. 수치는 2026-09-23
> 로컬 실행에 한정되며, 현재 작업트리의 보증으로 확대하지 않는다.

리뷰 문서 개선 #2의 실험이다: approve → claim → dispatch → audit 사이마다
crash, timeout, clock rollback, 동시 revoke, 백업 복원, worker restart를
주입하고 안전성·유용성 비용을 함께 측정한다.

## 실행

```sh
.venv/bin/python experiments/e006_fault_injection/run_fault_injection.py
```

러너는 실험 모듈을 **import해서** 실행한다. 스크립트로 직접 실행하면
co_filename이 상대 경로가 되어 어댑터 지문이 바뀌고(marshal이 co_filename을
포함한다) 부모·워커의 지문이 일치하지 않는다(아래 발견 2).

## 시나리오 매트릭스 (16)

crash한 서브에이전트가 설계한 매트릭스를 오케스트레이터가 완성했다.

| 시나리오 | 주입 | 결과 (2026-09-23) |
|---|---|---|
| adapter_exception_before_effect | 어댑터가 효과 전 raise | effects 0, ExecutionUncertain — capability 소모, 클라이언트는 불확실 응답 |
| adapter_exception_after_effect | 효과 후 raise | effects 1, ExecutionUncertain, 재생 거부, 새 토큰 실행 성공 (복구) |
| adapter_double_failure | 효과 + raise + failed_or_uncertain 감사도 실패 (trigger) | effects 1, ExecutionUncertain |
| slow_validator_concurrent_revoke | 검증기 블록 중 revoke | revoke 거부(revoke_not_applied), 효과 1회 — claim의 트랜잭션이 잠금을 보유하는 동안 revoke는 대기 후 claim-first로 귀결 |
| slow_adapter_concurrent_revoke | 어댑터 블록 중 revoke | 동일 — 효과 1회, claim-once 유지 |
| clock_rollback_before_claim | claim 전 wall clock 역행 | effects 0, Rejected — 사전 거부 (정확) |
| clock_rollback_after_dispatch | dispatch 중 wall clock 역행 | effects 1, **ExecutionUncertain** — 실행 후 실패가 '실행되지 않은 거부'로 보고되지 않음 (F04 수정 검증) |
| clock_rollback_tolerated_within_tolerance | tolerance 5에서 3 역행 | 효과 1회, 정상 진행 |
| clock_unavailable_before_claim | mono clock 부재 | effects 0, **uncaught ValueError** — 발견 1 |
| unauthorized_execute_forged_token | 위조 토큰 | effects 0, Rejected — 무승인 효과 없음 |
| db_copy_db_only | DB만 복사 | **열기 거부** (fail-closed, realm sidecar) |
| db_copy_full_snapshot | DB + sidecar 복제 | **double spend** — B2 잔여 (문서화된 한계와 일치) |
| db_restore_old_snapshot | 구 스냅샷 롤백 | **재실행** — B2 잔여 (anti-rollback 미보장) |
| worker_restart_before_effect | 실행 전 재시작 | 효과 1회 (claim-once 유지) |
| worker_restart_after_effect_inprocess | 실행 후 재시작 | 재실행 거부 (claimed 유지), 중복 없음 |
| worker_restart_after_effect_subprocess | 실제 os._exit 크래시 + temp-file sink | 효과 1회, 부모 재실행 거부, 중복 없음 |
| benign_baseline | 정상 5회 | 5/5 성공 (유용성 비용 없음) |

## 불변식 (수용 기준)

- **INV1 claim-once**: held — 한 토큰의 효과가 최대 1회. B2 잔여
  (full-snapshot 복사, 구 스냅샷 롤백)는 설계상 double-spend가 예상되는
  문서화된 한계이며 별도 나열, 은닉하지 않음.
- **INV2 no-wrong-rejection**: held — dispatch 후 어떤 실패도 '실행되지 않은
  거부'로 보고되지 않는다 (ExecutionUncertain exact-type 분류; ExecutionUncertain은
  Rejected를 상속하므로 정확한 타입 검사가 필요하다).

## 발견 사항 (report-only — 이 실험은 gateway.py를 수정하지 않는다)

1. **mono clock 실패의 오류 처리 불일치 (중간)**: mono clock callable이
   raise하면 ValueError가 handle()을 그대로 뚫고 나간다. wall clock은
   `Rejected("clock unavailable")`로 처리되지만 mono는 감싸지 않는다.
   실행 전이므로 효과는 없지만, 호출자가 Rejected도 ExecutionUncertain도 아닌
   예외를 받는다 — 오류 처리 계약의 불일치다.
2. **marshal 기반 어댑터 지문의 로드 모드 불안정 (높음, 혼합 로드 모드에서만
   발화)**: `_code_fingerprint`는 `marshal.dumps(code)` 전체를 지문으로
   쓴다. marshal은 .pyc에서 재구성한 코드 객체와 신규 컴파일한 코드 객체에 대해
   **동일 소스·동일 co_filename에서도 다른 바이트**를 낸다(참조 플래그 인터닝
   상태 차이). 부모가 스크립트로 실행되고 워커가 import하면 지문이 달라져
   **유효한 capability가 거짓 거부**된다. 러너가 모듈을 import해 실행하므로
   본 실험의 진입점에서는 발화하지 않는다. F11(구버전: co_consts 누락)의
   반대 방향 문제 — 완화는 gateway 수정(소스 해시 기반 지문 또는 명시적
   fingerprint 필수화)이 필요하므로 별도 조치다.

## 범위

합성 도구, 임시 디렉터리, in-process 스레드와 실제 os._exit subprocess.
외부 서비스·네트워크 리스너·실제 자격 증명은 연결하지 않았다. 이 실험은
`halo/gateway.py`를 수정하지 않는다 — 발견은 위에 기록되고 별도 검증 후
수정한다.

## 2026-09-25 후속 — 발견 1 수정

위 표와 발견 1은 2026-09-23 당시 원자료다(수정 전 상태로 보존). 발견 1
(mono clock 오류 처리 불일치)은 `halo/gateway.py`의 `_wall()`/`_mono_now()`가
"clock이 나쁜 값을 반환하는 경우"만 감싸고 "clock 호출 자체가 raise하는
경우"는 감싸지 않던 결함이었다 — wall/mono 양쪽 모두 동일한 구조라 실제로는
대칭적인 결함이었고, 이 실험이 mono 쪽만 우연히 노출시켰을 뿐이다. 두 메서드
모두 클록 호출을 `try/except`로 감싸 `Rejected("clock unavailable")`로
정규화하도록 수정했다. 이 실험 스크립트를 현재 트리에서 다시 실행하면
`clock_unavailable_before_claim`의 `response_type`이 `uncaught:ValueError`
대신 `Rejected`이고, `_collect_findings()`가 발견 1을 더 이상 만들지 않는다
(`report-only findings: 0`). 발견 2(marshal 지문 불안정)는 손대지 않았다 —
gateway 지문 방식 자체를 바꿔야 하는 별도 범위다. 상세는
[docs/reviews/2026-09-25-e006-mono-clock-fix.ko.md](../../docs/reviews/2026-09-25-e006-mono-clock-fix.ko.md).
