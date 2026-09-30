# HALO 종합 보안 평가 문서

> HALO AI safety containment 시스템의 모든 실증 평가·익스플로잇·재검증 결과를 하나로 통합한 문서다.
> 각 항목의 상세 원문은 링크된 개별 보고서에 있으며, 본 문서는 2026-09-21 검수에서 확인한 현재 상태와 역사적 기록을 구분한다.
> 모든 평가는 로컬 격리 환경·합성 데이터·가상 자원을 대상으로 했으며, 외부 시스템·실계정·실제 모델은 대상이 아니다.
>
> **현재 기준:** [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)와 [2026-09-21 검수 보고서](reviews/2026-09-21-review.ko.md)를 우선한다. 과거 문서의 수치와 “완전 차단” 표현은 당시 원자료다.

---

## 1. 평가 범위 및 대상

| 계층 | 대상 | 원문 |
| --- | --- | --- |
| 합성 실험 | E001–E005 containment 메커니즘 | [HALO_EXPLOIT_V4_REPORT.md](../HALO_EXPLOIT_V4_REPORT.md) |
| 실코드 직접 공격 | `experiments/`의 `run`/`evaluate` 직접 호출 | [HALO_EXPLOIT_V5_DIRECT_REPORT.md](../HALO_EXPLOIT_V5_DIRECT_REPORT.md), [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) |
| 울트라 익스플로잇 | 극한 파라미터 공간·임계값 정밀 공격 | [HALO_EXPLOIT_V7_ULTRA_REPORT.md](../HALO_EXPLOIT_V7_ULTRA_REPORT.md) |
| PoC | E003 stale-reads, E005 moving-target 우회 | [redteam/poc_e003_stale_reads_exploit.py](../redteam/poc_e003_stale_reads_exploit.py), [redteam/poc_e005_moving_target_bypass.py](../redteam/poc_e005_moving_target_bypass.py) |
| OS 샌드박스 | macOS `sandbox-exec` 격리 경계 | [artifacts/sandbox_benchmark/](../artifacts/sandbox_benchmark/) |
| Rust 구현 | 수치 검증·보호막·성능 | [rust/](../rust/) |
| 방어 회귀 | case-based 안전 불변식 | [CASE_BASED_REGRESSIONS.md](CASE_BASED_REGRESSIONS.md) |

---

## 2. 과거 평가 판정 요약

이 절의 실측은 2026-09-13~14의 기록이다. E004의 조용한 제약 완화는 후속 수정했고, 다른 역사적 공격의 현재 재현 여부는 이 표만으로 확정하지 않는다. 현재 회귀와 잔여 한계는 [공통 상태](reviews/REPORT_STATUS.ko.md)를 따른다.

### 2.1 방어 성공 (검증한 공격 범위에서 유지)

| 방어 | 공격 벡터 | 결과 |
| --- | --- | --- |
| `adaptive_cached` (E003) | 변동성 임계 정밀 공격, delay/윈도우 스윕, 상태 드리프트 | **0% 실패 전 구간** |
| `correlation_aware` (E001B) | 완전 상관(ρ=1.0) + 정상 오류율 | 0.11–0.25% 실패 |
| evidence-diverse 앙상블 (E002) | 블라인드 스팟 100% | 최악군 TPR ~97% |
| 사용 시점 재검증 (E003) | 상태 드리프트 | 0% 실패 |
| 샌드박스 HARDENED | 5대 핵심 익스플로잇, 기본 I/O | 25/25, 45/45 차단 |

### 2.2 당시 미해결 취약점 (우선순위 순)

| # | 실험 | 취약점 | 최악 실측 | 심각도 |
| --- | --- | --- | --- | --- |
| 1 | E003 | `progressive_refresh`가 window≥2 + 변동성 조합에서 실패 — **보고서의 "0%" 주장 반증** | 54.2% (vol=1.0, 홀수 delay, parity 버그) | 🚨 높음 |
| 2 | E003 | 과거 stale-read 완전 우회 주장은 재현으로 지지되지 않음: 해당 정책에서 읽기는 항상 안전하고 쓰기는 재검증 | 2026-09-21 재확인 0건 | 정정 |
| 3 | E002 | 극저 FPR (target_fpr≤0.001)에서 전 전략 붕괴 | 11.64% (FPR=0.0001) | 🚨 높음 |
| 4 | E001B | 고오류율(p≥0.95)에서 `correlation_aware` 이득 소멸 | 17.38% (p=0.99) | ⚠️ 중간 |
| 5 | E004 | robust 선택기 완화 체인·FPR 예산 고갈로 worst-group TPR 붕괴 | 0.0% TPR | ⚠️ 중간 |
| 6 | E005 | moving-target 모니터가 정적 대비 오히려 분산 증폭·꼬리 리스크 | max 0.739 | ⚠️ 중간 |
| 7 | OS 샌드박스 | 호스트 메타데이터·핑거프린트 경로 (statfs, 루트 목록, hw sysctl 등) | 다수 5/5 노출 | ⚠️ 중간 |

---

## 3. 합성 실험 익스플로잇 (E001–E005)

### 3.1 E001B — 상관 실패와 중복 방어

**원본 주장 vs 실측:**

| 공격 | 보고서 주장 | 직접 공격 실측 |
| --- | --- | --- |
| 완전 상관 ρ=1.0 (정상 오류율) | 0.11% 실패 | 0.11–0.25% 실패 ✅ 유지 |
| ρ=1.0 + p=0.99 | 개선 유지 | **17.38%** vs 단일 18.48% ⚠️ 거의 무용 |
| 제3소스 독립성 | "독립" | 고ρ에서 오차율이 상관 쌍에 수렴 (gap <0.005) |

- `correlation_aware`는 정상 오류율에서 강하지만, 오류율이 0.95를 넘으면 이득이 서서히 소멸한다.
- `three_source_diverse`(다수결)은 고오류율+완전상관에서 25–27% 실패로 붕괴한다 — **권장 전략이 아니다**.
- 상세: [HALO_EXPLOIT_V4_REPORT.md](../HALO_EXPLOIT_V4_REPORT.md) §E001B, [HALO_EXPLOIT_V5_DIRECT_REPORT.md](../HALO_EXPLOIT_V5_DIRECT_REPORT.md) §E001B, [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md)

### 3.2 E002 — 블라인드 스팟과 전략 다양성

| target_fpr | 최소 숨김 TPR (전 전략) |
| ---: | ---: |
| 0.0001 | **11.64%** 🚨 |
| 0.001 | 44.88% |
| 0.005 | 62.96% |
| 0.010 | 70.62% |
| 0.050 | ~92% |

- **`conservative_max`는 `max_pool`과 완전히 동일** (0.95 안전 마진이 자체 임계값과 상쇄) — 중복 방어가 아니라 죽은 방어다.
- `max_pool`/`weighted_max`/`adaptive_evidence`는 정상 FPR에서 블라인드 스팟 방어 유지.
- FPR=0.0001에서 `hybrid_evidence`는 8.66%, `max_pool`은 18.99% TPR로 붕괴.
- 상세: [HALO_EXPLOIT_V7_ULTRA_REPORT.md](../HALO_EXPLOIT_V7_ULTRA_REPORT.md) §E002, [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) §E002

### 3.3 E003 — 판정 신선도

**전략별 최종 판정:**

| 전략 | 정밀 임계 공격 | 상태 드리프트 | 최악 실측 |
| --- | --- | --- | --- |
| `adaptive_cached` | 0% 전 구간 ✅ | 0% ✅ | — |
| `use_time_revalidate` | — | 0% ✅ | — |
| `progressive_refresh` | vol≥0.02 + window≥2에서 실패 🚨 | window≥delay에서 캐시로 전락 | **54.2%** |
| `cached_verdict` | — | 취약 | 48.8% |

**핵심 발견:**
- `progressive_refresh`는 `adaptive_window(vol) ≥ delay_steps`가 되면 재검증 조건 `step-last > window`가 발화하지 않아 **순수 캐싱과 동일**해진다 (revalidation_count=0 확인).
- vol=0.02~0.08 구간에서 실패율이 비단조 증가하며 vol=0.10에서 0으로 떨어지는 역설적 패턴.
- **홀수/짝수 delay 패리티 버그**: vol=1.0에서 홀수 delay는 54.2%, 짝수 delay는 0% — 재검증 주기 `2*floor(round(fw*(1-vol)))`가 마지막 재검증을 놓치면 완전 반전 상태로 판독.
- vol=0.1, window=20에서 22.8% (큰 윈도우 + 느린 드리프트).
- **정정:** 읽기 위주 PoC는 unsafe_allowed=0을 출력하면서도 “완전 우회” 결론을 고정 출력했다. 현행 실제 실험 호출로 수정했다. 이 합성 정책은 읽기를 항상 안전하게 정의하므로 실제 읽기 기밀성의 검증으로 사용할 수 없다.
- 상세: [HALO_EXPLOIT_V7_ULTRA_REPORT.md](../HALO_EXPLOIT_V7_ULTRA_REPORT.md) §E003, [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) §E003

### 3.4 E004 — 견고한 평가 메트릭

| 공격 | 원본 취약점 | 수정 후 | 잔존 |
| --- | --- | --- | --- |
| 부분군 가중 조작 | 26% worst TPR 은닉 | equal-weight 강제 | — |
| 임계값 클러스터링 | 31% TPR | 70% TPR | ⚠️ 민감도 잔존 |
| FPR 예산 고갈 | — | — | 🚨 worst TPR **2.2%** |
| 완화 체인 | — | — | 🚨 worst TPR **0.0%** (fail-closed 없이 수용) |
| 디코이 플러드 | — | — | ⚠️ 4개 쉬운 그룹으로 0.931 보고 / 실위협 0.589 |

- **수정 전 결함:** 비실현 가능한 최소 TPR을 FPR-only로 조용히 완화했다. 2026-09-21 보완에서는 Python/Rust 모두 제약을 충족하는 임계값이 없으면 오류를 반환한다. 위 수치는 과거 공격 기록이다.
- 상세: [HALO_EXPLOIT_V4_REPORT.md](../HALO_EXPLOIT_V4_REPORT.md) §E004, [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) §E004

### 3.5 E005 — 적응형 회피

- **moving-target 모니터는 containment가 아니다**: 100시드 꼬리 분석에서 moving p95가 static max를 초과.
- moving worst-case 0.565 vs static worst-case 0.259; 특정 설정(survival 0.9/fresh 0.05)에서 max 0.739.
- static 대비 moving이 42% 시드에서 더 나쁨.
- Bayesian w0 추론으로 moving target의 가중치 분포 추정 가능 (PoC).
- 상세: [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) §E005

---

## 4. OS 샌드박스 격리 평가 (macOS sandbox-exec)

> 이 절의 9종·Round-2/3 수치는 2026-09-13 이전 라운드의 고정 기록이다. 현재 100개 사례·20회 반복 결과와 보안 게이트는 [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)를 우선한다.

### 4.1 기본 I/O 격리 (9종 × 5회)

| 모드 | 정상 허용 | 공격 차단 | 탈출 |
| --- | ---: | ---: | ---: |
| unconfined_control | 15/15 | 0/45 | 45/45 |
| sandbox_inherited_capabilities | 15/15 | 35/45 | 10/45 |
| sandbox_clean_launch | 15/15 | **45/45** | 0/45 |

### 4.2 익스플로잇 라운드

| 라운드 | 벡터 수 | HARDENED 차단 | 잔존 탈출 |
| --- | --- | ---: | ---: |
| 핵심 5대 | 5 | **25/25** | 0 |
| 2라운드 breakout | 9 | 30/45 | 15/45 |
| 매드니스 | 6 | 20/30 | 10/30 |
| 3라운드 | 9 | 20/45 | 25/45 |

### 4.3 미해결 노출 요약

1. **호스트 메타데이터/핑거프린트** — `statfs_probe`, `listdir_root`, `sysctl_hw_leak`, `ioregistry_enum`, `hw_machine`, `system_version_read`, `mach_host_statistics`, `metadata_boundary_map`
2. **IPC 존재 정찰** — `sysv_ipc_probe`
3. **바운드 리소스 고갈** — `memory_exhaust_bounded`
4. **오류 미판정** — `task_port`, `statfs_host` (차단으로 위장하지 않음)

**구조적 한계:** 루트 디렉터리 읽기 허용과 `hw.machine`/`kern.hostname` sysctl은 Python 로더·`os.uname()` 초기화가 요구하는 예외라서, `sandbox-exec` 프로파일만으로 제거 시 정상 실행이 실패한다. → **호스트 정보 비노출 요구 시 별도 VM/컨테이너 게스트가 필요**하며, 현재 호스트에서 "완전 격리"를 주장하지 않는다.

상세: [REPORT.ko.md](../artifacts/sandbox_benchmark/REPORT.ko.md), [EXPLOIT_REPORT.ko.md](../artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md), [RECHECK.ko.md](../artifacts/sandbox_benchmark/RECHECK.ko.md), [HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md](../artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md), [SANDBOX_BOUNDARY.ko.md](../rust/SANDBOX_BOUNDARY.ko.md)

---

## 5. Rust 구현 평가

### 5.1 수치 정확성

- **Shift v2 1,920행 전수 감사** (jq 독립 계산): 키 중복 0, FPR·TPR·예산·구간 점추정 불일치 0건.
- 극단값 중간 오버플로(가중합 보간)와 Neumaier 보상 합산으로 수치 오류 수정.
- E004 검증 512건 + 잘못된 입력 36건 거부 통과.
- 상세: [ROW_AUDIT.ko.md](../rust/ROW_AUDIT.ko.md), [SHIFT_BENCH.ko.md](../rust/SHIFT_BENCH.ko.md)

### 5.2 성능 (고부하 벤치)

| 실험 | 설정 수 | 규모 | 시간 |
| --- | ---: | --- | ---: |
| E001 | 20 | 20만/오염 0–100% | 0.274s |
| E001B | 45 | 25만/오류 최대 95% | 0.866s |
| E002 | 30 | 10만+10만 | 0.530s |
| E003 | 48 | 5만×256/257 단계 | 8.463s |
| E004 | 5 | 내부 100만 | 0.093s |
| E005 | 20 | 1만×100라운드 | 1.314s |

168개 워크로드 불변식 검증 실패 0건, 총 11.547s. 상세: [HARD_BENCH.ko.md](../rust/HARD_BENCH.ko.md)

### 5.3 보호막 (Shield)

- Hybrid(1:1 절충)는 clean 탐지 손실을 줄였지만 **모든 도메인에서 우월하지 않음** — offset에서 오탐 예산 위반 (3.734%).
- frozen_centered: correlated 최대 강도에서 최악 공격군 block 96.852% ✅, 센서 전손 시 모든 정상이 재검증으로 정지(가용성 손실).
- **복합 교란·공통 방향 상승 공격에 대한 일반 보장 없음**.
- 상세: [SHIELD.ko.md](../rust/SHIELD.ko.md), [ENFORCEMENT.ko.md](../rust/ENFORCEMENT.ko.md)

---

## 6. 보고서 주장 대비 실측 대조표

| 원문 주장 | 실측 | 판정 |
| --- | --- | --- |
| E001B 완전 상관 0.11% 실패 | ρ=1.0 정상 오류율에서 유지 | ✅ 성립 |
| E001B "97% 개선" | p=0.99에서 1.1pp로 소멸 | ⚠️ 저오류율 한정 |
| E002 "weighted_max 96% at low FPR" | FPR=0.01 한정, FPR=0.0001에서 11.64% | ⚠️ 과장 |
| E002 conservative_max 추가 보호 | max_pool과 **완전 동일** | ❌ 무의미 |
| E003 "progressive_refresh 전 변동성 0%" | window≥2에서 최대 54.2% 실패 | ❌ 반증 |
| E003 adaptive_cached 0% | 전 구간 유지 | ✅ 성립 |
| E004 worst-group 보호 | 완화 체인 시 worst TPR 0.0 수용 | ❌ 실패 |
| E005 moving-target 우월 | static 대비 분산 3배·42% 시드에서 열위 | ❌ 반증 |
| 샌드박스 "완전 차단" | 기본 I/O만 차단, 메타데이터 경로 노출 | ⚠️ 한정 |

---

## 7. 최종 권고

### 즉시 조치 (높은 우선순위)

1. **효과 시점 권한 검증** — 실제 실행은 호스트 권한과 adapter 상태 재검사를 사용한다. 합성 캐싱 전략의 0%를 운영 승인으로 사용하지 않는다.
2. **freshness 비교군 보존** — `progressive_refresh`는 허용한 verdict 재사용 기간 동안 stale할 수 있는 비교군이다. 항상 새로 검증하도록 몰래 바꿔 실험의 실패율을 없애지 않는다. 양언어 rounding 불일치는 수정했다.
3. **E002 FPR/TPR trade-off 명시** — 해당 합성 분포의 극저 FPR 탐지 저하를 일반적인 불가능성 정리나 운영 보증으로 확대하지 않는다.
4. **E004 strict 제약 적용 완료** — 최소 TPR/FPR를 동시에 만족하는 후보가 없으면 오류로 중단한다.
5. **`conservative_max` 비교군 표시 완료** — 과거 결과 호환성을 위해 보존하되 max_pool의 재보정된 scale control이며 독립 방어가 아님을 명시한다.

### 설계 원칙

1. **중복은 상관 무관할 때만 중복이다** — E001B 결과 재확인.
2. **독립 증거 채널이 알고리즘 다양성보다 강하다** — E002 재확인.
3. **"0% 실패"는 해당 파라미터 공간에서만 성립** — 문서의 무제한적 주장 금지.
4. **호스트 메타데이터 비노출이 요구되면 VM/컨테이너 격리** — `sandbox-exec`만으로는 구조적으로 불가.

---

## 8. 검증 환경 및 한계

- **일시:** 2026-09-11 ~ 2026-09-13
- **환경:** macOS (Apple Silicon) / Python 3.12, 로컬 격리, 합성 데이터
- **현재 재검증:** 수정 라운드 후 Python 260개 통과·0개 실패, Rust 통계 워크스페이스와 CLI/reference 테스트 통과, 샌드박스 실행기 14개 테스트 통과. 샌드박스 직접 security gate는 여전히 실패하며 잔여 메타데이터 접근을 뜻한다. 수정 전 재현과 수정 범위는 [2026-09-21 검수 보고서](reviews/2026-09-21-review.ko.md)에 기록했다.
- **한계:**
  - 합성 메커니즘이므로 실제 LLM/모델 containment를 증명하지 않음
  - "0% 실패"는 해당 seed·파라미터·워크로드 조합 한정
  - 반복 5회는 독립 공격 5종을 의미하지 않음 (동일 공격 반복)
  - 샌드박스 판정은 시행 중 오류를 차단으로 세지 않음

---

## 9. 원본 보고서 인덱스

| 문서 | 언어 | 범위 |
| --- | --- | --- |
| [HALO_EXPLOIT_V4_REPORT.md](../HALO_EXPLOIT_V4_REPORT.md) | EN | E001–E004 취약점·수정·재검증 |
| [HALO_EXPLOIT_V5_DIRECT_REPORT.md](../HALO_EXPLOIT_V5_DIRECT_REPORT.md) | KO | E001B/E002/E003 실코드 직접 공격 |
| [HALO_EXPLOIT_V7_ULTRA_REPORT.md](../HALO_EXPLOIT_V7_ULTRA_REPORT.md) | EN | E001B/E002/E003 극한 파라미터 공격 |
| [HALO_EXPLOIT_V3_DIRECT_FINDINGS.md](../HALO_EXPLOIT_V3_DIRECT_FINDINGS.md) | EN | E001B–E005 live-code 공격 요약 |
| [CASE_BASED_REGRESSIONS.md](CASE_BASED_REGRESSIONS.md) | EN | 방어 회귀 카탈로그 |
| [artifacts/sandbox_benchmark/REPORT.ko.md](../artifacts/sandbox_benchmark/REPORT.ko.md) | KO | 샌드박스 기본 벤치 |
| [artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md](../artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md) | KO | 샌드박스 5대 익스플로잇 |
| [artifacts/sandbox_benchmark/RECHECK.ko.md](../artifacts/sandbox_benchmark/RECHECK.ko.md) | KO | 2026-09-12 재검증 |
| [artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md](../artifacts/sandbox_benchmark/HALO_SANDBOX_V3_ROUND4_VERIFICATION.ko.md) | KO | 4라운드 동적 검증 |
| [rust/HARD_BENCH.ko.md](../rust/HARD_BENCH.ko.md) | KO | 고부하 벤치 |
| [rust/SHIFT_BENCH.ko.md](../rust/SHIFT_BENCH.ko.md) | KO | Shift 벤치 v2 |
| [rust/ROW_AUDIT.ko.md](../rust/ROW_AUDIT.ko.md) | KO | 행 전수 감사 |
| [rust/SHIELD.ko.md](../rust/SHIELD.ko.md) | KO | 보호막 평가 |
| [rust/ENFORCEMENT.ko.md](../rust/ENFORCEMENT.ko.md) | KO | 객체 접근 검증 연결 |
| [rust/SANDBOX_BOUNDARY.ko.md](../rust/SANDBOX_BOUNDARY.ko.md) | KO | Rust 샌드박스 경계 |
