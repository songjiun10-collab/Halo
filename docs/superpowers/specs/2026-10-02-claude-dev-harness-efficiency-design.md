# HALO Harness 효율 개선 설계

작성: Codex, 2026-10-02. 상태: 조사 기반 구현 제안 / Claude handoff.
이번 사용자 요청은 조사·설계·이첩이다. 이 문서는 구현 완료나 성능 개선을 주장하지 않는다.

## 1. 공개 자료에서 얻은 방향

- [Dynamic workflows](https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/): 작업 분해와 합성 barrier, 독립 검증, 완료 조건을 갖춘 반복 흐름을 제시한다. 다중 에이전트는 토큰·조정 비용이 있으므로 복잡한 작업에 선택적으로 사용한다. HALO에서는 모델 작성 JS를 실행하는 대신 검증된 선언형 계획으로 제한한다.
- [Context engineering](https://claude.dev/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models/): 문맥을 전부 선제 주입하기보다 필요한 도구·참조를 단계적으로 로드하고 인터페이스를 명료하게 만드는 방향을 제시한다. HALO에서는 goal·권한·provenance는 host가 항상 제공하고, 부가 관찰만 선택적으로 로드한다.
- [Performance engineering](https://claude.dev/blog/how-we-made-claude-ai-faster/): 사용자 동작부터 화면 반영까지 측정하고, 호출·렌더링 같은 반복 가능한 수치를 실제 지연 시간과 대조한다. 해당 글의 개선 수치는 Anthropic의 자체 사례이며 HALO의 예상 개선율로 쓰지 않는다.
- [Eval design and hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/): 실제 작업 분포, 고정 평가 조건, 보류 데이터, 한 번에 하나의 변경을 강조한다. HALO에서는 개발용 사례와 최종 평가 사례를 분리하며 성공률·안전·시간·메모리를 함께 판정한다.

## 2. 현재 코드에서 확인된 연결점

- `apps/computer-browser/main/harness/context-builder.js`: `buildContext()`가 goal/state/observation/recentEvents/userMemory/navigationHistory를 구성한다. pendingMessages에는 count·byte·총 packet 예산이 있고 teamBoard도 별도 예산으로 제한한다. 기본 packet이 상한을 넘으면 `context_limit`을 반환한다.
- `main/harness/routine-runner.js`: Routine은 proposal source이며 BrowserAdapter를 받지 않는다. cursor는 routineId/revision/stepIndex/stepDigest에 맞는 binding으로만 전진한다. 이 경계를 재사용한다.
- `main/harness/task-controller.js`: checkpoint에서 profile/budget/progress를 복원하고 `execution_uncertain`을 paused로 처리한다. 별도 실행 루프를 만들어 이 처리를 우회하지 않는다.
- `main/harness/work-goal-store.js`, `work-goal-orchestrator.js`: 프로젝트 Goal 및 기존 Task 결합을 확장 지점으로 사용한다.
- `shared/task-profile-router.js`, `task-profile-contracts.js`, `main/harness/planner-providers.js`: 기존 profile/provider 선택을 재사용한다.
- `integration/routine-vs-planner-benchmark.js`, `profile-long-task-benchmark.js`, `long-horizon-100-benchmark.js`: 측정 확장 후보. 실제 timing 필드의 존재와 정확성은 구현 전 확인한다.

경로의 `main/`, `shared/`, `integration/`은 위 apps/computer-browser 하위다. 작업 트리에 동시 수정이 있으므로 구현 시 현재 소스와 계약을 다시 확인한다.

## 3. 우선순위

1. **P0: 측정 계약** — planner/decision/approval/journal/checkpoint/browser의 비용을 분리한다.
2. **P1: Context manifest** — 기존 64KiB packet 안에서 필요 참조만 읽도록 만든다.
3. **P2: 선언형 workflow** — Routine·child dispatch·barrier·synthesis를 기존 Core 위에 결합한다.
4. **P3: 비용 최적화 평가** — 동일 작업·모델·effort·동시성으로 기존 실행과 비교한다.

프론트 handoff 통합과 병행할 때 이 작업은 harness/backend 및 integration 측정 파일에 한정한다. 기존 frontend 담당 작업을 덮어쓰지 않는다.

## 4. P0 측정 계약

host가 monotonic clock으로 span을 생성한다. 식별자는 taskId/runId/turnId/spanId/parentSpanId이며 stage는 `context`, `planner`, `decision`, `approval`, `journal_append`, `checkpoint`, `browser`, `verification`이다.

`durationMs`는 완료 시점에 기록한다. `wallMs`, `activeMs`, `humanWaitMs`를 구분하고 겹치는 span을 단순 합산하지 않는다. fsync 하위 span은 append/checkpoint 비용의 일부이며 중복 합산 금지다. 캐시 hit/miss, contextBytes, plannerCalls, journalOps, checkpointOps, actionCount, duplicateDispatchCount도 기록한다. provider가 token 수를 제공하지 않으면 null로 표시하며 bytes를 tokens로 표기하지 않는다.

벤치 telemetry는 bounded buffer 또는 기존 계측 경로를 사용한다. 매 span마다 새 fsync를 추가하면 측정 자체가 실행을 늦추므로 audit journal과 구분한다. telemetry 누락을 작업 완료 증거나 승인으로 사용하지 않는다. evidence와 durable 실행 기록의 보존 정책은 변경하지 않는다.

측정 실패로 span을 버릴 수는 있지만, 정책 판단이나 durable append 실패를 성공으로 바꿀 수는 없다. 사용자 체감은 task 제출→첫 관찰, 제출→첫 proposal, 승인→브라우저 결과, 총 완료 시간으로 별도 측정한다.

### 4.1 구현으로 확정한 계약 (Claude, 2026-10-02)

- **새 계측 지점은 하나뿐이다.** `TaskController`의 선택 옵션 `onTiming({operation: "context_build", elapsedMs, bytes})`이다. bytes는 planner가 받은 packet의 UTF-8 JSON 크기와 같다. 콜백 예외는 무시되고 실행 결과를 바꾸지 않는다. 함수가 아닌 값은 `invalid_config`로 거부한다. 나머지 측정은 모두 기존 `TaskStore.onTiming`과 벤치의 기존 래퍼를 재사용한다.
- **`apps/computer-browser/integration/stage-spans.js`**(벤치 전용, `main/`은 이 파일에 의존하지 않음):
  - 기존 라벨을 위 8개 stage로 매핑한다. 미지 라벨은 거부하므로 임의 metric 이름이 생기지 않는다.
  - `approve_call_inclusive`는 inclusive로 표시해 stage 합계에서 제외한다. 라벨별 값으로는 여전히 보고한다.
  - TaskStore의 journal/checkpoint 하위 연산은 순차적이고 서로 겹치지 않는 구간이라 합산해도 된다.
  - 통계는 nearest-rank p50/p75/p95/max/total이다.
  - raw span 버퍼는 `maxSpans`로 제한한다. 넘친 span은 `droppedSpans`로 세며, 집계는 모든 표본을 유지해 정확하다.
  - `phases`: `wallMs`, `activeMs`, `humanWaitMs`로 나누며, 측정하지 않은 값은 0이 아니라 null이다.
  - `marks`: `first_observation`, `first_proposal`(시작 기준 ms)을 기록한다.
  - `counters`: `contextBytes`, `plannerCalls`, `actionCount`, `journalOps`(= journal_fsync 수), `checkpointOps`(= checkpoint_rename 수), `duplicateDispatchCount`(= browser.execute 호출 수 − 예산에 잡힌 action 수)를 기록한다. `tokens`는 항상 null이고, 직접 기록하려고 하면 거부한다.
- **routine-vs-planner 벤치 연결:**
  - iteration마다 `note(label, ms)` 하나가 기존 `stages`와 span을 함께 갱신하므로 두 값이 서로 달라질 수 없다.
  - 이 과정에서 기존 `stages.proposal`이 항상 0이던 문제를 고쳤다. 실제 값은 `proposalSamples`에만 쌓이고 있었다.
  - `humanWaitMs`는 승인 대기가 보인 snapshot부터 `approve()` 호출까지다. 이 벤치는 승인을 프로그램으로 처리하므로 거의 0이고, 사람의 대기를 측정한 값이 아니다.
- **재현 명령**(apps/computer-browser에서 실행):
  `HALO_BENCH_SPANS_PATH=/tmp/spans.jsonl node_modules/.bin/electron integration/routine-vs-planner-benchmark.js`
  JSONL은 iteration마다 span 줄들과 summary 한 줄로 이루어진다.
- **미구현(완료로 보고하지 않음):**
  - cache hit/miss: 현재 context 경로에 캐시가 없다.
  - 승인→브라우저 결과 mark.
  - parentSpanId: 지금의 span은 모두 겹치지 않는 구간이라 항상 null이다.
  - `long-horizon-100`, `profile-long-task` 벤치 연결: 실제 Electron 스크립트이고, `durable_store`처럼 append와 checkpoint를 감싸는 겹치는 라벨을 쓰므로 별도 매핑 결정이 필요하다.

## 5. P1 Context manifest / 필요한 참조만 로딩

기존 64KiB 총 JSON 한도를 유지한다. 필수 영역은 host goal/binding, 현재 state/budget, 현재 observation identity·document epoch, pending approval 요약이다. 이 영역은 모델 요약으로 대체하지 않는다.

부가 영역은 최근 로그·페이지 관찰 상세·검색 결과·evidence 본문이다. host는 immutable reference와 짧은 summary를 제공한다. 자격증명/secret은 ref 본문에도 넣지 않는다.

제안 계약:

```json
{
  "contextManifest": {
    "version": 1,
    "refs": [{"refId":"opaque-id","kind":"observation","authority":"untrusted_page_derived","revision":"opaque-revision","byteLength":4096,"summary":"bounded text"}]
  }
}
```

planner 요청 `context_read`는 `{kind, taskId, goalVersion, refIds}`를 받는다. 세부 action envelope는 현재 planner 계약과 통일한다. 최대 4개 ref, ref당 UTF-8 JSON 결과 4KiB, 결과 집합 최대 12KiB, 결과를 포함한 다음 packet 최대 64KiB. 최신 revision과 task 소유권을 host가 검증하며 임의 파일 경로·URL 읽기로 변환하지 않는다.

너무 긴 결과는 `truncated: true`와 continuation ref를 제공한다. UTF-8 문자 경계 및 JSON envelope를 포함해 크기를 검증한다. 삭제/GC된 ref는 `context_ref_unavailable`, 다른 task의 ref는 `context_ref_forbidden`, 이전 goal/epoch는 `context_ref_stale`로 반환한다. ref 부재가 성공 결과를 뜻하지 않는다.

`context_read`는 기존 planner-call/action 예산에 과금한다. pending message의 기존 순서·admission·durable consumed 계약을 유지하며, manifest 최적화로 메시지를 자동 consumed 처리하지 않는다.

### 5.1 구현으로 확정한 계약 (Claude, 2026-10-02)

- **planner discriminant**: 새 proposal kind를 만들지 않았다. 기존 `mcp_*`처럼 `kind:"actions"` 안의 단독 action `{"type":"context_read","refIds":[1-4개]}`로 표현한다.
  - 다른 action과 섞이거나 키가 하나라도 다르면 실행하지 않는다.
  - TS 계약(`runtime-src`)과 proposal schema는 바뀌지 않았다. actions의 item은 이미 object로만 검증된다.
- **예산과 경계**:
  - read 1회는 `actionsUsed`에서 1을 쓴다. planner 호출은 원래대로 별도 과금된다.
  - 예산이 소진되면 `budget_exhausted`로 멈춘다.
  - 브라우저로 dispatch하지 않고 승인 대상도 아니다. host가 이미 planner에게 보여준 데이터를 다시 읽는 것뿐이다.
  - pending message의 admission과 consumed 처리는 건드리지 않았다.
- **opt-in**:
  - `TaskController({ contextRefs: true })`일 때만 동작하며, 기본값은 false다.
  - 꺼져 있으면 packet에 `contextManifest`가 없고, `context_read`는 기존 action 경로를 그대로 탄다.
  - 현재 TaskHost는 이 옵션을 켜지 않는다. 켜는 결정은 P3 평가 뒤에 한다.
- **ref 출처**:
  - 처음에는 recentEvents 밖의 오래된 journal event를 계획했다. 그러나 controller가 action마다 checkpoint를 남겨 `eventsSinceCheckpoint`가 사실상 비어 있으므로 제외했다.
  - 대신 task가 떠난 페이지의 텍스트 스냅샷 `{url, title, text}`를 등록한다. kind는 `observation`, authority는 `untrusted_page_derived`다.
  - element id가 없으므로 스냅샷으로 action 대상을 고를 수 없다.
  - 같은 URL을 다시 방문하면 이전 스냅샷을 대체한다.
- **stale 판정**:
  - live document에 묶인 page-derived ref(`documentEpoch`가 있는 것)는 epoch가 바뀌면 stale이다.
  - 과거 스냅샷은 `documentEpoch`가 null이라 goalVersion이 바뀔 때만 stale이 된다.
  - 다른 task의 ref는 `context_ref_forbidden`, 없거나 회수된 ref는 `context_ref_unavailable`이다.
  - 12KiB 집합 상한에 걸려 잘린 ref는 `context_read_budget`, 다음 packet 64KiB를 넘으면 `context_read_omitted`로 답한다. 어느 경우에도 빈 성공으로 답하지 않는다.
- **상한**:
  - catalog: 128개 ref, 본문 하나당 256KiB, continuation ref 512개. 모두 오래된 것부터 회수한다.
  - packet에 넣는 manifest는 최신 ref부터 8KiB까지만 담고, 남은 수는 `omittedRefs`로 알린다. catalog가 가득 차도 64KiB packet을 위협하지 않게 하기 위해서다.
  - ref id는 무작위 `ref_*` 토큰이며 경로나 URL로 해석하지 않는다.
- **prompt**: Claude bridge의 `buildPrompt`는 packet에 manifest가 있을 때만 `context_read` 사용법을 안내한다. Codex bridge도 같은 prompt를 쓴다.
- **미구현**: evidence 본문 ref, 캐시 hit/miss 카운터, 실제 모델에서의 사용성(P3 평가 대상).

작업마다 참조 catalog를 제한한다(초안 128개). 큰 본문은 저장소에서 읽으며 context-builder가 전체 기록을 메모리로 올리지 않는다. 캐시 키에는 taskId/goalVersion/documentEpoch/ref revision을 포함한다. 변경·회수 시 캐시는 무효화한다.

## 6. P2 선언형 workflow

계획은 데이터이며 실행 가능한 JS·shell·동적 import를 포함하지 않는다. 최초 지원은 `routine`, `child`, `barrier`, `synthesize` 네 node다. node 최대 32개, DAG만 허용하며 순환은 거부한다. 반복은 후속 버전에서 명시적 iteration·budget 계약을 먼저 정한다.

```json
{
  "version":1,"workflowId":"uuid","revision":1,
  "taskId":"uuid","goalVersion":1,
  "nodes":[
    {"id":"collect","type":"child","dependsOn":[],"request":"bounded task","capabilityProfileId":"host-known-id"},
    {"id":"join","type":"barrier","dependsOn":["collect"],"onFailure":"pause"},
    {"id":"report","type":"synthesize","dependsOn":["join"],"criterionIds":["host-criterion-id"]}
  ]
}
```

host는 schema/바인딩/DAG/예산/권한을 검증한 뒤 저장한다. workflow는 기존 TaskController에 proposal을 내고 실제 dispatch는 기존 policy→approver→executor를 사용한다. 자식은 부모 권한의 부분집합이며 task별 browser session과 기존 메모리 admission을 유지한다. 새로운 워크플로에서 사용자 override를 자동 켜지 않는다.

barrier는 dependencies가 host-recorded terminal 상태일 때만 풀린다. missing/failed/cancelled/uncertain 결과는 successful로 합성하지 않는다. 부분 결과 허용이 필요하면 계획의 명시적 정책과 Goal criteria가 함께 허용해야 한다. synthesis의 텍스트는 untrusted이며 criterion 충족은 host verifier가 결정한다.

node의 시작 의도·결과와 workflow revision을 기존 durable 저장 구조에 결합한다. crash 뒤 started-without-result는 uncertain으로 복원하고 자동 재실행하지 않는다. journal/checkpoint 중 무엇이 authoritative한지는 기존 TaskStore recovery 규칙을 따르고 구현 전에 명시한다. 완료 binding과 idempotency 키는 workflowId/revision/nodeId 및 실행 attempt에 묶는다. idempotency 키 자체는 외부 서비스의 exactly-once를 보장하지 않는다.

goal 변경은 이전 node proposal/approval을 무효화한다. pause/stop/takeover는 기존 admission gate와 FIFO drain을 따르며, workflow scheduler가 우회 dispatch를 갖지 않는다.

### 6.1 P2a로 확정한 계약 (Claude, 2026-10-02)

`apps/computer-browser/main/harness/workflow-plan.js`는 순수 모듈이다. fs, IPC, timer가 없고 아무것도 실행하지 않는다.

- **node payload는 기존 계약을 재사용한다.**
  - `child`: `{subgoal, entryUrl}`. `contracts.validateChildAssignment`로 검증하므로 http(s)만 허용하고, URL 안의 자격증명은 거부한다. 문서 초안의 `request`/`capabilityProfileId` 대신 현재 child_plan assignment 형태를 그대로 썼다. 자식 권한은 지금처럼 observe/scroll로 제한된다.
  - `routine`: `{routineId, revision, digest}`. RoutineStore가 고정한 세 값이다.
  - `barrier`: `{onFailure:"pause"}`만 허용한다. 부분 결과 정책은 v1에 없다.
  - `synthesize`: `{criterionIds}`. 현재 goal의 criterion만 허용하며, 입력 dependency가 하나 이상 필요하다.
- **plan 규칙**:
  - node id는 `^[a-z][a-z0-9_-]{0,31}$`이고 node는 최대 32개다.
  - 미지 필드는 plan과 node 모두에서 거부한다. 코드나 스크립트 필드는 들어올 자리가 없다.
  - 중복 id, 없는 dependency, 자기 참조, 순환은 각각 `duplicate_node`, `unknown_dependency`, `workflow_cycle`로 거부한다.
  - taskId와 goalVersion이 현재 goal과 다르면 `binding_mismatch`다.
  - 검증된 plan은 deep-freeze하고 안정적인 topological order를 붙인다.
- **상태 전이**:
  - node 상태는 pending → running → succeeded/failed/cancelled/uncertain이다.
  - start는 ready인 node만, 다음 attempt 번호로만 허용한다. result는 running인 node에 같은 attempt로 한 번만 받는다.
  - barrier는 시작하지 않는다. 입력이 모두 settled되면 host가 succeeded나 blocked로 판정한다.
  - failed, cancelled, uncertain은 성공으로 합성하지 않는다. 그 아래 node는 ready가 되지 않고, workflow는 `paused/workflow_dependency_failed`와 막힌 nodeId를 보고한다.
- **복구**:
  - `WorkflowState.replay(plan, records)`는 `workflow_node_started`/`workflow_node_result` 기록을 journal 순서대로 다시 적용한다.
  - 시작만 있고 결과가 없는 node는 uncertain으로 바꾸고 자동 재실행하지 않는다.
  - 순서가 깨진 기록은 fail-closed로 오류를 낸다.
- **idempotency 키**: `wf:<workflowId>:r<revision>:<nodeId>:a<attempt>`.
- **P2b(다음 단계, 미구현)**:
  1. `runtime-src/shared/harness-contracts.ts`의 EVENT_TYPES에 `workflow_plan_accepted`, `workflow_node_started`, `workflow_node_result`와 payload 검증을 추가하고 `npm run build:runtime`으로 빌드한다.
  2. 권위 있는 기록은 journal이다. child coordinator와 같이 `getEvents`로 처음부터 읽어 replay하며, checkpoint에는 workflow 상태를 따로 두지 않는다.
  3. `RoutineRunner`처럼 proposal source가 되는 `WorkflowRunner`를 만든다. child node는 `child_plan` proposal로 내보내 기존 `ChildAgentCoordinator`, admission, 승인 경로를 그대로 탄다. routine node는 고정된 `RoutineRunner`에 위임한다. synthesize는 기존 `finish`와 host verifier로 판정한다.
  4. child 결과는 `child_result_verified` 같은 host 기록만 node result로 인정한다.
  5. goal amend가 있으면 workflow 전체를 stale로 본다.

## 7. 평가와 수용 조건

- 최초 비교: scripted planner / Routine / 동일 작업의 선언형 workflow. 모델·effort·concurrency·task seed·환경을 고정한다. 실제 provider 실행은 사용 가능한 계정·비용 범위가 확인된 경우에만 별도 수행한다.
- 개발 사례와 sealed 평가 사례를 분리한다. 최종 평가 결과를 읽고 반복 조정한다면 더 이상 sealed라고 부르지 않고 새 검증 세트를 확보한다.
- 먼저 성공률, stale 승인 차단, uncertain 재실행 방지, goal 유지, 권한 축소, duplicate dispatch를 확인한다. 성능을 위해 이 조건을 완화하지 않는다.
- 시간은 p50/p75/p95와 반복별 원자료를 저장한다. planner calls/tokens/context bytes/RSS/journal ops/browser calls를 함께 남긴다. macOS에서 CPU instruction counting 지원을 가정하지 않는다.
- surrogate count가 줄어도 실제 wall time과 사용자 경로 지연이 개선되지 않으면 성능 개선으로 발표하지 않는다.
- P1 채택 기준 초안: paired 대표 사례에서 context bytes 중앙값 20% 이상 감소, 성공률 저하 없음, 안전 사례 전부 통과. 20%는 목표이지 확보한 결과가 아니다.
- 기본 1GiB 메모리 예산은 기존 host scheduler가 강제한다. 부모가 자식 수를 제안해도 실행 동시성은 예산 admission을 따른다.

## 8. 구현 분담과 Claude에 넘길 순서

Claude: P0의 기존 timing 구현을 먼저 조사하고 중복 계측을 피한다. 누락 span과 벤치 결과 schema부터 구현·검증한다. 다음 P1 manifest를 독립 변경으로 구현한다. P2는 P0/P1 결과와 기존 child-plan/Routine 계약 검토가 끝난 뒤 진행한다.

Codex: 설계 및 소스 연결점 제공, 변경 후 계약·안전·측정 검토. 동시 파일 편집 전에 소유 범위를 공유한다.

첫 구현 산출물은 stage별 profiling JSONL, 재현 명령, 기존 benchmark와의 비교, focused regression 결과다. 기존 사용자 수정은 보존하고 이 handoff에서 commit/push는 요청하지 않는다. 프론트 통합 작업이 이미 진행 중이면 완료 후 본 설계의 P0으로 이어간다.

## 9. 남은 결정

P0 기존 계측 재사용 가능 여부, context_read의 정확한 planner discriminant와 예산 카운터, workflow를 TaskStore에 결합할 이벤트 종류는 구현자가 현재 코드로 확정하고 문서에 기록한다. 현재 미정 항목을 구현 완료라고 보고하지 않는다.
