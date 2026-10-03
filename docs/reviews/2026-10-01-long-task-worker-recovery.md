# 장기 작업: 플래너 종료 확인과 안전한 재개

## 범위

기존 GoalSpec, journal/checkpoint, 승인·실행 경계, execution_uncertain 확인 절차를 유지한다.
새 플래너/provider나 자동 작업 재시도는 추가하지 않는다.

- Codex: planner-stdio, TaskController 취소 연결, 종료·재개 회귀 테스트 및 실제 Electron fixture.
- Claude: TaskHost의 memory_emergency 재부착 전 종료 확인, 기존 TaskHost 테스트 동기화.
- 기존 Claude의 Router/MCP TypeScript 변경은 별도 작업이며 이 구현에서 덮어쓰지 않는다.

## 변경 계약

1. 플래너 요청 시간 초과·취소 시 응답을 즉시 무효화하고 워커에 SIGTERM을 보낸다.
2. 워커의 실제 exit 이벤트를 보기 전에는 대체 워커를 생성하지 않는다. kill()의 반환값이나 live-process error는 종료 증거가 아니다.
3. 종료 확인의 기본 대기 한도는 6.5초다. 이 시간은 내장 Claude worker가 CLI 자식을 정리할 수 있게 하는 여유를 포함한다.
4. 종료 확인에 실패하면 worker_termination_timeout / worker_termination_failed로 실패하고 교체 금지를 유지한다. 나중에 실제 exit가 관찰되면 재개할 수 있다.
5. pause/takeOver/stop은 해당 플래너 turn을 취소한다. 취소한 워커의 close가 실패하면 controller admission은 닫힌 상태를 유지하며 전환 재시도가 가능하다.
6. memory_emergency 후 재부착도 기존 planner.close 성공 전에는 기존 entry를 지우거나 새 adapter를 생성하지 않는다.
7. plannerCallsUsed는 응답 성공 횟수가 아니라 시도한 turn 횟수다. 취소·시간 초과도 예산을 소비하며, 중단 checkpoint에 보존된다.

## 운영 확인 질문

- 새 워커가 왜 시작되지 않는가? → bounded transport error code와 controller의 닫힌 admission으로 구분한다.
- 종료 요청이 실제 종료로 확인됐는가? → 기존 onWorkerExit hook은 exit 확인 후에만 메모리 등록을 해제한다.
- 취소로 호출 예산을 우회할 수 있는가? → snapshot/checkpoint의 plannerCallsUsed와 budget_exhausted 회귀 테스트로 확인한다.

새 원문 프롬프트·응답·자격증명을 진단 로그에 추가하지 않는다.

## 검증과 재현

`apps/computer-browser`에서 다음을 실행한다.

```sh
node --test test/planner-stdio.test.js test/task-controller.test.js
node --test test/long-horizon-integration.test.js
npm test
npm run typecheck
```

새 실패 테스트를 먼저 실행해 종료 요청 부재, 종료 확인 전 재개, 취소 예산 미차감, stdin error의 호스트 전파를 재현한 뒤 수정했다.

실제 Electron 취소 시나리오는 임의의 60ms sleep 대신 scripted worker가 요청을 받은 사실과 초기화된 RSS의 실제 샘플을 확인한 뒤 응답을 보류하고 pause한다. 기존 initialized-RSS 및 1GB 상한 검증은 완화하지 않았다.

## 한계

- fixture는 결정론적 프로토콜 테스트이며 실제 자연어 모델의 성공률이나 성능 증거가 아니다.
- 짧은 실제 브라우저 실행 및 컨텍스트 교체 검증이다. 수 시간·수일 soak test 완료를 주장하지 않는다.
- SIGTERM을 무시하는 임의 워커는 자동 강제 종료하지 않는다. 해당 adapter는 실제 exit 확인까지 실패 폐쇄 상태다.
- 임의의 외부 worker가 만든 모든 자손 프로세스의 종료까지 보장하는 OS containment는 아니다. 내장 Claude worker는 별도의 CLI 종료·reap 경로를 사용한다.
- 호출 예산은 마지막 내구 checkpoint 기준으로 복원된다. checkpoint 전의 프로세스 강제 종료까지 금융 정산 수준의 정확한 API 과금 추적을 보장하지 않는다.
- 메모리는 OS polling의 관찰 피크다. 샘플 사이의 순간적인 피크를 완전히 포착한다는 주장은 하지 않는다.

## 최종 검증 결과 (2026-10-01)

- 브라우저 패키지 `npm test`: 1,212 tests / 1,212 pass / 0 fail / 0 cancelled / 0 skipped. 약 60.6초.
- `npm run typecheck`: 성공. shared audit와 두 TypeScript source cohort 모두 검사했다.
- `git diff --check`: 성공.
- 실제 Electron + Python approver + scripted JSONL planner: 재개 후 completed, 각 fixture 경로 탐색 1회씩, 실행 불확실 상태의 무확인 재개 금지.
- 실제 취소 시나리오: 초기화된 워커의 요청 수신 확인 → 응답 보류 → pause → worker exit 확인 → 새 컨트롤러 재부착 → completed.
- 실제 OS 관찰 피크: 588,759,040 bytes, 상한 1,000,000,000 bytes. 측정 불가 프로세스 목록은 비었다.
- fixture의 `contextResets: 4`는 설정한 실행 상한이다. 완료까지의 실제 journey timing은 3개 실행 segment이며, 상한을 실제 교체 횟수로 확대 해석하지 않는다.

첫 전체 실행에서 발견한 세 실패도 원인별로 보완한 뒤 재검증했다.

1. Work Goal blocker 기록 전에 stop이 먼저 도달하는 테스트 경합: 실제 내구 blockerStreak를 기다리도록 수정. 최종 blocked/count 3 검증은 유지.
2. MCP 인자 의미 검증 테스트의 cold-worker 시작 지연: 테스트에만 기존 허용 상한 1,000ms를 지정. 운영 기본 500ms 및 ReDoS 150ms 검증은 유지.
3. 임의 60ms 후 pause로 초기화 전 워커를 종료하는 integration fixture 경합: 실제 요청 수신과 초기화된 RSS를 확인한 뒤 취소. 메모리 검증은 완화하지 않음.

전체 실행 전후 핵심 product 파일 SHA-256이 동일함을 확인했다.

```text
planner-stdio.js  0a4523f202187d66a21a6e88a4fd4e59aeeb950526164a216d84238843ed0085
task-controller.js  a0529b117c56d11b1dbbbee633039929cf411dd6c75186721687a49ca05d7980
task-host.js  7bf069a060b96ddc881761fd1142bbd997957f1d29b7d48a0dda3878a3a88815
```

이 결과는 로컬 작업 트리 기준이다. 이 작업에서 커밋·push하지 않았다.
