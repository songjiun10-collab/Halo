# 로컬 MCP Docker sandbox 설계 (2단계)

상태: 구현 방향 사용자 승인(2026-10-01), 정식 spec 검토 대기.

## 목표

HALO가 호스트에 임의의 MCP 서버 명령을 직접 실행하지 않고, 사람이 호스트 allowlist에 등록한 이미지로만 로컬 MCP 서버를 실행한다. 모델은 서버 ID와 도구 호출만 제안할 수 있으며 이미지, 명령, 인자, 네트워크 정책, 자격증명 위치는 바꿀 수 없다. 실행은 계속 1단계 `GenericMcpBroker`의 사람 승인 큐와 journal 경계를 통과한다.

## 범위와 분담

- Claude: host-only catalog/generation store, settings v5, `McpSecretVault`, index/TaskHost 라우팅, provider/container 수명·정리, 기존 자원 장부 연결을 소유한다. 앱 index가 `ResourceAdmission` 하나를 만들고 모든 TaskHost 생성자와 MCP broker factory에 같은 인스턴스를 주입한다. `resource-admission.js`에 미측정 자원용 lease와 공유 provider의 idle `stopSession()` 수명을 추가하고 `memory-monitor.js`에는 별도 예약 장부를 만들지 않는다.
- Codex: `docker-runner.js`, `stdio-mcp-client.js`, `local-mcp-provider.js`, MCP 상태 IPC/preload API, 가짜 transport 테스트, 선택적 Docker 통합 테스트를 소유한다.
- UI, 원격 MCP, 임의 사용자 명령, Docker Compose, 자동 이미지 pull, Linux 지원, 새 모델 도구 인터페이스는 범위 밖이다.
- 기존 `GenericMcpBroker` 계약과 approval/journal 동작은 바꾸지 않는다. `LocalMcpProvider`는 `listConnections`, `listTools`, `describeTool`, `call`, `close`를 구현해 기존 provider 인터페이스에 맞춘다.

## 신뢰 경계 및 허용 목록

- Local MCP는 기본 비활성이다. 설정 v5의 `localMcpServers` 기본값은 `[]`이며, 저장 설정은 모델에게 공개하지 않는다. 설정된 ID 목록은 TaskHost가 task attach 시점에 복사해 고정한다. 진행 중인 task는 이후 설정 변경의 영향을 받지 않는다.
- 서버 정의는 userData 아래 host-only catalog 파일에 둔다. 파일은 0600 권한, `O_NOFOLLOW`, 정확한 schema validation을 적용하고, image digest와 고정 argv를 필수로 한다. 각 항목은 불변 ID, OCI image의 `sha256` digest, 고정 argv, credential 이름·주입 방식, network mode (`none` 또는 `egress`)만 담는다. 설정 v5의 `localMcpServers`는 catalog의 ID 활성화 목록(기본 `[]`)만 담고, 알 수 없는 ID 및 추가 필드는 거부한다. UI와 모델은 ID만 선택 가능하며 catalog file에 쓸 수 없다.
- 활성 서버 정의는 최대 4개다. 기존 `GenericMcpBroker` 전체 provider 제한은 8개다. local provider마다 기존 `SharedMcpProvider`의 task별 lease를 사용한다. 같은 server ID의 컨테이너/MCP 세션은 host에서 하나만 공유하되 활성 task lease가 0개가 되면 컨테이너를 종료하고, 프로세스 종료를 확인한 뒤 비밀 파일과 자원 lease를 정리한다. 다음 task가 붙으면 새 세션을 시작한다.
- `docker run` 대상은 고정된 digest만 허용하고 `--pull=never`를 쓴다. 이미지가 없으면 `needs_image` 상태와 사용자용 수동 안내를 내며 다운로드하거나 다른 digest로 fallback하지 않는다.
- Docker daemon/VM은 신뢰 기반이다. Docker socket을 컨테이너에 mount하지 않는다. 이 sandbox는 Docker daemon 또는 호스트 커널 취약점 방어를 보장하지 않는다.
- 컨테이너는 악성 입력과 MCP 응답을 포함해 신뢰하지 않는다. 도구 schema와 결과는 기존 broker에서 검증·크기 제한하고, 도구 실행 전 사람 승인을 유지한다.

## 컨테이너 제한

모든 컨테이너는 host-generated argv로만 실행한다. 필수 고정 플래그는 `--rm -i --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534 --pids-limit 128 --memory 256m --memory-swap 256m --cpus 1 --tmpfs /tmp:size=16m --pull never`이며, 이미지에 대한 모든 참조는 digest로 고정한다. Docker CLI는 host가 확인한 절대 경로로만 실행하고, 명시한 allowlist 외의 host 환경변수를 자식 프로세스에 상속하지 않는다. 선택된 daemon은 Docker CLI의 `docker context inspect` 결과에서 로컬 Unix socket endpoint임을 확인한다. `DOCKER_HOST`/`DOCKER_CONTEXT` override는 무시하지 않고 원격 endpoint인지 검사하며, 원격·불명·검사실패는 `docker_unavailable`로 거부한다. Docker endpoint 확인을 위해 `~/.docker/config.json`을 직접 읽거나 인증값을 로그하지 않는다. 앱은 HALO app label, userData 경로 digest, runtime-owner ID, 서버 ID label을 붙인다. Docker MCP는 background runtime service가 해당 userData의 capability/socket owner임을 증명한 경우에만 시작한다. direct UI host fallback은 local Docker 서버를 시작하거나 정리하지 않고 `owner_unavailable`을 보고한다. 시작 시 stale container를 정리할 수 있는 주체도 이 단독 background runtime owner뿐이다. owner capability·label 조회가 불확실하면 자동 삭제를 건너뛰고 수동 조치가 필요한 상태를 표시한다. 실행 중에는 현재 owner가 만든 container만 종료하며 다른 userData 프로필/프로그램 컨테이너는 건드리지 않는다.

`network=none`은 네트워크가 전혀 필요 없는 서버에 권장한다. catalog에 고정된 `egress`는 임의 목적지로 나가는 네트워크를 허용하며 domain allowlist가 아니다. 처음 활성화할 때 사람에게 이 한계를 알리고 확인을 받는다. 포트 publish, host network, 추가 capability, device, 임의 mount, privileged mode는 금지한다.

## 비밀 주입

- MCP 전용 `McpSecretVault`는 `safeStorage` 암호화를 사용하고 기존 사이트 로그인 금고와 분리한다. 값은 사용자 입력만 받는다.
- 기본 주입은 실행 직전에 만든 0700 임시 디렉터리의 0400 파일을 read-only mount하는 방식이다. 비밀은 argv, 모델 context, MCP catalog, journal, 앱 로그에 기록하지 않는다.
- 서버가 file secret을 지원하지 않는 예외는 host catalog가 `env` 방식을 명시해야 한다. 이 경우 secret은 Docker 환경 설정과 `docker inspect`에 노출될 수 있으므로 그 위험을 사용자에게 표시하고 secret 사용 전에 확인한다. 모델은 방식을 바꿀 수 없다.
- 컨테이너 종료·시작 실패·취소의 모든 경로에서 임시 비밀 파일을 지운다. 삭제 실패는 성공처럼 표시하지 않고 실패 상태와 정리 필요성을 남긴다.

## 수명 및 자원 예산

- `docker run -i`는 서버별로 하나만 유지하고 MCP newline-delimited JSON-RPC stdio를 연결한다. stdio는 stdout을 프로토콜 전용으로 사용하며, stderr 진단은 byte cap을 둔 뒤 폐기한다. 각 JSON line은 bounded bytes, JSON object, JSON-RPC id 및 응답 shape를 검증한다. 과대/잘림/잘못된 응답, 알 수 없는 ID, timeout, 프로세스 종료 시 해당 세션을 폐기하고 진행 중 호출을 실패시킨다. 실행을 자동 재전송하지 않는다.
- 하나의 provider/서버 세션은 하나의 MCP 요청만 처리한다. 요청 큐, framing, 응답 크기, timeout은 유한 상한을 둔다. JSON-RPC initialize/initialized와 tools/list, tools/call에 필요한 절차만 지원한다. 샘플링, elicitation, roots, 임의 server-to-client 요청은 지원하지 않고 fail-closed 처리한다.
- **수명 hook 계약**: Claude가 broker를 만들 때 `reserveLocalMcpServer(serverId, sessionId)`와 `releaseLocalMcpServer(reservation)` host hook을 주입한다. Codex 소유 local provider/runner는 새 세션의 `docker run` 직전에 reserve를 await하고, admission이 거부되면 spawn하지 않으며 `memory_pressure`를 반환한다. 예약에는 `ResourceAdmission` lease ID만 opaque handle로 전달한다. 프로세스/컨테이너 종료를 실제 확인한 뒤에만 release를 await한다. 연결 timeout/crash로 세션 존재가 불명확하면 label 기반 reconcile/강제 종료 결과를 확인할 때까지 예약을 유지한다. `SharedMcpProvider`의 broker 사용 lease(몇 개의 Task가 provider를 붙잡았는지)와 `ResourceAdmission`의 메모리 예약 lease(미측정 256 MB)는 서로 다른 장부/의미다. 마지막 broker 사용 lease가 닫히고 진행 중 call이 settle/cancel된 뒤에는 reversible `stopSession()`을 호출한다. 이 동작은 다음 Task에서 다시 시작할 수 있어야 하며 앱 종료 때 쓰는 terminal `close()`와 구분한다. provider 안에서 concurrent start/stop은 직렬화한다. 실행 후 응답 불명은 `execution_uncertain`으로 기록하고 tool call을 재전송하지 않는다.
- 닫기 순서는 stdin 종료 → 제한된 SIGTERM 대기 → SIGKILL 후 실제 종료 확인이다. PID 재사용 오등록 방지를 위해 PID와 creation time을 함께 식별한다.
- 앱 index는 앱 프로세스별 `MemoryMonitor` 뒤에 `ResourceAdmission`을 정확히 하나 만들고, `createHarnessHost()`가 만드는 모든 TaskHost에 생성자 옵션으로 같은 admission 인스턴스를 전달한다. 기존 테스트/주입 경로 호환을 위해 TaskHost는 옵션이 없을 때만 기존 지연 생성을 유지한다. MCP broker factory에도 같은 인스턴스에 결합된 reserve/release hook을 전달한다. 256 MB 컨테이너 예약은 `ResourceAdmission`의 **미측정(lease가 해제될 때까지 샘플 후에도 유지)** reservation lease로 server session당 한 번 잡고, 확인된 종료 뒤 해제한다. 이 예약은 task의 `user_override`에 의해 우회되지 않는다. lease를 만들 때도 최신 완전 샘플·압박 상태·기존 일반 lease와 모든 미측정 reservation의 합으로 strict 예산 검사를 한다. `user_override`가 이미 선택된 일반 Task는 기존 약속대로 예산 초과 실행을 허용할 수 있다. 이 비대칭은 명시적 사용자 override의 의도된 예외이며, 새 Docker 세션을 추가 시작할 권한까지 뜻하지 않는다. 컨테이너 안의 MCP 서버 메모리는 host RSS sample에 포함되지 않으므로 새 Docker reservation을 별도 자원으로 계산한다. Docker CLI 자체는 host 외부 프로세스로 `MemoryMonitor`에 등록해 RSS를 추적한다. 기본 1 GB tracked budget 및 앱 실측을 기준으로 동시 서버 수는 보통 1개이며, 가용 예산이 부족하면 추가 서버 시작을 거부한다.
- Docker VM의 실제 메모리는 macOS host process sampling으로 측정할 수 없으므로, Docker 사용 중에는 측정된 앱 RSS와 설정된 컨테이너 reservation 합계만 예산 기준으로 말한다. Docker Desktop VM 전체 메모리를 포함한 시스템 RSS가 1 GB 미만이라고 주장하지 않는다.
- 메모리 압박은 `MemoryMonitor`의 measured RSS와 `ResourceAdmission`의 모든 미측정 reservation을 더한 effective total로 산정한다. TaskController의 pressure check 및 공유 MCP provider의 `canRun` 모두 이 같은 effective pressure 조회를 사용한다. 예약이 있는 동안 pressure 경계는 더 일찍 도달할 수 있다. 메모리 샘플이 stale/incomplete하거나 미측정 예약 합계를 읽지 못하면 pause/fail-closed한다. `user_override`는 사용자가 명시적으로 요청한 일반 task admission에만 적용되며, 미측정 Docker reservation을 추가할 때의 strict cap은 우회하지 않는다. 어떤 모드에서도 container memory 제한과 안전 argv는 낮출 수 없다.

## 상태 및 오류 계약

호스트 API는 활성화된 catalog server ID에 대해 `disabled`, `owner_unavailable`, `needs_image`, `starting`, `ready`, `stopping`, `failed` 상태를 보고한다. IPC/preload는 상태 조회 및 사용자가 승인한 설정 변경만 연결하고, secret 원문·catalog path·실행 argv는 renderer에 넘기지 않는다. 출력에는 secret, full argv 내 secret 값, 컨테이너 stdout 원문을 넣지 않는다. server config/image digest/argv/network/secret delivery가 바뀌거나 세션이 시작될 때 generation을 증가한다. generation은 host-only catalog 옆의 `mcp-server-generations.json`에 서버별 safe integer로 저장하며 0600, `O_NOFOLLOW`, strict schema, atomic write를 적용한다. 증가·fsync가 완료되기 전에는 서버를 시작하지 않는다. 이 값은 provider가 `listConnections()`에 보고하고 기존 broker 승인 바인딩을 stale 처리한다. 정수 범위를 다 쓰거나 generation 상태를 검증할 수 없으면 fail-closed한다. 비밀 참조는 `(server ID, image digest, server config digest)`에 묶으며 이 식별자가 바뀌면 새 이미지로 비밀을 자동 전달하지 않고 사용자의 재확인을 요구한다. 주요 bounded 오류 코드는 `docker_unavailable`, `needs_image`, `invalid_server`, `owner_unavailable`, `busy`, `memory_pressure`, `timeout`, `transport_error`, `execution_uncertain`, `cleanup_failed`다. `execution_uncertain`은 자동 retry하지 않으며 기존 controller가 사람에게 표시한다.

## 테스트 / 완료 기준

- 가짜 spawn 및 가짜 Docker/MCP transport만 사용하는 테스트가 기본 경로다. 실제 `docker`나 이미지 pull은 일반 unit/full suite에서 실행하지 않는다.
- 검증: 고정 absolute Docker binary + sanitized environment, `docker context inspect`의 local Unix endpoint만 허용하고 remote/unknown/inspect failure 거부, Docker config 파일 직접 읽기 없음, UI direct fallback에서 owner 부재 시 spawn/cleanup 없는 `owner_unavailable`, index에서 여러 TaskHost를 만들어도 동일 ResourceAdmission 주입, 고정 argv만 생성, 임의 명령·image·mount 주입 불가, digest/allowlist fail-closed, Docker 미설치·이미지 부재, line/frame byte 상한, UTF-8 및 JSON-RPC 상관관계, 중복/오래된 ID, timeout/cancel/crash/reap, 새 샘플 이후에도 유지되는 unmeasured reservation, effective pressure가 측정 RSS+예약 합을 반영, `user_override` 비대칭을 문서화한 채 Docker reservation strict budget 유지, reserve 전에는 spawn 없음, 마지막 SharedMcpProvider broker lease가 닫히면 call drain→`stopSession()`→exit 확인→reservation release 순서, permanent `close()` 뒤에는 재lease 금지, 잘못된 owner의 stale cleanup 불가, durable generation update 전 session 시작 금지 및 generation 변경 시 오래된 승인 무효화, digest 변경 시 secret 자동 재사용 금지, 중복 call 금지, stderr/result/secret 로그 미노출, 실패 경로별 temp secret 정리.
- 선택적 macOS 통합 테스트는 사용자가 명시적으로 준비한 로컬 이미지와 Docker Desktop이 있을 때만 별도 명령으로 실행한다. `network=none`, read-only root, capability drop, memory/pids limit, non-root UID, secret mount 미노출을 실제 컨테이너에서 probe한다. 이미지 pull·레지스트리 로그인·외부 이미지 실행을 자동화하지 않는다.
- MCP stdio는 newline-delimited JSON-RPC다. framing은 공식 [MCP stdio transport 문서](https://go.sdk.modelcontextprotocol.io/protocol/)에 맞추며, stdout은 protocol message 외 출력을 허용하지 않는다.
- `npm test`, `npm run typecheck`, `npm run check:runtime` 통과. Docker가 없어도 단위 테스트와 전체 suite는 통과해야 한다.

## 재사용성 검토: Olma `olma/`

사용자가 제공한 [Classi의 `olma/` 브랜치](https://github.com/songjiun10-collab/classi/tree/claude/ai-assistant-creation-u0fsuo/olma)는 Python/Ollama/Playwright 기반 독립 실행기다. Docker 파일만이 아니라 planner/router/schema, queue/store/memory, browser/OCR, 웹 AI provider, 알림 분류, API/UI, 테스트까지 `olma/` 전체를 HALO 현재 코드와 대조했다.

**판정: 그대로 가져올 구현 파일은 없다.** 두 프로젝트의 런타임·상태 모델이 다르다. 일부 패턴은 아래처럼 HALO에 맞춰 제한적으로 참고하되, 기존 host-owned goal/journal/approval/provider 경계를 중복 구현하지 않는다.

| Olma 영역 | HALO 대응 및 판정 | 적용 방향 |
|---|---|---|
| Planner schema 강제, 입력 크기 제한, 명시적 상태 전이 | HALO의 `planner-stdio.js`, `harness-contracts.js`, `task-controller.js`, `TaskStore`가 request/proposal 계약·epoch·예산·복구를 더 강하게 host에서 검증한다. | 패턴은 이미 충족. Olma의 부분 step 복구나 keyword fallback으로 잘못된 계획을 실행 가능한 계획으로 바꾸지 않는다. HALO는 검증/계획 실패를 기록하고 멈춰 사용자의 원래 의도를 보존한다. |
| Ollama local inference + schema-constrained JSON | HALO `planner-providers.js`는 worker allowlist를 고정하고 provider 선택을 task 시작 시 pin하며, `PlannerStdioAdapter`가 동일 proposal contract로 검증한다. Olma의 `ollama_client.py`는 Ollama `/api/generate` HTTP 클라이언트이며 모델 lifecycle이나 HALO approval을 관리하지 않는다. | **제품 후보로 별도 검토 가치 있음**: optional local planner worker를 추가하면 사용자가 이미 운용 중인 Ollama를 쓸 수 있다. 다만 이번 Docker MCP와 분리한다. 구현 시 Ollama 자동 설치/pull 금지, 기본 off, loopback endpoint만 허용, 현재 HALO JSONL/proposal contract 사용, provider 선택을 작업 시작 때 pin, 실행 예산/health timeout 적용, local model의 추가 RSS와 응답 지연을 실측한다. |
| Router confidence/fallback target | `permission-policy.js`와 기존 approval/controller 경계가 실행 허용을 판단한다. Olma의 confidence는 필수 문자열 존재 여부 휴리스틱이고 browser 실패를 LLM에게 대신 답하게 한다. | 가져오지 않는다. confidence로 승인이나 실행을 우회하지 않는다. |
| SQLite task history, 단일 worker queue, restart cleanup | HALO의 `TaskStore` journal/checkpoint, `TaskHost`, `ResourceAdmission`, `routine-runner`, host-owned child coordinator가 지속성·재개·예산·동시성을 맡는다. Olma의 queue는 저장 실패를 로그만 남기고 작업을 계속할 수 있다. | 두 번째 task DB/queue를 만들지 않는다. Olma가 “진행 중 task를 재개하지 않고 failed 처리”하는 설계와 persistence 실패 무시는 HALO의 durable recovery/fail-closed 경계로 가져오지 않는다. |
| SQLite recent memory 및 작업 검색 | HALO에는 `LocalMemoryStore`, `context-builder`, 사용자 memory admission이 있다. HALO는 기억을 untrusted context로 태그하고 byte/count budget 안에서 매 작업에 넣는다. | 코드 복사 불필요. 과거 실행 결과를 신뢰 지시로 승격하지 않는 HALO 규칙 유지. Olma의 `find()` 전체 로드 후 선형 검색은 HALO 메모리/장기 보존 요구에 맞는 검색 엔진이 아니다. |
| Selector 후보 순회, 응답 안정화 polling, 닫힌 page 복구 | HALO `BrowserAdapter`는 bounded compact a11y/DOM observation, documentEpoch, stale element 재검증, destroyed/navigation 실패를 명시적으로 다룬다. | 유용한 브라우저 견고성 패턴으로만 기록한다. 적용 시 재관측 후 epoch를 갱신하고, page 재생성만으로 기존 action을 재시도하지 않는다. 이는 Docker MCP 작업과 분리된 후속 브라우저 개선이다. |
| DOM 비면 OCR, Tesseract 뒤 로컬 VLM OCR fallback | HALO observation에는 이미 bounded page text와 interactive element tree가 있고 visual control 경로도 별도 개발 대상이다. OCR은 이미지/메모리 비용이 있고 읽은 문구는 page-origin untrusted data다. | 지금 추가하지 않는다. 향후 unified DOM/CUA benchmark에서 DOM 관측 불능 사례와 비용이 확인되면, OCR 결과를 낮은 신뢰도의 관측 근거로만 연결한다. OCR 좌표로 approval·documentEpoch/stale 검사 없는 실행은 금지한다. |
| Web AI provider registry + 외부 사용 명시적 opt-in | HALO는 model/provider와 browser task를 분리하고, MCP 호출은 연결 provider를 통해 사람이 승인한다. 웹 로그인 세션에서 외부 AI 사이트를 자동으로 호출하는 것은 별도 credential·site-policy 경계다. | 현 단계에서는 가져오지 않는다. 나중에 검토해도 host 설정으로 provider를 pin하고, 사용자 명시 선택/승인 및 외부 전송 표시가 필요하다. Planner가 임의로 외부 AI로 승격하는 자동 동작은 채택하지 않는다. |
| 알림 OCR·메시지 분류·채널 추천(전송 없음) | HALO provenance/context는 외부 페이지 내용을 untrusted로 취급하고 sensitive action을 승인 큐에 둔다. | 제품 범위와 개인 데이터 위험 때문에 제외. 추후 별도 요구가 있더라도 read-only 수집·근거 표시·분류 오류 노출을 먼저 설계하고, 메시지 전송은 독립 승인 없이는 연결하지 않는다. |
| FastAPI task/history/metrics 및 정적 UI | HALO는 Electron IPC/preload와 `TaskHost`가 host 권한을 보유한다. Olma API 기본 bind `0.0.0.0`, 선택적 API key, wildcard CORS 조합은 임의 네트워크 노출에 안전한 기본값이 아니다. | HTTP API/UI 코드를 앱에 붙이지 않는다. 향후 원격 제어 요구가 생기면 인증·origin·승인·host attach 모델부터 별도 설계한다. |
| Ollama HTTP retry 및 모델 호출 | HALO 모델 연동은 allowlisted planner worker의 표준 JSONL/proposal protocol을 쓴다. Olma의 모델 `POST` 재시도는 planner 요청에 한정된 것이며, 이를 browser/MCP action에 일반화하면 중복 실행 위험이 있다. | 필요하면 Ollama를 별도 provider로 구현하되, tool/action call retry와 분리한다. 응답을 proposal로 변환하고 existing host contract로 검증한 뒤에만 controller에 전달한다. |
| OCR 분류 기본값 처리 | Olma의 알림 분류는 검증 실패 시 `personal/low`로 조용히 기본값을 반환한다. HALO는 정책/approval 판단 실패를 명시적 오류로 유지한다. | 분류 실패를 정상적 의미로 대체하지 않는다. 나중에 분류 기능을 만들면 `unknown/unavailable`을 노출하고 provenance 근거를 붙인다. |
| Worker별 기존 브라우저 프로필 복사 | HALO는 task/child 별 agent surface와 origin/epoch 제약을 host에서 관리한다. 기존 로그인 프로필 복사는 인증 cookie와 session을 복제한다. | 프로필 복사 코드를 가져오지 않는다. 동시 작업은 별도 surface와 명시적 browser ownership으로 격리한다. |
| 재시도/backoff, browser 실패 시 alternate target, OCR/VLM fallback | `executor.py`는 실패한 action을 재시도할 수 있다. HALO는 post-dispatch 실패를 `execution_uncertain`으로 내고 자동 재실행하지 않는다. | action 재시도 및 alternate execution은 채택하지 않는다. 안전한 범위의 읽기 전용 관측 재시도도 새로운 관측으로 기록하고, side effect action과 분리한다. |
| 풍부한 mock 테스트 | HALO에도 planner/browser/task recovery/MCP 경계 테스트가 있다. Olma 테스트는 자체 Python sync stack의 fixture와 내부 구현에 결합되어 있다. | 테스트 코드는 복사하지 않는다. 아래의 동등 경계 사례를 HALO의 fake adapter/transport와 crash-recovery fixture로 재현한다. |
| Dockerfile/Compose 배포 | [Dockerfile](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/Dockerfile)과 [docker-compose.yml](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/docker-compose.yml)은 API 앱과 `ollama:latest`를 실행하는 전체 개발 스택이다. | 그대로 재사용 불가. 이번 기능은 고정 digest의 단일 MCP server만 띄우는 host-owned 제한 runner다. |

현재 Docker MCP 작업에 직접 재사용할 Olma 구현은 없다. `[main/index.js]`의 실제 구성에서 MemoryMonitor는 앱 프로세스 전역이지만 ResourceAdmission은 TaskHost가 지연 생성하며, `createHarnessHost()`로 복수 TaskHost가 생길 수 있고 provider factory는 index.js에서 공유된다. 따라서 앱 index에서 ResourceAdmission 하나를 생성해 모든 TaskHost와 provider hook에 직접 전달한다. 또한 Electron `requestSingleInstanceLock()`은 현재 사용하지 않는다. 서비스 모드에서는 `BackgroundRuntimeService`의 capability file/socket이 TaskHost 소유 경계이므로 stale cleanup 권한에 그 구조를 사용한다. 자원 ledger 소유자가 없는 direct UI fallback에서는 Docker MCP를 비활성화해 별도 lock 구현과 중복 manager를 피한다. `executor.py`의 모든 예외 재시도는 side-effect action에 대해 `execution_uncertain`을 보존하는 HALO 계약과 다르다. `memory.py`/`task_store.py`/`task_queue.py`를 추가하면 이중 상태 저장소가 생긴다. README가 설명하는 action·fallback·API도 HALO의 승인 경계와 같지 않다. 따라서 기존 HALO 상태·승인·자원 ledger를 유지하고 코드를 복사하지 않는다. 근거 파일: [Olma README](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/README.md), [planner.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/planner.py), [fallback_planner.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/fallback_planner.py), [router.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/router.py), [schema.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/schema.py), [task_queue.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/task_queue.py), [task_store.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/task_store.py), [memory.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/memory.py), [browser.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/tools/browser.py), [ocr.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/tools/ocr.py), [web_ai_providers.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/web_ai_providers.py), [notifier.py](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/core/notifier.py), [API server](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/api/server.py), [browser tests](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/tests/test_browser.py), [executor tests](https://github.com/songjiun10-collab/classi/blob/claude/ai-assistant-creation-u0fsuo/olma/tests/test_executor.py).

가져올 만한 **개념 수준의 후속 후보**는 세 가지다. (1) 이미 스트리밍 중인 출력처럼 읽기 작업의 완료를 기다릴 때 고정 sleep 대신 bounded 안정화 polling을 쓰되 전체 작업 deadline과 취소를 존중한다. (2) DOM만으로 읽을 수 없는 페이지를 benchmark로 분리해 OCR/CUA 관측 fallback의 성공률·지연·메모리 비용을 측정한다. (3) 별도 planner-provider로 Ollama를 선택적으로 지원하되 기존 HALO proposal 계약·권한 경계와 로컬 자원 budget 안에서만 운용한다. 셋 다 현 Docker MCP 범위에는 추가하지 않으며, 첫 번째도 side-effect 재시도와 결합하지 않는다. 이 판단은 “쓸만한 개념을 HALO 경계 안에 옮길 수 있는지 평가하고, 독립 Olma 런타임은 이식하지 않는다”는 분리다.

## 검토 시 확인할 위험 경계

- v1은 `network=none`과 `network=egress`를 모두 지원하되, egress는 임의 목적지 접근이며 destination/domain 제한이 아니다. connector 활성화 전에 이를 사용자에게 표시하고 사람 확인을 받는다.
- host catalog는 사용자 데이터 디렉터리에서 사람이 직접 관리한다. macOS Docker Desktop file sharing이 허용되지 않는 host path에서는 secret mount를 시작하지 않고 오류를 반환한다.
- Docker Desktop은 host temp secret 파일이 VM으로 복사/캐시될 수 있다. 임시 파일 unlink는 host 디스크나 Docker VM에서 물리적 디스크 소거를 보장하지 않는다.
- `env` secret 방식은 Docker inspect/daemon 데이터에 값이 노출될 수 있음을 명시하고, catalog에 고정 선언된 경우에만 허용한다.
- stale-container 정리는 background runtime capability/socket 소유권과 userData digest가 모두 확인된 경우에만 한다. Electron `requestSingleInstanceLock()`은 전제하지 않는다. 실패하면 자동 삭제를 건너뛴다.
