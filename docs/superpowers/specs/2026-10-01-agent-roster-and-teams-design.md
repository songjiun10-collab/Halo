# 맞춤형 Agent와 팀 (백엔드 1단계) 설계

상태: 2026-10-01 사용자 지시("백엔드만 구축", "멤버별로 일을 나눠 진행", "A. 리더가 나눔",
"너 혼자서 ㄱㄱ")에 따라 Claude가 작성. 미커밋.

## 목표

사용자가 이름·설명·캐릭터·역할 지시문·능력(capability)을 가진 Agent를 저장하고, 최대
6명의 Agent를 팀으로 묶어 일을 맡길 수 있는 **호스트 백엔드**를 만든다. 화면
(`frontend/**`)은 이번 범위가 아니다. 나중에 UI가 붙을 IPC 채널만 연다.

참고: `b-nnett/grok-bot-0.18-reconstructed`(roster/group/settings 모델)와
`elie222/rakazo`(팀 handoff의 멤버 재확인, 1회성 delivery key, hop 상한)는 구조
아이디어만 참고했고 코드는 가져오지 않았다.

## 저장 (`main/harness/agent-store.js`)

- TaskHost `storageRoot` 아래 `agents/agents.json` 한 파일(TaskHost가 직접 만든다. `index.js` 변경 없음). 디렉터리 0700, 파일 0600,
  `O_NOFOLLOW` 읽기, 임시 파일+fsync+rename 원자 쓰기, 모든 쓰기는 한 체인으로 직렬화.
- 엄격 스키마 v1, 알 수 없는 필드는 거부(fail-closed). 손상된 파일을 기본값으로 덮어쓰지 않는다.
- **Agent**: `id`(uuid, 호스트 생성), `name`(1~64자), `title`(0~64자), `description`(0~1,000자),
  `avatar={shape,color}`(호스트 고정 목록), `instructions`(0~2,000자),
  `capabilityId`(`browser`|`research`|`computer_use` 중 저장 시점에 registry가 `available`로 표시한 것만 —
  지금은 `browser`뿐, 아니면 `capability_unavailable`), `generation`, `createdAt`, `updatedAt`, `archived`.
- **팀**: `id`, `name`, `title`, `description`, `avatar`, `memberAgentIds`(1~6명, 중복 없음, 저장
  시점에 보관되지 않은 Agent만), `generation`, `createdAt`, `updatedAt`, `archived`.
- 상한: Agent 50개, 팀 20개. 보관(archive)은 삭제하지 않으며 지난 대화 기록이 남는다.
- **대화 연결(link)**: `{taskId, kind:"agent"|"team", ownerId, generation, createdAt}`. 최근
  500개만 유지한다. 대화 내용은 복제하지 않고 기존 TaskStore가 원본이다.

## 작업 시작 (`main/harness/agent-service.js`)

- `startAgentTask({agentId|teamId, request})`. 정확히 하나의 대상만 받는다.
- **Agent**: 기존 `TaskHost.createTask(goalInput, {requestedCapabilityProfile})`를 그대로 쓴다.
  역할 지시문은 512자 단위로 나눠 goal `constraints`(`agent-role-N`)에 넣는다. 이것은 사용자가
  쓴 작업 지시일 뿐이고 권한·capability·승인 경로를 바꾸지 않는다.
- **팀(A안, 리더가 나눔)**: 부모 작업은 `multi_agent` capability로 시작한다. constraints에
  "멤버별 역할로 목표를 나눠 자식 작업으로 진행"과 멤버별 역할 요약(이름·직함·설명·지시문
  일부, 512자 이하)을 넣는다. planner가 기존 child plan 경로로 자식을 만든다.
- 멤버가 하나라도 보관되었거나 없으면 `team_member_unavailable`로 거부한다(fail-closed).
- 생성 직후 link를 기록한다. link 기록 전에 앱이 죽으면 그 작업은 일반 작업 목록에만 보이고
  Agent 대화 목록에는 없다. link는 표시용이며 어떤 권한도 주지 않는다.
- Agent/팀 수정은 이미 시작한 작업에 영향이 없다(goal은 생성 시 고정, link는 generation 기록).

## 2단계: 로스터 상태 (grok-bot·OpenAI 닷츠 조사 반영)

- 참고한 아이디어: grok-bot의 Agent 행 동작(고정, 읽음/안 읽음, 복제)과 로스터 행의
  `hasUnread`·`lastEntry`·`awaitingUserResponse`, 닷츠의 "맡긴 일의 진행을 확인하고 방향을
  고친다". 코드는 가져오지 않았다.
- 저장 스키마 v2: Agent/팀에 `pinned`(기본 false), link에 `seenState`(사용자가 마지막으로 본
  작업 상태, 기본 null). v1 파일은 읽을 때 기본값을 채워 올리고, 다음 쓰기에서 v2로 저장한다.
- `setAgentPinned({kind, id, pinned})`: 표시 설정이라 generation을 올리지 않는다.
- `duplicateAgent(id)`: 프로필을 복사한 새 Agent(이름 뒤 " 사본", 고정 해제). 보관된 Agent나
  지금 쓸 수 없는 capability는 거부한다.
- `getAgentRoster()`: Agent/팀마다 `status={running, awaitingUser, hasUnread, lastConversation}`.
  `running`은 running/idle, `awaitingUser`는 awaiting_approval/awaiting_verification/paused.
  안 읽음은 진행 중이 아닌 작업의 현재 상태가 `seenState`와 다를 때다. 정렬은 보관 안 됨 →
  고정 → 최근 대화 → 생성 순.
- `markAgentConversationsRead({agentId|teamId})`: 그 대상의 link마다 현재 작업 상태를
  `seenState`로 기록한다.
- 방향 수정은 새 API 없이 기존 `amendTask(taskId, …)`를 쓴다.

## 토큰 최적화 (GPT-6 Astra 방향 반영)

planner는 매 턴 goal 전체를 다시 받는다(`context-builder.js`의 `goal.constraints`). 그래서
Agent가 붙이는 역할 문구는 턴 수만큼 곱해진다. 참고한 Astra 방향은 세 가지다: 경로별로
reasoning effort를 다르게 정한다, 고정된 앞부분을 캐시에 맞게 유지한다, 컨텍스트를 키운다고
토큰이 줄지는 않는다.

구현함(이 단계):
- 역할 문구 압축: 공백 연속은 하나로, 빈 줄 3개 이상은 2개로 줄이고 앞뒤를 자른다. 공백뿐인
  지시문은 제약을 만들지 않는다.
- 팀 역할 예산: 멤버 줄은 240자 상한, 내용은 지시문(없을 때만 설명)으로 한다. 팀 머리 줄도
  줄였다. 최대 팀(6명, 모든 필드 최대 길이)에서 턴당 제약 JSON이 7,951B에서 2,638B로 줄었다
  (-67%). 공백이 많은 2,000자 Agent 지시문은 2,797B에서 2,161B로 줄었다(-23%).
- 캐시 친화: 역할 제약은 시작 시 한 번 정해지고 순서·문구가 결정적이라 매 턴 같은 바이트로
  나간다. 가변 정보(진행 상태 등)는 제약에 넣지 않는다.
- 로스터 조회는 저장 파일을 한 번만 읽는다(`AgentStore.snapshot()`).

경로별 effort와 캐시 친화 프롬프트 (Codex 한도로 Claude가 이어서 구현):
- **경로별 effort** (`main/harness/planner-effort-policy.js`): 사용자의 `plannerEffort`가 상한이다.
  새 설정 `plannerEffortMode`(`auto`|`fixed`)가 `auto`이면 자식 작업과 short 작업만 `low`로
  낮추고, middle·long은 사용자 값을 그대로 쓴다. 어떤 경우에도 사용자 값보다 높이지 않는다.
  경로는 이미 저장되는 작업 프로필의 duration에서 계산하므로 새 저장 필드 없이 재개 후에도 같다.
- **적용 지점**: TaskHost가 controller 생성 시와 `updateHostSettings` 시 작업마다 계산해 넘긴다
  (이전에는 설정 변경이 모든 작업을 같은 값으로 덮었다). 자식 코디네이터는 effort를 함수로 받아
  자식이 시작될 때 계산한다(이전에는 호스트 생성 시 값으로 고정돼 설정 변경이 자식에 반영되지
  않았다). TaskHost 생성자 기본값은 `fixed`이고 앱(`index.js`)은 설정값을 넘긴다.
- **설정 v5**: `plannerEffortMode` 추가, 새 설치와 v1~v4 이전 모두 `auto`(비용을 줄이기만 함).
  v4 이전 시 `mcpProviders`를 보존한다. 되돌리려면 `updateHostSettings({plannerEffortMode:"fixed"})`.
- **캐시 친화 프롬프트** (`claude-code-bridge.js`): 작업마다 다른 부분(행동 개수 상한, MCP 안내)을
  공통 지시문 뒤로 옮겼다. 이제 모든 작업·턴의 프롬프트가 같은 정적 지시문 바이트로 시작하고,
  그다음 작업별 부분, 마지막에 context JSON(안정적인 goal이 매 턴 바뀌는 progress보다 앞)이 온다.

측정(오프라인, `buildPrompt` 기준): 작업 사이에 공유되는 정적 지시문 앞부분이 590자에서
2,669자로 늘었다(지시문 2,735자 중 98%). 한 작업 안의 턴끼리는 이전에도 앞부분이 같았으므로
이득은 작업 사이 공유분이다. 실제 캐시 적중률과 effort별 토큰은 실제 CLI 실행으로만 측정할 수
있어 아직 확인하지 않았다.

## 로스터 변경 알림

- `TaskHost.onAgentRosterEvent(listener)`: 저장·복제·고정·보관·대화 시작·읽음 표시가 성공한
  뒤에만 `{kind:"agent"|"team", id, change}`를 보낸다. `change`는 `saved|archived|pinned|
  conversation_started|read`. 이름·지시문 같은 내용은 싣지 않고, UI가 `getAgentRoster()`를 다시
  읽는다.
- 전달: `main/ipc.js`가 `halo:agentRosterEvent`로 창에 보내고(창이 닫히면 구독 해제), preload가
  `onAgentRosterEvent(callback)`을 연다. background runtime은 `agentRosterEvent`로 방송한다.
- 연결된 작업의 상태 변화는 기존 `taskEvent`로 오므로 UI는 그때도 로스터를 다시 읽으면 된다.

## Agent MCP 고정 (줄이기만, 사용자 결정)

- 저장 스키마 v3: Agent에 `mcpProviders`(null=호스트 설정을 따름, 또는 알려진 provider id의
  중복 없는 배열). v1·v2 파일은 읽을 때 null로 채운다. 수정 시 필드를 빼면 기존 값을 유지하고,
  null을 넣으면 해제한다. 복제는 값을 그대로 복사한다.
- 작업 시작 시 실제 provider = 호스트에서 켠 provider ∩ Agent 부분집합. 호스트에서 꺼진 것은
  절대 켜지지 않는다. 팀은 모든 멤버가 부분집합을 가질 때만 그 합집합으로 줄이고, 하나라도
  null이면 호스트 설정을 따른다(자식 작업은 원래 MCP를 받지 않는다).
- `createTask`에 선택자 `mcpProviders`를 더했다(같은 줄이기 전용 규칙). 값은 작업 저널에
  `mcp_scope_selected` 노트로 남기고, 재개·대기열 시작 시 `_attachPrepared`가 노트를 읽어
  같은 범위로 붙인다.
- 도구 선택 화면용 `listMcpProviders()`: 알려진 provider 전체를 `{id, label, enabled}`로 돌려준다
  (`host-settings.js`의 `MCP_PROVIDER_CATALOG`). `enabled:false`인 것은 보여 주되 고를 수 없다.
  고르는 단위는 provider이고 개별 도구가 아니다(디자인 시안의 Filesystem/Calendar 같은 도구
  목록과 다르다).

## 상시(always-on) Agent (사용자 결정 반영)

- 저장(`main/harness/agent-schedule.js`): `agents/schedules.json`, 위와 같은 원자 쓰기·0600·
  symlink 거부. 일정 최대 20개. 필드: `kind`, `ownerId`, `request`(1~2,000자), `trigger`
  (루틴 스케줄과 같은 once/interval/calendar 계약 재사용), `onApproval`(`pause`|`deny`),
  `maxPlannerCalls`(1~200), `enabled`. 승인 동작과 planner 호출 상한은 **사용자가 반드시 고른다**
  (기본값 없음). 저장할 때 대상이 있고 보관되지 않았는지 확인한다. 저장하면 다시 무장한다
  (기록 초기화, 다음 회차는 지금부터 계산).
- 실행(`AgentScheduler`): 회차가 되면 같은 `createTask` 대기열·입장·승인 경로로 Agent 대화를
  시작한다. goal `limits.maxPlannerCalls`에 사용자 상한을 넣고, `onApproval:"deny"`이면 선택자
  `reviewFallback:"deny"`를 넘긴다.
- 승인 동작: TaskController에 `reviewFallback`(`queue` 기본|`deny`)을 더했다. `deny`이면 사람 확인이
  필요한 동작(approver의 review와 권한 모드의 사람 확인 모두)을 대기열에 넣지 않고 거부하며,
  `review_auto_denied` 노트로 남기고 다음 동작으로 진행한다. 절대 자동 허용하지 않는다. 값은
  `review_fallback_selected` 노트로 저널에 남아 재개 후에도 같다. `pause`는 지금과 같이 사용자를
  기다린다. MCP 제안 승인은 이 옵션의 대상이 아니다(기존처럼 만료된다).
- calendar 트리거(`shared/schedule-contracts.js`): `{kind:"calendar", days, time, timeZone}`.
  `days`는 ISO 요일 1(월)~7(일), `time`은 `HH:MM`, `timeZone`은 IANA 이름. 현지 시각을 지키므로
  서머타임이 바뀌어도 9:00은 9:00이다. 없는 시각(서머타임 시작)은 밀린 시각에 한 번, 두 번 있는
  시각(서머타임 끝)은 앞의 것에 한 번 실행한다. 지난 회차는 interval처럼 가장 최근 하나로 합친다.
  "평일 9:00"=`days:[1,2,3,4,5]`, "매일 9:00"=1~7, "매시간"=interval, "한 번"=once.
- 겹침: 지난 실행이 아직 끝나지 않았으면(승인 대기·일시정지 포함) 그 회차를 건너뛴다.
- 회차당 최대 한 번: 회차를 먼저 기록하고 시작한다. 그 사이에 앱이 죽으면 그 회차는 건너뛴다
  (무인 실행을 두 번 하는 것보다 안전). Agent 작업에는 `goal.trigger`를 붙이지 않는다. 기존 루틴
  스케줄러가 루틴이 아닌 trigger 작업을 고아로 보고 중지하기 때문이다.
- 실패: 대상이 보관·삭제되면 즉시 `owner_unavailable`로 끄고, 그 밖의 실패는 3번 연속이면 끈다.
- 시작: `TaskHost.startAgentScheduler()`. 앱에서는 background service 모드의 호스트에서만
  시작한다(창마다 생기는 호스트는 같은 저장소를 공유하므로 같은 회차를 중복 실행할 수 있다).
  같은 이유로 루틴 스케줄러(`TaskHost.startScheduler()`)도 service 모드에서만 시작한다.
- calendar 트리거는 conformance 코퍼스(`contracts/conformance/schedule_input.json`,
  `schedule_evaluate.json`)에도 들어가 있어 이후 포트가 같은 결과를 내야 한다.
- 알림: 일정 저장·삭제는 `schedule_saved`/`schedule_deleted`, 무인 시작은 `conversation_started`
  로스터 알림을 보낸다.

## 하지 않는 것 (별도 승인 필요)

- 실제 CLI로 캐시 적중률·effort별 토큰 측정(사용자 결정: 측정 안 함).

- **자식 권한 확대**: 지금 자식 에이전트는 전역 제약으로 정확히 observe+scroll이다
  (`child-agent-coordinator.js`). 멤버 자식이 클릭·입력하려면 그 제약을 바꿔야 하므로
  멤버 capability ∩ 부모 capability, 모든 효과 동작의 approver 경유, 자식 결과 taint,
  handoff hop 상한/1회성 key를 담은 별도 보안 설계와 사용자 승인 뒤에 한다.
- 자식 작업에 멤버 지시문을 직접 고정하는 것(코디네이터 변경), Agent별 planner 고정,
  이미지 아바타, 공유 방, 원격 실행.

## 열리는 API (TaskHost 메서드 → IPC `halo:*` → background runtime allowlist)

`listAgents`, `saveAgent`, `archiveAgent`, `listTeams`, `saveTeam`, `archiveTeam`,
`startAgentTask`, `listAgentConversations`, `getAgentRoster`, `setAgentPinned`, `duplicateAgent`,
`markAgentConversationsRead`, `listAgentSchedules`, `saveAgentSchedule`, `deleteAgentSchedule`,
`listMcpProviders`, `getChildPlan`.
창별 background runtime(`main/harness/background-runtime-ui.js`): `getBackgroundRuntimeSnapshot`,
`attachBackgroundRuntime`, `detachBackgroundRuntime`(거부, 창 닫기가 분리), `setMemoryPolicy`,
`stopBackgroundService`, 푸시는 `halo:backgroundRuntimeEvent`. 한 창이 메모리 정책을 바꾸면
다른 창들도 각자 스냅샷을 다시 읽어 푸시한다. `launchAgentInstalled`는 `registerIpc`의
`launchAgentInstalled` 옵션(`LaunchAgentManager.isInstalled({label})`, symlink는 설치로 보지
않음)을 넘길 때만 채워진다. 앱은 아직 LaunchAgent를 설치하지 않고 label의 userId 규칙도 정해지지
않아 `main/index.js`는 이 옵션을 넘기지 않는다(필드 생략 = 모름).
자식 계획: `getChildPlan(taskId)`와 계획 변경 시 `halo:taskEvent`의 `childPlan` 푸시.
`evidenceCount`는 아직 0으로 고정이다.
신뢰된 발신자 검사는 기존 IPC 경로를 그대로 쓴다. `createTask` 선택자에 `mcpProviders`와
`reviewFallback`이 더해졌다(둘 다 제한을 더할 뿐 넓히지 않는다).

## 시험

- 저장: 생성/수정 generation 증가, 필드 상한, 알 수 없는 필드·잘못된 avatar·capability 거부,
  상한 초과 거부, symlink 파일 거부, 손상 파일 fail-closed, 파일 0600.
- 팀: 1~6명, 중복·없는·보관된 멤버 거부.
- 시작: Agent는 지정 capability와 역할 constraints로 createTask, 팀은 `multi_agent`와 멤버
  constraints, 보관된 대상·멤버 거부, link 기록, 대화 목록이 task 요약과 결합됨.
- MCP 고정(`agent-mcp-scope.test.js`): 부분집합 검증·v2 이전, 줄이기, 꺼진 provider는 켜지지
  않음, 저널 기록 후 재시작에도 유지, 팀 합집합 규칙.
- 상시 Agent(`agent-schedule.test.js`, `task-controller-review-fallback.test.js`,
  `task-host-review-fallback.test.js`): 입력 검증, symlink·0600, 회차 1회, 겹침 건너뜀, 대상 없음·
  연속 실패 시 끔, once 완료, 호스트 통합(상한·deny·대화 연결·알림), deny는 대기열 없이 진행하고
  기본값은 기존처럼 대기. 진입점 시험은 service 모드에서만 스케줄러 시작을 확인한다.
- calendar 트리거(`schedule-calendar-trigger.test.js`): 입력 검증, 평일만 실행·주말 건너뜀,
  생성 전 회차 미실행, 지난 회차 합치기, 서머타임 전후 현지 시각 유지, Agent 일정 저장.
- MCP 목록(`mcp-provider-catalog.test.js`): 모든 id에 label, 호스트 켜짐 여부 반영, IPC 노출.
- background runtime(`background-runtime-ui.test.js`): 로컬/연결 창 스냅샷, 서비스 중지, 정책 검증,
  IPC 발신자 검사, `launchAgentInstalled` 표시·실패 시 생략, symlink plist 거부, 정책 변경의 전체 창 전파.
- 자식 계획(`child-plan-summary.test.js`): 렌더러 계약, 재시작 재구성, 변경 알림, 손상 링크는 null.
