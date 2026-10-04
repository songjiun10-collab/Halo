# Planner Router v1 설계

상태: 2026-10-01 사용자 승인 (기본값 `"none"`).

## 배경

`b-nnett/grok-bot-0.18-reconstructed`의 Inference Router에서 두 아이디어만
참고했다: (1) 설정에서 고른 백엔드는 새 작업부터 적용, (2) provider별 사용량
기록. 그 저장소는 라이선스가 없는 비공식 재구성본이므로 코드·구조·문자열은
가져오지 않았고, 구현은 HALO의 기존 패턴(`HostSettingsStore`, `PlannerStdioAdapter`,
`usage-ledger`)으로 새로 작성한다.

## 범위

- v1 provider는 `claude_code` 하나. 목록 구조는 Codex/OpenRouter 추가를 위해 열어 둔다.
- 설정 화면 UI는 범위 밖(`frontend/**` 비수정 지시). 기존 `updateHostSettings` IPC 계약만 확장한다.
- MCP 도구 공유와 로컬 Docker 샌드박스는 후속 단계에서 별도 설계한다.

## 설계

1. **Provider 목록** (`main/harness/planner-providers.js`): 호스트가 고정한 frozen
   목록. 항목은 `id`, worker 진입점(앱 루트 기준 상대 경로), 사용량 provider 이름.
   UI·페이지·모델은 id만 고를 수 있고 명령·경로·인자를 넘길 수 없다.
2. **설정 v3** (`host-settings.js`): `plannerProvider` 필드 추가(`"none"` 또는 목록 id,
   기본 `"none"`). v2 파일은 필드 집합이 정확히 맞을 때만 v3로 이전하고, v1은
   기존처럼 이전한다. 다른 형태는 거부한다(fail-closed).
3. **작업 시작 시 고정**: TaskHost가 `plannerEffort`처럼 현재 provider를 들고 있다가
   `makePlanner(taskId, { role, plannerProvider })`로 넘긴다. `makePlanner`는 작업마다
   한 번 호출되고 컨텍스트 리셋은 adapter 내부에서 처리되므로, 설정이 바뀌어도
   진행 중인 작업의 planner는 바뀌지 않는다. 자식 에이전트는 생성 시점의 값을 쓴다.
4. **우선순위** (`resolvePlannerLaunch`):
   1) `HALO_PLANNER_COMMAND`/`HALO_PLANNER_ARGS` 운영자 지정(기존 동작 그대로),
   2) 설정의 `plannerProvider`(목록의 worker를 검증된 node 명령으로 실행),
   3) `"none"`이면 명령 없음 → 기존 `planner_unavailable` 정지.
5. **사용량**: 설정 경로로 띄운 worker의 사용량은 목록의 provider 이름과 일치할 때만
   기록한다. 운영자 지정 경로는 기존 동작을 유지한다.

## 시험

- 목록 frozen, 알 수 없는 id 거부, 경로가 앱 내부 고정 파일인지.
- v2→v3 정확 이전, 이상한 v2 거부, v1→v3 이전, 패치에 알 수 없는 provider 거부.
- 환경변수 > 설정 > none 우선순위.
- 작업 중 설정 변경이 진행 중 작업의 planner에 영향 없음, 새 작업에는 반영.
- 실제 `claude` 프로세스는 띄우지 않는다.
