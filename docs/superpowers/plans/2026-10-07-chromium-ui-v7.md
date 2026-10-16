# Halo for Chromium UI (Design System-7 시안) 적용 계획

시안: `/private/tmp/claude-501/-Users-songjiun-Halo/4e4a13a6-89fb-4a01-8fa5-fabd2115c2e9/scratchpad/ds7/Halo Chromium.html`
(보려면 `cd` 그 폴더 후 `python3 -m http.server 18765 --bind 127.0.0.1`, 브라우저로 `http://127.0.0.1:18765/Halo%20Chromium.html`.)
대상: Chromium 런타임도 `frontend/`(React)를 앱 창으로 띄우므로 Chromium 소스 수정이 아니라 `frontend/src` 개편이다.
시안의 CSS 토큰은 기존 `design-system.css`/`tokens.css`와 같다(`tokens/*`, `components.css`, `agents.css` 동일).

## 전역 제약
- 커밋하지 않는다. `frontend/`에 다른 미커밋 변경이 있으니 해당 슬라이스에 필요한 파일만 고친다.
- 기존 동작(작업 시작, 승인 시트, 에이전트 홈, 설정, 단축키, 접근성 `inert`/`aria`)을 유지한다. 새 API를 만들지 않고 기존 `store`/`window.haloBrowser`만 쓴다. 값이 없으면 빈 상태로 보여주고 가짜 데이터를 넣지 않는다.
- TypeScript(tsx). 확인: `cd frontend && npx tsc -b && npm test`.
- 시안 문구는 영어 그대로.

## 슬라이스
1. 홈(Viewport/HomeScreen): 검색창 + Search/Ask 토글, 아래에 Chats / Routines 탭, "All Chats" 링크, 카드 목록(시간, 제목, 한 줄 요약). Routines 비면 "No active routines / Let Halo handle the tasks you do on repeat." 데이터: 기존 작업 목록(`s.tasks`)과 `listRoutines`(workspace-api).
2. 왼쪽 사이드바(WorkspaceSidebar): Bookmarks / Agents / Chats / Tabs 섹션(접기 가능), 하단 프로필.
3. 오른쪽 에이전트 패널(HaloChat): 오버레이가 아니라 오른쪽에 도킹, 헤더에 대화 제목 드롭다운, 알약형 입력창, 하단 Local/Guard/Auto 선택.
4. 툴바: 시안의 주소창(`Tab | Ask` 토글, Halo 버튼) 정리.
