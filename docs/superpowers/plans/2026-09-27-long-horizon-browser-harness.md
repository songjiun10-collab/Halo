# Long-horizon Browser Harness Implementation Plan

> For agentic workers: use superpowers:executing-plans and implement task by task. 사용자 지정 실행자는 기존 Claude 런타임 세션이다. 사용자 요청은 설계 후 Claude 구현이며 추가 단계 승인을 반복 요청하지 않는다.

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

### Task 2: Context, progress, completion gates

Files: create `main/harness/context-builder.js`, `main/harness/progress.js`, `test/context-builder.test.js`, `test/progress.test.js`.
Interfaces: `buildContext({goal,state,observation,recentEvents}) -> ContextPacket`; `validateProposal(proposal,context) -> validated proposal`; `verifyCriterion(criterion,evidence,hostVerifier) -> verdict`; `canComplete(goal,evidence) -> {complete,missingIds}`.

- [ ] 실패 시험: 10회 요약/재구성 뒤 originalRequest와 constraints/criteria가 byte-equivalent; forged summary가 goal/verified 기록을 덮지 못함.
- [ ] 실패 시험: unknown criterionId/off-goal proposal 거부, stale goalVersion 거부, 64KiB 초과 시 goal을 잘라내지 않음, unverified finish는 awaiting_verification.
- [ ] 관련 node --test 실패 확인 후 순수 함수 구현. 자연어 의미 이해를 deterministic verifier라고 주장하지 않기.
- [ ] 구체 criterion evidence가 없는 자유문은 사용자 검증 C1로 매핑. goal revision 뒤 evidence 재검증.
- [ ] 시험 통과 후 해당 파일만 커밋.

### Task 3: Long-running controller and planner protocol

Files: create `main/harness/task-controller.js`, `main/harness/planner-stdio.js`, `test/task-controller.test.js`, `test/planner-stdio.test.js`, `test/fixtures/scripted-planner.js`.
Interfaces: spec의 Planner.next/TaskController.start,pause,resume,stop,amend 사용. dependencies는 store/planner/browser/approver/verifier/clock으로 주입.

- [ ] 실패 시험: 100 action/최소 10 context reset, stop 이후 늦은 planner 무시, 25-call rotation 누적 budget 유지, 3회 무진척→replan 1회→다시 반복 시 pause.
- [ ] 실패 시험: approval 사용자 대기 active-time 제외, transport timeout/error가 task failed/paused로 남음, crash uncertain 자동 재실행 없음.
- [ ] 실패 시험: JSONL 64KiB 초과·부분 EOF·wrong requestId·중복 reply·stdout log 오염 거부; shell=false argv/env allowlist.
- [ ] 시험 실패 확인 후 controller 상태기계와 stdio adapter 구현. 한 task에 한 action dispatch. 각 await 직후 epoch 검사.
- [ ] 모든 action 전 durable started, 결과 후 outcome/검증/checkpoint 기록. 모델과 goal 업데이트 채널 분리.
- [ ] 시험 통과, JSONL 예제 실행 확인 후 해당 파일만 커밋.

### Task 4: Browser + approver execution integration

Files: create `main/harness/browser-adapter.js`, `test/browser-adapter.test.js`; modify `main/control-api.js`, `main/approver-client.js`, `approver/approver_service.py`; add `tests/test_computer_browser_harness_approver.py`.
Interfaces: observe/execute typed ActionResult, task-bound approval context in spec. legacy evaluate contract may remain behind an explicit legacy path; new harness wire is versioned and unknown versions denied.

- [ ] 실패 시험: rejected loadURL가 ok/completed 아님; timeout listener 정리; navigation ID 교차 이벤트 무시; stop during pace는 dispatch 0회.
- [ ] 실패 시험: 바뀐 anchor href/documentEpoch, 60초 만료/goal amendment 후 승인, 모델 source='user_prompt' 위조 거부; remote frame 요청 거부(Task 5와 연결).
- [ ] bounded DOM traversal, observation IDs, runtime-owned target resolution, navigation/read/scroll adapter 구현. observe 실패를 빈 페이지 성공으로 표시하지 않기.
- [ ] old fixed startTask flow를 controller facade로 전환하되 기존 URL demo는 명시적인 legacy 모드로 회귀 보존. 새 모드의 natural-language planner 미연결은 paused:planner_unavailable.
- [ ] approver response schema/request binding/abort를 검증. free-form planner eval/selector 명령을 IPC로 노출하지 않기.
- [ ] 관련 node tests와 `.venv/bin/python -m pytest -q tests/test_computer_browser_approver.py tests/test_computer_browser_harness_approver.py` 통과 후 해당 파일만 커밋.

### Task 5: Host/UI lifecycle bridge and recovery

Files: modify `main/index.js`, `main/ipc.js`, `preload/index.js`; create `test/harness-ipc.test.js`; minimal changes `renderer/renderer.js`, `test/renderer.test.js`만 frontend 담당과 조율.
Interfaces: createTask/listTasks/resumeSavedTask/amendTask/confirmCriterion/getTaskDetail; additive snapshot.harness; 기존 start/pause/resume/stop 유지.

- [ ] 실패 시험: remote webContents/subframe에서 amendment/approval/confirmCriterion 차단; 잘못된 task/goalVersion/evidence 확인 차단.
- [ ] 실패 시험: 앱 재시작 후 goal/진척 복원·paused:recovered, resume 이후 fresh observation, 사용자 수동 탐색 뒤 stale pending proposal 무효화.
- [ ] trusted sender 검증과 host controller lifecycle 연결. shell이 바뀌지 않는 한 renderer 디자인 재작업 금지.
- [ ] 최소 상태 메시지/완료 검토 동작을 연결해 awaiting_verification이 막다른 길이 되지 않게 함. 새 frontend에는 additive 계약만 제공.
- [ ] 관련 시험 통과 후 해당 파일만 커밋.

### Task 6: End-to-end evidence and handoff

Files: create `test/integration/long-horizon-electron.js`, `test/fixtures/long-horizon-site.js`, `bench/long-horizon-bench.js`, `docs/reviews/LONG_HORIZON_HARNESS.ko.md`; modify package scripts as needed.

- [ ] 로컬 HTTP 3페이지 fixture, 실제 Electron BrowserAdapter, 실제 Python approver, JSONL scripted process로 task 실행.
- [ ] phase별 stop/pause/context reset/process restart/사용자 evidence 확인을 관측; started-only crash 뒤 중복 navigation이 없는지 서버 request log로 검사.
- [ ] 100-step deterministic simulation과 실제 Electron 통합 결과를 별도 표로 기록. 목표 hash·criterion coverage·회전 횟수·진척·실행 중복·wall/active/user_wait/phase p50/p95 출력.
- [ ] `npm test --prefix apps/computer-browser`, `.venv/bin/python -m pytest -q`, 신규 Electron integration 실행. 빠진 환경은 명시하고 mock 통과를 대체 증거로 쓰지 않음.
- [ ] `git diff --check`; 리뷰 문서에 exact commit, commands, observed results, limits(semantic drift·same-UID worker·모델 미연결)를 기록.
- [ ] 최종 구현 commit과 테스트 결과를 사용자/Codex에 보고. 실제 모델 연결 전까지 원문 목표 보존/브라우저 실행 근거와 자연어 능력을 구분.
