# 라우팅된 MCP 도구 공유 설계 (하네스 1단계)

상태: 2026-10-01 사용자 승인. 구현 및 전체 테스트 완료(미커밋).

## 배경

범용 MCP broker 설계(`2026-09-30-generic-mcp-broker-design.md`)에 따른
`GenericMcpBroker`, `CodexMcpProvider`, TaskController/TaskHost의 MCP 메서드는
이미 있다. 그러나 두 가지가 빠져 있다.

1. `main/index.js`가 TaskHost에 `makeMcpBroker`를 넘기지 않아 실제 앱에서는 범용
   MCP가 꺼져 있다.
2. planner(모델)가 MCP를 요청할 경로가 없다. 지금은 호스트·사람만 호출한다.

이번 단계는 이 둘을 연결한다. `b-nnett/grok-bot-0.18-reconstructed`는 "도구
목록을 공유하되 실행은 작업별로 묶는다"는 아이디어만 참고하고 코드는 가져오지 않는다.

## 범위

- 지원 출처는 Codex가 제공하는 연결 서비스(hosted) 하나. 로컬 MCP 서버 시작,
  Claude SDK 경로, 자동 OAuth는 범위 밖이다.
- 설정 화면 UI는 범위 밖(`frontend/**` 비수정). 기존 `updateHostSettings` 계약만 확장한다.
- Docker sandbox는 2단계에서 별도 설계한다.

## 결정

1. **기본은 꺼짐.** 설정 v4에 `mcpProviders` 배열을 추가한다. 허용값은 `"codex"`
   하나이고 기본값은 `[]`이다. v3 파일은 필드 집합이 정확히 맞을 때만 v4로
   이전하고 다른 형태는 거부한다(fail-closed). 로컬 서버 목록은 프로세스를
   시작하므로 설정으로 노출하지 않는다.
2. **공유 단위.**
   - provider(Codex app-server 프로세스)는 앱 전체에서 하나만 둔다. 그 프로세스는
     기존처럼 MemoryMonitor에 외부 프로세스로 등록되어 RSS 예산에 포함된다.
   - provider는 한 번에 한 호출만 처리하므로, 호스트가 `SharedMcpProvider` 래퍼로
     작업 간 호출을 FIFO로 직렬화한다. 대기열은 길이 제한이 있고, 넘치거나 취소되면
     `busy`/`cancelled`로 실패한다(재시도하지 않음).
   - broker는 작업마다 하나다. 승인·journal·epoch 바인딩이 작업마다 다르기 때문이다.
   - 연결 목록과 도구 스키마는 호스트 `McpCatalogCache`에 둔다. 키는
     provider+connectionId+toolName+generation이고, generation이 바뀌면 해당 연결의
     항목을 모두 버린다. 캐시는 2MiB/1,000 도구 상한을 지킨다.
   - 자식 에이전트는 이번 단계에서 MCP를 받지 않는다(`mcp_disabled`). 자식 controller는
     `child-agent-coordinator.js`에서만 만들어지고 권한이 정확히 observe+scroll로
     고정되어 있기 때문이다. 자식 공유는 그 정책을 바꾸는 별도 승인 단계로 남긴다.
   - MCP provider 목록은 planner provider처럼 작업이 attach될 때 고정된다. 설정을
     바꿔도 이미 attach된 작업에는 영향이 없다. MCP를 끄면 새 broker만 거부되고,
     이미 만든 broker는 작업이 끝날 때까지 유지된다(진행 중 호출을 끊지 않음).
3. **자동 실행 없음.** 모델이 제안한 MCP 호출은 권한 모드와 관계없이 항상 기존 승인
   큐로 가서 사람의 승인을 받는다. search/describe는 실행 권한을 발급하지 않는다.
4. **메모리 압박.** `canRun`은 MemoryMonitor 압박이 `normal`일 때만 true다. 아니면
   새 호출은 `memory_pressure`로 거부된다.

## planner 계약 (Claude ↔ Codex 경계)

planner 응답은 기존 proposal envelope를 유지한다. 공통 필드는
`taskId`, `goalVersion`, `basedOnObservationId`, `criterionIds`, `kind`이며,
`kind`는 `"actions"`이고 `actions` 배열에는 아래 MCP 액션 하나만 넣는다.
MCP 액션과 브라우저 액션은 한 proposal에 섞지 않는다.

```text
{ type: "mcp_search", query }                                      -> 도구 요약 최대 10개/4KiB
{ type: "mcp_describe", connectionId, toolName }                    -> 스키마 설명 + schemaDigest
{ type: "mcp_propose", connectionId, toolName, arguments, reason }  -> 승인 대기 → 결과 또는 거부
```

정확한 액션 필드 집합은 `mcp_search={type,query}`;
`mcp_describe={type,connectionId,toolName}`;
`mcp_propose={type,connectionId,toolName,arguments,reason}`이다. 추가 필드는
거부한다. `query`는 비어있지 않은 UTF-8 1KiB 이하, 이름은 각각 256자 이하,
`arguments`는 기존 MCP 인자 검증 상한을 따르고, `reason`은 비어있지 않은
2,000자 이하이다.

- 결과는 다음 planner 턴에 `mcpResult` 관측으로 전달한다. 모델용 결과는 4KiB 이하이고,
  전체 planner context는 기존 64KiB 상한을 지킨다.
- 인자는 16KiB 이하이며, `validateMcpArguments`가 describe 때 받은 스키마로 검증한다.
- MCP가 꺼진 작업에서 이 액션이 오면 `mcp_disabled` 관측을 돌려준다. 작업은 멈추지 않는다.
- MCP 액션도 기존 action/planner-call 예산에 포함된다.
- `execution_uncertain` 결과는 자동으로 다시 시도하지 않고 사람에게 보인다.
- MCP 결과는 `observation.mcpResult={authority:"untrusted_mcp",action,outcome,result,truncated}`
  로 다음 planner 요청에 한 번만 전달한다. 거부·비활성·불확실 결과는 `code`를 포함한다.
- 모델용 `mcpResult` 객체 전체가 UTF-8 4KiB를 넘지 않으며, 삽입 후 context 전체가
  기존 64KiB 한도를 넘으면 결과를 줄이고, 그래도 맞지 않으면 context를 보내지 않는다.

## 담당

| 담당 | 소유 파일 | 내용 |
|---|---|---|
| Claude | `main/index.js`, `main/harness/task-host.js`, `main/harness/host-settings.js`, 새 `main/harness/shared-mcp-provider.js`, 새 `main/harness/mcp-catalog-cache.js`, 각 테스트 | 설정 v4, 실제 앱에서 broker 생성, provider 직렬화, 카탈로그 캐시, 작업별 고정 |
| Codex | `main/harness/planner-stdio.js`, `main/harness/task-controller.js`, `main/harness/providers/claude-code-worker.js`, 각 테스트 | planner `mcp_*` 액션, controller 처리(승인 큐 연결, 관측, 예산), worker 경계 |

서로의 파일은 수정하지 않는다. 경계에서 필요한 변경은 상대에게 요청한다.
controller가 부르는 `makeMcpBroker(hooks)`는 그대로다. TaskHost가 세 번째 인자로
고정된 `{ mcpProviders }`를 붙여 호스트 factory를 부른다. 캐시는 broker 아래의
provider lease에 있으므로 broker(TS)와 controller는 바뀐 것을 알 필요가 없다.
작업마다 받는 lease를 닫아도(broker 종료·deadline 정리 포함) 공용 provider는 닫히지
않고, 앱 종료 때만 닫힌다.

구현 경계 메모: 실제 Claude 프롬프트의 action 안내는
`providers/claude-code-bridge.js`에서 처리한다. 최초 분담표에는 없었지만, 양측
협의에 따라 Claude가 해당 파일을 수정해 `progress.mcp.enabled === true`일 때만
세 MCP 액션을 안내하고, `mcpResult`를 비신뢰 데이터로 취급하도록 했다. TaskHost도
attach 시 고정된 provider 목록을 controller의 `mcpEnabled`에 연결한다.
planner-stdio와 controller는 기존 proposal envelope 및 정확한 MCP action 필드 집합을
검증한다.

## 시험

- 설정: v3→v4 정확 이전, 이상한 v3 거부, 알 수 없는 provider 거부, 기본 `[]`이면 broker 없음.
- 공유: 두 작업이 동시에 호출해도 provider에는 한 번에 하나만 도달, 대기열 초과 시 `busy`,
  generation 변경 시 캐시 무효화, 캐시 상한.
- 고정: attach 시점의 mcpProviders만 쓰고, 꺼진 작업은 `mcp_disabled`, 자식은 MCP 없음.
- planner: `mcp_*` 액션 왕복, 꺼진 상태의 `mcp_disabled`, 크기 상한, 예산 차감, 승인 거부 관측.
- 실제 Codex app-server나 `claude` 프로세스는 띄우지 않는다(가짜 transport 사용).
