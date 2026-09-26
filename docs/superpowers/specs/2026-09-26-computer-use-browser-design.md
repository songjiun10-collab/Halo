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
  page: { url, title, loadState, canGoBack, canGoForward, hasPage },
  task: { id, state },   // state: idle|running|awaiting_approval|paused|stopped|completed|error
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

## 정직한 한계

- 이 문서 작성 시점까지 Electron 앱을 실제로 빌드·실행해 검증하지 않았다 —
  CDP(`webContents.debugger`) 관련 세부 동작은 실제 실행 후 조정이 필요할 수
  있다.
- Electron 기본 프로세스 격리(contextIsolation+sandbox) 이상의 OS 수준 격리는
  없다 — Halo의 기존 "배포 판정"이 이미 밝힌 한계(외부 불변 감사, 백업/복구)가
  여기에도 그대로 적용된다.
- 에이전트 루프 자체의 폭주(무한 루프, 과도한 요청 빈도)에 대한 rate
  limit·리소스 상한은 아직 설계에 없다.
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
