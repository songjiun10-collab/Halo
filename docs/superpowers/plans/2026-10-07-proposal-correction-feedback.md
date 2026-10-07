# 플래너 제안 교정 피드백

## 범위와 동작

승인된 작은 개선: 형식·바인딩 오류를 반복하는 플래너에 호스트가 만든 짧은 교정 정보를 전달한다. 목표, 승인, 도구 권한을 수정하지 않는다. 새 로직은 `runtime-src/main/harness/recovery-policy.ts`에 있으며 기존 JS controller는 호출 배선만 담당한다.

- `progress.proposalFeedback`: `authority: host_diagnostic_not_permission`, 허용 목록의 `code`, 고정 `guidance`, 현재 `taskId/goalVersion/basedOnObservationId/maxActions`.
- 원본 provider 오류 메시지와 거부된 모델 출력은 복사하지 않는다. 알 수 없는 오류 코드는 `invalid_proposal`로 정규화한다.
- 피드백은 직렬화한 UTF-8 기준 1KiB 이하다. 이스케이프가 많은 유효한 관측 ID는 보존하고 고정 안내 문구만 줄인다.
- `invalid_proposal_json`/`invalid_proposal` transport 오류는 기존 관측을 그대로 사용하되 교정 피드백과 최신 호출 예산을 붙여 한 번 재요청한다.
- 재요청 전에 중단 상태, 남은 planner-call 예산, active-time 예산을 검사한다. 새 packet도 기존 64KiB 상한을 검사하며 실제 시도할 호출만 추가 차감한다.
- 호스트가 거부한 제안은 새 관측으로 한 번 교정한다. 연속 두 번 거부되면 `invalid_proposal`로 중단한다. 유효한 제안이 들어오면 경고를 지운다.
- 제안의 `basedOnObservationId`가 이번 관측과 다르면 일반 액션도 실행 전에 거부한다. 기존 coordinate binding 검사도 그대로 남는다.
- 명시적인 사용자 resume는 교정 창만 다시 연다. 누적 planner-call 예산은 초기화하지 않는다. 이 교정 창·힌트는 비내구 상태이며, 기존 내구 예산을 대체하지 않는다.

## 재현 및 검증

기존 코드에서 호출 한도가 1인데 형식 교정으로 2번 호출되는 실패를 재현했다. 고정된 잘못된 목표 버전 제안은 7회 반복됐으며, 수정 후 2회에서 중단된다. 이는 통제된 fixture의 낭비 호출 감소이며 실제 모델 전체 작업의 호출 감소율은 아니다.

테스트는 JSON 교정, stale goal, stale observation, 연속 오류 중단, 호출·활성 시간 예산, takeover, 유효한 제안 뒤 경고 제거, 명시적 재개, 최대 이스케이프 ID 및 오류 코드 주입을 다룬다. 새 테스트 11개를 포함한 최신 관련 회귀 124개가 통과했다. TypeScript와 생성 코드 일치 검사가 통과했다. 전체 회귀는 1,985개 통과, 실패·취소·skip 0개이며 543.358초가 걸렸다 (`npm test -- --test-concurrency=1`).

독립 리뷰 에이전트는 모델 라우팅 오류로 시작하지 못했다. 독립 리뷰 완료로 취급하지 않으며 직접 변경 검토와 테스트 결과만 보고한다.

## 통제된 피드백 비교

`apps/computer-browser`에서 `node integration/proposal-feedback-benchmark.ts`로 재현한다. 같은 현재 controller와 실제 TaskStore에 같은 scripted planner를 사용하고, 두 조건 중 하나에서만 `proposalFeedback`을 숨긴다. 각 8회, 순서는 번갈아 실행한다.

| 측정 | 피드백 숨김 | 피드백 전달 |
| --- | ---: | ---: |
| 교정된 제안 / 8회 | 0 | 8 |
| 총 planner 호출 | 16 | 16 |
| 요청별 누적 context bytes 평균 | 2,498 | 2,811 |
| 요청별 추가 feedback bytes 평균 | 0 | 293 |
| 로컬 wall p50 / p95 | 10.929 / 22.398ms | 6.982 / 8.026ms |
| 실행된 browser actions | 0 | 0 |

중요: scripted planner는 이 진단을 읽으면 고치도록 만들어져 있다. 결과는 피드백 경로의 접속 시험이며 모델 정확도 향상이 아니다. 두 조건 모두 새 controller를 쓰므로 과거 controller의 E2E 비교도 아니다. 바이트를 측정했으며 토큰, 모델 비용·지연을 측정하지 않았다. 완료가 아니라 제안이 수용돼 `awaiting_verification`에 도달하는지만 확인했다. C1의 사람 확인은 계속 필요하다. Wall time은 로컬 내구 기록을 포함하지만 store 생성·정리는 제외한다. 지연 차이는 실제 모델 속도 개선으로 해석하지 않는다.

## 진단 질문

1. 어떤 종류의 제안이 거부됐는가? 다음 턴의 허용된 `proposalFeedback.code`로 확인한다.
2. 추가 호출이 예산을 넘었는가? checkpoint의 `budgets.plannerCallsUsed`와 호출 수를 대조한다.
3. 실패한 제안이 실행됐는가? 테스트의 실제 controller dispatch 수와 action journal을 확인한다.

외부 모델·API·사용자 브라우저는 사용하지 않았다. 커밋·푸시 없음.
