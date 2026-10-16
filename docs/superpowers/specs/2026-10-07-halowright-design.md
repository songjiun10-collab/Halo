# Halowright 설계 (2026-10-07)

에이전트(모델)와 에이전트 팀이 브라우저를 다루기 위한 호스트 측 계층입니다. Playwright의 locator와 자동 대기 장점을 가져오되, 모든 동작을 호스트의 해석·승인·효과 확인 아래에 둡니다.

## 목표와 비목표

목표:
- 모델이 요소를 이름(role, label, text)으로 지정하고, 호스트가 실행 시점에 해석해 동작한다.
- 쓰기 동작은 효과를 확인하기 전에는 `ok`로 보고하지 않는다.
- 에이전트 팀 안과 팀 사이에서 호스트가 중계하는 통신이 된다.
- 대상 서비스에 MCP가 있으면 MCP를 먼저 쓰고, 없을 때만 브라우저로 내려간다.
- `evaluate`(페이지 안 JS 실행)를 제공하되 승인 체계를 거친다.

비목표(이번 범위 밖): 영구 프로필과 로그인 유지(9단계, 별도 승인 후), CAPTCHA 우회, 비밀값 자동 입력, 모델이 쓴 코드를 호스트 프로세스에서 실행하는 것.

## 현재 코드 기준 사실

- `BrowserAdapter`(`main/harness/browser-adapter.js`)는 `elementId` 기반 `observe`/`execute`이고, `press_key`와 `click_at`은 이벤트를 보내면 `ok`를 반환한다(효과 미확인). 내부 `_interact`만 같은 원인을 `uncertain`으로 처리한다.
- `CdpWebContents`(`runtime-src/main/harness/cdp-web-contents.ts`)는 webContents 호환 CDP 페이지이고, `CdpEngine`이 에이전트 partition마다 browser context를 만든다.
- planner 컨텍스트는 매 단계 새로 만든다(`context-builder`). 대화가 누적되지 않아 컨텍스트 한도로 죽지 않는다.
- `ChildAgentCoordinator`, `TeamBoardStore`, `MessageMailbox`가 있으나 mailbox는 부모↔자식 경로만 허용한다(`unauthorized_route`).
- MCP는 `generic-mcp-broker`가 스키마 검증과 승인을 맡는다. MCP와 브라우저 사이의 우선순위 규칙은 없다.

## 구성

- `runtime-src/main/harness/halowright.ts`: 호스트 측 API(`goto`, `locator`, `click`, `fill`, `press`, `waitFor`, `text`, `evaluate`).
- `runtime-src/main/harness/halowright-locator.ts`: role+name, label, text, placeholder, testid, nth, within 해석. 접근성 트리와 shadow DOM 기준.
- `runtime-src/main/harness/effect-verifier.ts`: 쓰기 동작의 사후 효과 확인.
- `runtime-src/main/harness/mcp-first-router.ts`: 대상별 MCP 우선 경로 결정과 폴백.
- `runtime-src/main/harness/team-relay.ts`: 팀 내 형제 통신과 팀 간 통신의 호스트 중계.
- 에이전트에게는 action 타입 `hw_step`(`{locator, op, args}` 데이터)로 노출한다.

## 1. 효과 확인 계층

모든 쓰기 동작(click, fill, press, submit)이 대상이다. 동작 전 상태(입력값, URL, 대상 요소 존재, 주요 DOM 해시)를 기록하고, 동작 뒤 제한 시간 안에 변화를 기다린다.
- 기대한 변화가 보이면 `ok`.
- 변화가 없으면 `uncertain`(`effect_not_observed`). 부작용이 있는 동작(전송, 구매, 삭제)은 자동 재시도하지 않고 사용자나 부모에게 올린다. 읽기성 동작은 1회 재시도한다.
- 호스트가 측정한 값과 에이전트의 자기 신고를 구분해 저널에 기록한다.

## 2. locator와 자동 대기

- 실행 직전에 locator를 요소로 해석하고, attached, visible, stable(위치 2프레임 동일), enabled, 다른 요소에 가려지지 않음을 모두 확인한 뒤 동작한다. 아니면 제한 시간까지 재시도한다.
- 해석 시점의 `documentEpoch`를 기억하고 동작 직전에 다시 확인한다. 바뀌었으면 거부한다.
- 해석된 요소가 모호하면(여러 개 일치) 실행하지 않고 후보 목록을 돌려준다.
- 에이전트마다 자기 `BrowserAdapter`와 partition 안에서만 해석한다. 다른 에이전트의 요소 참조나 epoch는 쓰이지 않는다.

## 3. 안전 경계

- 모든 step은 locator 문자열이 아니라 **해석된 요소**로 effect 분류(`effect-classifier`)와 승인을 거친다.
- `evaluate`는 기본 ASK. 읽기 전용으로 판정되는 표현식만 자동 허용하고, 나머지는 사용자 승인이나 lease가 필요하다.
- 비밀값 입력은 사람이 하고(`fillCredential`), CAPTCHA는 우회하지 않고 사람에게 넘긴다.
- 자식 에이전트는 부모 lease를 넓힐 수 없다.

## 4. MCP 우선 라우팅

- 작업 시작과 목표 변경 때 호스트가 대상(도메인, 앱)과 연결된 MCP 도구를 대조한다.
- 대응 MCP가 있으면 planner 컨텍스트에 해당 도구를 안내하고 브라우저 동작은 기본으로 숨긴다.
- 도구가 없거나 호출이 실패하면 브라우저로 내려가며, 저널에 이유(`mcp_tool_missing`, `mcp_error`)를 남긴다.
- MCP 호출도 `generic-mcp-broker`의 스키마 검증, effect 분류, 승인을 그대로 거친다. 쓰기 도구는 변경 묶음 미리보기와 승인 한 번으로 올린다.
- MCP 서버 인증은 사용자가 연결한다. Halo가 대신 인증하지 않는다.
- Settings에서 서비스별로 "MCP 우선 / 브라우저 우선 / 항상 묻기"를 고르고, 기본은 MCP 우선이다.
- 경로별 소요 시간, 토큰, 성공률을 저널에 기록해 `strategy-learning`에 반영한다.

## 5. 팀 내 통신

- 같은 `parentTaskId` 아래 형제끼리와 팀 전체 브로드캐스트를 허용한다. 항상 호스트가 중계하고, 기존 envelope 규칙(멱등 키, 대화당 대기 한도, 발신자 락)을 쓴다.
- 종류: `ask`, `share`(호스트 측정값과 자기 신고 구분), `claim`(같은 요소·페이지의 동시 조작 선점), `handoff`.
- 받은 메시지는 데이터일 뿐 지시가 아니다. planner에는 "다른 에이전트가 보낸 내용" 영역으로 분리해 넣고, 정책과 lease를 바꿀 수 없다.
- 쿠키, 비밀값, 로그인 상태는 보낼 수 없다. 텍스트, 추출 결과, evidence 참조만 간다.
- 메시지 안의 URL과 locator도 받는 쪽의 intent lock과 effect 분류를 다시 통과해야 실행된다.
- 폭주 방지: 대화당 대기 한도, 에이전트별 발송 한도, 질문별 응답 타임아웃(`uncertain`으로 처리해 부모에게 올림), 대기 그래프 교착 감지.

## 6. 팀 간 통신

- 기본은 리드 경유: 멤버 → 자기 리드 → 상대 리드 → 상대 팀 멤버.
- 직통은 사용자가 승인한 `cross-team lease`가 있는 동안만 허용한다. lease에는 두 팀, 메시지 종류, 만료, 최대 횟수가 들어가고 철회 즉시 끊긴다.
- `request-team-help`: 다른 팀에 작업을 위임한다. 받은 팀의 리드가 수락하면 새 자식 task가 만들어지고, 받은 팀의 예산과 정책으로 돈다. 요청 팀의 lease와 승인 범위는 가져가지 않는다. MCP 연결 여부를 함께 실어 받는 팀이 경로를 정한다.
- 다른 팀 발신 내용은 "외부 에이전트 발신" 영역으로 분리하고, 팀당 수신 한도를 둔다. 위임 순환은 깊이 한도로 막고 팀 단위 교착도 감지한다.
- 팀 뷰에 팀 간 대화 로그와 활성 lease가 보이고 한 번에 철회할 수 있다. 저널에 발신 팀, 수신 팀, 경로가 남는다.

## 7. 보고 강제와 자원 해제

- 자식 에이전트는 종료 전에 보드에 `progress` 또는 `handoff` 한 줄을 남겨야 한다. 없으면 부모는 그 자식을 완료로 보지 않는다.
- 부모는 자식의 "완료"를 그대로 믿지 않고, 호스트가 잰 효과 확인 결과와 evidence를 본다.
- 끝난 자식은 partition과 context를 즉시 해제한다. 메모리 압박 때는 팀 안에서 오래된 자식부터 discard하고, 부모가 멈춘 자식을 UI와 보드에 표시한다. 열려 있는 세션 수를 UI에 보인다.
- 팀별 예산(메모리, 토큰, 동시 에이전트 수)을 따로 두고, 팀 간 위임으로 상대 예산을 소진시키지 못하게 한다.
- 컨텍스트 인계: planner는 매 단계 새 컨텍스트를 만들므로 한도로 죽지 않는다. 자식 교체가 필요하면 `handoff`(목표, 진행, 남은 일, 현재 URL과 locator 상태)로 이어받는다.

## 8. Playwright와의 차이 요약

| | Playwright | Halowright |
|---|---|---|
| 신뢰 모델 | 코드가 시킨 대로 실행 | 호스트가 해석한 요소를 판정 후 실행 |
| 성공 판정 | 이벤트를 보내면 성공 | 효과를 확인해야 `ok` |
| `evaluate` | 임의 JS 즉시 실행 | 기본 ASK, 읽기 전용만 자동 |
| 병렬 | 컨텍스트를 개발자가 관리 | 에이전트별 partition, 끝나면 해제 |
| 팀 | 없음 | 팀 내/팀 간 통신, 교착 감지, 팀 예산 |
| MCP | 해당 없음 | MCP 우선, 브라우저는 폴백 |

공통점은 접근성 기반 locator, 자동 대기, 격리 컨텍스트, CDP 기반이다.

## 9. 테스트

- 로컬 fixture 페이지로 role/label/text locator, 지연 렌더링 자동 대기, 가려진 요소 거부, 모호한 locator 거부, epoch 불일치 거부를 검증한다.
- Enter를 무시하는 입력창 fixture로 `press_key` 후 `uncertain`이 나오는지, 부작용 동작은 재시도하지 않는지 검증한다.
- "Delete" 버튼이 locator와 무관하게 effect 분류로 막히는지, `evaluate` 승인 경로를 검증한다.
- 자식이 보드 보고 없이 종료하면 완료로 처리되지 않는지, 끝난 자식의 partition이 해제되는지 검증한다.
- 형제 `ask`/`share`/`claim`, 교착 감지, 대기 한도, 타임아웃을 검증한다. 다른 팀 메시지가 정책이나 lease를 바꾸지 못하는지, cross-team lease 철회가 즉시 효력을 갖는지 검증한다.
- MCP 우선 경로 선택, 폴백 이유 기록, MCP 호출도 승인을 거치는지 검증한다.
- 긴 작업 후 planner 컨텍스트 크기가 상한 안인지 확인한다.

## 구현 순서

1. 효과 확인 계층과 테스트
2. locator와 자동 대기, 에이전트 단위 격리
3. 종료 전 보고 강제와 부모 검증
4. MCP 우선 라우터와 폴백
5. 팀 내 통신과 교착 감지
6. 팀 간 통신(리드 경유, cross-team lease, `request-team-help`)
7. 자원 해제와 팀·팀 간 예산
8. `evaluate`와 lease 연동
9. 영구 프로필(별도 승인)

구현 계획은 (1)~(3), (4)~(6), (7)~(9) 세 묶음으로 나눠 각각 테스트를 통과시키며 진행한다.

## 열린 질문(결정 필요)

- 문서 편집기(Google Docs, Sheets, Slides)처럼 캔버스 기반 앱을 첫 대상으로 삼을지. 삼는다면 MCP 경로를 우선하고, 브라우저 경로는 "변경 묶음 미리보기와 승인 한 번"으로 올린다.

## 부록 A. Grok Bot 가이드에서 가져온 후보 (2026-10-07, 미구현)

| 항목 | 내용 | 대응 절 |
|---|---|---|
| `blocked` 보드 종류 | 팀 보드 kind에 `blocked`(사람 입력 필요)를 추가한다. | 5 |
| 팀 크기 상한 | 한 팀의 동시 자식 에이전트를 약 6명으로 제한한다. | 7 |
| 인증 실패 중단 | 루틴은 인증 실패 2회 뒤 멈추고 사용자에게 알린다. | 7 |
| 기본 비활성 | 새 에이전트는 기본 비활성이며 사용자가 켠다. | 3 |
| 전송 전 확인 | 메시지 전송, 게시, 구매는 보내기 전에 확인한다. | 3 |
| 기존 에이전트 우선 | 새로 만들기 전에 기존 에이전트를 재사용한다. | 5 |
| 템플릿 내보내기 | 에이전트 템플릿을 내보낼 때 비밀 값은 제외한다. | 3 |
