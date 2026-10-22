# HALO 기능 목록과 검증 상태

버전 `0.1.0-beta`, 연구용 프로토타입. 이 문서는 코드 구조와 테스트 참조를 기준으로 쓴 것이고,
실제 앱을 사람이 써 본 결과는 포함하지 않는다.

**검증 열 읽는 법 (대리 지표)**: `apps/computer-browser/test/*.test.js`(200개 파일) 중
해당 모듈 이름이 등장하는 파일 수. 0이면 직접 테스트가 없다는 뜻이고,
높다고 해서 동작이 옳다는 보장은 아니다.

전체 스위트(2200개): 2174 통과, 6 실패(root 환경 실제 Electron, 예상됨), 20 스킵. CI 12개 통과.

## 1. 브라우저 앱 (`apps/computer-browser`)

| 영역 | 주요 모듈 | 테스트 참조 |
|---|---|---|
| 태스크 코어 | task-store, task-controller, task-host, progress, task-contract, task-queue | 38 / 30 / 26 / 32 / 1 / 1 |
| 에이전트·팀 | agent-store, agent-service, child-agent-coordinator, room-orchestrator, branch-runner, message-mailbox | 8 / 4 / 12 / 2 / 1 / 4 |
| 장기 목표·복구 | work-goal-store, work-goal-orchestrator, recovery-policy | 3 / 2 / 3 |
| 백그라운드 런타임 | background-runtime-service·ipc·client, launch-agent-manager | 7 / 4 / 3 / 3 |
| 플래너 연결 | planner-providers, planner-routing, planner-escalation, planner-failure, model-tiers | 8 / 1 / 1 / 1 / 3 |
| MCP | generic-mcp-broker, mcp-schema-validator, mcp-catalog-cache | 8 / 3 / 3 |
| 권한·승인 | permission-policy, action-gate, action-safety, effect-classifier, effect-verifier | 4 / 1 / 2 / 2 / 1 |
| 결제·민감정보 | payment-mandate, card-blind, pii-tiers, private-network, local-credential-vault, session-vault | 1 / 3 / 1 / 1 / 2 / 7 |
| 브라우저 계층 | browser-adapter, browser-surfaces, cdp-engine, cdp-browser-host, cdp-web-contents | 14 / 6 / 6 / 5 / 5 |
| 컴퓨터 사용 | computer-use-contract, computer-use-observation, frame-capture, halowright | 3 / 1 / 1 / 2 |
| 기억·컨텍스트 | local-memory-store, activity-journal(opt-in), context-builder | 2 / 2 / 6 |
| 스케줄·루틴 | scheduler, routine-runner, routine-store, agent-schedule | 5 / 4 / 4 / 2 |

직접 테스트 참조가 0인 모듈: `browser-input`, `chromium-desktop`, `skill-library`, `turn-memory-preparation`.

## 2. 프론트엔드 (`frontend`)
탭·툴바·찾기·단축키, Halo 채팅, 모델 선택기·노력 슬라이더, 에이전트 홈/상세/룸/자식 계획,
백그라운드 런타임 패널, 승인·활동 화면. 디자인 기준은 `DESIGN.md`.

## 3. HALO Core (`halo`, `rust`, `experiments`)
Python 게이트웨이(승인자/실행자 분리, 짧은 수명 capability, 실행 기록), 실험 e001~e007,
Rust 구현과 shield/protected_store. 일반적인 격리 보장은 주장하지 않는다.

## 4. 벤치·평가 도구
Online-Mind2Web(HALO 러너, 바닐라 러너), WebArena 러너, 장기 100스텝, 동시 처리량, 효과 검증,
`grade-bench.js`, `compare-aside-bench.js`.
**벤치 성공률 숫자는 아직 없다.** HALO 대 바닐라 실험은 미실행.

## 5. 알려진 문제
- `work-goal-store` 락 경쟁: 패배한 worker가 `writer_conflict` 대신 `storage_corrupt`를 반환 (로컬 약 2/25).
- Electron 통합 테스트는 root 환경에서 실패하며 사실상 방치 상태.
- Halowright 일부(`hw_step` 등)와 Task Contract opt-in 잠금은 미완성.
- 루트에 정리되지 않은 익스플로잇 스크립트·디버그 파일이 많다.
