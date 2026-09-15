# HALO 종합 보안 평가 문서

> HALO AI safety containment 시스템의 모든 실증 평가·익스플로잇·재검증 결과를 하나로 통합한 문서다.
> 각 항목의 상세 원문은 링크된 개별 보고서에 있으며, 본 문서는 2026-09-14 기준 종합 판정이다.
> 모든 평가는 로컬 격리 환경·합성 데이터·가상 자원을 대상으로 했으며, 외부 시스템·실계정·실제 모델은 대상이 아니다.
>
> **현재 기준:** 2026-09-14 최신 집계와 과거 보고서의 해석 규칙은 [REPORT_INDEX.ko.md](../REPORT_INDEX.ko.md)를 우선한다. 과거 문서의 수치와 “완전 차단” 표현은 당시 원자료다.

---

## 1. 평가 범위 및 대상

| 계층 | 대상 | 원문 |
| --- | --- | --- |
| 합성 실험 | E001–E005 containment 메커니즘 | [EXPLOIT_REPORT.md](../EXPLOIT_REPORT.md) |
| 실코드 직접 공격 | `experiments/`의 `run`/`evaluate` 직접 호출 | [EXPLOIT_REPORT_DIRECT.md](../EXPLOIT_REPORT_DIRECT.md), [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) |
| 울트라 익스플로잇 | 극한 파라미터 공간·임계값 정밀 공격 | [ULTRA_EXPLOIT_REPORT.md](../ULTRA_EXPLOIT_REPORT.md) |
| PoC | E003 stale-reads, E005 moving-target 우회 | [redteam/poc_e003_stale_reads_exploit.py](../redteam/poc_e003_stale_reads_exploit.py), [redteam/poc_e005_moving_target_bypass.py](../redteam/poc_e005_moving_target_bypass.py) |
| OS 샌드박스 | macOS `sandbox-exec` 격리 경계 | [artifacts/sandbox_benchmark/](../artifacts/sandbox_benchmark/) |
| Rust 구현 | 수치 검증·보호막·성능 | [rust/](../rust/) |
| 방어 회귀 | case-based 안전 불변식 | [CASE_BASED_REGRESSIONS.md](CASE_BASED_REGRESSIONS.md) |

---

## 2. 종합 판정 요약

### 2.1 방어 성공 (검증한 공격 범위에서 유지)

| 방어 | 공격 벡터 | 결과 |
| --- | --- | --- |
| `adaptive_cached` (E003) | 변동성 임계 정밀 공격, delay/윈도우 스윕, 상태 드리프트 | **0% 실패 전 구간** |
| `correlation_aware` (E001B) | 완전 상관(ρ=1.0) + 정상 오류율 | 0.11–0.25% 실패 |
| evidence-diverse 앙상블 (E002) | 블라인드 스팟 100% | 최악군 TPR ~97% |
| 사용 시점 재검증 (E003) | 상태 드리프트 | 0% 실패 |
| 샌드박스 HARDENED | 5대 핵심 익스플로잇, 기본 I/O | 25/25, 45/45 차단 |

### 2.2 미해결 취약점 (우선순위 순)

| # | 실험 | 취약점 | 최악 실측 | 심각도 |
| --- | --- | --- | --- | --- |
| 1 | E003 | `progressive_refresh`가 window≥2 + 변동성 조합에서 실패 — **보고서의 "0%" 주장 반증** | 54.2% (vol=1.0, 홀수 delay, parity 버그) | 🚨 높음 |
| 2 | E003 | `adaptive_cached`가 읽기 위주 워크로드에서 stale verdict 허용 (redteam PoC, 실코드 직접 공격 시 0%였으나 로직 재구현 기준 우회) | 완전 우회 | 🚨 높음 |
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
- 상세: [EXPLOIT_REPORT.md](../EXPLOIT_REPORT.md) §E001B, [EXPLOIT_REPORT_DIRECT.md](../EXPLOIT_REPORT_DIRECT.md) §E001B, [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md)

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
- 상세: [ULTRA_EXPLOIT_REPORT.md](../ULTRA_EXPLOIT_REPORT.md) §E002, [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) §E002

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
- PoC는 읽기 위주 워크로드(write_ratio≤0.05)와 vol=0.050001 임계 경계 타기팅으로 `adaptive_cached`의 읽기 경로 우회도 시연한다.
- 상세: [ULTRA_EXPLOIT_REPORT.md](../ULTRA_EXPLOIT_REPORT.md) §E003, [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) §E003, [redteam/poc_e003_stale_reads_exploit.py](../redteam/poc_e003_stale_reads_exploit.py)

### 3.4 E004 — 견고한 평가 메트릭

| 공격 | 원본 취약점 | 수정 후 | 잔존 |
| --- | --- | --- | --- |
| 부분군 가중 조작 | 26% worst TPR 은닉 | equal-weight 강제 | — |
| 임계값 클러스터링 | 31% TPR | 70% TPR | ⚠️ 민감도 잔존 |
| FPR 예산 고갈 | — | — | 🚨 worst TPR **2.2%** |
| 완화 체인 | — | — | 🚨 worst TPR **0.0%** (fail-closed 없이 수용) |
| 디코이 플러드 | — | — | ⚠️ 4개 쉬운 그룹으로 0.931 보고 / 실위협 0.589 |

- **완화 체인이 조용히 실패**: `min_any_group_tpr`/`min_worst_group_tpr`가 비실현 가능하면 FPR-only로 완화되어 worst-group TPR 0.0을 차단 없이 수용한다.
- 상세: [EXPLOIT_REPORT.md](../EXPLOIT_REPORT.md) §E004, [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) §E004

### 3.5 E005 — 적응형 회피

- **moving-target 모니터는 containment가 아니다**: 100시드 꼬리 분석에서 moving p95가 static max를 초과.
- moving worst-case 0.565 vs static worst-case 0.259; 특정 설정(survival 0.9/fresh 0.05)에서 max 0.739.
- static 대비 moving이 42% 시드에서 더 나쁨.
- Bayesian w0 추론으로 moving target의 가중치 분포 추정 가능 (PoC).
- 상세: [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) §E005, [redteam/poc_e005_moving_target_bypass.py](../redteam/poc_e005_moving_target_bypass.py)

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

상세: [REPORT.ko.md](../artifacts/sandbox_benchmark/REPORT.ko.md), [EXPLOIT_REPORT.ko.md](../artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md), [RECHECK.ko.md](../artifacts/sandbox_benchmark/RECHECK.ko.md), [DYNAMIC_VERIFICATION_2026-09-13.ko.md](../artifacts/sandbox_benchmark/DYNAMIC_VERIFICATION_2026-09-13.ko.md), [SANDBOX_BOUNDARY.ko.md](../rust/SANDBOX_BOUNDARY.ko.md)

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

1. **E003 기본 캐싱 전략을 `adaptive_cached`로 전환** — `progressive_refresh`의 window≥2 버그와 패리티 버그가 해결되기 전까지 사용 금지.
2. **`progressive_refresh` 수정** — 적응형 윈도우 상한을 1로 캡하거나, 변동성>0이면 `adaptive_cached` 의미론으로 폴백. 재검증 주기 패리티 버그 제거.
3. **E002 극저 FPR 경계 명시** — target_fpr≤0.001 배포는 블라인드 스팟 탐지가 사실상 불가능. 독립 증거 채널로 대체.
4. **E004 완화 체인 fail-closed** — 제약 비실현 시 FPR-only로 완화하지 말고 오류로 중단.
5. **`conservative_max` 제거 또는 실질 구현** — 현재 max_pool과 동일하므로 방어 깊이를 늘리려면 별도 임계값 경로로 수정.

### 설계 원칙

1. **중복은 상관 무관할 때만 중복이다** — E001B 결과 재확인.
2. **독립 증거 채널이 알고리즘 다양성보다 강하다** — E002 재확인.
3. **"0% 실패"는 해당 파라미터 공간에서만 성립** — 문서의 무제한적 주장 금지.
4. **호스트 메타데이터 비노출이 요구되면 VM/컨테이너 격리** — `sandbox-exec`만으로는 구조적으로 불가.

---

## 8. 검증 환경 및 한계

- **일시:** 2026-09-11 ~ 2026-09-13
- **환경:** macOS (Apple Silicon) / Python 3.12, 로컬 격리, 합성 데이터
- **회귀 테스트:** Python 159/159 통과, Rust 통계 테스트 57개와 샌드박스 실행기 테스트 13개 + Clippy 통과
- **한계:**
  - 합성 메커니즘이므로 실제 LLM/모델 containment를 증명하지 않음
  - "0% 실패"는 해당 seed·파라미터·워크로드 조합 한정
  - 반복 5회는 독립 공격 5종을 의미하지 않음 (동일 공격 반복)
  - 샌드박스 판정은 시행 중 오류를 차단으로 세지 않음

---

## 9. 원본 보고서 인덱스

| 문서 | 언어 | 범위 |
| --- | --- | --- |
| [EXPLOIT_REPORT.md](../EXPLOIT_REPORT.md) | EN | E001–E004 취약점·수정·재검증 |
| [EXPLOIT_REPORT_DIRECT.md](../EXPLOIT_REPORT_DIRECT.md) | KO | E001B/E002/E003 실코드 직접 공격 |
| [ULTRA_EXPLOIT_REPORT.md](../ULTRA_EXPLOIT_REPORT.md) | EN | E001B/E002/E003 극한 파라미터 공격 |
| [DIRECT_EXPLOIT_FINDINGS.md](../DIRECT_EXPLOIT_FINDINGS.md) | EN | E001B–E005 live-code 공격 요약 |
| [CASE_BASED_REGRESSIONS.md](CASE_BASED_REGRESSIONS.md) | EN | 방어 회귀 카탈로그 |
| [artifacts/sandbox_benchmark/REPORT.ko.md](../artifacts/sandbox_benchmark/REPORT.ko.md) | KO | 샌드박스 기본 벤치 |
| [artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md](../artifacts/sandbox_benchmark/EXPLOIT_REPORT.ko.md) | KO | 샌드박스 5대 익스플로잇 |
| [artifacts/sandbox_benchmark/RECHECK.ko.md](../artifacts/sandbox_benchmark/RECHECK.ko.md) | KO | 2026-09-12 재검증 |
| [artifacts/sandbox_benchmark/DYNAMIC_VERIFICATION_2026-09-13.ko.md](../artifacts/sandbox_benchmark/DYNAMIC_VERIFICATION_2026-09-13.ko.md) | KO | 4라운드 동적 검증 |
| [rust/HARD_BENCH.ko.md](../rust/HARD_BENCH.ko.md) | KO | 고부하 벤치 |
| [rust/SHIFT_BENCH.ko.md](../rust/SHIFT_BENCH.ko.md) | KO | Shift 벤치 v2 |
| [rust/ROW_AUDIT.ko.md](../rust/ROW_AUDIT.ko.md) | KO | 행 전수 감사 |
| [rust/SHIELD.ko.md](../rust/SHIELD.ko.md) | KO | 보호막 평가 |
| [rust/ENFORCEMENT.ko.md](../rust/ENFORCEMENT.ko.md) | KO | 객체 접근 검증 연결 |
| [rust/SANDBOX_BOUNDARY.ko.md](../rust/SANDBOX_BOUNDARY.ko.md) | KO | Rust 샌드박스 경계 |
