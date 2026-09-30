# HALO 범용 MCP Broker 설계

상태: 대화상 방향 승인 완료, 문서 검토 대기. 제품 구현 계획/구현은 아직 승인하지 않았다.

## 1. 사용자 의도와 성공 조건

사용자는 Claude 또는 GPT에 연결한 MCP를 HALO 내부 에이전트에서도 사용하려 한다.
GitHub처럼 서비스별 기능을 하드코딩하지 않고 연결 발견, 도구 검색, 선택적 설명,
승인된 실행을 공통화한다. 목적은 브라우저로 모든 화면을 읽는 비용을 줄이면서
기존 목표·권한·내구 기록·증거 경계를 유지하는 것이다.

“전부”는 서버/서비스 이름에 대한 제한을 없앤다는 뜻이다. 공개 인터페이스가 없는
연결, 조직 차단, 만료된 인증, 런타임에서 제공하지 않는 도구까지 호출할 수 있다는
보장은 아니다. 모든 발견 항목에 실제 지원 상태와 이유를 표시한다.

현재 단계는 백엔드 설계다. 프론트 변경, 인증 정보 추출, 기존 앱 설정 변경,
패키지 설치, 새 권한 부여, 실제 쓰기 호출은 이 문서 작성 범위에 포함하지 않는다.

## 2. 선택한 방식과 대안

선택: 원래 런타임의 인증·조직 정책을 유지하는 broker를 우선 사용하고, 재사용이
안 되는 로컬/원격 서버는 사용자가 별도로 등록·승인하는 직접 MCP 연결로 보완한다.

대안 A(런타임만): 인증 복제가 없지만 Claude 직접 호출 및 Desktop 내부 연결에
한계가 있다. 대안 B(모든 설정/인증 가져오기): 호환성보다 비밀 유출·OAuth 대상
변경·권한 확대 위험이 커서 채택하지 않는다. URL/명령만 가져오는 연결 안내와
인증 재사용은 다른 기능이며, 안내도 원문 설정을 모델이나 로그에 노출하지 않는다.

## 3. 출처별 지원 계약

| 출처 | 실행 경로 | 설계상 상태 |
| --- | --- | --- |
| Codex가 제공하는 연결 서비스 | app-server의 도구 목록과 직접 호출 | 우선 구현 |
| Codex 설정의 로컬 MCP | 사용자가 선택한 서버만 켠 owned thread | 별도 서버 시작 승인 후 지원 |
| Claude Code/SDK의 claude.ai 연결 | 구독 로그인한 전용 SDK 실행 세션 | 호스트 차단 훅 검증 전에는 실행 비활성 |
| Claude에 등록한 로컬 MCP | HALO 직접 클라이언트에 별도 등록 | 인증/명령 승인 후 지원 |
| Claude Desktop 내부 sdk 연결 | 외부 공개 실행 경로 미확인 | 해당 경로 unsupported; Code 로그인 경로를 별도로 확인 |
| 런타임에 나타나지 않는 ChatGPT 웹 전용 연결 | HALO 별도 연결 또는 원래 앱에서 설정 안내 | 자동 재사용 미지원 |

Claude의 모델 없는 직접 tool-call API는 현재 조사에서 확인하지 못했다. SDK에
서버 관리/상태 API가 있다는 사실은 직접 도구 호출 지원의 증거가 아니다.
전용 SDK 경로에는 추가 모델 턴 비용과 지연이 발생할 수 있으며 사용자에게 표시한다.
Desktop 로그인 성공을 standalone CLI/SDK 로그인 성공으로 간주하지 않는다.

직접 연결의 첫 구현 범위는 승인된 stdio 및 HTTPS Streamable HTTP다. SSE/WS는
발견되더라도 구현/검증 전에는 unsupported_transport로 표시한다. 자동 OAuth 로그인,
비밀 헤더 가져오기, 임의 프로그램 다운로드는 하지 않는다.

## 4. 구성 요소와 공통 인터페이스

- `McpRegistry`: host-owned 연결 식별자, 출처, 상태, 설정 revision. 비밀값을 저장하지 않는다.
- `McpCatalog`: 이름/설명 색인과 선택한 도구 스키마. 연결 세대가 바뀌면 무효화한다.
- `McpPolicy`: 호스트가 정한 위험/데이터 범위 규칙. 도구 annotation은 참고 데이터다.
- `McpBroker`: 승인 capability 검증, durable claim, provider dispatch, 결과 정규화.
- provider: Codex runtime / Claude SDK execution / 직접 MCP client. renderer에 raw RPC를 제공하지 않는다.

host API의 의미는 다음과 같다. 함수명은 구현 계획에서 최종 파일 구조와 함께 확정한다.

```text
listConnections(cursor) -> bounded summaries + nextCursor
searchTools(query, filters, cursor) -> bounded tool summaries
describeTool(connectionId, toolId) -> bounded schema + schemaDigest
proposeCall(taskId, goalVersion, connectionId, toolId, arguments) -> approval request
dispatchApproved(capability) -> bounded tool result / error / execution_uncertain
close() -> cancel active work and reap owned workers
```

list/search/describe는 실행 권한을 발급하지 않는다. 상태는 connected, needs_auth,
disabled, blocked, unsupported, failed다. resource read도 따로 검증하는 액션이며
도구 실행 허용을 통해 우회할 수 없다. prompt/resource subscription은 첫 구현 범위 밖이다.

도구 identity는 provider + connectionId + server + connectorId(있는 경우) + toolName이다.
표시명만으로 합치지 않는다. 서로 다른 계정/출처의 같은 이름은 별개로 유지한다.
connection generation은 런타임 재시작·재인증·설정 변경 시 증가한다. 제공자가 계정
identity를 확인해 주지 않으면 account_verified를 주장하지 않는다.

## 5. 발견과 토큰 예산

기본값: 목록 페이지 20개, 검색 최대 10개/4KiB, 설명 하나 최대 16KiB,
도구 인자 최대 16KiB, 모델용 결과 최대 4KiB, 전체 context 기존 64KiB 상한 유지.
검색 설명은 항목당 240자로 제한한다. 잘린 스키마는 실행 검증에 사용하지 않는다.
스키마가 한도를 넘으면 schema_too_large로 실행을 막고 명시적 전용 매핑을 요구한다.

raw catalog는 호스트 메모리에서 최대 2MiB/1,000 도구까지 유지하고 초과 항목은
provider cursor로 추가 검색한다. 정확한 서버 실행 없이 목록을 읽을 수 없는 경우
선택 서버의 시작 승인 전까지 discovered_not_initialized 이유를 표시한다.
모든 로컬 MCP를 목록 수집 목적으로 동시에 시작하지 않는다.

원문 결과는 실행 artifact로 최대 1MiB까지만 로컬 보존한다. 상한을 넘는 응답은
정규화 실패로 표시한다. 모델 결과에는 truncated, contentType, source, artifactRef,
byte counters를 명시한다. 비문자 콘텐츠는 자동 다운로드/실행하지 않고 메타데이터만
제공한다. artifactRef가 GC되면 evidence_missing이며 다른 파일로 대체하지 않는다.

byte 감소와 실제 token 감소를 구분한다. 전체 도구 목록을 planner에 주지 않는 것이
기본 원칙이지, 모든 서비스에서 토큰·지연이 개선된다는 보장은 아니다.

## 6. 권한·승인·실행 경계

기존 permission-policy는 브라우저 액션만 정의하므로 MCP 이름을 브라우저 observe로
위장하지 않는다. 별도 `mcp_call` descriptor와 공통 controller dispatch 경로를 추가한다.
기존 브라우저 permission 동작은 보존하고, MCP permission은 별도로 host에 저장한다.
기존 full 브라우저 모드를 새 MCP 전체 허용으로 자동 승격하지 않는다.

검토된 조회 도구만 host scope에 따라 승인자 또는 사용자로부터 권한을 얻는다.
분류되지 않은 도구와 쓰기 도구는 기본 human review다. full MCP scope도 사용자에게
출처·서버·데이터 범위가 명시된 별도 설정이다. 조직의 blocked/ask와 제공자의
추가 승인 요구는 HALO의 full 설정으로 덮어쓰지 않는다.

승인에는 taskId, goalVersion, connection generation, tool identity, schemaDigest,
정규화한 argsDigest, 정책 revision, 짧은 expiry를 결합한다. 브라우저 관찰에 근거한
요청이면 documentEpoch도 결합한다. provider/도구/인자/목표/스키마가 바뀌면 재승인한다.
범용 스키마 검증은 local JSON Schema만 사용하고 remote $ref는 가져오지 않는다.

dispatch 전에 기존 TaskStore journal에 durable claim을 남기고 1회만 실행한다.
중단·takeover·goal amendment의 admission/drain 경계를 MCP에도 적용한다.
재시작 때 open action은 execution_uncertain이다. tool의 idempotentHint를 믿고
자동 재실행하지 않는다. 오류 결과만으로 외부 부작용이 없었다고 판단하지 않는다.

host args scope는 계정·저장소·파일·수신자·대상 origin을 제한한다. 조회 역시 민감
정보 접근이나 외부 서비스로의 데이터 전송을 포함할 수 있으므로 무조건 안전하지 않다.
결제·인증 변경 등 사람 인계가 필요한 행동은 capability만으로 자동 처리하지 않는다.

## 7. Claude 전용 실행 세션의 추가 경계

기존 `claude-code-bridge` planner의 tools-disabled/safe-mode 구조는 유지한다.
MCP 실행은 별도 worker로 분리하고, planner에 shell/MCP 권한을 열지 않는다.

`allowedTools`는 도구 전체의 독점 allowlist가 아니며 `canUseTool`보다 먼저 자동
승인할 수 있다. 따라서 두 옵션만으로 exact-tool/args 통제를 주장하지 않는다.
항상 호출되는 host-owned PreToolUse gate에서 승인된 identity/인자/세대를 비교하고
모든 도구에 적용되는 matcher로 1회 실행 허가를 검증한다. controller가 기록한
durable claim은 worker에 보내기 전에 준비하고, 훅에서는 같은 claim의 실행 허가를
원자적으로 한 번만 사용한다. 별도 journal claim 두 개를 만드는 구조가 아니다.
불일치·추가 호출·built-in·재귀 Agent 호출은 deny한다.
호스트 훅의 등록·호출·차단을 실제 SDK에서 증명하지 못하면 provider 실행은 비활성이다.

콜백 내부 오류는 명시적 deny로 변환하고, hook timeout/worker 연결 단절이 실제
실행을 차단하는지 fault injection으로 확인한다. 외부 shell hook의 실패를 차단으로
가정하지 않는다. SDK가 hook 실패 시 실행을 계속할 수 있으면 해당 경로는 지원하지
않는다. 첫 모델 턴 전에 runtime tool inventory를 확인해 승인 대상 외 내장 도구나
추가 서버가 남아 있으면 세션을 중단한다. inventory 확인이 불가능하면 활성화하지 않는다.

project hook/plugin/settings는 불러오지 않고 필요한 인증/조직 정책만 공식 런타임
경로에서 유지한다. 이 구성이 claude.ai 연결과 양립하는지는 acceptance probe에서
검증한다. 설정을 축소했는데 연결이 사라지면 unsafe bypass가 아니라 unsupported다.
도구 실제 결과 이벤트만 수집하고 모델의 최종 문장을 실행 결과로 인정하지 않는다.

## 8. 수명·성능·실패 처리

broker당 동시 실행 1개, 전체 새 MCP 실행 worker 최대 1개를 기본으로 한다.
대기열은 최대 8개이며 초과는 busy다. child agent도 host broker를 공유한다.
부모가 만드는 subagent 수와 MCP 실행 worker 수는 별개다.

Codex/direct 호출은 전체 10초 기한, Claude 실행은 전체 60초/모델 턴 최대 2회를
기본으로 한다. 기한에는 startup/discovery/auth 확인/tool 실행을 모두 포함한다.
취소 시 late result를 버리고 own process tree를 종료한다. 이전 worker reaping 전
새 worker를 시작하지 않는다. teardown 실패 시 연결을 fail-closed로 격리한다.

기존 1GiB 기본 메모리 예산과 memory pressure admission을 유지한다. 사용자에게
예산 확대 설정이 있어도 사전 통지/명시적 선택 없이 이를 바꾸지 않는다. 예산 부족은
capacity 상태로 보고하며 동시에 더 띄우거나 보안 경계를 우회하지 않는다.

unknown method, server permission 요청, elicitation은 runtime protocol대로 처리하되
정확한 pending operation과 사람 승인에 결합되지 않은 요청은 decline한다. HALO 승인과
원래 런타임 승인이 둘 다 필요한 경우 둘 다 만족해야 실행된다.

## 9. 기록과 증거

기본 로그는 requestId, identity, 위험 분류, 결정 이유 코드, startup/discovery/
approval/journal/dispatch/result 지연, byte counters, RSS, 종료 상태다. args/result/
OAuth URL/헤더/stderr/설정 원문은 로그에 넣지 않는다. 인자 원문은 승인 UI에 필요한
경우에만 보호된 로컬 저장소에서 사용하고 durable payload는 secret scanner를 통과한다.

tool text/description/schema는 모두 untrusted다. MCP가 “trusted”라고 자기 신고해도
독립 분류를 바꾸지 않는다. 결과를 journal에 저장했다고 목표 달성 증거가 되는 것은
아니다. evidence validity/completion은 기존 별도 검증 규칙으로 판단한다.

## 10. 구현 분할과 검증 기준

후속 구현 계획은 세 단계로 분리한다: 공통 registry/catalog/policy + Codex provider,
직접 MCP provider, Claude SDK provider. 미구현 출처도 공통 상태 인터페이스로 표시한다.
역할 제안: Codex는 공통 contract/controller/journal·회귀, Claude는 provider backend와
독립 승인 gate·실제 SDK 검증. 공유 파일은 한 명만 소유하고 각 diff를 교차 검토한다.

필수 테스트:

- 여러 서비스/동일 이름 출처 구분, catalog pagination·예산·schema 초과·remote ref 거부.
- annotation 위조, prompt injection, 연결/계정 세대 변경, 스키마/인자 변경 시 재승인.
- unknown/write 거부 또는 human review, 조직 blocked/ask 유지, 전체 허용의 명시적 scope.
- claim-before-dispatch, 중복 요청·추가 호출 거부, crash 후 uncertain·자동 replay 금지.
- timeout/abort/startup hang/slow close/failed close, parent-child admission와 takeover drain.
- Claude allowedTools auto-approval 및 내장 도구에도 host gate가 반드시 실행되는 실제 probe.
- hook exception/timeout/disconnect, 버전 변경으로 추가된 내장 도구, project allow 주입을 차단하는 probe.
- connected/needs_auth/unsupported를 혼동하지 않는 테스트와 각 provider의 읽기 전용 실연결.
- 동일 task/model/effort로 browser baseline 대비 calls/tokens/bytes/latency/RSS를 각각 기록.

실제 쓰기·민감 서비스·인증·소프트웨어 시작 승인은 mock 테스트 결과로 대체하지 않는다.
검증 전에는 “모든 MCP 가능”, “토큰 절감”, “1GiB 보장”을 완료 보고에 쓰지 않는다.

## 11. 근거와 한계

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): 목록·직접 tool call 경로.
- [Claude MCP](https://code.claude.com/docs/en/mcp): 구독 연결 및 Desktop/Code 실행 경로 차이.
- [Claude SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp): 서버 설정·상태 확인.
- [Claude SDK permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions):
  allow 규칙이 callback을 생략할 수 있고 모든 호출 통제에는 PreToolUse gate가 필요하다.

Claude Opus의 독립 read-only 검토 결과를 반영했다. direct-call 부재는 조사에서 찾지
못했다는 범위의 결론이며 비공개 인터페이스가 없다는 증명이 아니다. SDK/런타임 실제
실행과 호환성 probe는 아직 수행하지 않았다. 기존 GitHub v1의 테스트 결과는 범용
broker 구현의 증거로 재사용하지 않는다.
