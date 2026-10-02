# 팀 채팅방 설계 (구현됨)

2026-10-02. 팀 Agent들이 한 방에서 대화하고, 합의되면 팀 작업 하나를 자동으로 시작한다.
사용자 선택: 범위는 팀 채팅방(공용 게시판은 다음 단계), 자유 토론(턴 상한), Agent가 작업 자동 시작.

## 구성

| 파일 | 역할 |
|---|---|
| `apps/computer-browser/shared/room-contracts.js` | 응답 계약(`say` / `pass` / `propose_task`), 턴 context 생성, 상한값 |
| `main/harness/room-store.js` | `<storageRoot>/agents/rooms/<teamId>.jsonl` append-only 로그(디렉터리 0700, 파일 0600, symlink 거부, 손상 시 `room_corrupt`) |
| `main/harness/room-orchestrator.js` | 라운드 진행, 발언자 선택, 자동 작업 시작 안전장치 |
| `main/harness/providers/claude-code-bridge.js` | `context.roomTurn`이면 방 전용 프롬프트·검증(브라우저 동작 어휘 없음) |
| `main/harness/task-host.js` | `listRooms` / `getRoom` / `postRoomMessage` / `stopRoomRound` / `onRoomEvent` |
| `main/ipc.js`, `preload/index.js`, `background-runtime-service.js`, `background-runtime-client.js` | 다른 harness API와 같은 경로. 푸시 채널 `halo:roomEvent` |
| `frontend/src/agent/Room.tsx` | 팀 상세의 "Team room" 화면 |

## 동작

- 방은 팀 하나에 하나이며, 방 id는 team id다.
- 사용자 글이 라운드를 연다. 호스트가 멤버를 돌아가며 부르고, 직전 발언자는 다시 부르지 않는다. 멤버가 한 명이면 글 하나에 한 번만 답한다.
- 라운드가 끝나는 조건:
  - 턴 상한(기본 6, 최대 12)
  - 모든 멤버가 연달아 `pass`
  - 작업 시작(실패 포함)
  - 사용자 중지
- 라운드 중에 올라온 사용자 글은 다음 발언자가 읽는 transcript에 들어간다.
- 턴 한 번은 그 팀의 planner 요청 하나다. `makePlanner("room-<teamId>", { role: "child" })`로 만들기 때문에 child_plan을 제안할 수 없다.
- 잘못된 응답, 오류, 시간 초과는 `pass`로 기록하고 `error` 코드를 남긴다.
- context에 들어가는 것:
  - 자기 이름·직함·지시문
  - 팀원 이름·직함(다른 팀원의 지시문은 넣지 않음)
  - 최근 transcript(32KB 이하)
- 프롬프트는 transcript 전체를 신뢰할 수 없는 입력으로 다룬다.

## 자동 작업 시작 안전장치

- `propose_task`가 나오면 `startAgentTask({teamId, request})`를 호출한다. 그래서 수동 시작과 똑같이 다음이 모두 적용된다:
  - 팀 capability와 MCP 범위
  - 작업 큐
  - approver
- 라운드 하나에서 작업은 최대 1개다.
- 방에서 실행 중인 작업도 최대 1개다. 이미 돌고 있으면 시작하지 않고 notice를 남긴다.
- 작업 요청 글은 1,000자까지다.
- goal 계약에는 새 필드를 넣지 않았다. 대신 방 로그의 `task_started` 메시지에 `taskId`와 `originMessageId`(라운드를 연 사용자 메시지)를 남겨, 이 요청을 모델이 썼다는 기록으로 삼는다.
- 작업이 `completed` 또는 `stopped`가 되면 결과 notice를 한 번 남긴다.

## 재시작·여러 창

- 방마다 `<teamId>.lock`({pid, owner, at}, `O_EXCL`·`O_NOFOLLOW`, 0600)을 둔다. 라운드는 lock을 잡은 host 하나만 돌린다.
  - 로컬 모드에서 다른 창이 받은 글은 로그에만 쌓인다. 라운드를 돌리던 host가 그 라운드를 끝낸 뒤 후속 라운드로 답한다. 후속 라운드는 연달아 최대 3번이다.
  - 마지막 턴이 읽은 transcript 이후의 사용자 글만 후속 라운드로 답한다. 작업 시작이나 중지로 끝난 라운드는 후속 라운드를 만들지 않는다.
  - lock은 턴마다 갱신한다. 프로세스가 없거나 15분 동안 갱신이 없으면 stale로 본다.
  - stale lock은 `rename`으로 가져간다. 그래서 여러 host가 동시에 복구해도 한 곳만 처리한다.
- 로그 append는 같은 프로세스 안에서 경로별로 직렬화한다(창마다 TaskHost가 따로 있어도 같다). 작업 결과 notice는 로그에 같은 `taskId`의 notice가 없을 때만 쓴다.
- 복구(`RoomOrchestrator.recover`)는 그 host에서 처음 방 API를 부르거나 첫 작업 이벤트가 올 때 한 번 돈다.
  - 로그에 결과 notice가 없는 마지막 `task_started`를 다시 지켜본다. 그 사이 이미 끝난 작업이면 바로 결과를 남긴다.
  - 죽은 프로세스가 남긴 lock은 지우고 "The previous round was interrupted when HALO stopped."를 남긴다.
- 로그는 끝에서부터 256KB 단위로 최신 500개만 읽는다.

## planner·worker

- planner는 방마다 하나를 만들어 턴 사이에 재사용한다. 1분 동안 턴이 없을 때, 턴이 실패했을 때, host를 닫을 때 닫는다.
- 한 라운드의 모든 턴이 오류로 끝나면 "Team members couldn't reply (<code>). Their worker may not support team rooms." notice를 한 번 남긴다. operator가 지정한 worker가 room context를 모르는 경우가 여기에 해당한다.

## 한계

- 서로 다른 프로세스(서비스와 로컬 창)가 같은 로그에 동시에 쓰는 경우는 파일 append의 원자성에만 기댄다. 그래서 같은 결과 notice가 두 번 남을 수 있다.
- 다른 host가 돌리는 라운드는 이 창의 `round` 상태에 보이지 않는다. 메시지는 이벤트로 오지 않으므로 다시 열 때 보인다.
- 로그는 지우지 않는다.
- 공용 게시판, 팀 간·개인 Agent 간 방, 방에서 브라우저를 직접 조작하는 기능은 범위 밖이다.

## 로그인 시 시작(background service)

- `main/harness/background-launch-agent.js`
  - label은 `com.halo.computerbrowser.background.<계정 이름>`이다. 계정 이름은 `[A-Za-z0-9._-]` 밖의 문자를 `-`로 바꾼 것이고, 남는 것이 없으면 `uid-<uid>`를 쓴다.
  - 켜기는 plist 작성 후 `launchctl bootstrap`이다. RunAtLoad라서 바로 시작된다.
  - 끄기는 `bootout` 후 plist 삭제다. 로그는 `<userData>/background-runtime/launch-agent.log`에 남는다.
- `BackgroundRuntimeUi.setLaunchAtLogin(boolean)` → IPC `halo:setBackgroundLaunchAtLogin` → preload `setBackgroundLaunchAtLogin`. 바꾼 뒤 모든 창이 자기 snapshot을 다시 보낸다.
- 화면(`BackgroundRuntimePanel`)은 host가 설치 상태를 알려주고 변경 API가 있을 때만 "Start at login" 스위치를 보인다. 켤 때는 확인을 한 번 받는다.
- macOS UI 프로세스에서만 제공한다. service 프로세스 자신은 제공하지 않는다.

## 시험

- `test/room.test.js`: 계약, 저장소, 진행기, 복구, lock, 긴 로그 21개
- `test/task-host-room.test.js`: planner 재사용, 재시작 후 결과 알림 포함 5개
- `test/background-runtime-ui.test.js`: 로그인 시 시작 4개, `test/main-entrypoint-lifecycle.test.js`: 1개
- bridge, ipc, preload, runtime service 테스트에 각각 추가
- 프론트 `test/agent-ui.test.mjs`: room 3개, 로그인 시 시작 1개 / `test/background-runtime.test.mjs`: 1개
