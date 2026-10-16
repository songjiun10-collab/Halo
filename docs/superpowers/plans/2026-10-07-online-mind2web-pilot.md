# Online-Mind2Web + Halo + Luna 실제 파일럿

## 고정 조건

공식 `osunlp/Online-Mind2Web` 데이터의 읽기 전용 5개를 미리 선택했다. 전체 300개를 대표하는 표본이 아니며, 하네스 미사용 baseline이나 Aside와 동일 조건의 비교가 아니다.

- 데이터 SHA-256: `7dedf381531d423dc0fc48d21dc1d425655dd75f38b10211a880fa09102f257f`
- 모델: `gpt-6-luna`, medium effort. 실제 로그인된 Codex CLI 사용.
- Halo: 실제 TaskController, BrowserAdapter, TaskStore, browse 권한, Middle profile.
- Chromium: 로컬 headless_shell, 작업별 새 private profile, 1440×900.
- 동시 작업 1개, 작업별 controller active-time 상한 180초, 호출 25회, 행동 50회.
- 지정된 원래 사이트에서 시작. 원본 작업 지시를 바꾸지 않았다.
- 승인자는 navigate/follow_link/scroll/observe/record_evidence만 허용한다. 다른 제안은 사람 검토로 보내며 자동 승인하지 않는다. 이 제한 때문에 일반 벤치의 범용 클릭·입력 조건과 다르다.
- 캡차·접근 차단을 우회하지 않는다. 루나가 결과를 주장해도 호스트가 성공으로 선언하지 않는다.

## 실제 실행 결과

2026-10-07, `/Users/songjiun/Downloads/halo-online-mind2web-PsIMbZ/summary.json`에 저장했다.

| 공식 작업 | 시간 | Planner 호출 | 종료 상태 |
| --- | ---: | ---: | --- |
| FlightAware AeroAPI 비교 | 49.36초 | 3 | paused / need_user |
| Discogs 등록 안내 | 58.14초 | 2 | paused / need_user |
| IGN Zelda 공략 | 77.25초 | 7 | awaiting_verification |
| MTA Brooklyn 지도 | 31.87초 | 2 | paused / need_user |
| Apple 최신 MacBook Air 사양 | 47.88초 | 4 | paused / need_user |

총 task wall time 264.496초, 호출 시도 18회, 실제 usage가 반환된 응답 17회. 반환된 usage 합계는 입력 302,586 / 출력 3,355 토큰이다. 입력 토큰은 provider 보고값 그대로이며 cached input을 추가로 합산하지 않는다. provider의 costUsd=0은 무료 실행을 증명하지 않는다.

FlightAware·Apple은 모델이 공개 정보 요약을 need_user로 반환했다. Discogs·MTA는 모델이 HTTP 403을 보고하며 중단했다. 저장된 이미지도 직접 확인했다: Discogs는 Cloudflare 사람 확인 화면, MTA는 Access Denied 화면이다. 이는 판정이 아니라 진단이다. IGN의 마지막 스크린샷에는 공략 페이지와 개인정보 동의 오버레이가 함께 보인다. 확인 대기 상태를 성공으로 계산하지 않았다.

## 증거와 한계

17개의 pre-action PNG가 각 실제 행동 기록과 연결됐고 파일 존재를 모두 검사했다. 초기 지정 URL 이동은 bootstrapActions=1로 따로 기록하며 controller budget에 넣지 않는다. stale_document 취소도 원래 상태로 기록했다.

각 작업의 `result.json`, `steps.jsonl`, `trajectory/*.png`, `run.json`, 실제 Halo store를 로컬에 보존한다. result.json은 v2 형태의 초안 내보내기이며 공식 validator 검증·제출·WebJudge 채점은 하지 않았다. `graded=false`, `success=null`이다. 모델 finish는 factual browser action에 추가하지 않는다. 모델 최종 요약을 내보내는 별도 계약은 아직 없어서 agent_final_answer는 빈 문자열이다. 최종 answer와 terminal screenshot 보완 전에는 정식 제출용 artifact라고 부르지 않는다.

RSS는 runner 프로세스의 turn-boundary sample만 기록하며 Chromium·worker를 제외한다. 전체 메모리 상한 준수 또는 실제 peak RSS 증거로 쓰지 않는다. wall time은 초기 브라우저 생성·bootstrap을 포함하지만 teardown을 제외한다. 전체 회귀 검사와 동시에 실행했으므로 순수 latency baseline으로 쓰지 않는다.

## 재현 및 검증

`apps/computer-browser`에서 `node integration/online-mind2web-pilot.ts /Users/songjiun/Downloads/Online_Mind2Web.json`을 실행한다. 매 실행마다 새로운 Downloads 하위 디렉터리를 만들어 기존 결과를 덮어쓰지 않는다. 외부 업로드·점수 제출은 없다.

새 회귀 테스트 3개와 standalone TypeScript strict 검사가 통과했다. 전체 회귀 검사는 진행 중이며 `cdp-engine.test.js`의 `AgentViewportHost builds Chromium pages when the engine is on and Electron ones when it is off`가 약 30초 뒤 실패했다. 라이브 파일럿 종료 후 같은 테스트만 다시 실행하면 23.207초에 통과했다. 동시 부하 관련 가능성은 있으나 원인이 확정된 것은 아니다. 원래 전체 run을 green으로 주장하지 않는다.

`renderer-lifecycle.test.js`의 `real Chromium: BrowserAdapter survives freeze and discard; old observations go stale; cookies stay`도 실패했다. 단독 재검사에서도 첫 `observe()` (test line 176)에서 `cdp_error: Cannot find context with specified id` / `observe_failed`로 재현됐다. 기존 런타임 파일은 이번 벤치 작업에서 수정하지 않았으며 이 문제는 미해결이다.

독립 리뷰 에이전트는 모델 라우팅 오류로 시작하지 못했다. 커밋·푸시는 하지 않았다.
