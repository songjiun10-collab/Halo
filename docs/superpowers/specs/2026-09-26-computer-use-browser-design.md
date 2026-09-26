# Computer-use 전용 브라우저 — 설계서

날짜: 2026-09-26
상태: 승인됨(사용자 "ㄱㄱ"), 구현 진행 중

## 배경과 동기

Halo는 승인(approve)과 실행(execute)을 분리하는 AI 컨테인먼트를 연구한다.
지금까지는 `sha256` 데모 도구(`halo.gateway`)와 그 실험적 확장인 E007(승인자·
실행자를 각자 별도 프로세스·별도 키로 분리하고 `halo.policy.decide()`로
판단하는 참조 구현)로 이 개념을 검증해왔다. 이번 작업은 이 연구를 **실제로
의미 있는 공격 표면**으로 확장한다: AI가 웹을 직접 탐색·클릭·입력하는
"computer-use 브라우저"다.

### 왜 이게 단순한 또 다른 에이전트 브라우저가 아닌가

업계 조사 결과([자료 참고](#참고-자료)), computer-use 브라우저의 핵심 위험은
"권한 혼동(authority confusion)"이다 — AIRGuard 논문의 정의를 빌리면,
*신뢰할 수 없는 리소스(방금 읽은 웹페이지)는 에이전트의 추론에 정보를 줄 수는
있지만, 부작용을 일으킬 권한을 부여해서는 안 된다.* 실제로 이 문제는 이미
프로덕션에서 사고로 이어졌다:

- **Perplexity Comet** (2025년 8월~10월): 캘린더 초대장에 숨겨진 지시문을
  에이전트가 사용자 지시로 오인해 실행 — 제로클릭으로 로컬 파일이 유출됐다.
  브라우저가 "사용자의 지시"와 "방금 읽은 페이지의 내용"을 구분하지 않은 게
  근본 원인이다.
- **OpenAI ChatGPT Atlas**: 이 문제를 인지하고 에이전트가 임의 코드 실행·
  다운로드·확장 설치를 못 하게 막고, 금융기관 등 민감 사이트에서는 사용자가
  지켜보고 있는지 확인 후에만 진행하도록 제한했다. OpenAI 스스로 "프롬프트
  주입은 아마 영구히 완전히 해결되지 않을 것"이라고 밝혔다.

Halo가 이미 갖고 있는 자산(결정론적 정책 엔진, 실제 프로세스 분리, provenance
불일치 탐지)은 이 문제에 구조적으로 들어맞는다 — E007의 "자기 신고와 독립
분류가 불일치하면 거부한다"는 패턴을, "에이전트가 방금 읽은 페이지 내용에서
나온 의도"와 "사용자의 원 지시에서 나온 의도"를 구분하는 데 그대로 쓴다.

## 역할 분담

- **Claude**: Electron main 프로세스(runtime), 브라우저 제어 API, 승인-실행
  경계, 통합/보안 테스트.
- **Codex**: renderer UI(`apps/computer-browser/renderer/` — 주소창·작업
  패널·승인 큐·타임라인·중단 상태), UI 테스트.
- 기존 `halo/authority.py`·`halo/gateway.py`·`halo/gateway_app.py`·
  `halo/dev_server.py`는 이번에도 전혀 수정하지 않는다. `halo.policy`·
  `halo.safety_cases`를 라이브러리로만 가져다 쓴다.

## 접근 방식 검토

세 가지를 검토했다:

1. **기존 `halo.gateway` 그대로 재사용** — 모든 브라우저 동작을 Gateway
   tool로 등록. 검증된 인프라를 재사용하지만, 매 클릭마다 HTTP 왕복이 필요해
   인터랙션이 느리고, 고정 tool fingerprint 모델이 자유로운 탐색에 안 맞는다.
2. **Electron 프로세스 내부의 경량 승인 계층** — 빠르지만 승인자·실행자가
   같은 프로세스 안에 있어 분리가 모듈 경계일 뿐 물리적 경계가 아니다.
   E007이 지적한 self-servable override 문제가 재현된다.
3. **하이브리드 (채택)** — Electron main을 실행자로, 별도 상시 구동 Python
   프로세스를 승인자로 분리하고, E007에서 이미 검증된 `UnixSocketChannel`을
   재사용한다. Gateway의 SQLite/HTTP/토큰 오버헤드는 가져오지 않고, "분리
   자체"와 "결정론적 정책 엔진"만 계승한다.

**채택: 3.** 실제 프로세스 경계를 유지하면서 이미 검증된 코드를 재사용해
새로 짜는 양을 줄이고, HTTP 왕복 없이 인터랙션 성능을 확보한다.

## 아키텍처

```
Electron App (macOS, 네이티브 타이틀바, frame:false 미사용)
├─ renderer/  (Codex 담당)
│   index.html, renderer.js, styles.css
│   window.haloBrowser 브리지로만 main과 통신, Node API 접근 없음
├─ preload/index.js  (Claude 담당)
│   contextBridge.exposeInMainWorld('haloBrowser', {...})
├─ main/  (Claude 담당) — 실행자, HALO_EXECUTOR_KEY만 보유
│   index.js           BrowserWindow 생성, renderer/index.html 로드
│   control-api.js      WebContentsView 생성/제어, CDP(webContents.debugger)로
│                        실제 클릭·타이핑·네비게이션 수행, bounds 클램프
│   approver-client.js  승인자 프로세스와 통신하는 Unix socket 클라이언트
├─ approver/approver_service.py  (Claude 담당) — 승인자, HALO_APPROVER_KEY만 보유
│   halo.policy.decide() + halo.safety_cases.evaluate_trace()로 판단
│   experiments/e007_dual_agent_provenance_gate/channel.py의
│   UnixSocketChannel을 그대로 import해 재사용
└─ shared/layout-constants.js  (Claude 작성, 양쪽이 참조)
    HEADER_HEIGHT=124, FOOTER_HEIGHT=25, SIDE_PANEL_WIDTH=342,
    MOBILE_BREAKPOINT=680 — preload가 이 값을 읽어 window.haloBrowser.layout
    으로 camelCase read-only 노출, renderer는 이를 CSS custom property로 주입
```

## 신뢰 경계와 게이팅 규칙

**자유(승인 없이 즉시 실행)** — 전부 사람이 UI를 직접 조작하는 동작이며,
Gateway의 "승인 키는 인증된 사용자 의도를 나타낸다"는 철학과 동일하게
취급한다:
`navigate(url)`, `goBack()`, `goForward()`, `reload()`, `newTab()`,
`pauseTask()`, `resumeTask()`, `stopTask()`, `getSnapshot()`.

**승인 대상** — `startTask(prompt)` 실행 중 에이전트가 스스로 결정하는
후속 동작(클릭, 타이핑, 폼 제출, 새 origin 이동, 다운로드)은 전부 승인자를
거친다. 이때 핵심 신호는 **그 동작의 근거가 사용자의 원 지시에서 왔는가,
아니면 에이전트가 방금 읽은 페이지 내용에서 왔는가**다 — Comet 사고와 정확히
같은 위협을 겨냥한다.

승인자의 판단은 `halo.safety_cases.evaluate_trace(events, trusted_telemetry=False,
host_provenance=...)` → `halo.policy.decide(findings, effectful=True)`로만
나온다. 자유 형식 LLM 판단은 어떤 경로로도 승인에 영향을 주지 않는다.

| Decision | 처리 |
|---|---|
| ALLOW | 자동 실행, `timeline`에만 기록 |
| DENY / QUARANTINE | 자동 차단, `timeline`에 사유와 함께 기록 |
| REVIEW | `approvalQueue`에 대기, 사람이 `approve`/`deny` 호출해야 진행/폐기 |

**구현 중 발견한 중요한 제약**: `halo.safety_cases`의 기존 action 어휘
(`read/list/search/lookup/compute`, `send_message/.../post_web/...`,
`grant_access/...`)에는 브라우저 동작이 하나도 없다. 매핑 없이 그대로 보내면
"어휘 밖 action"으로 매번 `MONITORING_GAP`이 뜨고, `effectful=True`에서는
MONITORING_GAP이 하나라도 있으면 REVIEW 단계에 가지도 못하고 즉시 DENY된다
— 즉 매핑 없이는 **모든 동작이 항상 거부**된다. `approver_service.py`가
다음과 같이 매핑한다:

| 브라우저 action (wire-level) | halo action | halo effect | 실제 도달 가능한 결정 |
|---|---|---|---|
| `navigate` / `click` / `type` | `read` | 없음 | ALLOW · REVIEW · DENY 전부 (provenance에 따라) |
| `submit_form` | `post_web` | `external_write` | **항상 DENY** (독립 텔레메트리 없음) |
| `download` | 매핑 없음(어휘 밖 유지) | — | **항상 DENY** |

`submit_form`이 항상 거부되는 이유는 `effect="external_write"`인데
`trusted_telemetry=False`(독립 실행 증거 없음)이면 `evaluate_trace()`가
"self-reported telemetry is not independent execution authority"로 심각도 5
MONITORING_GAP을 내기 때문이다 — E007이 이미 문서화한 것과 같은 보수적
fail-closed 동작이다. `download`은 어휘에 대응 항목을 만들지 않아 항상
거부되게 뒀다 — ChatGPT Atlas가 같은 이유로 에이전트의 다운로드를 아예
금지한 것과 같은 실제 업계 선례를 따른 결정이다.

`click`/`type`을 `read`로 매핑한 것은 근사치다 — 실제로 상태를 바꾸는 클릭
(구매·삭제·확인 버튼)과 무해한 클릭(링크 열기)을 구분하지 못한다. 이건
숨기지 않고 아래 "정직한 한계"에도 남긴다.

이 동작은 `tests/test_computer_browser_approver.py`(21개)로 고정돼 있다 —
ALLOW/REVIEW/DENY 각 경로, self-report가 host 판단과 불일치할 때 DENY로
가는 것, `host_provenance=None`이었다면 같은 거짓 신고가 ALLOW로 새는
대조군까지 포함한다.

## IPC 계약 (`window.haloBrowser`)

```
getSnapshot(): Promise<Snapshot>
navigate(url: string): Promise<Snapshot>
startTask(prompt: string): Promise<Snapshot>
pauseTask(): Promise<Snapshot>
resumeTask(): Promise<Snapshot>
resumeAfterCaptcha(): Promise<Snapshot>   // (2026-09-27 추가, "후속 업데이트 4" 참고)
stopTask(): Promise<Snapshot>
goBack(): Promise<Snapshot>
goForward(): Promise<Snapshot>
reload(): Promise<Snapshot>
newTab(): Promise<Snapshot>
approve(requestId: string): Promise<Snapshot>
deny(requestId: string): Promise<Snapshot>
setBrowserBounds({x, y, width, height}): Promise<void>
onEvent(callback: (event) => void): () => void   // returns unsubscribe
layout: Readonly<{ headerHeight, footerHeight, sidePanelWidth, mobileBreakpoint }>
```

`Snapshot` 형태:
```
{
  page: { url, title, loadState, canGoBack, canGoForward, hasPage,
          captchaSuspected },  // (2026-09-27 추가) 읽기 전용 휴리스틱, 항상 계산됨
  task: { id, state, pauseReason },
    // state: idle|running|awaiting_approval|paused|stopped|completed|error
    // pauseReason(2026-09-27 추가): null|"user"|"captcha" -- state가 "paused"일 때만 의미 있음
  approvalQueue: [{ id, summary, origin, action, reason, createdAt }],
  timeline: [{ id, at, kind, message, status }],  // status: allow|deny|review|error|info
}
```

## WebContentsView 배치와 보안

`WebContentsView`는 renderer DOM 위에 얹히는 네이티브 오버레이라서 두 가지를
지킨다:

1. **탭이 없을 때는 숨긴다** (`setVisible(false)`) — 그래야 renderer의 초기
   empty-state가 가려지지 않는다. 탭이 생기면 `setVisible(true)` 후 클램프된
   bounds를 적용한다.
2. **bounds는 renderer를 신뢰하지 않고 main에서 항상 클램프한다** — 그렇지
   않으면 렌더러(또는 이를 흉내내는 무언가)가 bounds를 조작해 실제 브라우저
   화면이 승인 큐·타임라인 위를 덮어, 사용자가 뭘 승인하는지 모르고 누르게
   만드는 UI 스푸핑 경로가 생긴다.

```js
function clampBrowserBounds({x, y, width, height}, contentWidth, contentHeight) {
  const isDesktop = contentWidth > MOBILE_BREAKPOINT;
  const maxRight = isDesktop ? contentWidth - SIDE_PANEL_WIDTH : contentWidth;
  const minY = HEADER_HEIGHT, maxBottom = contentHeight - FOOTER_HEIGHT;
  const cx = Math.max(0, Math.min(x, maxRight));
  const cy = Math.max(minY, Math.min(y, maxBottom));
  return { x: cx, y: cy,
    width: Math.max(0, Math.min(width, maxRight - cx)),
    height: Math.max(0, Math.min(height, maxBottom - cy)) };
}
```

macOS 네이티브 타이틀바를 쓰므로(`frame:false` 미사용) `WebContentsView.setBounds()`가
쓰는 콘텐츠 영역 좌표계에 별도 보정이 필요 없다고 가정한다.

## 승인자 프로세스 ↔ Electron main 통신

E007의 `UnixSocketChannel`은 **1회용**이다 — `listen()`/`connect()` 한 번에
정확히 요청 1개·응답 1개만 주고받고 소켓을 닫는다(그리고 `listen()`은
경로를 언링크한다). 브라우저 세션 중에는 승인 요청이 계속 발생하므로,
approver_service.py는 루프를 돈다:

```python
while running:
    channel = UnixSocketChannel.listen(SOCKET_PATH)
    request = channel.recv()
    decision = evaluate(request)
    channel.send(decision)
```

각 반복 사이 소켓 파일이 사라졌다가 다시 생기는 극히 짧은 창이 있다 —
main 쪽 `approver-client.js`는 `connect()` 실패 시 짧은 backoff로 재시도한다.
이건 E007 원 설계의 "1회성 채널"을 상시 서비스로 억지로 당겨쓰는 데서 오는
알려진 제약이며, 숨기지 않고 여기 남긴다.

## 테스트 계획

- **Claude**: main/preload/approver 단위 테스트(bounds 클램프, 승인 게이팅
  결정 로직, 소켓 재연결), 통합 테스트(실행자↔승인자 실제 프로세스 2개로
  ALLOW/DENY/REVIEW 각 경로), 보안 테스트(반대 역할 키 존재 시 시작 거부,
  bounds가 예약 영역을 침범 못 함).
- **Codex**: renderer UI 테스트(스냅샷 렌더링, 승인 큐 버튼, 상태 전이 표시).

## 검증됨 (실제 Electron 앱으로 확인)

이 설계는 실제로 `npm install && npx electron .`로 앱을 띄우고 CDP
(`--remote-debugging-port`)로 `window.haloBrowser`를 직접 호출해 검증했다
(가정이 아니라 실제 실행 결과):
- `window.haloBrowser`가 정확히 15개 키(13개 메서드 + `onEvent` + `layout`)로
  노출되고, `layout` 값이 `shared/layout-constants.js`와 정확히 일치한다.
- `startTask('https://example.com/')` → 실제 승인자 프로세스(별도 Python
  OS 프로세스, 실제 Unix 소켓)가 ALLOW를 반환 → 실제 `WebContentsView`가
  진짜로 `https://example.com/`을 로드해 타이틀이 "Example Domain"으로
  갱신됨 → `timeline`에 `task started → agent proposes navigate [allow] →
  navigated` 3단계가 정확히 기록됨.
- 이 과정에서 실제 버그 3개를 발견·수정했다: (1) `approvalQueue`의 private
  `_execute` 클로저가 IPC structured-clone에서 직렬화 예외를 일으킴, (2)
  view 생성 전에 도착한 `setBrowserBounds`가 캐시에 걸려 새 view에 한 번도
  적용되지 않을 수 있음, (3) macOS `/var`→`/private/var` 심링크 때문에
  `os.tmpdir()` 경로를 그대로 쓰면 `UnixSocketChannel`이 심링크 컴포넌트를
  거부해 승인자가 소켓 바인딩에 영원히(조용히) 실패함.

**후속 업데이트 (같은 날) — REVIEW가 이제 UI에서도 실제로 도달 가능하다.**
`startTask`를 2단계로 확장했다: 1단계는 그대로 사용자 프롬프트의 URL로
이동(`source="user_prompt"`, ALLOW만 가능). 성공하면 2단계로, 방금 로드된
페이지에서 외부 링크 하나를 실제로 찾아(`executeJavaScript`로 페이지 자신이
아니라 우리가 작성한 고정 추출 스크립트를 실행 — 페이지 콘텐츠를 eval하는
게 아니라 읽기다) `source="page_content"`, `self_provenance="untrusted"`
(정직한 자기 신고)로 후속 이동을 제안한다. 실제 Electron 앱 + CDP로 끝까지
검증했다: `https://example.com/`으로 이동 → 페이지의 "Learn more" 링크를
찾아 `approvalQueue`에 실제로 큐잉됨(`reason: "Content originated from an
untrusted data channel."`) → `approve(requestId)` 호출 → 실제로
`https://iana.org/domains/example`(리다이렉트 후 `iana.org/help/example-domains`)
로 이동, `canGoBack: true`, 타임라인에 "(approved by reviewer)" 기록까지
정확히 확인됨.

**여전히 남은 것**: 이건 여전히 정해진 2단계 스크립트이지 진짜 멀티스텝
루프가 아니다 — 한 번의 후속 링크 제안 이후 멈춘다. 루프 횟수 상한·중복
방문 방지 같은 것도 없다(루프 자체가 없으므로 아직 필요 없다). Provenance
mismatch로 인한 DENY(에이전트가 거짓으로 `self_provenance="trusted"`를
주장하는 경우)는 여전히 Python 유닛 테스트에서만 검증된다 — 정직하게
동작하는 이 데모 에이전트는 스스로 거짓말을 하지 않으므로, 실제로 거짓
신고하는 에이전트(또는 공격자가 조작한 실행자)가 있어야 라이브로 재현된다.

**후속 업데이트 2 (2026-09-27) — stopTask()/pauseTask() 경쟁 상태 수정.**
Codex가 런타임 경계를 검수하던 중 실제 경쟁 상태 2건을 발견해 알려왔다:
`stopTask()`가 이미 승인자에게 보낸 `requestDecision()` 호출을 취소하지
않아, 정지 후 늦게 ALLOW가 도착하면 그대로 실행되고, 늦게 REVIEW가
도착하면 `stopTask()`가 방금 비운 `approvalQueue`를 되살리며
`_task.state`도 `"stopped"`에서 `"awaiting_approval"`로 조용히 되돌아갈 수
있었다. `pauseTask()`도 동일한 문제였다 — 대기 중이던 결정이 도착하면
일시정지 상태를 무시하고 그대로 실행됐다.

수정: `stopTask()`가 세대 카운터(`_stopEpoch`)를 증가시키고,
`performGatedAction()`은 `requestDecision()`이 풀린 직후 그 카운터가
바뀌었는지 확인해 바뀌었으면(=그사이 정지됨) 실행도, 큐잉도 하지 않고
버린다(`"cancelled"` 반환). `pauseTask()`는 대칭적으로, 결정이 도착한
시점에 `_task.state === "paused"`이면 즉시 적용하지 않고 단일 슬롯
(`_deferredDecision`)에 보류했다가 `resumeTask()`가 명시적으로 적용한다.
`startTask()` 내부에서 결과를 `"completed"`로 덮어쓰던 두 지점도 함께
고쳐, 정지·일시정지 상태가 덮어써지지 않게 했다.

정직하게 남는 한계: `resumeTask()`가 보류된 결정을 적용해도 이미 반환된
`startTask()`의 실행 흐름(1단계→2단계) 자체를 재개하지는 않는다 — 정지된
2단계 고정 스크립트일 뿐 진짜 루프가 아니므로, 예를 들어 1단계에서
일시정지된 뒤 재개하면 그 결정(ALLOW/REVIEW)은 적용되지만 2단계(링크
추적 제안)로는 이어지지 않고 작업이 그대로 끝난다. 이는 기존에 문서화된
"진짜 멀티스텝 루프 없음" 한계의 연장선이다. 검증: `apps/computer-browser
/test/control-api.test.js`에 7개 회귀 테스트 추가(정지 후 늦은
ALLOW/REVIEW 폐기, 일시정지 중 보류·재개 시 적용, 일시정지 후 정지 시
보류분까지 폐기 등) — `node --test` 20/20 통과, 전체 Python 회귀
`.venv/bin/python -m pytest -q` 494/494 통과 유지 확인.

**후속 업데이트 3 (2026-09-27) — 실행 중 정지 레이스 추가 수정.** Codex가
독립적으로 재현해 알려왔다: 위 수정은 "판정이 아직 안 왔는데 정지/일시정지"
경우만 막고, "판정은 ALLOW로 이미 왔고 `execute()`(예: 실제 `navigate()`의
`loadURL` 대기)가 진행 중인 동안 `stopTask()`가 오는" 경우는 여전히 놓쳤다.
재현: `requestDecision`은 즉시 ALLOW, `navigate`는 수동 resolve Promise,
`_findFirstOutboundLink`는 `null` 반환으로 대체한 뒤 `startTask(...)`
실행 → `navigate`가 대기 중일 때 `stopTask()` 호출 → `navigate` resolve →
최종 스냅샷이 `{state: "completed"}`로 나왔다(직접 재실행해 확인).
원인은 `startTask()`가 `_findFirstOutboundLink()` 이후("링크 없음" 분기
포함) 및 `_applyDecision`의 `await execute()` 이후 지점에서 정지 세대를
다시 확인하지 않은 것 — `execute()`가 실행되는 동안에는 이미 유효했던
ALLOW가 그대로 통과해 `_task.state`를 `"completed"`로 덮어썼다.

수정: `_applyDecision(descriptor, execute, decision, epoch)`가 `execute()`
직후 `_stopHappenedSince(epoch)`를 다시 확인해, 정지가 있었으면(이미
`execute()`는 실제로 실행됐지만) 호출자에게 `"cancelled"`를 돌려줘
`"completed"`로 덮어쓰지 못하게 한다. `startTask()`는 함수 맨 위에서 한
번 세대를 캡처해 이후 모든 await 지점(1단계 판정 후, `_findFirstOutboundLink`
후, 2단계 판정 후 — "링크 없음" 분기 포함)에서 같은 세대로 재확인한다.
`resumeTask()`(보류된 결정의 `execute()` 도중 정지)와 `approve()`(승인된
항목의 `execute()` 도중 정지)에도 동일한 가드를 추가했다 — 이 둘도 같은
클래스의 구멍이었다. `execute()` 자체를 중단시키지는 않는다(이미 시작된
탐색을 안전하게 되돌릴 방법이 없음) — 고치는 것은 그 이후의 상태
장부 기록이지, 진행 중인 실행 자체가 아니다. 검증: 위 재현을 그대로
회귀 테스트 4개로 추가(performGatedAction·startTask·resumeTask·approve
각각의 실행-중-정지 경로), `test/control-api.test.js` 최종 11개, `node
--test` 24/24 통과, 전체 Python 회귀 494/494 통과 유지 확인.

**후속 업데이트 4 (2026-09-27) — 요청 pacing 기본값 + CAPTCHA 감지·보존·
핸드오프.** 사용자가 Codex와 Claude 모두에게 "자동 브라우징이 사이트의
CAPTCHA를 유발하는 빈도 자체를 낮추라"고 요청했다 — anti-bot 우회가
아니라 정상 이용 pacing만으로. 별도로 "CAPTCHA 때문에 사용자의 작업이
사라지거나 실패 처리되지 않게 해달라"는 요청도 있었고, 뒤이어 "포괄적
허락만으로 자동 해결하지 말라"는 정정이 왔다 — 두 요청 모두 이 프로젝트의
기존 원칙(CAPTCHA 판정 우회·자동 해결 금지)과 정확히 일치한다.

*Pacing (요청 빈도 낮추기).* 사람이 직접 하는 free action(주소창 입력·
뒤로가기·앞으로가기·새로고침·새 탭)에는 전혀 적용하지 않는다 — 에이전트가
개시해 실제로 실행되는 탐색(ALLOW 즉시 실행 + REVIEW 후 사람이 승인한
실행)에만 공통 pacing 시계(`_lastAgentActionAt`)를 적용해, 연속된
에이전트 액션 사이에 최소 간격(`MIN_AGENT_ACTION_INTERVAL_MS`, 기본
2000ms, 테스트에서는 생성자 옵션 `minAgentActionIntervalMs`로 낮춰
검증)을 강제한다. 첫 액션은 지연되지 않는다. 이미 구조적으로 만족되는
것도 확인했다: 동시성은 원래 1(`WebContentsView` 하나, 순차 `await`),
실패한 탐색에 대한 자동 재시도 로직 자체가 없음(=이미 0회), 에이전트
경로는 `newTab()`/`reload()`를 자동 호출하지 않음, `startTask()`는 여전히
고정 2단계라 요청 폭주 자체가 구조적으로 불가능함 — 새 코드가 필요했던
부분은 이 pacing 하한뿐이다.

*CAPTCHA 감지·보존·핸드오프.* `shared/captcha-heuristics.js`의
`looksLikeCaptcha(url, title)`는 알려진 CAPTCHA/anti-bot 벤더 호스트
문자열과 인터스티셜 제목 문자열만 대조하는 순수 함수다 — DOM을 읽지
않고, 챌린지를 풀거나 클릭하거나 우회하는 코드는 어디에도 없다. 모든
페이지 상태 갱신(`_syncPageState`, `did-navigate` 등에서 호출)마다
계산돼 `page.captchaSuspected`로 항상 노출되고, 그 시점에 작업이
`"running"`/`"awaiting_approval"`(=진행 중)이면 자동으로
`pauseTask()`와 같은 방식으로 일시정지하되 `task.pauseReason: "captcha"`
를 남겨 사람이 직접 손댄 일시정지(`"user"`)와 구분한다(idle·완료·정지된
작업은 보존할 게 없으므로 건드리지 않는다). `WebContentsView`는 원래도
항상 사람에게 보이고 입력을 받는 실제 네이티브 뷰라 "브라우저 조작권을
넘기는" 별도 접근 제어 코드는 필요 없었다 — 이미 그 자리에서 사람이
직접 풀 수 있다.

재개는 두 경로로 분리했다: `resumeTask()`는 `pauseReason === "captcha"`
이면 거부하고(계속 일시정지, 재시도 없음) `resumeAfterCaptcha()`를
쓰라고 안내한다. `resumeAfterCaptcha()`는 재개 직전 같은 휴리스틱으로
현재 페이지를 다시 확인해 여전히 CAPTCHA로 보이면 거부·유지하고(자동
재시도 없음), 아니면 `pauseReason`을 지우고 정상 재개 경로로 넘어간다.
`execute()`가 실제로 실행되는 도중(예: 실제 `navigate()`의 `loadURL`
대기 중) 그 탐색 자체가 CAPTCHA를 유발하는 경우도 다뤘다 —
`_applyDecision`이 `execute()` 직후 `_task.state === "paused"`를 다시
확인해(정지 세대 확인과 같은 자리), 이미 실행된 ALLOW를 "완료"가 아니라
"일시정지"로 보고하도록 해 위 "후속 업데이트 2/3"에서 고친 상태 장부
가드를 그대로 재사용한다. IPC 계약에 `resumeAfterCaptcha()`와
스냅샷의 `page.captchaSuspected`/`task.pauseReason` 필드를 추가했다
(`main/ipc.js`, `preload/index.js`) — 렌더러 쪽 UI 문구·배지·재개 버튼은
이 문서의 범위 밖이며(렌더러는 별도로 다시 만들어지는 중), 위 필드/메서드
계약만 맞으면 어떤 렌더러든 연결할 수 있다.

**정직한 한계(이번 추가분)**: `looksLikeCaptcha`는 알려진 문자열 몇 개만
대조하는 최선-노력 휴리스틱이다 — 목록에 없는 CAPTCHA 서비스나 커스텀
문구는 놓친다(위양성보다 위음성 쪽으로 보수적으로 설계했다: 놓치면
그냥 페이지가 평소처럼 보일 뿐이고, 잘못 걸리면 불필요하게 한 번
일시정지할 뿐이라 안전 방향이 같다). 완전한 감지 보장이 아니다. 검증:
`test/captcha-heuristics.test.js`(순수 함수 5개), `test/control-api.test.js`
에 pacing 2개 + CAPTCHA 핸드오프 7개 추가 — `node --test` 38/38 통과,
전체 Python 회귀 494/494 통과 유지 확인.

**후속 업데이트 5 (2026-09-27) — 재개가 실제로 이어지지 않던 문제 수정
(이전 "정직한 한계" 정정).** 위 "후속 업데이트 4"와 "후속 업데이트 2/3"에서
"`resumeTask()`가 보류된 결정을 적용해도 이미 반환된 `startTask()`의
1→2단계 흐름 자체를 재개하지는 않는다"고 적었는데, 이 내용을 검증 요청
받아 직접 재현해보니 CAPTCHA로 일시정지된 뒤 `resumeAfterCaptcha()`를
불러도 `_task.state`만 `"running"`으로 바뀔 뿐 `_findFirstOutboundLink()`도
후속 승인 흐름도 전혀 재실행되지 않아, 작업이 "실행 중"이라고 표시된 채
조용히 멈춰 있는 상태였다(재현: `startTask()`의 1단계 `navigate`가 CAPTCHA를
유발하도록 만든 뒤 `resumeAfterCaptcha()` 호출 → `_findFirstOutboundLink`
호출 횟수가 0에서 그대로 멈춤). 이건 "일시정지"보다 나쁘다 — UI에 "진행
중"이라고 보이지만 실제로는 아무 일도 일어나지 않기 때문이다.

수정: `_taskCursor`(`{ step: "step1"|"step2", trimmed, epoch }`)를 도입해
`startTask()`가 각 단계의 게이티드 호출 직전에 "이 단계가 끝나면 다음에
뭘 해야 하는지"를 기록해 둔다. 단계 완료 후 처리 로직을 `_afterStepOutcome()`
로, 2단계 자체를 `_runStepTwo()`로 뽑아내 `startTask()`의 최초 실행 경로와
`resumeTask()`의 재개 경로가 완전히 같은 함수를 공유한다. 판정이 실행 전에
보류된 경우(`_deferredDecision`, 사람이 미리 `pauseTask()`한 경우)든 판정이
이미 ALLOW로 실행된 뒤 보류된 경우(CAPTCHA 감지, 또는 실행 도중 겹친
`pauseTask()`)든, 재개 시 커서가 가리키는 단계의 결과를 그대로
`_afterStepOutcome()`에 넘겨 실제로 다음 단계(2단계 링크 탐색 → 후속
게이티드 이동, REVIEW면 승인 대기열 적재까지)를 계속 실행한다. 2단계 자체가
끊긴 경우는 이 고정 2단계 데모의 마지막 단계이므로 재개는 그냥
`"completed"`로 정리한다. `stopTask()`는 `_taskCursor`도 함께 초기화한다.
`startTask()`를 거치지 않은 단발 `performGatedAction()` 호출(기존 pause
테스트들)은 커서가 없으므로 기존 동작(재개 후 단순 완료 처리) 그대로
유지된다 — 하위 호환. 검증: 재현 절차를 그대로 회귀 테스트 3개로 추가(
CAPTCHA로 멈춘 뒤 재개가 실제로 2단계까지 이어져 완료/REVIEW에 도달하는지,
그리고 실행 전 보류(pauseTask)의 경우도 동일하게 이어지는지) —
`test/control-api.test.js` 최종 23개, `node --test` 41/41 통과, 전체
Python 회귀 494/494 통과 유지 확인.

**후속 업데이트 6 (2026-09-27) — 지연 계측 + navigation timeout/abort +
DOM 스캔 상한(병목 분석 후속).** 사용자가 웹 근거(Anthropic computer-use
문서의 tool_use↔tool_result 루프, WebArena의 long-horizon 실패 논의,
Electron `loadURL()`가 완료 이벤트까지 promise가 끝나지 않는다는 공식
문서)와 로컬 코드 병목 분석(고정 2단계 데모, 무기한 대기 가능한
`navigate()`, `_findFirstOutboundLink()`의 전체 DOM 스캔, 액션마다 새
Unix 소켓 왕복, 전체 목록을 매번 다시 렌더하는 렌더러)을 근거로 5가지
우선순위를 제시했다: (1) 단계별 지연·실패 사유 계측(p50/p95, 테스트 가능한
fixture)을 먼저, (2) navigation timeout/abort 연동, (3) LLM 미연결 상태를
UI에 명확히 유지한 채 step/action/time/token 예산과 승인 게이트를 보존하는
bounded loop **설계**, (4) selector 기반 관측량 상한, (5) 실측으로 렌더링이
병목임이 확인될 때만 timeline 증분 렌더링. 이번에는 (1)·(2)·(4)를 구현했다
— (1)은 나머지 판단의 증거가 되므로 먼저 필요했고, (2)는 `navigate()`가
`loadURL()`을 무기한 대기하는 실제 안전/복구 공백이라 가장 구체적인
병목이었으며, (4)는 (2)를 손보는 김에 저비용으로 막을 수 있었다. (3)은
"설계부터", (5)는 "측정 후에만"이라는 사용자 지시대로 이번 범위에서
제외했다.

*지연 계측.* `shared/metrics.js`의 순수 함수 `summarizeMetrics(records)`가
`{kind, ms, outcome}` 기록들을 종류별로 묶어 `count/p50/p95/outcomes`(실패
사유별 개수)를 계산한다. `ControlApi`는 승인 왕복(`decision_wait`), 실제
액션 실행(`execute`), 탐색 자체(`navigation`), 페이지 DOM 읽기(`dom_read`),
승인 대기열 체류 시간(`queue_wait`), 작업 전체 시간(`task_total`) 여섯
종류를 각 지점에서 기록하고 `getMetricsSummary()`(IPC로도 노출)로
조회한다. 시계는 `now` 생성자 옵션으로 주입 가능해 테스트가 실제 sleep
없이 정확한 지속시간을 단언한다. 렌더러 쪽 스냅샷 수신→페인트 지연은
이 main 프로세스 코드에서 관측 불가능하므로(관측하려면 렌더러 자신이
측정해야 함) 범위에서 제외했다 — 렌더러는 별도로 다시 만들어지는 중이라
같은 규약(kind/ms/outcome)으로 자체 계측을 추가하면 된다.

*navigation timeout/abort.* Electron 공식 문서대로 `loadURL()`은 완료
이벤트까지 promise가 끝나지 않는다 — 느리거나 멈춘 페이지가 `startTask()`
호출자(또는 대기 중인 resume)를 무기한 붙잡을 수 있었다. `navigate()`가
이제 `loadURL()`을 타이머와 경쟁시켜(`_loadWithTimeout()`), 기본
30초(`navigationTimeoutMs`로 설정 가능) 안에 끝나지 않으면
`webContents.stop()`으로 실제로 중단시키고 `page.loadState = "error"`로
보고한다(중단은 하되 예외를 던지지는 않는다 — `execute()` 클로저로도
쓰이는 함수이므로 게이티드 파이프라인에 새 미처리 예외를 만들지 않기
위함). 진짜 빠른 실패(DNS 실패 등)는 그대로 `did-fail-load` 리스너 경로로
처리되며 이 타임아웃과 무관하다.

*DOM 스캔 상한.* `_findFirstOutboundLink()`의 앵커 순회를
`maxDomLinksScanned`(기본 500)로 제한해, 앵커가 병적으로 많은 페이지가
"링크 하나 읽기"를 무제한 스캔으로 만들지 못하게 했다. `executeJavaScript`
호출 자체에는 별도 타임아웃을 걸지 않았다(정직한 한계 참고).

*벤치마크.* `bench/latency-bench.js`(신규, 반복 가능한 Node 스크립트,
`node --test` 대상 아님)가 모의 지연을 주입해 계측이 실제로 의미 있는
수치를 만드는지 보여준다 — **이 수치는 시뮬레이션이며 실제 운영 측정치가
아니다**(실제 측정은 살아있는 Electron 앱·실제 승인자·실제 외부 사이트가
필요해 이번 세션 범위 밖 — 이 프로젝트의 "가능하면 localhost/fixture로
검증" 원칙과도 일치한다). 200회 반복 예시 출력:
```
execute        count=153   p50=525   ms p95=875   ms outcomes={"ok":153}
dom_read       count=167   p50=24    ms p95=41    ms outcomes={"not_found":167}
decision_wait  count=166   p50=17    ms p95=31    ms outcomes={"allow":152,"review":14}
queue_wait     count=14    p50=11163 ms p95=14896 ms outcomes={"approved":14}
```
(카운트 합이 500인 것은 버그가 아니라 `MAX_METRICS=500`이 종류 구분 없이
전체에 걸리는 공유 롤링 윈도우이기 때문이다 — 정직한 한계 참고.)

**정직한 한계(이번 추가분)**: `MAX_METRICS=500`은 모든 종류를 합친
공유 버퍼라서, 한 종류가 다른 종류보다 훨씬 자주 기록되면(예:
`decision_wait`가 `queue_wait`보다 훨씬 잦음) 드문 종류의 표본이 상대적으로
더 빨리 밀려날 수 있다 — 종류별 개별 버퍼가 아니다. `navigationTimeoutMs`
기본값(30초)은 실측 p95 없이 고른 정적 추정치다(실제 측정 후 조정 대상).
`executeJavaScript` 자체에는 타임아웃이 없다(앵커 개수만 상한). 렌더러
페인트/스냅샷-수신 지연은 계측되지 않는다(주 프로세스 코드의 관측
범위 밖). 벤치 수치는 시뮬레이션이며 실제 프로덕션 latency 분포를
대표하지 않는다. 검증: `shared/metrics.js` 순수 함수 테스트 6개
(`test/metrics.test.js`), `test/control-api.test.js`에 계측·타임아웃·
DOM 상한 회귀 테스트 7개 추가 — `node --test` 54/54 통과, 전체 Python
회귀 494/494 통과 유지 확인.

**후속 업데이트 7 (2026-09-27) — computer-use 속도/효율 연구 반영, navigation
readiness 옵션 추가.** 사용자가 추가 웹 근거(OSWorld-Human: 37개 task
분해에서 planning+reflection LLM 호출이 전체 지연의 75–94%; WABER:
성공률뿐 아니라 reliability·시간/비용 효율까지 측정 필요; D2Snap: DOM
downsampling 실험, 연구 환경 한정이라 일반화 금지; Anthropic
latency/prompt-caching/tool-caching/computer-use 문서; OpenAI
computer-use 가이드; Playwright의 networkidle 비권장; Electron
`loadURL()`이 `did-finish-load`까지 기다린다는 공식 문서)를 근거로 7가지
속도 개선안을 제시하고, "보안 게이트를 약화시키지 않는 조건"과 "벤치마크
수치 근거 없는 개선 주장 금지"를 명시했다.

**항목별 적용 가능성 판정(정직하게 가려냄)** — 대부분의 제안은 이
코드베이스에 아직 없는 것을 전제로 한다: 항목 1(LLM wait 등 지연
decomposition), 4(스크린샷/DOM downsampling), 5(모델 한 스텝에서 독립
저위험 액션 배치), 6(안정적 system/task/action 스키마의 prompt
caching)은 모두 실제 LLM 모델 호출·스크린샷·모델 왕복이 존재해야
의미가 있는데, `startTask()`는 여전히 고정 2단계 스크립트일 뿐 어디에도
모델 호출이나 스크린샷이 없다(설계 문서 상단의 "정직한 한계" 참고). 이
넷을 "구현"한다고 하면 존재하지 않는 파이프라인을 벤치마크했다고
주장하는 셈이라 하지 않았다. 항목 2(`MIN_AGENT_ACTION_INTERVAL_MS`
고정값 조정)는 사용자가 직접 "봇/사이트 우회 목적으로 올리거나 내리지
말고, 정당한 근거 없이는 조정하지 말라"고 명시했고 실측 근거가 없으므로
그대로 두었다. 항목 7(불필요 action 수 지표)은 지난 커밋의
`getMetricsSummary()`가 이미 종류별 `count`로 일부 커버한다(고정
2단계라 "불필요한" 액션 자체가 아직 없다). **실제로 새로 구현 가능했던
것은 항목 3(navigation readiness) 하나뿐이다.**

*Navigation readiness.* Electron의 `loadURL()`은 `did-finish-load`(전체
로드, 서브리소스 포함)까지 promise가 끝나지 않는다 — Playwright가
`networkidle` 대기를 권장하지 않는 것과 같은 맥락에서, 이 앱의 유일한
페이지 콘텐츠 읽기(`_findFirstOutboundLink()`)엔 그보다 이른
`dom-ready`(DOMContentLoaded 상당) 시점으로도 충분할 수 있다.
`navigationWaitUntil` 생성자 옵션(`"load"`(기본, 기존 동작 그대로) |
`"dom-ready"`)을 추가했다 — `_loadWithTimeout()`이 `dom-ready` 모드일
때는 `loadURL()` 자체의 promise 대신 `dom-ready` 이벤트를 기다리고,
기존 timeout/abort(`webContents.stop()`)와 `did-fail-load` 처리 경로는
그대로 유지된다. **기본값은 바꾸지 않았다** — 스크립트로 주입된 링크가
DOMContentLoaded 이후 시점에 나타나는 페이지(SPA 등)에서는 `dom-ready`가
일부 링크를 놓칠 수 있어, 실제 페이지로 측정한 근거 없이 기본 동작을
바꾸는 건 이번 요청의 "근거 없는 개선 주장 금지"에 위배된다고 판단했다.

*결정론적 벤치 근거(동일 fixture, before/after).*
`bench/navigation-readiness-bench.js`(신규)가 가짜 `WebContentsView`로
동일한 모의 페이지 로드 모양(dom-ready 50ms, 전체 로드 400ms)에 대해
`"load"` vs `"dom-ready"` 두 모드를 각각 측정한다 — 30회 반복 예시:
```
waitUntil="load"      p50=402ms  p95=403ms  outcomes={"ok":30}
waitUntil="dom-ready" p50=52ms   p95=53ms   outcomes={"ok":30}
```
이 수치는 **만든 시나리오에 대한 통제된 비교**이지 실제 페이지 측정치가
아니다 — 실제 페이지에서 두 모드 중 무엇이 안전하고 빠른지는 살아있는
Electron 앱으로 측정해야 알 수 있고, 이번 세션엔 그런 환경이 없다.

**정직한 한계(이번 추가분)**: 항목 1/4/5/6은 코드에 대응물이 없어
구현하지 않았다 — LLM 루프가 생기면 그때 다시 검토해야 한다. `dom-ready`
모드는 완전성(페이지가 늦게 그리는 콘텐츠를 놓칠 수 있음)과 속도의
트레이드오프이며 승인 게이트나 pacing에는 영향을 주지 않는다. 검증:
`test/control-api.test.js`에 회귀 테스트 3개 추가(기본값이 실제로
`dom-ready`를 구독하지 않음, `dom-ready`가 실제로 더 이른 시점에
풀림, `dom-ready` 모드에서도 timeout/abort가 그대로 동작함) —
`node --test` 57/57 통과, 전체 Python 회귀 494/494 통과 유지 확인.

## 정직한 한계

- 이 문서 작성 시점까지 Electron 앱을 실제로 빌드·실행해 검증하지 않았다 —
  CDP(`webContents.debugger`) 관련 세부 동작은 실제 실행 후 조정이 필요할 수
  있다.
- Electron 기본 프로세스 격리(contextIsolation+sandbox) 이상의 OS 수준 격리는
  없다 — Halo의 기존 "배포 판정"이 이미 밝힌 한계(외부 불변 감사, 백업/복구)가
  여기에도 그대로 적용된다.
- 개별 에이전트 액션 사이의 최소 간격(pacing floor)은 있지만(위 "후속
  업데이트 4"), 작업당 최대 액션 수·시간 예산 같은 전체 상한은 없다 —
  지금은 `startTask()`가 고정 2단계라 무한 루프 자체가 불가능해서 아직
  필요하지 않지만, 실제 멀티스텝 루프가 생기면 반드시 함께 추가해야 한다.
- `classify_provenance`/`host_provenance`는 이번에도 실제 독립 텔레메트리
  채널이 아니라 호스트가 설정하는 규칙 기반 판별이다(E007과 동일한 정직한
  한계) — 진짜 web content는 실제로 신뢰할 수 없는 소스이므로 프로세스
  경계는 real하지만, provenance 분류 자체의 정교함은 향후 과제다.
- `click`/`type`을 halo의 `read` 어휘로 매핑한 것은 근사치다 — 상태를
  바꾸는 클릭(구매·삭제·확인)과 무해한 클릭(링크 열기)을 구분하지 못한다.
  클릭 대상의 시맨틱(버튼 텍스트·aria-role)을 기반으로 한 세분화는 향후
  과제다.
- `submit_form`/`download`는 이 참조 구현에서 provenance와 무관하게 항상
  거부된다(위 표 참고) — REVIEW로 도달하는 경로가 아예 없다. 이건 버그가
  아니라 독립 실행 증거가 없는 상태에서의 의도된 보수적 선택이지만,
  "고위험 동작은 승인 대상"이라는 설계 문구를 "고위험 동작은 이 v1에서
  전면 차단"으로 정정해야 정확하다.
- Unix 소켓 1회용 채널을 루프로 재사용하는 데서 오는 짧은 재연결 창(위 참고).

## 참고 자료

- [ceLLMate: Sandboxing Browser AI Agents](https://arxiv.org/pdf/2512.12594)
- [Building Browser Agents: Architecture, Security, and Practical Solutions](https://arxiv.org/pdf/2511.19477)
- [AIRGuard: Guarding Agent Actions with Runtime Authority Control](https://arxiv.org/abs/2605.28914)
- [Agentic Browser Security: Indirect Prompt Injection in Perplexity Comet (Brave)](https://brave.com/blog/comet-prompt-injection/)
- [PerplexedBrowser: Perplexity's Agent Browser Can Leak Your Personal PC Local Files (Zenity)](https://labs.zenity.io/p/perplexedbrowser-perplexity-s-agent-browser-can-leak-your-personal-pc-local-files)
- [Continuously hardening ChatGPT Atlas against prompt injection attacks (OpenAI)](https://openai.com/index/hardening-atlas-against-prompt-injection/)
- [OpenAI says prompt injection may never be 'solved' for browser agents like Atlas (CyberScoop)](https://cyberscoop.com/openai-chatgpt-atlas-prompt-injection-browser-agent-security-update-head-of-preparedness/)
