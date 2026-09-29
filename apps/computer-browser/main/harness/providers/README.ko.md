# Claude Code CLI provider bridge

로컬에 이미 로그인되어 있는 `claude` CLI(Claude Code)를 harness의 플래너로
재사용하기 위한 provider bridge다. `main/harness/task-controller.js`,
`main/harness/planner-stdio.js`, `main/harness/task-host.js`,
`main/index.js` 등 기존 파일은 **전혀 수정하지 않았다** — 이 디렉터리는
순수 추가 파일이며, `main/index.js`의 `makeHarnessPlanner()`가 이미 제공하는
`HALO_PLANNER_COMMAND`/`HALO_PLANNER_ARGS` 배선을 그대로 재사용한다.

## 구성

- `claude-code-bridge.js` — `ClaudeCodeBridge` 클래스. `start(context, {signal})`
  하나로 로컬 `claude` CLI를 1회 호출하고, `shared/harness-contracts.js`의
  `validateProposalEnvelope()`를 통과한 proposal만 resolve한다. `cancel()`로
  진행 중인 호출을 죽일 수 있다. Electron/durable journal/approver에 대한
  의존성이 전혀 없어 `test/claude-code-bridge.test.js`가 가짜 `spawnFn`만으로
  단독 테스트한다.
- `claude-code-worker.js` — `PlannerStdioAdapter`가 실제로 spawn하는 진입점.
  `planner-stdio.js`가 이미 쓰는 JSONL 프로토콜(`{requestId, context}` 한
  줄 → `{requestId, proposal}` 한 줄)을 그대로 따른다. 새 wire 포맷을 만들지
  않았다.

## 활성화 방법 (operator가 직접 환경변수로 설정)

```bash
export HALO_PLANNER_COMMAND=node
export HALO_PLANNER_ARGS='["apps/computer-browser/main/harness/providers/claude-code-worker.js"]'
```

이 두 값이 모두 설정되어야만 `main/index.js`의 `makeHarnessPlanner()`가
플래너를 활성화한다(기존 동작 그대로 — 코드 변경 없이 operator 설정만으로
켜고 끌 수 있다). 아무것도 설정하지 않으면 오늘과 동일하게
`paused: planner_unavailable`이다.

## 데이터 흐름 — 이것은 오프라인/로컬 모델이 아니다

- **모든 호출은 실제로 네트워크를 타고 Anthropic API로 나간다.** `claude`
  CLI가 로컬 바이너리라는 사실이 "오프라인 실행"을 의미하지 않는다 —
  이 bridge가 매 호출마다 프롬프트에 직렬화해 넘기는 `context`에는 목표
  (`context.goal`)와 그 판정 기준, 최근 저널 이벤트, 그리고 **현재 페이지
  관찰 내용**(`context.observation` — 실제 페이지 텍스트/구조)이 통째로
  들어 있고, 이 전체가 사용자 자신의 `claude` CLI 계정(자신의 로그인,
  자신의 사용량/쿼터)으로 Anthropic에 전송되어 처리된다.
- 이는 "로컬 CLI 로그인 재사용"이 크리덴셜을 새로 만들지 않는다는 뜻이지,
  데이터가 기기를 떠나지 않는다는 뜻이 아니다. 운영자가 이 provider를
  활성화하면, 그 시점부터 브라우저가 방문하는 페이지의 내용이 (그 페이지가
  신뢰할 수 없는 외부 사이트라도) Anthropic으로 전송된다는 것을 명확히
  인지해야 한다.
- 이 문서와 `claude-code-bridge.js` 상단 주석 양쪽에 이 사실을 명시해
  두는 이유: "로컬 바이너리를 쓴다"와 "로컬에서만 처리한다"를 혼동하기
  쉽고, 이 provider를 켜는 결정은 그 차이를 알고 내려야 하기 때문이다.
- `--no-session-persistence`는 CLI의 로컬 대화 세션 저장을 끄는 옵션일
  뿐, Anthropic 측의 처리·보존 정책을 보장하거나 변경하지 않는다 — 해당
  사항은 사용 중인 Anthropic 계정과 서비스 약관을 따른다. 사용자는 자신이
  외부 전송을 허용할 수 있는 페이지와 데이터에만 이 provider를 활성화해야
  한다.

## 로컬 로그인 재사용 / 크리덴셜 처리

- Halo는 이 provider를 위해 어떤 API 키도 새로 요구하거나 저장하지 않는다.
  `claude` 바이너리가 이미 가진 자체 로그인(OAuth/keychain)을 그대로
  재사용한다.
- `--bare`는 의도적으로 쓰지 않는다 — `--bare`는 OAuth/keychain 읽기를
  강제로 막고 `ANTHROPIC_API_KEY`/`apiKeyHelper`만 허용하므로, "로컬 CLI
  로그인 재사용"이라는 요구와 정반대다. 대신 `--safe-mode`(hooks/plugins/
  MCP/skills 비활성화, 인증은 정상 동작)를 쓴다.
- `context-builder.js`가 만드는 context packet에는 애초에 크리덴셜 필드가
  없다 — 이 bridge는 그 packet을 프롬프트에 그대로 직렬화할 뿐, 크리덴셜을
  읽어오는 새 코드 경로를 추가하지 않았다.
- **환경변수는 데널리스트가 아니라 얼롤리스트다.** `buildEnv()`는
  `PATH`/`HOME`/`LANG`/`TZ`/`TMPDIR` 다섯 개만 자식 프로세스에 복사하고,
  그 외 이름(생성자의 `env` 오버라이드로 들어오든, `process.env`에 이미
  있든)은 무엇이든 전부 제외한다 — `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `HALO_APPROVER_KEY`/`HALO_EXECUTOR_KEY` 등 이름을 일일이 나열해 막는
  구식 데널리스트 방식은 쓰지 않는다 — 나열되지 않은 새 크리덴셜 이름이
  나오면 그 즉시 뚫리는 구조이기 때문이다. 얼롤리스트에 없는 키를 생성자
  `env` 옵션으로 넘기면 `invalid_config` 에러로 즉시 거부되고, 그 어떤
  `claude` 프로세스도 스폰되지 않는다(`test/claude-code-bridge.test.js`의
  관련 회귀 테스트 참고).
- `--tools ""`로 `claude` CLI의 내장 도구(Bash/Edit/Read 등)를 전부
  비활성화한다 — 이게 없으면 신뢰할 수 없는 페이지 관찰 내용이 프롬프트에
  포함될 때 "다음 행동 제안"이 실제 로컬 명령 실행으로 이어질 수 있다(승인
  게이트를 완전히 우회하는 경로). `--permission-prompts none`,
  `--disable-slash-commands`, `--no-session-persistence`도 같은 방어선의
  일부다. **이 플래그들을 우회할 방법이 없다** — `CLI_ARGS`는 고정·동결된
  상수이고, 호출자가 인자를 추가·override할 수 있는 `extraArgs` 같은
  생성자 옵션은 존재하지 않는다(이전 초안에는 있었으나, 그런 옵션이 있으면
  CLI 인자 파서가 "뒤에 온 `--tools` 값이 이긴다"는 식으로 동작할 경우
  도구가 도로 켜질 수 있다는 지적을 받아 완전히 제거했다). 정확한 플래그
  목록과 근거는 `claude-code-bridge.js` 상단 주석 참고.
- **exit code가 0이 아니면 무조건 fail-closed다.** `close` 핸들러는 종료
  코드부터 확인하고, 0이 아니면 stdout에 형식이 멀쩡한 proposal JSON이
  들어 있었더라도 절대 resolve하지 않고 `cli_exit_nonzero`로 거부한다 —
  실제 설치된 CLI(v2.1.277)에서 인증 만료 시 `is_error: true`이면서 exit
  code 1로 종료하는 것을 직접 확인했기 때문에, "정상 종료했지만
  is_error"(`cli_error`)와 "비정상 종료"(`cli_exit_nonzero`)를 반드시
  구분해서 둘 다 막는다.
- **stdout 캡처량은 `MAX_CLI_STDOUT_BYTES`(1 MiB)로 제한된다** — 폭주하거나
  악의적인 CLI 프로세스가 이 (task당 재사용되는, 즉 오래 사는) bridge
  객체의 메모리를 무한정 늘리지 못하도록 하는 백스톱이며, 초과 시 자식을
  죽이고 `output_too_large`로 거부한다.
- **종료(`close()`)는 실제로 자식이 reap될 때까지 기다린다.** `cancel()`은
  호출자의 Promise를 즉시 `cancelled`로 거부하지만, `isBusy()`는 실제
  `"close"` 이벤트가 올 때까지 `true`로 남아 — 죽이라고 신호만 보내고 아직
  살아있는 프로세스 위에 두 번째 `claude` 프로세스가 겹쳐 뜨는 경쟁 조건을
  막는다. `close({killTimeoutMs})`는 이 reap을 실제로 기다리고, 시간
  내에 스스로 종료하지 않으면 `SIGKILL`로 승격한다.
  `claude-code-worker.js`의 SIGTERM/SIGINT 핸들러도 `cancel()`만 부르고
  바로 `process.exit(0)`하지 않고 `await bridge.close()`한 뒤에 종료한다 —
  그렇지 않으면 워커 프로세스가 죽은 뒤에도 `claude` 자식 프로세스가
  사용자 계정으로 계속 실행 중인 채 남을 수 있다.

## 정직한 한계

- **credential broker는 이 배치에 포함되지 않는다.** 시크릿 저장/동기화/자동
  채움 기능은 없음 — 별도 설계 제안(대화 기록 참고)만 있고 구현은 하지
  않았다.
- 실패한 요청에 대한 별도 에러 프레임이 없다(기존 `planner-stdio.js`
  프로토콜 자체에 그런 게 없다) — CLI 호출이 실패하면 그 요청은 응답 없이
  넘어가고, `PlannerStdioAdapter`의 기존 60초 타임아웃이 다른 플래너
  고장과 동일하게 `pauseReason: "planner_error"`로 처리한다. 이건 새로
  생긴 지연이 아니라 기존 설계를 그대로 재사용한 것이다.
- `--json-schema`로 CLI 출력 형태를 강제하지만, 실제 안전 게이트는 여전히
  `contracts.validateProposalEnvelope()`다 — CLI가 스키마를 어겨도 이
  bridge가 fail-closed로 거부한다.
- CLI 응답 envelope의 정확한 최상위 필드(`type`/`is_error`/`result`)는
  설치된 `claude` CLI(v2.1.277)를 실제로 1회 호출해 직접 확인했다(인증
  만료 오류 응답으로 확인됨). 정상 성공 응답의 전체 shape은 실제 로그인된
  환경에서 재확인이 필요할 수 있다.
- 이 provider가 결정하는 행동(navigate/follow_link/scroll/observe)의
  정확한 필드 형식은 여전히 `browser-adapter.js` 소관이며 이 문서는 그
  파일을 수정하지 않았다.
