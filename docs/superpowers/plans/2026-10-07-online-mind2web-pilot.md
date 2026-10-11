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

원본 결과는 평가기 채점을 하지 않아 `graded=false`, `success=null`로 남아 있다. 이후 저장된 최종 화면을 과제 문구와 직접 대조해 별도의 수동 증거 판정을 했다. Apple은 현재 MacBook Air의 Tech Specs 화면, IGN은 해당 게임의 Walkthrough 본문이 보여 **2개 완료로 수동 확인**했다. IGN의 개인정보 동의 오버레이는 남았지만 요청한 공략 페이지와 본문은 이미 보인다. Discogs는 Cloudflare 사람 확인 화면, MTA는 Access Denied 화면이어서 **2개 미완료**다. FlightAware는 비교 요약이 로그에 일부만 기록되고 마지막 이미지에도 요금제 근거가 없어 **1개 판정 보류**다. 따라서 이 5개 파일럿의 수동 판정은 완료 2/5, 미완료 2/5, 보류 1/5다. 보류를 제외한 확인된 비율은 2/4이며, 보류를 실패로 놓는 보수적 자체 점수만 2/5(40%)다. 이는 공식 WebJudge/benchmark 점수도, 전체 데이터 성능 추정치도 아니다. 근거별 설명은 결과 디렉터리의 `manual-review.md`에 있다.

## 증거와 한계

17개의 pre-action PNG가 각 실제 행동 기록과 연결됐고 파일 존재를 모두 검사했다. 초기 지정 URL 이동은 bootstrapActions=1로 따로 기록하며 controller budget에 넣지 않는다. stale_document 취소도 원래 상태로 기록했다.

각 작업의 `result.json`, `steps.jsonl`, `trajectory/*.png`, `run.json`, 실제 Halo store를 로컬에 보존한다. result.json은 v2 형태의 초안 내보내기이며 공식 validator 검증·제출·WebJudge 채점은 하지 않았다. 원본 `graded=false`, `success=null`은 공식 채점 없음이란 뜻이고 수동 증거 판정은 위 결과와 별도 문서에 기록했다. 모델 최종 요약을 내보내는 별도 계약이 아직 없어 `agent_final_answer`는 비어 있다. FlightAware의 최종 화면과 답변 원문이 누락되어 그 작업을 수동 판정하기 어렵다.

### 파일럿 실행기 보정

이번 결과를 보고 실행기를 보정했다. `need_user`의 답변은 계약 허용 상한인 2,000자까지 controller snapshot과 `result.json`의 `agent_final_answer`에 유지한다(기존 UI/컨트롤러 제한은 600자였다). planner 질문의 원문도 `run.json`의 `terminalProposal.reason`에 보존한다. 각 task 종료 시점에 최종 페이지 캡처를 `trajectory/final.png`로 저장하고 URL·제목·상태·해상도를 `run.json.terminalEvidence`에 기록한다. 새 결과 JSON에는 benchmark v2에 없는 키를 추가하지 않는다. 기존 파일럿 산출물은 수정하지 않았으며 이 보정은 다음 실행부터 적용된다.

보정 코드를 적용한 뒤 같은 5개를 재실행했고 새 결과는 `/Users/songjiun/Downloads/halo-online-mind2web-fnIcOr/summary.json`에 있다. 모두 정상 종료했으며 5/5에서 `trajectory/final.png`가 실제 생성되고 `run.json`에 terminal URL·제목·상태가 연결됐다. 전체 155.80초, 15 planner calls, 반환 usage 입력 158,350 / 출력 1,611 tokens였다. `need_user`가 반환한 원문은 FlightAware 694자, MTA 126자, Apple 543자로 `result.json.agent_final_answer`에 들어갔다. Discogs는 captcha에서 멈췄고, IGN은 입력 제안이 승인 대기 상태라 작업을 진행하지 않았다. 이는 새 실행의 기록 완결성을 입증하지만 공식 채점이나 성공률 판정은 아니다.

RSS는 runner 프로세스의 turn-boundary sample만 기록하며 Chromium·worker를 제외한다. 전체 메모리 상한 준수 또는 실제 peak RSS 증거로 쓰지 않는다. wall time은 초기 브라우저 생성·bootstrap을 포함하지만 teardown을 제외한다. 전체 회귀 검사와 동시에 실행했으므로 순수 latency baseline으로 쓰지 않는다.

## 재현 및 검증

`apps/computer-browser`에서 `node integration/online-mind2web-pilot.ts /Users/songjiun/Downloads/Online_Mind2Web.json`을 실행한다. 매 실행마다 새로운 Downloads 하위 디렉터리를 만들어 기존 결과를 덮어쓰지 않는다. 외부 업로드·점수 제출은 없다.

기존 파일럿 회귀 테스트에 종료 화면 산출 테스트를 추가했고, `node --test test/online-mind2web-pilot.test.js test/task-controller-recovery.test.js`에서 19개 모두 통과했다. `npm run typecheck`, `npm run check:runtime`, `git diff --check`도 통과했다. 전체 회귀 검사는 1,991개 중 1,989개 통과, 2개 실패, 취소·건너뜀 0개로 종료했다(840.694초). `cdp-engine.test.js`의 `AgentViewportHost builds Chromium pages when the engine is on and Electron ones when it is off`가 약 30초 뒤 실패했다. 라이브 파일럿 종료 후 같은 테스트만 다시 실행하면 23.207초에 통과했다. 동시 부하 관련 가능성은 있으나 원인이 확정된 것은 아니다. 다른 실패는 아래 Chromium lifecycle 관측 오류다. 전체 회귀 suite는 green이 아니다.

`renderer-lifecycle.test.js`의 `real Chromium: BrowserAdapter survives freeze and discard; old observations go stale; cookies stay`도 실패했다. 단독 재검사에서도 첫 `observe()` (test line 176)에서 `cdp_error: Cannot find context with specified id` / `observe_failed`로 재현됐다. 기존 런타임 파일은 이번 벤치 작업에서 수정하지 않았으며 이 문제는 미해결이다.

독립 리뷰 에이전트는 모델 라우팅 오류로 시작하지 못했다. 커밋·푸시는 하지 않았다.

## 모델 3종 × 권한 2종 비교 (2026-10-09, 별도 세션)

같은 파일럿·같은 데이터셋·같은 하네스로 모델과 권한 범위만 바꿔 5개 과제를 돌렸다.
`HALO_PILOT_PROVIDER` / `HALO_PILOT_MODEL` / `HALO_PILOT_SCOPE=full`(신규)로 선택하며,
`benchmarkScope`·`permissionMode`·`model`이 manifest.json과 각 run.json에 기록된다.
`full`은 제품의 Full 권한 모드와 같아서 **실제 공개 사이트에 클릭·입력이 나간다**
(로그인 정보는 로드하지 않으므로 익명 상호작용 범위).

| 모델 | 권한 | 시간 | 호출 | 플래너 실패 | 완전 답변 | 종료 상태 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Codex `gpt-6-luna` | readonly | 114s | 18 | 0 | **2** | need_user×3, captcha, approval |
| Codex `gpt-6-luna` | full | 160s | 24 | 1 | **2** | need_user×3, captcha, awaiting_verification |
| NVIDIA Nemotron | readonly | 128s | 14 | 1 | 0 | approval×4, captcha |
| NVIDIA Nemotron | full | **684s** | **51** | 4 | **0** | running×3(예산 소진), captcha, awaiting_verification |
| NVIDIA DeepSeek V4.1 Flash | readonly | 862s | 17 | **12** | 0 | planner_error×3, captcha, approval |

세 모델의 실패는 서로 다른 층에서 일어난다 — DeepSeek은 **전송**(턴이 브리지 55초
타임아웃을 못 넘김: 실패 호출당 ~55초), Nemotron은 **전략**(읽기 전용에서는
click/type 제안이 승인 대기로 막히고, 풀 권한에서는 `type`을 8회 연속 반복하는
루프에 빠져 51회 호출에도 답을 못 냄), Codex는 전송·전략 모두 통과하고
**어느 권한에서도 답을 낸 유일한 모델**.

한계: 5개 수작업 선택 과제, 공식 채점 아님. 스크린샷은 상단 뷰포트만이라
답변 수치의 화면 검증은 별도 절차가 필요하다(이전 세션의 지적과 동일).
