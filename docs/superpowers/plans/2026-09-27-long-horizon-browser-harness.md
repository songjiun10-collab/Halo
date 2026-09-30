# Long-horizon Browser Harness Implementation Plan

> For agentic workers: use superpowers:executing-plans and implement task by task. 사용자 지정 실행자는 기존 Claude 런타임 세션이다. 사용자 요청은 설계 후 Claude 구현이며 추가 단계 승인을 반복 요청하지 않는다.

**Status note (2026-09-30):** 아래 체크박스 20개는 미체크로 남아 있지만, 재감사 결과 서술된 동작은 이미 구현·테스트되어 있음을 확인했다 (`main/harness/task-store.js`의 goalVersion/amendment 직렬화와 UUID 기반 경로 검증, torn-line/uncertain 복구, `main/harness/task-controller.js`의 `_noProgressThreshold`/replan 게이트, `main/harness/planner-stdio.js`의 `shell:false`+argv/env allowlist — 개별 테스트는 `task-store.test.js`/`task-controller.test.js`에 있고 전체 스위트 933/933 통과). 체크박스 자체를 개별 항목별로 다시 검증·표기하지는 않았다; 문서 하단의 "정직한 한계" 절이 이 계획의 실제 마감 기록이다.

**Goal:** 컨텍스트 교체와 재시작 뒤에도 최초 목표·제약·검증된 진척을 유지하는 브라우저 하네스.
**Architecture:** Host-owned GoalSpec와 durable event journal에서 매 planner context를 재구성한다. 모델은 제안하고 host verifier/approver/executor가 진척·완료·실행을 통제한다.
**Tech Stack:** Existing Electron/CommonJS, Node built-ins, Python approver, node:test/pytest.
**Spec:** `docs/superpowers/specs/2026-09-27-long-horizon-browser-harness-design.md` (먼저 전부 읽기).

## Global constraints

- product code owner Claude runtime; 다른 frontend 세션 코드와 기존 dirty edits 보존.
- goal 원문과 모든 버전 보존; 모델은 goal/verified evidence/전체 budget 수정 불가.
- 스펙 수치: 1000 actions, 500 planner calls, 4h active/task; segment 25 calls; planner timeout 60s; frame/context 64KiB; task disk 100MiB.
- Browser 초기 동작은 navigate/follow_link/scroll/observe. 기존 위험한 click/type=read 매핑으로 기능 확장하지 않는다.
- 기존 halo gateway/E007 channel는 수정하지 않는다. 승인 전에 dispatch하지 않는다.
- app 종료 중 자동 수행은 없다. crash 복구는 paused, execution_uncertain은 재실행하지 않는다.
- 자연어 모델 연결 없이 scripted fixture를 autonomous intelligence로 표시하지 않는다.
- **(2026-09-27 후속 추가, 사용자 확정)** HALO 프로세스 합계(Electron main+renderer+
  GPU/utility+Python approver+local planner worker와 그 자식; Claude 개발 앱·원격
  모델 서버는 제외) < decimal 1,000,000,000 bytes. V8 heap만 재거나 worker를 합계에서
  빼서 통과시키지 않는다. 임계값 700/800/900MB는 실측으로 더 보수적으로 낮출 수 있으나
  사용자 상한 자체는 올리지 않는다. 상세: [설계서 §10](../specs/2026-09-27-long-horizon-browser-harness-design.md#10-메모리-예산과-프로세스-합계-상한-2026-09-27-후속-추가-사용자-확정-요구).

## Review focus

- 정상-looking 모델 요약에서 최초 제약이 빠져도 ContextBuilder가 정확히 복원하는가(Task 2).
- action dispatch 뒤 outcome append 전 crash가 duplicate 실행을 만들지 않는가(Task 1/3).
- 사용자 amendment/수동 탐색/stop가 pacing 중 도착해도 stale 승인이 실행되지 않는가(Task 3/4).
- budget/context/disk 오류가 completed로 바뀌거나 context rotation으로 예산이 초기화되지 않는가(Task 2/3).
- UI 없는 model completion이 required criterion을 임의 verified로 만들지 않는가(Task 2/5).

### Task 1: Durable goal/task store

Files: create `apps/computer-browser/shared/harness-contracts.js`, `main/harness/task-store.js`, `test/task-store.test.js`.
Interface: `TaskStore.create(goalInput)`, `append(event)`, `load(taskId)`, `checkpoint(state)`, `close()`; async promises. TaskStore owns sequence and durable writes; callers cannot assign seq.

- [ ] 실패 시험: goal-v1 원문 불변, amendment v2 병존, same-task writer 중복 거부, path traversal/unknown version 거부.
- [ ] 실패 시험: checkpoint 이후 journal 재생, 마지막 torn line 복구, 중간 corruption 중단, journal append 실패 시 dispatch 불가, started-only는 uncertain.
- [ ] `node --test apps/computer-browser/test/task-store.test.js` 실패 확인.
- [ ] contracts 검증, 0700/0600 private store, lock, append/fsync/atomic checkpoint/replay 구현. snapshots에 execution closure 직렬화하지 않기.
- [ ] 해당 시험 통과 확인; Task 1 파일만 커밋.
- [x] **(2026-09-27 후속 추가)** `b60a94c` 커밋 이후 지적된 메모리 문제 수정: journal
  재생을 전체 파일 in-memory 배열이 아니라 줄 단위 스트리밍 + O(1) 리듀서로 재구현.
  `eventsSinceCheckpoint`는 `MAX_RECENT_EVENTS_IN_CONTEXT`(10)개로 상한. "한 task에
  한 action dispatch" 불변식을 이용해 진행 중 action 상태도 Map이 아닌 단일 슬롯으로
  추적하고, 겹치는 action_started/짝이 안 맞는 action_outcome은 storage_corrupt로 강화.

### Task 2: Context, progress, completion gates

Files: create `main/harness/context-builder.js`, `main/harness/progress.js`, `test/context-builder.test.js`, `test/progress.test.js`.
Interfaces: `buildContext({goal,state,observation,recentEvents}) -> ContextPacket`; `validateProposal(proposal,context) -> validated proposal`; `verifyCriterion(criterion,evidence,hostVerifier) -> verdict`; `canComplete(goal,evidence) -> {complete,missingIds}`.

- [ ] 실패 시험: 10회 요약/재구성 뒤 originalRequest와 constraints/criteria가 byte-equivalent; forged summary가 goal/verified 기록을 덮지 못함.
- [ ] 실패 시험: unknown criterionId/off-goal proposal 거부, stale goalVersion 거부, 64KiB 초과 시 goal을 잘라내지 않음, unverified finish는 awaiting_verification.
- [ ] 관련 node --test 실패 확인 후 순수 함수 구현. 자연어 의미 이해를 deterministic verifier라고 주장하지 않기.
- [ ] 구체 criterion evidence가 없는 자유문은 사용자 검증 C1로 매핑. goal revision 뒤 evidence 재검증.
- [ ] 시험 통과 후 해당 파일만 커밋.
- [ ] **(2026-09-27 후속 추가)** `buildContext`는 recentEvents를 항상 최근
  `MAX_RECENT_EVENTS_IN_CONTEXT`개로만 자르고, observation/이전 로그 전체를 누적하지
  않는다(§10). untrustedSummary는 caching/delta 최적화 대상이 아니라 그대로 통과.

### Task 3: Long-running controller and planner protocol

Files: create `main/harness/task-controller.js`, `main/harness/planner-stdio.js`, `test/task-controller.test.js`, `test/planner-stdio.test.js`, `fixtures/scripted-planner.js` (**not** under `test/` -- `node --test`'s default discovery treats any file under a `test`/`tests` directory as a test to run, and this is a long-running stdio worker that blocks on stdin forever; placing it there hangs the whole suite, confirmed by reproduction).
Interfaces: spec의 Planner.next/TaskController.start,pause,resume,stop,amend 사용. dependencies는 store/planner/browser/approver/verifier/clock으로 주입.

- [ ] 실패 시험: 100 action/최소 10 context reset, stop 이후 늦은 planner 무시, 25-call rotation 누적 budget 유지, 3회 무진척→replan 1회→다시 반복 시 pause.
- [ ] 실패 시험: approval 사용자 대기 active-time 제외, transport timeout/error가 task failed/paused로 남음, crash uncertain 자동 재실행 없음.
- [ ] 실패 시험: JSONL 64KiB 초과·부분 EOF·wrong requestId·중복 reply·stdout log 오염 거부; shell=false argv/env allowlist.
- [ ] 시험 실패 확인 후 controller 상태기계와 stdio adapter 구현. 한 task에 한 action dispatch. 각 await 직후 epoch 검사.
- [ ] 모든 action 전 durable started, 결과 후 outcome/검증/checkpoint 기록. 모델과 goal 업데이트 채널 분리.
- [ ] 시험 통과, JSONL 예제 실행 확인 후 해당 파일만 커밋.
- [ ] **(2026-09-27 후속 추가)** controller는 매 action/planner dispatch 전 주입된
  memory-monitor(Task 5)의 압력 상태를 확인한다. 800MB 이상이면 dispatch를 멈추고
  durable checkpoint 후 `paused: memory_pressure`; 900MB 비상 신호를 받으면 자신이
  띄운 자원부터 정리 신호를 보낸다(재시도 폭주 없이). in-memory 상태는 현재 목표/현재
  work item/bounded 최근 결과만 유지하고 전체 이력을 들고 있지 않는다(§10).

### Task 4: Browser + approver execution integration

Files: create `main/harness/browser-adapter.js`, `test/browser-adapter.test.js`; modify `main/control-api.js`, `main/approver-client.js`, `approver/approver_service.py`; add `tests/test_computer_browser_harness_approver.py`.
Interfaces: observe/execute typed ActionResult, task-bound approval context in spec. legacy evaluate contract may remain behind an explicit legacy path; new harness wire is versioned and unknown versions denied.

- [x] 실패 시험: rejected loadURL가 ok/completed 아님; timeout listener 정리; navigation ID 교차 이벤트 무시; stop during pace는 dispatch 0회.
  (control-api.js: navigation error swallowing + pacing-during-stop race 수정,
  browser-adapter.js: navSeq 기반 cross-event isolation + timeout에서 wc.stop())
- [x] 실패 시험: 바뀐 anchor href/documentEpoch, 60초 만료/goal amendment 후 승인, 모델 source='user_prompt' 위조 거부. remote frame 요청 거부는 Task 5(IPC sender 검증)로 이연.
  (browser-adapter.js: follow_link는 model이 준 href를 무시하고 실제 anchor를 재확인,
  documentEpoch 불일치는 stale_document로 거부; task-controller.js: approve() 큐 항목에
  epoch/expiresAt 바인딩 추가, amend/pause/stop 이후 또는 60초 경과 후 승인은 실행되지 않음;
  "모델 source 위조 거부"는 이미 _dispatchActionsBatch가 하드코딩으로 방어하고 있었음을
  회귀 테스트로 고정)
- [x] bounded DOM traversal, observation IDs, runtime-owned target resolution, navigation/read/scroll adapter 구현. observe 실패를 빈 페이지 성공으로 표시하지 않기.
  (browser-adapter.js: TreeWalker 500 visited/100 element/12KiB text 상한, elementId는
  host가 매긴 인덱스일 뿐 model의 selector/href를 신뢰하지 않음, observe 실패는 throw)
- [ ] **(이연, Task 5로)** old fixed startTask flow를 controller facade로 전환. Task 5가
  main/index.js·main/ipc.js에 createTask/resumeSavedTask 등 IPC 계약을 추가하는 시점에
  같이 처리한다 — 그 계약이 없는 채로 지금 전환하면 Task 5의 IPC 설계를 앞지르게 된다.
  legacy URL demo(startTask)는 그대로 남아 있고 변경하지 않았다.
- [x] approver response schema/request binding/abort를 검증. free-form planner eval/selector 명령을 IPC로 노출하지 않기.
  (approver-client.js: decision enum/reasons 배열 검증 후 아니면 reject, AbortSignal 지원;
  control-api.js: 이 reject를 잡아 deny로 fail-closed 처리하는 코드가 없었던 기존 gap도 함께 수정.
  browser-adapter.js는애초에 selector/eval을 받는 action type 자체가 없음 — click/type/
  submit_form/download는 전부 unsupported_action)
- [x] 관련 node tests 통과 후 해당 파일만 커밋 (node --test: 155/155).
  approver_service.py의 wire 포맷 자체는 이번 라운드에서 변경하지 않았으므로(클라이언트
  측 검증 강화만 진행) tests/test_computer_browser_harness_approver.py는 아직 만들지
  않았다 — 실제 Python 쪽 변경이 생기는 시점(Task 5/6에서 실제 프로세스 spawn·와이어
  버전 협상이 필요해지면)에 함께 추가한다. `.venv/bin/python -m pytest -q`: 494/494
  (변경 없음, 회귀만 확인).
- [ ] **(이연, Task 5로)** approver/local worker 프로세스를 spawn하는 시점에
  pid+creationTime을 memory-monitor(Task 5)에 등록해, Electron이 직접 보지 못하는
  프로세스도 합계에 들어가게 한다. memory-monitor.js가 아직 존재하지 않아 지금은
  등록할 대상이 없다 — Task 5에서 memory-monitor.js와 함께 만든다. observation은
  이미 spec대로 500 노드/100 element/12KiB 상한이며, browser-adapter.test.js에서
  이 상한이 실제 traversal script에 반영됐는지 회귀로 확인했다.

### Task 5: Host/UI lifecycle bridge and recovery

Files: modify `main/index.js`, `main/ipc.js`, `preload/index.js`; create `test/harness-ipc.test.js`, `test/memory-monitor.test.js`; create `main/harness/memory-monitor.js`; minimal changes `renderer/renderer.js`, `test/renderer.test.js`만 frontend 담당과 조율.
Interfaces: createTask/listTasks/resumeSavedTask/amendTask/confirmCriterion/getTaskDetail; additive snapshot.harness; 기존 start/pause/resume/stop 유지. `MemoryMonitor.registerExternalProcess({pid,creationTime,label})`/`unregister(pid)`/`sample() -> {totalBytes, unmeasurable: string[], byProcess}`/`getPressureLevel() -> "normal"|"caution"(700MB)|"pause"(800MB)|"emergency"(900MB)`.

- [x] 실패 시험: remote webContents/subframe에서 amendment/approval/confirmCriterion 차단; 잘못된 task/goalVersion/evidence 확인 차단.
- [x] 실패 시험: 앱 재시작 후 goal/진척 복원·paused:recovered, resume 이후 fresh observation, 사용자 수동 탐색 뒤 stale pending proposal 무효화.
- [x] 실패 시험(**2026-09-27 후속 추가**): `app.getAppMetrics()`와 등록된 외부 프로세스
  수치를 pid+creationTime으로 중복 제거·합산; 지원되지 않는 metric은 0이 아니라
  unmeasurable로 표시; 700/800/900MB 경계에서 정확한 단계 전환; 900MB 이후 재시도
  폭주(짧은 간격 반복 정리/재시작) 금지; 사용자가 설정한 1GB보다 높은 임계값을
  거부(설정 API 자체가 상한을 못 넘게 함).
- [x] trusted sender 검증과 host controller lifecycle 연결. shell이 바뀌지 않는 한 renderer 디자인 재작업 금지.
- [x] 최소 상태 메시지/완료 검토 동작을 연결해 awaiting_verification이 막다른 길이 되지 않게 함. 새 frontend에는 additive 계약만 제공.
- [x] 관련 시험 통과 후 해당 파일만 커밋.
- [x] **(2026-09-27 후속 추가, Task 5 마무리)** `memory-monitor.js`/`trusted-sender.js`/
  `task-host.js`(자체 커밋 `6dcba33`)에 이어, `main/ipc.js`를 `{ipcMain, taskHost}`
  주입 가능하게 리팩터링(실제 `require("electron")`은 이 저장소에서 경로 문자열로만
  해석되어 기존 방식으로는 테스트 불가였음을 확인)하고, 10개 harness IPC 채널
  (`halo:createTask` 등)을 각각 `isTrustedSender` 게이트 뒤에 연결. `preload/index.js`에
  대응 메서드 노출. `main/index.js`에 실제 `TaskHost`/`WebContentsView` 기반
  harness browser/planner/approver 팩토리와 5초 간격 `memoryMonitor.sample()` 폴러를
  배선. 900MB(emergency) 도달 시 `_pauseForMemoryEmergency()`가 checkpoint 후
  browser.dispose()/planner.close()/store.close()를 각각 독립 try/catch로 정리하고,
  `resume()`은 `resources_disposed`로 거부하며 오직 `TaskHost.resumeSavedTask()`의
  새 인스턴스 재부착만 허용(설계상 실제 프로세스 재시작과 동등하게 취급).
  `test/harness-ipc.test.js`(6) 포함 전체 회귀 통과.

### Task 6: End-to-end evidence and handoff

Files: create `test/integration/long-horizon-electron.js`, `test/fixtures/long-horizon-site.js`, `bench/long-horizon-bench.js`, `docs/reviews/LONG_HORIZON_HARNESS.ko.md`; modify package scripts as needed.

- [x] 로컬 HTTP 3페이지 fixture, 실제 Electron BrowserAdapter, 실제 Python approver, JSONL scripted process로 task 실행.
- [x] phase별 stop/pause/context reset/process restart/사용자 evidence 확인을 관측; started-only crash 뒤 중복 navigation이 없는지 서버 request log로 검사.
- [x] 100-step deterministic simulation(가짜 기반, `task-controller.test.js`)과 실제
  Electron 통합 결과를 별도로 기록 -- 아래 "정직한 한계" 참고, 두 증거를 섞지 않음.
- [x] **(2026-09-27 후속 추가)** 위와 같은 실제 통합 실행에서 memory-monitor로 시작
  피크·안정 상태·pause/restart·의도적 메모리 압력 시나리오의 실제 프로세스 합계(바이트)·
  측정 정의·sampling interval·측정 불가 프로세스를 함께 기록한다. 주입한 가짜 메모리
  수치로 만든 정책 테스트(`memory-monitor.test.js`)와는 반드시 구분해 표기한다.
  1GB 미만 통과와 목표 보존(원문/증거/재개)을 함께 확인.
- [x] `node --test`(apps/computer-browser, 211/211), `.venv/bin/python -m pytest -q`(494/494), 신규 Electron integration(`test/long-horizon-integration.test.js`) 실행 확인.
- [x] 리뷰 문서(`docs/reviews/REPORT_REMEDIATION.ko.md`)에 exact commit, commands, observed results, limits 기록.
- [x] 최종 구현 commit과 테스트 결과를 사용자에게 보고. 실제 모델 연결 전까지 원문 목표 보존/브라우저 실행 근거와 자연어 능력을 구분.

**실제 Electron E2E에서 발견·수정한 실제 버그 2건 (검토용 gap이 아니라 real-Electron 실행으로만 드러난 결함):**
1. `webContents.executeJavaScript()`가 그 webContents에 단 한 번도 실제 navigate가 커밋되기 전에 호출되면 (표시 여부와 무관하게) 영원히 hang. `browser-adapter.js`의 `_ensureReadyForScriptExecution()`이 `wc.getURL()`이 falsy할 때만 `loadURL("about:blank")`을 1회 선행 호출해 수정 (fake 기반 view는 `getURL`이 없어 영향 없음).
2. Electron 메인 프로세스 안에서 `process.execPath`는 Node가 아니라 Electron 바이너리 자체를 가리켜, `ELECTRON_RUN_AS_NODE=1` 없이 planner worker를 spawn하면 스크립트를 실행하지 못함(500회 근접까지 planner 응답이 사실상 무의미하게 진행). `integration/long-horizon-electron.js`의 3곳 `PlannerStdioAdapter` 생성에 `env:{ELECTRON_RUN_AS_NODE:"1"}` 추가로 수정.
3. **(하네스 본체의 실제 결함, regression test 추가)** `task-controller.js`의 `observationKey()`가 `JSON.stringify(observation)`을 그대로 사용해, 실제 `BrowserAdapter`가 매 observe()마다 부여하는 임의 `id`(`_randomId()`) 때문에 동일 페이지를 반복 관찰해도 키가 절대 일치하지 않아 no-progress 감지(design doc 5절)가 사실상 완전히 무력화됨 -- 기존 가짜 기반 테스트는 고정 id를 쓰는 fake만 사용해 이 결함을 잡지 못했다. `id` 필드를 제외하고 키를 계산하도록 수정, `test/task-controller.test.js`에 임의 id를 흉내 내는 회귀 테스트 추가(수정 전 재현 확인 후 수정 -- TDD).

### Task 6 후속: approver_error 근본원인 규명·수정, 20회 연속 실제 완주 검증 (2026-09-27)

이전 판(위 "정직한 한계")이 미해결로 남긴 `approver_error`를 실제 Electron·실제
Python approver·실제 planner worker로 재현해 근본원인 3건을 규명·수정했고,
관련해 범위 안에서 발견한 체크포인트 복원 결함도 함께 고쳤다. 상세 근거는
`docs/reviews/REPORT_REMEDIATION.ko.md`의 "2026-09-27 후속 22" 항목 참고.

- [x] 재현: 세션 scratchpad의 계측 스크립트로 실제 approve() 왕복마다 sanitized
  진단(`requestId`/`action`/`errorName`/`errorCode`/approver `exitCode`/`signalCode`/
  bounded stderr — role key·approval token 없음)을 수집해 `errorCode:"ECONNREFUSED"`
  (approver는 생존)를 확인.
- [x] 근본원인 1 — `main/approver-client.js`: approver의 1회용 `UnixSocketChannel`이
  `accept()` 직후 즉시 close+unlink하는 재사용 루프의 레이스가 ENOENT뿐 아니라
  ECONNREFUSED로도 나타남. `RETRYABLE_CONNECT_ERROR_CODES`로 재시도 코드 확장(예산은
  기존과 동일, 무제한 재시도 아님). 회귀 테스트 2건(`test/approver-client.test.js`,
  실제 SIGKILL로 소켓만 남긴 재현).
- [x] 근본원인 2 — `approver/approver_service.py`: 실제 하네스 어휘
  `follow_link`/`scroll`/`observe`가 `VALID_ACTIONS`/`_ACTION_MAPPING`에 없어
  무조건 deny(정책 판단이 아니라 어휘 누락). navigate/click과 동일한 "read" 취급으로
  매핑. 회귀 테스트(`tests/test_computer_browser_approver.py`, navigate와 동일한
  provenance별 결정을 확인).
- [x] 근본원인 3 — `main/harness/browser-adapter.js`의 `buildObserveScript()`:
  `childNodes.length===0` 조건이 텍스트 노드를 가진 보통 element에는 거의 맞지 않아
  관찰 텍스트가 사실상 항상 비어 완료 마커를 planner가 절대 못 봄.
  `childElementCount===0`으로 수정. 회귀 테스트 2건(`test/browser-adapter.test.js`,
  Node `vm`으로 실제 프로덕션 스크립트를 fake DOM에 실행해 검증).
- [x] 관련 결함(범위 안) — `TaskController` 생성자·`TaskHost.listTasks()`의 peek 경로가
  `store.recoveryReason`만으로 상태를 도출해, 이미 completed/stopped에 도달한 task를
  리로드하면 항상 paused/recovered로 오분류(resume()이 이를 무조건 받아들임 — 이번
  20회 검증 자체가 이 버그에 처음 걸릴 뻔했다). `store.lastCheckpoint`의 종결 상태를
  우선하도록 좁게 수정(진행 중 task의 전체 상태 재구성은 다루지 않음). 회귀 테스트
  각 1건(`test/task-controller.test.js`, `test/task-host.test.js`).
- [x] 신규 `integration/repeat-journey-verification.js` + `test/repeat-journey-verification.test.js`
  (routine 회귀용 5회 버전)로 20회 연속 독립 실제 3페이지 여정 검증: 하나의 실제
  Electron 앱 + 하나의 실제 Python approver를 재사용하되, 매 반복은 완전히 독립된
  새 TaskStore/taskId/WebContentsView/PlannerStdioAdapter. 명령:
  `HALO_PYTHON=.venv/bin/python HALO_REPEAT_COUNT=20 node_modules/.bin/electron
  integration/repeat-journey-verification.js`. 결과: **20/20 성공, 0 실패**,
  elapsed 최소/평균/최대 = 395/404.95/423ms, 총 wall 8329ms, 매 반복 `/`·`/page2`·
  `/page3` 정확히 1회씩만 요청.
- [x] 메모리 재점검(approver 포함): 300ms 간격 27샘플, 실측 피크 약 446MB(<1GB
  통과), 커버리지 = Electron main/renderer/GPU/utility(`app.getAppMetrics()`) +
  Python approver(`ps` rss). planner worker 자체는 별도 등록하지 않음(정직한 한계
  참고).
- [x] `long-horizon-integration.test.js`의 관대한 단언(`"paused"`도 허용)을 근본원인
  수정 후 더 이상 정직하지 않다고 판단해 `finalState==="completed"` 엄격 단언 +
  `requestPathCounts` 정확히 1회씩 단언으로 강화.
- [x] 전체 회귀 재확인: `node --test`(apps/computer-browser) 218/218 통과,
  `.venv/bin/python -m pytest -q`(repo root) 497/497 통과.
- [x] 100단계/10회 컨텍스트 초기화 검증과 재시작/execution_uncertain 검증은 이번
  20회 여정 검증과 evidential하게 분리 유지(아래 정직한 한계 참고, 세 검증 축을
  하나의 숫자로 섞지 않음).

**정직한 한계 (미해결로 남은 것, 숨기지 않음):**
- ~~실제 3페이지 전체 여정 완주 미확인~~ → **해결됨**(위 Task 6 후속, 20/20 실제
  연속 완주로 검증). 이 항목은 더 이상 유효하지 않다.
- criteriaStatus/budgets/segment를 진행 중(터미널이 아닌) task의 리로드에서
  체크포인트+저널로부터 전체 재구성하는 문제는 이번에 다루지 않았다 —
  completed/stopped 두 종결 상태만 좁게 고쳤다. `awaiting_verification` 상태의
  리로드/peek 표시도 마찬가지로 미해결이다.
- 20회 연속 검증의 실측 메모리 합계에 planner worker 프로세스 자체가 포함됐는지
  별도로 확인하지 않았다(Electron이 같은 UID 자식 프로세스를 `app.getAppMetrics()`로
  함께 보고하는지 미검증 — 실측 피크가 한도 대비 충분히 낮아 결론을 바꾸지는 않을
  것으로 판단하나 검증하지 않았다).
- 100단계/10회 컨텍스트 초기화 규모의 장기 목표 보존은 여전히 가짜(fake) 기반
  `task-controller.test.js`에서만 검증했다. 실제 Electron 실행에서는 여전히 4회
  컨텍스트 초기화만 수행한다(scenario 1) — 이번 20회 반복 검증은 매 반복이 독립된
  단일 연속 실행(컨텍스트 리셋 없음)이라 이 규모 축을 대체하지 않는다.
- 재시작 중 pause/fresh-reattach(scenario 2)와 execution_uncertain 게이팅
  (scenario 3)은 `long-horizon-electron.js`에 별도로 유지되며, 20회 반복 검증
  스크립트에는 포함되지 않는다.
- 20회는 전부 같은 macOS 머신의 같은 프로세스 안에서 순차 실행한 결과다 — 여러
  머신·여러 프로세스에 걸친 반복이나 동시(병렬) 다중 task 실행은 검증하지 않았다.
- 단일 macOS 머신·단일 실행 기준 측정치이며, 여러 번 반복한 통계적 분포는 없다.
- 실제 자연어 planner는 한 번도 연결되지 않았다 -- scripted/protocol fixture worker만 사용.
