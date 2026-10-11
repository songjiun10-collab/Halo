# 보안 리뷰 및 조치 — Halo + Chromium (2026-10-07)

범위: `/Users/songjiun/Halo`의 데스크톱 런타임(Electron/Chromium), preload·IPC 경계,
승인·권한 게이트, 자격증명·세션 저장소, 프로파일 임포트, MCP 브로커, 프로바이더
브리지, Python 게이트웨이/정책, 배포 설정. `/Users/songjiun/chromium`.

기준: 리뷰 시점 HEAD `e2ad6fe` + 미커밋 변경. 아래 "검증"의 결과는 이 체크아웃에서
직접 실행한 값이며, 과거 문서의 수치를 인용하지 않는다. 테스트 통과는 보안 판정과
별개다(저장소 기존 규율 유지).

## Chromium 저장소 사실

- `~/chromium/src`는 upstream `32ecd686f2`(Chrome 157) clean 체크아웃이다.
- `halo` 브랜치는 존재하나 base와 **커밋 차이 0**, `apps/computer-browser/chromium-patches/`는
  비어 있다. 리뷰할 Halo 패치가 없다.
- 따라서 이번 "Chromium 리뷰"는 Halo가 Chromium을 띄우는 방식(런치 플래그/프로세스
  모델)에 한정된다. 포크가 시작되면 `git format-patch` 산출물을 같은 형식으로 리뷰한다.

## 발견 사항과 조치

| # | 심각도 | 발견 | 조치 | 상태 |
|---|---|---|---|---|
| F1 | Medium | `runHwStep`(Halowright)이 `sendInputEvent`/`insertText`로 입력을 직접 보내는 저수준 프리미티브인데, 승인·효과 게이트를 강제하는 장치가 없어 향후 `hw_step`을 직결하면 우회 가능 | `authorize` 호출을 **필수**로 만들고, 해석된 타깃으로 게이트를 호출한 뒤 `true`일 때만 입력. 누락/거짓/예외는 입력 전 fail-closed(`authorization_required`/`not_authorized`) | 수정 |
| F2 | Low | Chromium 런타임은 `senderFrame`을 창의 `mainFrame`으로 합성해 `isTrustedSender`의 frame-identity 절이 no-op | `chromium-desktop`에 `trustedUiOrigin` 바인딩 전 호출 거부(`untrusted_sender`) 추가, `trusted-sender`에 런타임별 신뢰 근거 주석 | 수정 |
| F3 | Low | 에이전트 브라우저 공용 `LEAN_FLAGS`에 `--disable-ipc-flooding-protection`, `--disable-popup-blocking` 추가로 방어심층 약화 | 두 플래그 제거. 자동화 의미론에 필요한 나머지(백그라운드 스로틀 해제·hover/포인터 스푸핑·autoplay)는 유지하고 이유 주석 | 수정 |
| F4 | Info | renderer bridge 쿠키가 host 스코프(포트 무시)라 127.0.0.1의 여러 창이 `halo_renderer`를 공유 | 쿠키 이름을 브리지별 랜덤(`halo_renderer_<hex>`)으로, 쿠키 토큰·capability 비교를 `timingSafeEqual`로 | 수정 |
| F5 | Info | Chromium 포크 패치 없음 | 문서화(위). 패치 발생 시 리뷰 게이트 | 문서 |
| F6 | Info | 의존성 CVE 미검증 | `npm audit` 실행. computer-browser(dev 포함) 0건. frontend에서 `source-map-js@1.2.1`(vite→postcss 경유, 빌드타임) high 1건 → lockfile만 `1.2.2`로 갱신 | 수정 |

## 검증

```
apps/computer-browser/node tools/build-runtime.js          # TS -> 생성 JS
apps/computer-browser/node tools/build-runtime.js --check  # 동기화 확인 (exit 0)
apps/computer-browser/node --test \
  test/halowright.test.js test/effect-verifier.test.js test/chromium-desktop.test.js \
  test/cdp-browser-host.test.js test/trusted-sender.test.js test/harness-ipc.test.js
  → 57 passed / 0 failed
Halo/.venv/bin/python -m pytest tests/test_url_query_secret_scan.py experiments/test_security_regressions.py -q
  → 58 passed
apps/computer-browser/npm audit (dev 포함)            → 0 vulnerabilities
frontend/npm audit                                    → source-map-js 1건 (fix 후 0)
```

F6 상세: `frontend`의 `vite@8.3.1 → postcss@8.5.28 → source-map-js@1.2.1`이
GHSA-68fv-2mgg-jv7q(빌드타임 DoS)에 해당. `npm audit fix --package-lock-only`로
lockfile만 `1.2.2`로 갱신(런타임 번들에는 포함되지 않음). `frontend/node_modules`는
다음 `npm install` 시 반영된다. `renderer/dist`는 재생성하지 않았다(불필요한 산출물 churn
방지) — 다음 프론트엔드 빌드 때 정상 재생성된다.

F1 회귀: 승인 콜백 누락 → 입력 0회, 거부/예외 → 입력 0회, 승인 시 게이트가 해석된
타깃(`{x,y,tag}`)을 받고 입력 전에 호출됨을 테스트로 고정했다.

주의: 위 `node --test`에서 `test/halowright-locator.test.js`는 실제 Chromium 기동이
필요해 이 환경에서 `startup_timeout`으로 실패한다(보안 결함 아님, 환경 의존). 위 57은
해당 파일을 제외한 선택 실행 결과다.

## 잘 방어된 부분(회귀 유지 대상)

- Python 게이트웨이: role-separated HMAC, 요청별 `BEGIN IMMEDIATE`, clock-rollback 탐지,
  DB 밖 realm secret, fail-closed 403/503, 스택트레이스 미노출.
- Electron: 모든 webPreferences `sandbox+contextIsolation+nodeIntegration:false`, preload
  고정 allowlist, `ipc.js` sender 재검증, navigation/download/permission deny, 렌더러에
  `dangerouslySetInnerHTML`/`innerHTML` 없음.
- 저장소 계층 전반: `O_NOFOLLOW`, 0600/0700, 원자적 rename, 심링크 거부, OS 암호화,
  스키마 검증. 프로파일 임포트: allowlist + registrable-domain(public suffix) 규칙.
- MCP 브로커: 사람 승인 필수, 스키마는 리소스 제한 worker 검증, `$ref` 거부, dispatch 시
  capability 소비·context drift 재확인. Slack: HMAC·freshness·allowlist·rate limit·replay.

## 남은/열린 항목

- 플래너 worker의 OS 격리는 policy isolation이지 OS 샌드박스가 아니다(기존 문서 유지).
- 외부 감사·복구 절차 미완료(기존 문서 유지).
- F6 의존성 CVE: `npm audit` 결과 기록 완료. lockfile 변경분은 커밋 시 함께 반영한다.

## 상용 브라우저 심층 리뷰 (2차, 2026-10-07)

공격자 모델을 로컬 프로세스·공급망·렌더러 탈취까지 넓힌 결과. **핵심 판단:** 페이지·모델에
대한 경계는 강하지만, **동일 사용자 로컬 프로세스**에 대한 경계가 상용 기준에 못 미친다.
로컬 프로세스는 데스크톱 브라우저의 실제 위협 모델이다(멀웨어, 타 앱, 브라우저/IDE 확장).

| # | 심각도 | 발견 | 근거 | 영향 | 조치 |
|---|---|---|---|---|---|
| C1 | High | **무인증 CDP 원격 디버깅 포트**를 에이전트·UI 모든 브라우저에 개방 | `cdp-browser-host` `--remote-debugging-port=0`+`--remote-debugging-address=127.0.0.1`; `connectCdpTransport`는 인증 없음; `chromium-desktop` UI도 `acquireCdpBrowser` 사용 | 같은 사용자 로컬 프로세스가 `/json`으로 WS를 얻어 브라우저 완전 제어: 네비게이션·`Runtime.evaluate`·전 쿠키 열람(임포트 세션 복호화 상태). UI 브라우저면 브리지까지 | `--remote-debugging-pipe`(fd 3/4, 네트워크 노출 없음) 또는 0600 Unix 소켓으로 전환. 디버그 포트를 배포에 열지 않는다 |
| C2 | High | **브리지 부트스트랩 토큰이 `--app=` argv에 노출** | `chromium-bridge`가 `url=/bootstrap/<cookieToken>` 반환 → `chromium-desktop` → `--app=<url>` | `ps`로 origin+토큰이 보임 → 로컬 프로세스가 부트스트랩→쿠키→`/halo-bridge.js`(capability)→`/rpc`로 **모든 `halo:*` 특권 채널 호출**(setApiKey·fillCredential·설정 등). 쿠키/capability/Origin 검사가 무력화 | 토큰을 argv에서 제거. target을 `about:blank`로 만들고 CDP `Network.setCookie`(호스트 측)로 쿠키 설치 후 `Page.navigate(origin)`. `/bootstrap/<token>` 라우트 삭제 |
| C3 | High | **`chromiumPath` 설정이 임의 실행 파일 spawn** | `host-settings` 검증은 절대경로/길이/NUL만; `cdp-engine`→`launchBrowser`→`spawn(executablePath, flags)`. 설정은 `halo:updateHostSettings`로 쓰임 | 렌더러 탈취/C2 공격자/기만된 사용자가 임의 실행 파일 경로 지정 → 임의 코드 실행 | 알려진 Chromium 번들로 제한(베이스명 allowlist + macOS `.app/Contents/MacOS/` + 서명/bundle-id), 또는 네이티브 파일 선택기+검증. 사용자 문자열을 그대로 spawn 금지 |
| C4 | High | **레거시 브라우징 표면(ControlApi 탭) 하드닝 누락 + UI와 기본 세션 공유** | `control-api._buildTabView`는 sandbox+contextIsolation만; `setWindowOpenHandler`/`setPermissionRequestHandler`/`will-navigate`/`will-download` **전무**, partition 없음. UI 창도 partition 없음(기본 세션 공유). 에이전트 뷰·UI 창은 하드닝됨 | 임의 웹페이지를 렌더하는 사용자 표면이 Electron 기본값에 의존: 팝업 허용, 권한 명시 거부 없음, 다운로드 허용, 비 http(s) 네비게이션 제한 없음 | 모든 web-contents에 명시 핸들러 설치(제품 정책에 따라 deny/프롬프트). 누락 방지를 위해 `app.on('web-contents-created')` 전역 default-deny 권장, 브라우징 표면은 별도 partition |
| C5 | Medium | 배포 브라우저가 `headless_shell`/component build | `cdp-browser-host`가 `out/Trial/headless_shell` 우선; Trial은 component build | 테스트 타깃·미서명·업데이트 채널 없음·Safe Browsing 없음 → 상용 배포 부적합 | release·non-component·서명·노타라이즈 빌드와 업데이트 채널 |
| C6 | Medium | **업데이트/코드사이닝 메커니즘 부재** | autoUpdater/Sparkle/notarization 코드 없음 | 보안 패치 배포 수단 없음 | 서명 업데이트(Squirrel/Sparkle) + 노타라이즈 + 버전 관리 |
| C7 | Medium | 권한 모델 비대칭: Electron은 default-deny, Chromium(CDP)은 이름 denylist | Electron `callback(false)` vs `DENIED_PERMISSIONS` | CDP에는 deny-all이 없어 누락 이름이 생길 수 있음 | **denylist 대폭 확장(반영함)**, Chromium 업그레이드마다 PermissionType 대조. 근본적으로 CDP deny-all 수단 검토 |
| C8 | Medium | 데스크톱 UI 브라우저가 **임의 unpacked 확장 로드** | `chromium-desktop` `installedExtensions`→`--load-extension`(브리지를 쥔 브라우저에서) | `<userData>/chromium-extensions/`에 놓인 악성 확장이 전체 확장 권한·백그라운드 스크립트로 실행 | 서명/권한 검토, 최초 로드 경고, 브리지 브라우저와 확장 브라우저 분리, 서명 allowlist |
| C9 | Low | `HALO_IN_PROCESS_GPU=1`로 GPU 프로세스 병합 | `main/index.js` `in-process-gpu` | 샌드박스 약화(환경변수 게이트, 기본 꺼짐) | 개발 빌드 전용으로 제한 |
| C10 | Low | `fillCredential`이 `approved:true` 하드코딩 | `task-host.fillCredential` | 어떤 IPC 호출자(예: C2)도 현재 origin에 자동입력 트리거 가능(origin 일치만 게이트) | 요청에 묶인 명시적 승인/제스처 요구 |
| C11 | Low | Dockerfile에 dev 툴링 + 비고정 3자 설치를 프로덕션 이미지에 포함 | `Dockerfile` `npm i -g @anthropic-ai/claude-code`, `git clone --depth 1`(3자 repo), unpinned pip | 공급망·공격면 확대(게이트웨이도 같은 이미지) | dev 이미지 분리, 커밋/hash 고정, 게이트웨이 이미지 최소화 |

**검증(2차):**
```
node tools/build-runtime.js --check                 → exit 0
node --test browser-adapter browser-interactions text-computer-use \
  child-agent-coordinator message-port agent-viewport-host main-entrypoint-lifecycle
  → 218 passed / 0 failed
```
C7만 이번에 반영(denylist 확장). C1·C2·C3·C4는 구조 변경/제품 결정이 필요해 조치 전이며,
**상용 배포 전 필수**로 표시한다. C1·C2는 서로 독립적인 로컬 코드실행/세션탈취 경로다.

## C1+C2 구현 계획 (트리 고정 후 착수)

착수 조건: 동시 편집 프로세스가 멈추거나, 미커밋 병렬 작업이 커밋/스태시되어 작업 트리가
고정될 것. (참고: 작성 시점에 다른 프로세스가 `cdp-browser-host.ts`/`chromium-desktop.ts`와
생성 JS를 동시에 편집·재생성 중이었고, 충돌을 피해 이번 편집은 되돌렸다.)

**C1 — CDP를 TCP 포트에서 파이프로**
- `cdp-browser-host.ts`: `--remote-debugging-port=0`+`--remote-debugging-address` 제거,
  `--remote-debugging-pipe` 추가. `launchBrowser`의 `spawn` stdio를
  `["ignore","ignore","ignore","pipe","pipe"]`로(자식 fd3=명령, fd4=응답), `stderr`는
  `"ignore"`로 두어 역압 차단. 핸들에 `pipe` 노출(`wsUrl`은 attach 모드 전용 optional).
  `pid`/`launchedAt`/프로파일 정리는 그대로 보존.
- `cdp-web-contents.ts`: `connectCdpPipe(pipe, timeout)` 추가 — NUL 종료 JSON 프레이밍,
  `Browser.getVersion`으로 준비 확인(파이프 모드엔 "DevTools listening" stderr가 없음).
  `connectCdpBrowser(handle)`로 pipe/ws 선택. `openCdpView`는 handle도 받게 확장.
- `cdp-engine.ts`·`chromium-desktop.ts`: `browser.pipe ? connectCdpPipe : connectCdpTransport`.
  `endpoint` attach 경로는 WS 유지(사용자가 직접 띄운 브라우저).

**C2 — 부트스트랩 토큰을 argv에서 제거**
- `chromium-bridge.ts`: `start()`가 `{ origin, url: `${origin}/` }` 반환(토큰 없음),
  `authCookie()` 추가, `/bootstrap/<cookieToken>` 라우트 삭제.
- `chromium-desktop.ts` `openUi`: attach 후 `Network.setCookie`(HttpOnly, SameSite=Strict,
  host 127.0.0.1)로 브리지 쿠키를 심고 `Page.navigate(origin)` — 이때 `--app=`에는 토큰이 없다.
  `chromium-ui-guard`의 Document Fetch 가드와 순서 확인 필요.

**갱신 대상(호출/테스트)**: `cdp-web-contents.test.js`(3), `chromium-renderer-e2e.test.js`,
`human-scroll.test.js`, `cdp-isolated-world-lifecycle.test.js`, `accuracy-harness.test.js`의
`.wsUrl` 사용부 → `connectCdpBrowser(handle)`/`openCdpView(handle)`; `cdp-browser-host.test.js`
플래그 단언; `chromium-desktop.test.js` 부트스트랩 → `authCookie()`.

**검증**: `build:runtime`(write)+`--check`; `HALO_CHROMIUM=…/headless_shell`로 실제 CDP 테스트
(`cdp-web-contents`, `cdp-engine`, `renderer-lifecycle`, `cdp-isolated-world-lifecycle`)와
`halowright`/`effect-verifier`/`chromium-desktop`/`trusted-sender`/`harness-ipc` 실행. 파이프
경로는 실제 브라우저 통합 테스트로만 보증된다.
