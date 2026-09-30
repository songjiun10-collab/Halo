# HALO 렌더러 ↔ 롱호라이즌 하니스 통합 (Phase 2) — 설계 + Codex 인계

## Context

`frontend/`는 새 HALO 디자인(halo 링 + Chat/Activity/Notice/Toast/TabOverview
등)을 Vite+React+TS로 구현한 독립 프로토타입이다. 모든 상호작용은
`session/session.ts`의 순수 리듀서가 로컬 상태만으로 흉내 낸 것이고, 실제
브라우저나 에이전트에는 연결되어 있지 않다 (Phase 1, 완료).

Phase 2는 이 프로토타입을 `apps/computer-browser/renderer/`의 실제 Electron
렌더러로 교체하고, 데모 상호작용을 실제 `window.haloBrowser` IPC — 구체적으로
**롱호라이즌 하니스(`main/harness/task-host.js` + `task-controller.js` +
`task-store.js`)** — 에 연결하는 작업이다. 이 문서는 그 통합에 필요한 조사·
설계 결정을 모두 마친 뒤 실제 구현을 Codex에게 넘기기 위한 준비 문서다.

`apps/computer-browser/package.json`의 `description` 필드에 이미 이 저장소의
소유권 관례가 명시되어 있다: *"main/preload/approver are owned by Claude
(runtime + approve/execute boundary); renderer/ is owned by Codex (UI)"*.
이 문서의 역할 분담도 그 관례를 그대로 따른다 — Claude는 설계·인터페이스
계약까지만 확정하고, `main/`·`renderer/` 양쪽의 실제 구현은 Codex가
아래 설계에 따라 진행한다. main 쪽 변경은 전부 **기존 코드에 추가만
하는 방식**(additive)으로 범위를 좁혀서, 소유권 관례를 깨지 않으면서도
Codex가 필요한 만큼 손댈 수 있게 했다.

## 범위

**포함**: `apps/computer-browser/renderer/`를 `frontend/`의 디자인으로
교체, 하니스 IPC에 대한 실제 연결(태스크 생성/목록/전환/승인/거부/일시정지/
정지/인수·기준 확인/목표 수정), 하니스에 없는 두 가지(푸시 알림, 타임라인
조회)를 위한 최소 additive 백엔드 확장.

**제외**: 레거시 `control-api.js` 경로 자체의 변경(그대로 둔다 — 이 문서는
레거시를 건드리지 않는다), 하니스 내부 실행 루프/정책 로직 변경,
`shared/harness-contracts.js`의 계약 스키마 변경(기존 검증기를 그대로 쓴다),
Docker/배포 관련 어떤 것도 포함하지 않는다.

## 확인된 사실 (조사 결과)

- `apps/computer-browser/preload/index.js`: `contextBridge`로
  `window.haloBrowser`에 정확히 `LEGACY_METHODS`(`getSnapshot`, `navigate`,
  `startTask`, ... `approve`, `deny`, ...)와 `HARNESS_METHODS`(`createTask`,
  `listTasks`, `resumeSavedTask`, `amendTask`, `confirmCriterion`,
  `getTaskDetail`, `taskApprove`, `taskDeny`, `taskPause`, `taskStop`,
  `taskTakeOver`)만 노출한다. 각각 `ipcRenderer.invoke("halo:${method}", ...)`.
  푸시는 `onEvent(callback)` 하나뿐 — `ipcRenderer.on("halo:event", ...)`.
- `apps/computer-browser/main/ipc.js`: 하니스 채널은 전부
  `isTrustedSender(event, win)` 검사를 거친 뒤 `taskHost[method](...)`로
  위임한다(레거시 채널에는 이 검사가 없다 — 레거시는 신뢰 경계 요구 이전
  코드). 푸시는 **레거시 `controlApi.onChange()`만** `win.webContents.send
  ("halo:event", {snapshot})`로 연결되어 있다. **하니스(`taskHost`)에는
  동등한 push 경로가 전혀 없다** — `main/harness/task-host.js`,
  `task-controller.js`를 전체 grep해도 `_emit`/`onChange`/`EventEmitter`가
  단 한 곳도 없다(레거시 `control-api.js`에는 23곳의 `_emit()` 호출과
  `onChange()`/`_listeners`가 있다 — 이것이 참고할 기존 패턴이다).
- `TaskHost`가 실제로 제공하는 데이터 모양(이미 코드에서 확인, 추측 아님):
  - `createTask(goalInput) → { taskId, snapshot, goal }`
  - `listTasks() → [{ taskId, originalRequest, state, pauseReason, active }]`
    (attach 안 된 태스크도 디스크에서 peek해서 포함 — 매번 브라우저를
    띄우지 않는다)
  - `getTaskDetail(taskId) → { taskId, goal, snapshot, active }` 또는
    (attach 안 됐으면) `{ taskId, goal, recoveryReason, active: false }`
  - `TaskController.getSnapshot() → { state, pauseReason, goalVersion,
    budgets, segment, criteriaStatus, approvalQueue }` — **journal/timeline
    이벤트는 전혀 포함되지 않는다.** `approvalQueue`는 태스크당 여러 건이
    쌓일 수 있는 배열(`{id, summary, action, createdAt}[]`)이다.
- `docs/superpowers/specs/2026-09-27-long-horizon-browser-harness-design.md`
  section 8은 "언젠가 legacy snapshot과 통합"할 의도를 적어뒀지만 실제
  코드는 그렇게 되어 있지 않다 — 완전히 분리된 두 시스템이다. 같은 문서
  section 9는 "Codex: 이 설계/계획 작성과 검토. 실제 product code는
  Claude가 구현한다" 라고 되어 있는데, 이는 **하니스 자체(main/harness/*)를
  만들 때의 분담**이었다. 이번 문서가 다루는 "하니스를 렌더러에 연결하는
  일"은 그 문서의 범위가 아니었으므로 이 문서에서 새로 분담을 정한다
  (위 Context 참고).
- `frontend/`의 현재 세션 모델(`session/types.ts`, `session/session.ts`)은
  구조상 **레거시 control-api의 단일 스냅샷 모양**(하나의 진행 중인
  작업 + 하나의 승인 + 탭 배열)에 가깝다. 하니스는 태스크가
  여러 개 동시에 존재할 수 있고, 각 태스크가 자기 자신의
  `BrowserAdapter`/`WebContentsView`(= 탭들)를 갖는다 — 축이 다르다.
- Phase 1에서 이미 만든 `HaloChat`(`frontend/src/components/HaloChat.tsx`)은
  `recentTasks?: {label, meta}[]`를 선택적 prop으로 받아 비어있으면 그
  섹션 자체를 렌더링하지 않도록 만들어뒀다(가짜 데이터 금지 원칙). 이는
  우연이 아니라 정확히 `listTasks()`가 채워줄 자리로 의도한 것이었다 —
  아래 결정 2에서 그대로 연결한다.
- 렌더러는 `win.loadFile(".../renderer/index.html")`로 정적 로드되고,
  CSP는 `script-src 'self'; connect-src 'none'`(CDN 없음, 인라인 스크립트
  없음)이다. `frontend/`는 Vite 빌드 산출물이 로컬 번들 JS/CSS라 이
  CSP와 원칙적으로 호환되지만, 실제로 CSP 위반 없이 뜨는지는 아직
  검증된 적이 없다.

## 결정사항

### 1. 대상 백엔드 = 하니스

레거시 `control-api.js`는 건드리지 않고 그대로 둔다. 새 렌더러는 태스크
관련 모든 상호작용에 `HARNESS_METHODS`만 쓴다. (이건 애초에 이 작업을
브레인스토밍할 때 정해진 전제였고, 조사 결과로 뒤집을 이유가 없었다.)

### 2. 태스크 ↔ 탭 매핑

`SessionState.tabs`(웹페이지 탭)의 의미는 바꾸지 않는다 — **현재 활성
(attach된) 하니스 태스크 하나의 브라우징 컨텍스트 안에 있는 탭들**로
그대로 둔다. 대신 `SessionState`에 `activeTaskId: string | null`을
새로 추가한다. `HaloChat`의 `recentTasks`는 `listTasks()`의 결과를
`{label: originalRequest, meta: `${state}` + (pauseReason ? ` · ${pauseReason}` : '')}`로
매핑해 채운다. 태스크 전환 = (attach 안 돼 있으면) `resumeSavedTask(taskId)`
호출 후 `activeTaskId`를 바꾸고 `tabs`/`approval`/타임라인을 그 태스크
스코프로 다시 채운다. "여러 태스크를 동시에 보여주는 화면"은 이번
범위에 넣지 않는다(YAGNI) — 항상 "지금 보고 있는 태스크 하나 +
전환 가능한 최근 태스크 목록"이 frontend/의 기존 단일-포커스 UI 모델과
가장 자연스럽게 맞는다.

### 3. 푸시 알림 격차 — additive 확장으로 메운다

`TaskController`에 `control-api.js`가 이미 쓰고 있는 것과 **동일한 패턴**을
추가한다: `_listeners = new Set()`, `onChange(listener)`(구독 해제 함수
반환), `_emit()`(`this.getSnapshot()`을 만들어 모든 리스너에 전달). 기존
23곳의 `control-api.js` `_emit()` 호출 지점을 참고하되, `TaskController`의
경우 각 **공개(public) 메서드의 성공 경로 끝**(`pause`, `resume`, `stop`,
`takeOver`, `approve`, `deny`, `confirmCriterion`, `amend`, 그리고 내부
`_pauseForMemoryPressure` 등 상태를 바꾸는 지점)에서 호출하면 된다.
**주의**: 이 파일은 admission/transition 큐잉이 매우 신중하게 짜여 있다
(주석 참고) — `_emit()` 삽입이 트랜지션 도중의 불일치 상태를 노출하지
않도록, 반드시 트랜지션이 완전히 끝나고 `getSnapshot()`이 일관된 값을
반환하는 시점에서만 호출할 것. 기존 리턴값/에러 던지는 동작은 전혀
바꾸지 않는다 — 순수하게 부수효과만 추가한다.

`TaskHost`는 태스크를 `_attach()`할 때마다 그 컨트롤러의 `onChange`를
구독해 `(snapshot) => this._emit(taskId, snapshot)` 형태로 자기 자신의
`onEvent(listener)`(TaskHost 레벨, 여러 태스크를 하나의 스트림으로 합침)를
통해 흘려보낸다. 태스크가 attach 해제/종료되면 구독도 해제한다.

`main/ipc.js`는 `taskHost.onEvent((taskId, snapshot) => { if
(!win.isDestroyed()) win.webContents.send("halo:taskEvent", { taskId,
snapshot }) })`를 추가한다. **기존 `"halo:event"` 채널(레거시, `{snapshot}`
모양)은 그대로 두고, 하니스용으로 별도 채널 `"halo:taskEvent"`(`{taskId,
snapshot}` 모양)를 새로 쓴다** — 두 페이로드 모양이 다르므로 채널을
합치지 않는다. `preload/index.js`는 `onEvent`와 같은 패턴으로
`api.onTaskEvent(callback)`를 추가한다.

검증: 기존 `test/task-controller.test.js`, `test/task-host.test.js`가
전부 그대로 통과해야 한다(순수 additive). 추가로 "성공한 트랜지션마다
`onChange`가 정확히 한 번씩 불린다", "실패/거부된 트랜지션에서는 불리지
않는다", "구독 해제 후에는 더 이상 불리지 않는다" 테스트를 새로 추가한다.

### 4. 타임라인/저널 노출 격차 — 새 read-only IPC 메서드 추가

`getSnapshot`/`getTaskDetail`은 현재 상태 스냅샷만 주고 이력(journal)은
전혀 주지 않는다. 새 메서드 `getTaskEvents(taskId, { since } = {})`를
추가한다: `TaskController`에 (아마 `store`를 통해 저장된 JSONL 저널을
읽는) `getEvents({since})`를, `TaskHost`에 이를 위임하는
`getTaskEvents(taskId, opts)`를 추가하고, `preload`의
`HARNESS_METHODS`에 `getTaskEvents`를 추가한다. **저널의 실제 읽기
API는 `main/harness/task-store.js`(633줄, 이 설계 문서 작성 시점에
Claude가 전체를 읽지 않았다)에 있다 — Codex는 구현 전에 이 파일을
반드시 전체 읽고, 이미 있는 읽기 경로를 재사용할 것(새로 저널 포맷을
만들지 말 것).** 반환하는 이벤트 각각은 `shared/harness-contracts.js`가
이미 정의한 이벤트 검증기(`EVENT_TYPES` 등)를 통과하는 모양이어야
한다 — 그 파일의 기존 상수/검증 함수를 그대로 쓰고 새로 정의하지 않는다.

### 5. 승인(approval) 모양 불일치

`frontend/`의 현재 `SessionState.approval`(HaloSheet가 씀)은 단수 —
레거시의 "한 번에 하나"에 맞춘 모양이다. 하니스의
`approvalQueue`는 태스크당 배열이다. 렌더러 쪽에서: 큐의 맨 앞 항목
하나만 `HaloSheet`에 보여주고(기존 UI 재사용, 새 컴포넌트 불필요),
승인/거부 액션에 `taskId`를 실어 `taskApprove(activeTaskId, approvalId)`
/ `taskDeny(activeTaskId, approvalId)`를 호출하도록 세션 리듀서를
확장한다. 뒤에 더 쌓인 큐 항목은 앞 항목이 처리되는 즉시(다음
`onTaskEvent` 스냅샷에서) 자연히 다음 것이 드러난다 — 별도 "대기 중인
승인이 N개 더 있음" UI는 이번 범위에 넣지 않는다(YAGNI, 필요해지면
나중에).

### 6. 누락된 UI — 새로 필요한 두 개, 하나는 이미 자리가 있음

- **다중 태스크 목록**: 결정 2에서 다룸 — `HaloChat`의 기존
  `recentTasks` 슬롯을 그대로 씀. 새 컴포넌트 불필요.
- **기준 확인(`confirmCriterion`)과 목표 수정(`amendTask`)**: frontend/에
  대응하는 UI가 전혀 없다. 완전히 새로 만들되, **기존 디자인 토큰만
  쓰고 새 색상·새 글래스 레이어를 추가하지 않는다**(`tokens.css`의
  `--halo-glass-*`, `--brand`, `--warning` 등 재사용). 제안: `HaloChat`의
  스레드 안에 `.hx-msg` 말풍선과 같은 자리에, `from: 'halo'`인 특수
  메시지로 렌더링되는 인라인 확인/수정 카드 하나만 추가(승인 시트처럼
  별도 오버레이를 새로 만들지 않는다 — Chat 안에서 완결).
- **채팅 메시지 전송의 실제 의미**: `HARNESS_METHODS`에는 "실행 중인
  태스크에 자유 텍스트 메시지를 보낸다"에 해당하는 메서드가 **없다**.
  가장 가까운 것은 `amendTask(taskId, amendmentInput)`인데, 이건 목표
  자체를 수정하는 경로이지 범용 채팅이 아니다. **결정**: 활성 태스크가
  없을 때 컴포저 제출 = `createTask(goalInput)`(새 태스크 시작). 활성
  태스크가 있을 때 컴포저 제출 = `amendTask(activeTaskId, amendmentInput)`
  (목표 수정 요청)로 처리하고, placeholder 문구 등 UI 카피로 "이건
  실시간 대화가 아니라 목표 수정 요청"이라는 걸 사용자에게 정직하게
  드러낸다(Phase 1에서 지킨 "가짜 기능처럼 보이게 하지 않는다" 원칙의
  연장). `amendTask`가 실제로 받는 정확한 입력 스키마는
  `shared/harness-contracts.js`의 `GoalSpec`/amendment 관련 검증기를
  직접 읽고 그것에 맞춰 구현할 것(이 문서에서 스키마를 다시 베끼지
  않는다 — 원본이 이미 있다).

### 7. 렌더러 빌드 툴체인

`frontend/`를 지우거나 옮기지 않는다 — 계속 `frontend/`가 소스,
`apps/computer-browser/renderer/`가 그 빌드 산출물이 놓이는 자리다.
`frontend/vite.config.ts`의 `build.outDir`을
`../apps/computer-browser/renderer/dist`로 향하게 하고(정확한 상대
경로는 실제 파일 위치 기준으로 Codex가 계산), `apps/computer-browser/
main/index.js`의 `win.loadFile(...)` 호출 대상을 새 `renderer/dist/
index.html`로 바꾼다(딱 한 줄). `apps/computer-browser/package.json`에
`"build": "npm --prefix ../../frontend run build"` 같은 스크립트를
추가해 두 패키지를 연결한다. **기존 CSP(`script-src 'self';
connect-src 'none'`)는 완화하지 않는다** — Vite 프로덕션 빌드는 기본적으로
로컬 번들만 참조하고 `eval`을 쓰지 않지만, 이건 "이론상 맞다"이지
검증된 사실이 아니다. Codex는 빌드 후 실제로 Electron 앱을 띄워 콘솔에
CSP 위반 에러가 없는지 직접 확인해야 한다. 확인되면 기존
`renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`,
`renderer/preview.html`(있다면) 를 삭제한다 — 이중 유지보수 금지.
`frontend/src`의 실제 IPC 연결부는 `window.haloBrowser`(preload가
주입한 전역)를 그대로 참조하면 된다 — 별도 어댑터 레이어 불필요.

## 파일별 작업 목록 (Codex)

**`apps/computer-browser/main/` (additive만, 소유권 관례상 신중하게):**
- `harness/task-controller.js`: `onChange`/`_emit()` 추가(결정 3),
  `getEvents({since})` 추가(결정 4 — `task-store.js`부터 먼저 읽을 것).
- `harness/task-host.js`: 컨트롤러 attach 시 `onChange` 구독 → 자체
  `onEvent(listener)`로 재발행(결정 3), `getTaskEvents(taskId, opts)`
  위임 추가(결정 4).
- `ipc.js`: `HARNESS_METHODS`에 `"halo:getTaskEvents": "getTaskEvents"`
  추가, `taskHost.onEvent(...)` → `win.webContents.send("halo:taskEvent",
  ...)` 배선 추가(결정 3).
- `index.js`: `win.loadFile` 대상 변경(결정 7).
- 전체 기존 테스트(`test/task-controller.test.js`, `test/task-host.test.js`,
  `test/harness-ipc.test.js` 등) 통과 확인 + 새 동작에 대한 신규 테스트.

**`apps/computer-browser/preload/index.js`:**
- `HARNESS_METHODS` 배열에 `getTaskEvents` 추가, `api.onTaskEvent(callback)`
  추가(기존 `onEvent`와 동일한 패턴).

**`frontend/` (디자인 프로토타입 → 실제 렌더러 소스로 승격):**
- `src/session/types.ts`: `SessionState`에 `activeTaskId: string | null`
  추가, 승인 타입에 `taskId` 필드 추가(결정 5).
- `src/session/session.ts`: 리듀서 액션들을 실제
  `window.haloBrowser.*` 호출로 연결(현재는 로컬 상태만 바꾸는 순수
  리듀서이므로, IPC 호출 자체는 리듀서 밖 — 기존 프로젝트 관례를 보고
  effect/커맨드 패턴 위치를 결정할 것), `window.haloBrowser.onTaskEvent`
  구독을 앱 최상단(App.tsx)에 연결해 들어오는 스냅샷으로 상태 동기화.
- `src/components/HaloChat.tsx`: `recentTasks` prop을 실제 `listTasks()`
  결과로 채움(결정 2), 기준 확인/목표 수정 인라인 카드 추가(결정 6),
  컴포저 제출 분기(결정 6).
- `src/components/HaloSheet.tsx`(승인 시트): 큐 맨 앞 항목만 표시,
  `taskId` 포함해 승인/거부 호출(결정 5).
- `vite.config.ts`, `apps/computer-browser/package.json`: 빌드 배선
  (결정 7).
- `apps/computer-browser/renderer/{index.html,renderer.js,styles.css}`:
  새 빌드가 CSP 위반 없이 뜨는 것을 실기기로 확인한 뒤 삭제.

## 검증 계획

1. `apps/computer-browser`의 기존 전체 테스트(`node --test`)가 변경
   전후로 동일하게 통과 — 특히 harness 관련 테스트.
2. 새로 추가한 `onChange`/`getTaskEvents`에 대한 단위 테스트.
3. `frontend`: `npx tsc -b`, `npx oxlint` 클린.
4. 실기기 검증(Electron 앱을 실제로 띄워서): 새 태스크 생성 → 승인 대기
   → 승인/거부 → 완료까지 최소 1개 골든 패스를 실제로 실행해 화면이
   실제 하니스 상태와 어긋나지 않는지 확인. 콘솔에 CSP 위반 에러가
   없는지 확인.
5. 완료되면 이 문서에 언급된 각 결정사항이 실제로 어떻게 구현됐는지
   (특히 결정 4의 `task-store.js` 저널 읽기 방식, 결정 6의
   `amendTask` 스키마 적용 방식) 요약해서 알려줄 것 — 둘 다 이 문서
   작성 시점에 Claude가 직접 확인하지 못한 부분이라 리뷰가 필요하다.

## 정직한 한계

- 이 문서의 결정 3(`onChange`/`_emit()` 삽입 위치)은 `task-controller.js`의
  약 40%(주요 트랜지션 로직, 세그먼트 로테이션, 메모리 압박 처리 부분)를
  Claude가 직접 다 읽지 못한 상태에서 내린 설계 결정이다 — 정확한 삽입
  지점은 Codex가 파일 전체를 읽고 판단해야 하며, 위 원칙("트랜지션이
  완전히 끝난 시점에서만 emit")을 지키는 한 정확한 줄 번호까지 이
  문서가 지정하지 않는다.
- `task-store.js`(저널 저장 방식)와 `shared/harness-contracts.js`의
  `GoalSpec`/amendment 스키마 세부사항은 이 문서가 재현하지 않았다 —
  원본 파일이 항상 정답이다.
- 다중 태스크를 "동시에" 보여주는 화면, 승인 큐가 2개 이상 쌓였을 때의
  전용 UI는 의도적으로 범위 밖에 뒀다(YAGNI) — 필요해지면 별도로 다시
  브레인스토밍한다.

---

## Codex 인계 내용 (그대로 전달 가능)

> HALO 저장소(`/Users/songjiun/Halo`)에서 두 가지가 이미 완성되어 있다:
> (1) `frontend/`에 새 HALO 디자인의 React/Vite 프로토타입(halo 링, Chat,
> Activity, Notice, Toast, TabOverview 등 — 전부 실제 브라우저/에이전트
> 없이 로컬 리듀서로만 동작), (2) `apps/computer-browser/`에 실제 Electron
> 앱과 롱호라이즌 하니스 백엔드(`main/harness/task-host.js` +
> `task-controller.js` + `task-store.js`, `window.haloBrowser` IPC로
> 노출됨).
>
> 이 문서(`docs/superpowers/specs/2026-09-27-halo-renderer-harness-integration-design.md`)가
> 그 둘을 연결하는 전체 설계다. 필요한 조사와 설계 결정은 전부 끝났고,
> 실제 구현을 요청한다. 문서의 "결정사항" 7개와 "파일별 작업 목록"을
> 그대로 따르면 되고, 특히 다음을 지켜달라:
>
> 1. `apps/computer-browser/main/`은 이 저장소 관례상 원래 Claude
>    소유 영역이다 — 이번엔 예외적으로 손대되, **전부 additive로만**
>    (기존 메서드의 반환값·에러 동작은 절대 바꾸지 않고, `_emit()`
>    같은 부수효과만 새로 추가). 시작 전에 `main/harness/task-controller.js`
>    전체와 `main/harness/task-store.js` 전체(둘 다 아직 부분적으로만
>    검토됨)를 반드시 다 읽을 것.
> 2. `HARNESS_METHODS`에 새 메서드(`getTaskEvents`)를 추가할 때, 기존
>    `isTrustedSender` 검사를 그대로 통과하도록 `ipc.js`의 기존 등록
>    루프 패턴을 그대로 따를 것(새 예외 경로를 만들지 말 것).
> 3. 레거시 `control-api.js`/`LEGACY_METHODS`는 전혀 건드리지 않는다.
> 4. `frontend/`의 "가짜 데이터 금지" 원칙(Phase 1에서 확립)을 그대로
>    유지 — 새로 연결하는 모든 화면은 실제 IPC 응답만 보여주고, 캔드
>    응답/샘플 데이터를 넣지 않는다.
> 5. CSP(`script-src 'self'; connect-src 'none'`)를 완화하지 말 것 —
>    Vite 빌드 산출물이 위반 없이 뜨는지 실기기로 직접 확인.
> 6. 기존 테스트(`apps/computer-browser/test/*.test.js`)가 전부 그대로
>    통과해야 하고, 새 동작(onChange 발행 시점, getTaskEvents, 승인 큐
>    처리, amendTask를 통한 메시지 전송)에 대한 테스트를 추가할 것.
>
> 완료되면 (a) 전체 테스트 결과, (b) `task-store.js` 저널을
> `getTaskEvents`에 어떻게 연결했는지, (c) `amendTask`에 컴포저 입력을
> 어떻게 매핑했는지 요약해서 알려달라 — 이 세 가지는 설계 시점에
> Claude가 원본 파일을 전부 검토하지 못해 리뷰가 필요하다.
