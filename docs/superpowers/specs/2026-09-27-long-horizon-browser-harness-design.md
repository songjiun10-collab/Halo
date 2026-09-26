# 장기 브라우저 작업 하네스 — 목표 보존 설계

날짜: 2026-09-27
설계 기준 checkout: `79d8251`
작성: Codex / 구현 담당: Claude 런타임 세션

## 1. 사용자 의도와 완료 기준

사용자 요청: “브라우저 하네스 설계 ㄱㄱ 그 후에 클로드에게 구현 ㄱㄱ”.
사용자 보정: **“장기 작업용 하네스인데 원래목표를 잃지 않는거”**.

핵심 결과는 여러 컨텍스트 창·프로세스 재시작·사용자 개입을 거쳐도 최초 목표,
제약, 완료 조건, 검증된 진척을 유지하는 브라우저 작업 실행기다.
속도는 이 결과를 보존하는 범위에서 개선한다. 단순히 더 오래 도는 while-loop나
이전 대화의 요약만을 메모리로 삼는 설계는 요구를 충족하지 않는다.

성공 기준:

- 100단계 fixture 작업이 10회 이상의 컨텍스트 교체 후에도 모든 최초 조건을 유지한다.
- 재시작 시 원래 목표·검증된 증거·남은 조건·마지막 실행의 불확실성이 복구된다.
- 모델의 “완료” 발언만으로 완료 처리되지 않고 모든 필수 조건의 증거를 검사한다.
- 페이지의 목표 변경 지시나 모델이 만든 요약이 사용자 목표를 덮어쓸 수 없다.
- 장시간 승인/CAPTCHA/사용자 대기, 예산 소진은 `completed`로 위장되지 않는다.
- 실제 Electron fixture 통합 테스트와 모의 모델 테스트의 결과를 구분해 기록한다.

## 2. 선택한 구조와 대안

대화 전체 재전송은 비용과 문맥 누적 문제가 있고, 자유 서술 요약만 저장하면
요약 과정에서 빠진 요구가 소실된다. **호스트가 소유하는 목표 원장 + 증거 원장 +
재생 가능한 이벤트 저널 + 교체 가능한 planner**를 채택한다.

```text
사용자 입력 ─→ GoalSpec(버전 보존, 호스트만 변경)
                   ↓
TaskStore ─→ ContextBuilder ─→ Planner ─→ ProposalValidator
   ↑                               ↓           ↓
   └── Evidence/Journal ← Verifier ← Executor ← Approver
                               ↓
                  완료 조건별 verified / pending
```

Planner는 사고와 제안을 담당하고, TaskController는 수명주기·예산·진척·재개를
담당한다. BrowserAdapter만 실제 브라우저를 조작한다. 기존 Python approver
프로세스는 실행 전 정책 판정을 계속 담당한다.

## 3. 권위가 있는 목표와 파생 데이터

공유 JSON 계약은 `shared/harness-contracts.js`에 runtime 검증기로 둔다.
모든 객체는 허용 필드만 수용하고, 모르는 필드·버전·enum을 거부한다.

### GoalSpec (사용자 권위)

```text
schemaVersion: 1
taskId: host UUID
goalVersion: positive integer
originalRequest: verbatim user text, immutable
amendments: [{id, text, at, supersedesConstraintIds, authority: "user"}]
constraints: [{id, text, sourceMessageId}]
criteria: [{id, text, required, verification: "host"|"user", sourceMessageId}]
limits: {maxActions: 1000, maxPlannerCalls: 500, maxActiveMs: 14400000}
createdAt: ISO timestamp
```

기존 `startTask(prompt)`는 유지하며 기본 필수 조건 C1은
“originalRequest를 달성했고 사용자가 결과를 확인했다”로 정의한다.
자유문으로 시작해도 모델이 원래 요구 자체를 다시 정의하지 못하게 한다.
새 `createTask({prompt, constraints, criteria, limits})`는 명시적인 조건을 받는다.
criteria 생략 시 같은 C1을 사용한다. 모델의 작업 분해는 아래 WorkPlan에 넣는다.

원문은 어떤 요약에서도 재작성하지 않는다. 새로운 사용자 요청이 도착하면
호스트가 amendment와 버전 증가를 기록한다. 무엇을 대체하는지 명시되지 않은
보완은 기존 제약에 추가한다. 모순은 `paused: clarification`으로 표시한다.
페이지/모델/도구의 문장은 amendment API에 접근할 수 없다.

### WorkPlan / Evidence (파생 데이터)

```text
WorkItem = {id, criterionIds, description, status, dependencies, evidenceIds}
Evidence = {id, taskId, goalVersion, criterionId, kind, observationId,
            sourceUrl, artifactHash, at, verification: "pending"|"verified"|"rejected",
            verifierId, details}
```

WorkPlan은 모델이 제안할 수 있지만 모든 항목이 기존 criterionId와 연결되어야
한다. 연결이 없는 제안은 실행하지 않고 `off_goal`로 돌려준다. 이 검사는 참조의
일관성만 보장하며, 설명에 같은 ID를 붙인 의미상 탈선까지 증명하지 않는다.
모호한 진척·목표 해석은 사용자 검토로 넘긴다. 별도 LLM 검토 결과도 증거 후보다.

모델은 증거를 `verified`로 쓸 수 없다. 호스트 verifier가 실행 결과·artifact를
검사하거나, 로컬 사용자 IPC로 해당 결과를 확인한 경우만 변경한다.
목표 amendment 후 기존 evidence는 보존하되 기본적으로 새 버전에 재검증한다.

## 4. 지속 저장과 복구

`app.getPath("userData")/tasks/<host-generated-uuid>/`에 저장한다.
디렉터리 0700, 파일 0600, taskId를 경로 입력으로 직접 연결하지 말고 UUID를 검증한다.
호스트가 만든 루트를 canonicalize하고 하위 symlink를 거부하며 파일은 O_NOFOLLOW로 연다.
한 task의 writer는 하나이며 배타적 lock 파일로 중복 controller를 차단한다.
stale lock은 같은 호스트의 PID와 프로세스 생존을 확인한 후에만 회수한다.

- `goal-vNNNN.json`: 변경 불가능한 목표 버전. 이전 버전을 덮어쓰지 않는다.
- `events.jsonl`: `{seq,eventId,taskId,goalVersion,type,payload,at}` 순서 저널.
- `checkpoint.json`: 마지막 적용 seq, task state, work plan, budgets, evidence index.
- `artifacts/`: 필요한 결과만 저장. 원본 화면/본문을 무제한 보관하지 않는다.

action의 승인·실행 시작·결과를 저널에 append하고 `fsync`한다. 실행 시작 기록이
durable해진 뒤에만 dispatch한다. checkpoint는 같은 디렉터리 임시 파일에 기록,
fsync, atomic rename, 부모 디렉터리 fsync를 사용한다. checkpoint는 캐시이며,
복구는 그 seq 이후의 저널을 재생한다. OS/filesystem별 보장 한계를 문서화한다.

마지막 미완성 JSONL 줄만 잘라낼 수 있다. 중간 파손·seq 역행·중복 충돌은
`paused: storage_corrupt`로 멈춘다. 잘린 action outcome을 추정해 성공으로 복구하지 않는다.
로그 기록 실패는 새 action을 막는다. goal/checkpoint/log 용량 초과는
`paused: storage_limit`이며 오래된 근거를 자동 삭제하지 않는다.
기본 task 저장 한도 100 MiB, 개별 journal event 64 KiB, checkpoint 2 MiB.

`action_started`만 있고 outcome이 없으면 `paused: execution_uncertain`으로 복구한다.
네비게이션을 포함해 자동 재실행하지 않는다. 현재 페이지 재관측과 사용자 확인으로
해소한다. 기존 approval은 복구 시 모두 만료시켜 새 페이지 상태에서 재요청한다.
재시작으로 복구된 task는 자동 출발하지 않고 `paused: recovered`에서 사용자 resume을 받는다.
앱이 꺼진 동안 작업이 수행된다고 표시하지 않는다.

## 5. 컨텍스트 교체와 목표 이탈 방지

각 planner 호출의 입력은 호스트 ContextBuilder가 다시 구성한다:

1. **GoalSpec 원문/모든 amendment/제약/필수 완료 조건. 절대 요약·삭제하지 않는다.**
2. 현재 goalVersion, 완료 조건별 검증 상태와 evidence ID.
3. 진행 중 WorkItem, 남은 의존 작업, 승인/불확실성/사용자 대기 사유.
4. 마지막 durable checkpoint와 최근 action/result 10쌍.
5. 현재 페이지의 bounded observation과 필요한 artifact 참조.
6. 선택적인 모델 요약. `untrusted_summary`로 표시하고 상위 기록보다 낮은 권위로 둔다.

requestId 등 JSONL envelope를 포함한 구조화된 packet 상한 64 KiB. goal 블록만으로 초과하면 잘라내지 말고
`paused: context_limit`로 보고한다. 원문 16 KiB, 조건은 총 64개·각 512자까지.
정적 바이트 한도는 tokenizer가 아니므로 provider adapter는 모델 토큰 한도도 검사한다.
상세 evidence 본문은 ID로 필요할 때 가져오고 verified 사실/출처는 packet에 유지한다.

25회 planner 호출마다 새 segment를 열고, provider가 context pressure를 보고하면
더 일찍 회전한다. model transcript를 비워도 위 packet만으로 재출발할 수 있어야 한다.
segment 교체는 task 완료/새 목표 생성/전체 예산 초기화가 아니다.
3회 연속 같은 `(action,target,observationHash)`이고 검증된 진척도 없으면
재계획 1회, 다시 반복하면 `paused: no_progress`로 멈춘다. 새로운 로그 자체는 진척이 아니다.

완료는 `finish({criterionIds,evidenceIds})` 제안 뒤 호스트가 현재 goalVersion의
모든 required criterion을 확인할 때만 가능하다. 확인되지 않은 자유문 목표는
`awaiting_verification`이며, 사용자가 증거와 결과를 보고 승인한다. 숫자 진척은
검증된 필수 조건 수 / 전체 필수 조건 수로만 계산한다(행동 횟수는 별도 지표).

## 6. 런타임/Planner 계약

```text
Planner.next(context, {signal}) -> Proposal
Proposal = {taskId, goalVersion, basedOnObservationId, criterionIds,
            kind: "actions"|"replan"|"finish"|"need_user", ...kindPayload}
BrowserAdapter.observe({signal}) -> Observation
BrowserAdapter.execute(action, {signal, documentEpoch}) -> ActionResult
ActionResult = {status:"ok"|"failed"|"cancelled"|"uncertain", evidenceCandidate?, errorCode?}
TaskStore.append(event) / load(taskId) / checkpoint(state)
TaskController.start(goal) / pause(reason) / resume(taskId) / stop() / amend(input)
```

`Observation`: host ID/documentEpoch/URL/time + bounded visible text/elements;
최대 500개 방문 노드, 100개 element, text 12 KiB. 전체 querySelectorAll 후 slice만
하는 방식은 노드 방문량 제한이 아니므로 bounded TreeWalker 등을 사용한다.
elementId는 해당 문서·관측의 호스트 참조이며 모델의 임의 selector/eval은 받지 않는다.
페이지 텍스트는 모두 untrusted. screenshot은 필요 시 요청하고 좌표 변환을 기록한다.

초기 브라우저 adapter는 `navigate`, `follow_link`, `scroll`, `observe`를 구현한다.
모든 action은 host policy와 예산 검사를 거친다. follow_link는 실제 anchor href를
재확인해 navigate로 수행한다. 일반 click/type/submit/download는 현재 정책의
read 매핑으로 활성화하지 않고 unsupported로 반환한다. 자연어 planner가 이를
요청하면 가능한 작업 범위를 명확히 보고한다. 이후 확장 시 별도 위험 분류가 필요하다.

Planner 연결은 모델 독립적인 로컬 JSONL stdio adapter. trusted host config의
명령 argv만 `spawn(...,{shell:false})`로 시작한다. UI/페이지/모델이 명령을 정하지 않는다.
stdin context, stdout proposal, stderr bounded 진단. 각 요청/응답에 host requestId;
1개 in-flight, 프레임 64 KiB, 응답 timeout 60초, 잘린/추가/늦은 응답 거부.
기본은 미연결 상태를 명시하고 가짜 자연어 완료를 출력하지 않는다. fixture용
ScriptedPlanner와 독립 JSONL 예제 worker를 함께 제공한다. 모델 공급자·키·유료 호출은
자동 선택하지 않는다. 프로토콜 fixture는 자연어 모델 품질의 증거가 아니다.

worker env는 명시적 allowlist만 전달한다. HALO_APPROVER_KEY/HALO_EXECUTOR_KEY와
그 파일 경로, 기타 앱 비밀은 넘기지 않는다. 같은 UID의 외부 worker는 OS sandbox가
아니며 로컬 파일 접근 권한이 있을 수 있다. 이 버전은 악성 worker 격리를 주장하지 않는다.

## 7. 실행 상태와 승인 결합

상태: `idle`, `running`, `awaiting_approval`, `awaiting_verification`, `paused`,
`stopped`, `completed`, `error`. running에는 phase `observe/plan/approve/execute/verify/checkpoint`.
긴 작업은 segment 단위로 계속되지만 task 전체 action/call/active-time 예산은 누적한다.
active-time은 running/실제 승인자 RPC 시간을 포함하며 사용자 대기/paused는 제외한다.
기본 1000 action/500 planner call/4시간 active 사용 후 `paused: budget_exhausted`;
사용자가 늘릴 수 있고 모델이 늘릴 수 없다. 전체 wall elapsed는 별도로 표시한다.

사용자 pause/stop/수동 브라우징/goal amendment마다 execution epoch를 올려 늦은
응답·예전 승인·예약 action을 무효화한다. 모든 await(특히 pacing/승인/DOM/planner)
뒤와 dispatch 직전에 epoch·taskId·goalVersion·documentEpoch를 다시 확인한다.
pause에서 원래 goal과 verified evidence는 남고, resume은 새 observation부터 시작한다.
이미 끝난 action은 재생하지 않는다. CAPTCHA 해제 뒤에도 새 observation과 재계획을 한다.
새 task가 활성 task를 조용히 덮어쓰지 못한다(명시적 stop 후 새 task, 또는 resume).

approval은 `{requestId,taskId,goalVersion,epoch,documentEpoch,actionDigest,expiresAt}`에
묶으며 60초 후 만료한다. 모델이 source/provenance/effect/trusted 플래그를 정하지 않는다.
호스트가 직접 사용자 입력으로 받은 정확한 초기 URL만 user_prompt로 분류;
그 밖의 모델/페이지 유래 제안은 page_content로 분류한다. 별도 Python 프로세스의
분류는 신뢰하는 호스트 입력에 의존한다. 악성 Electron main에 대한 독립 인증은 아니다.

IPC sender는 해당 로컬 shell webContents의 main frame·로컬 UI URL과 일치해야 한다.
goal amendment, approval, verification은 이 trusted UI API에서만 가능하다.
remote WebContents에는 preload/Node/이 IPC를 노출하지 않는다.

기존 navigation 오류 삼키기/timeout 뒤 completed 기록은 typed ActionResult로 수정한다.
stop은 in-flight 탐색을 중단하고 listener/timer/RPC를 정리한다. 저널 outcome과
실제 dispatch 사이의 crash는 uncertain으로 처리한다. 승인 대기는 pacing으로 표시하지 않는다.

## 8. 성능과 UI 계약

최적화는 goal packet의 핵심을 유지하며 불필요한 history/관측 전송을 줄이는 방향이다.
한 번의 planner 응답에서 최대 3개 observe/scroll만 순차 묶음 실행 가능;
navigate/follow_link는 단독 실행 후 재관측한다. 각 항목은 독립 정책 확인을 거친다.
페이지 로딩은 navigation ID와 연결된 readiness+timeout을 사용하며 listener를 정리한다.
2초 pacing 기본은 유지하고 실제 지연 중 pace_wait를 별도 기록한다.

snapshot은 기존 `{page,task,approvalQueue,timeline}`를 유지하고 `harness`를 추가한다:
`{goalVersion,originalRequest,currentWorkItem,criteriaProgress,resumeReason,segment,budgets}`.
기존 start/pause/resume/stop는 controller에 위임한다. createTask, listTasks, resumeSavedTask,
amendTask, confirmCriterion, getTaskDetail을 main/preload 계약에 추가한다.
confirmCriterion은 현재 goalVersion·criterionId·결과 evidenceId를 함께 받아 오래된 확인을 거부한다.
기존 UI는 호환을 유지하고 새 장기작업 UI는 다른 Claude frontend 세션 담당이다.
최소 현재 UI에도 awaiting_verification과 paused 이유가 표시되어 작업이 갇히지 않아야 한다.

측정: planner/observe/decision/pace/execute/verify/checkpoint 시간, 사용자 대기,
wall/active 합계, call/action/observation 수, token usage(제공된 경우만), 조건별 verified 수.
카운터는 durable 전체 누적, histogram/sample은 bounded. 빠른 실패가 빠른 성공으로
보이지 않게 성공률·중단·불확실성을 p50/p95와 같이 보고한다. 샘플 평균만으로 speedup을 주장하지 않는다.

## 9. 검증과 구현 경계

필수 시험: 100단계/10회 컨텍스트 초기화(시험에서는 회전 경계를 10호출로 주입); 원문·제약 보존; 가짜 summary/페이지의 목표
덮어쓰기 거부; 미검증 완료 거부; 사용자 amendment의 이전 승인 무효화; 재시작 직전/직후
dispatch crash; torn tail/중간 journal 파손; stop 중 pacing; stale DOM·late approval;
사람 대기 뒤 진척 보존; 반복 없는 재개; 예산 전체 누적; 다른 IPC sender 거부.

실제 Electron+로컬 HTTP fixture+Python approver로 3페이지 읽기 작업을 수행하고
중간 pause/restart/복구/증거 확인까지 검증한다. 외부 계정/결제/유료 모델 없이 재현 가능해야 한다.
기존 `npm test --prefix apps/computer-browser`와 `.venv/bin/python -m pytest -q` 회귀를 유지한다.
의도적으로 강화된 새 v1 계약의 테스트를 legacy demo 테스트와 구분한다.

Claude 런타임 담당: main/harness, approver, main/preload integration, runtime tests/docs.
Codex: 이 설계/계획 작성과 검토. 실제 product code는 Claude가 구현한다.
다른 Claude frontend 세션의 frontend/ 또는 UI 디자인 작업을 가져오거나 덮어쓰지 않는다.
기존 halo/gateway.py와 E007 channel 인터페이스는 이번 구현에서 변경하지 않는다.

## 참고 근거

- [Anthropic: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): 컨텍스트 창 사이에 진척·작업 목록·검증 기록을 남기는 구조. 브라우저 목표 원장 설계는 이 문서 자체의 구현이 아니라 HALO 적용안이다.
- [Anthropic: context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): compaction과 외부 구조화 메모리. 본 설계는 요약을 권위 있는 목표 대신 쓰지 않는다.
- [OSWorld-Human](https://arxiv.org/abs/2506.16042): 모델 왕복과 과다 단계의 비용. HALO 실측치로 인용하지 않는다.
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents): navigation readiness·stop·원격 콘텐츠 실행 경계 구현 참고.
