# Halo 에이전트 생태계 도입 후보 (2026-10-08)

목적: Halo의 browser computer-use와 플러그인/스킬 생태계에 실제 도입할 외부 프로젝트를
한 곳에 모아, 도입 형태·보안 영향·필요 작업·순서를 기록한다. 결론이 아니라 **입력 목록**이며,
구현은 아래 "게이트"가 풀린 뒤 별도 승인 하에 진행한다.

## 후보 요약

| # | 프로젝트 | 소속/라이선스 | 규모 | 층 | Halo 접점 |
|---|---|---|---|---|---|
| 1 | [alibaba/page-agent](https://github.com/alibaba/page-agent) | Alibaba / MIT | ★29.3k · TS · v1.12.4 | in-page GUI 에이전트 | DOM-first computer-use 관측·프롬프트 |
| 2 | [morluto/rea](https://github.com/morluto/rea) | morluto / MIT | 포크 2.0k · TS · v6.0.0 | 역공학 MCP/CLI | MCP 도구·스킬로 바이너리/Electron/웹 분석 |
| 3 | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | Anthropic / Apache-2.0 | 포크 3.2k · Python(md+json) | 플러그인/스킬 포맷 | Halo 플러그인·스킬·MCP 커넥터 포맷 |
| 4 | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | DietrichGebert / MIT | ★158k · JS · v5.0.0 | 에이전트 스킬(프롬프트) | dev 워크플로 스킬 + 크로스 에이전트 패키징 |

층 구분: 1·2는 **능력(capability)**, 3·4는 **생태계/포맷(ecosystem)**. 2는 둘 다.

## 1. PageAgent — 도입 형태 확정 필요

- 무엇: 스크립트 하나로 웹페이지에 AI 에이전트를 심는 in-page JS GUI 에이전트. 텍스트 기반
  DOM 조작(스크린샷 불필요), BYO LLM, 선택적 Chrome 확장(멀티페이지), MCP Server(Beta).
  browser-use의 DOM 처리·프롬프트 계승(MIT 출처 표기 필요). CONTRIBUTING: 전적 AI 생성 기여 거부.
- Halo 접점: `agent-viewport-host.captureTextObservation`/`screen-map`(DOM-first 경로)과 직접 비교.
- **보안 충돌(반드시 해결)**: PageAgent는 LLM 호출과 API 키를 **페이지 컨텍스트**에 둔다.
  Halo는 키를 호스트에 두고 승인·감사로 통제한다. 그대로 넣으면 페이지가 키를 읽거나
  프롬프트 인젝션으로 에이전트를 조종할 수 있다. 도입 시 LLM 호출을 **호스트 프록시**로
  바꾸고 페이지에는 키를 넘기지 않는 설계가 전제.
- 도입 후보 형태(사용자 선택: "다" — A/B/C/D 전부):
  - A) 텍스트-DOM 기법 흡수(호스트 통제 유지) — 안전, 우선
  - B) 페이지 주입형 코파일럿 기능 — 호스트 LLM 프록시 전제, 별도 설계
  - C) 에이전트 루프 교체 — 승인·효과검증·증거·epoch 계약 상실, **비권장**
  - D) 동일 작업셋 벤치마크로 비교 측정 — 되돌리기 쉬움, 먼저
- 필요 작업: D→A 순서로 측정·이식, B는 별도 ADR+보안 리뷰, C는 보류.

## 2. REA — MCP 도구로 도입

- 무엇: 로컬에서 바이너리/JS·Electron/.NET/웹사이트/APK/펌웨어/프로세스 행동을 분석하는
  MCP 서버 + CLI(`npx rea-agents setup`). 결과에 증거·한계 포함. 네이티브는 Hopper/Ghidra/IDA
  사용(설치 승인), 정적 JS/.NET은 엔진 불필요.
- Halo 접점: Halo의 MCP 브로커(`generic-mcp-broker`, 사람 승인 필수) 뒤에 REA MCP를 연결하고,
  Halo 스킬로 "기능 역설계" 워크플로 제공. 브라우저 저장소 관점에선 **웹사이트/Electron/
  네트워크 캡처 분석**이 가장 직접적.
- 보안/리스크: REA는 로컬에서 앱을 **실행·상호작용**할 수 있고(Hopper 자동 실행, 프로세스 캡처)
  강력한 도구다. Halo에 붙일 때 (a) MCP 승인 큐를 반드시 경유, (b) 네이티브 provider 자동
  설치는 opt-in, (c) 분석 대상 경로를 사용자 확인으로 한정, (d) 결과를 신뢰 경계 밖 데이터로 표기.
- 필요 작업: MCP 등록 방식 확정(외부 프로세스 vs in-process), 스킬 문서, 승인 정책 테스트.

## 3. knowledge-work-plugins — 포맷/마켓플레이스 레퍼런스

- 무엇: Anthropic의 업무 역할별 플러그인 11종. 파일 기반(코드/빌드 없음):
  `.claude-plugin/plugin.json` + `.mcp.json` + `commands/`(슬래시) + `skills/`(자동 발동).
- Halo 접점: Halo의 `contracts/HALO-SKILLS-PLUGINS.md`, `main/harness/skill-library.js`,
  `mcpProviders` 설정. 이 포맷을 Halo 플러그인 포맷의 기준으로 삼아 **호환/차용 범위**를 정한다.
- 보안/리스크: 순수 md+json이라 코드 실행 위험은 낮다. 위험은 **MCP 커넥터 카탈로그**가
  외부 도구 연결을 넓히는 것 → Halo의 MCP 승인·스키마 검증 경로를 그대로 태운다.
- 필요 작업: Halo 플러그인 스키마 확정(매니페스트/커맨드/스킬/커넥터), 서명·검증 정책,
  마켓플레이스 설치 UX.

## 4. Ponytail — dev 워크플로 스킬 + 크로스 에이전트 패키징

- 무엇: "가장 게으른 시니어 개발자"처럼 사고하게 하는 에이전트 스킬. 핵심은 프롬프트 하나
  (`skills/ponytail/SKILL.md`, 축약 `AGENTS.md`). 명령 `/ponytail-review|audit|debt|gain|help`,
  라이프사이클 훅(JS), ~20개 에이전트 어댑터. 벤치: 코드 -53%·시간 -41%·비용 -26%·토큰 -45%,
  위험 로직 98% 테스트, 보안 6종 30/30(주장 — Halo 자체 측정 필요).
- Halo 접점: (a) 개발 워크플로 스킬로 Halo 레포 리뷰에 사용, (b) 크로스 에이전트 패키징
  (`.claude-plugin`/`.codex-plugin`/`.opencode`/`plugin.json` 등)이 3번 포맷 설계의 실증 사례.
- 보안/리스크: 훅이 에이전트 라이프사이클에서 **JS를 실행**하므로 공급망 신뢰가 필요하다.
  공식 저장소/ npm `@dietrichgebert/ponytail` 외 복사본은 금지(README 명시). Halo 제품 런타임이
  아니라 **개발/플러그인 층**에만 둔다.
- 필요 작업: 파일럿 적용 후 Halo 자체 벤치(코드량/토큰/테스트 커버리지)로 주장 검증.

## 권장 순서

1. **D(측정)**: PageAgent 텍스트-DOM vs Halo DOM-first를 동일 작업셋으로 비교 → A/B/C 결정 근거.
2. **3→4(포맷)**: knowledge-work-plugins 포맷을 기준으로 Ponytail의 크로스 에이전트 패키징을
   참고해 Halo 플러그인 스키마를 확정. Ponytail은 개발 워크플로에 파일럿.
3. **1A(이식)**: 호스트 통제를 유지한 채 텍스트-DOM 기법을 Halo 경로에 이식.
4. **2(MCP)**: REA를 MCP 브로커 뒤에 연결(승인·스키마·경로 한정).
5. **1B(주입형)**: 별도 ADR + 보안 리뷰(호스트 LLM 프록시 전제) 후에만. 1C는 보류.

## 게이트 (진행 전 필수)

- **작업 트리 고정**: 다른 opencode 세션이 같은 파일을 편집/재생성 중이었다. 고정 후 진행.
- **미완료 보안 항목 우선**: C1(무인증 CDP 포트→파이프)·C2(argv 브리지 토큰)가 상용 배포 전 필수.
  도입 작업이 이 둘과 같은 파일을 건드리므로 순서를 앞에 둔다.
- **각 도입은 보안 리뷰 통과**: 특히 1(페이지 컨텍스트 키), 2(로컬 실행 도구), 4(훅 JS 실행).
- **측정 우선**: 4번의 벤치 주장과 1번의 관측 품질은 Halo 자체 측정으로 검증한다.

## 진행 기록 (2026-10-08 · PageAgent → browser-use)

- **슬라이스 1 완료(라이브 트리, 신규 파일)**: `main/harness/dom-outline.js` +
  `test/dom-outline.test.js`. PageAgent 관측 포맷(`[elementId]` 인덱스, `*` 신규 요소,
  depth 들여쓰기, scrollable 거리)을 Halo 모델로 이식한 순수 포매터. 8/8 통과.
  페이지 실행·정책·게이트 변경 없음.
- **슬라이스 3 완료(라이브 적용)**: 클릭 충실도 — `.click()` 앞에 W3C 순서
  pointer/mouse 시퀀스 추가. 활성화는 기존 단일 `.click()` 유지, 게이트·효과검증 불변.
  출처: PageAgent(MIT). 패치 기록:
  `docs/references/2026-10-08-pageagent-slice3-pointer-click.patch` (적용 완료).
- **슬라이스 2 완료(라이브)**: `browser-adapter.js` 관측 스냅샷이 각 요소에 `depth`
  (parentIndex 체인, 0~12)와 `scrollable`(up/down/left/right px, 0이면 생략)을 싣는다.
  읽기 전용 — 검증·게이트·승인에 쓰이지 않음.
- **슬라이스 4 완료(라이브)**: `agent-viewport-host.captureTextObservation`이
  `buildDomOutline`으로 텍스트 관측을 만든다(기존 `screen-map`은 좌표 hit-test
  `resolveTarget`과 화면 타깃 경로에 그대로 유지). `targets` 형태가 동일해 소비자 계약 불변.
- **검증**: `HALO_DESKTOP_RUNTIME=chromium node --test` 로 dom-outline·browser-adapter·
  agent-viewport-host·text-computer-use·browser-interactions·child-agent-coordinator
  **192/192 통과**. 관측/상호작용 스크립트는 `new Function`으로 문법 파싱 확인.
  `build:runtime --check` exit 0.
- **e2e 미검증(환경)**: 머신 부하로 Chromium 기동이 30s를 넘겨 `startup_timeout` —
  수정되지 않은 원본 트리에서도 동일 재현. 조용할 때 `HALO_CHROMIUM=… node --test
  test/cdp-web-contents.test.js`로 재검증 필요(포인터 시퀀스가 실제 페이지에서
  pointerdown/mousedown 리스너를 발화시키는지).
- 게이트 유지: 다른 세션이 계속 편집/재생성 중.
