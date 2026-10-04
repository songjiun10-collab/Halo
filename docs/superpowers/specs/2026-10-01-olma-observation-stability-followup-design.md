# Olma 관측 안정화 후속 설계

## 상태

사용자 설계 검토 대기. 이 문서 작성은 설계 검토 승인을 뜻하지 않으며, 구현은 승인 후 별도 계획 검토를 거친다.

## 목적

Classi 저장소의 `olma/` 전체를 읽고 HALO에 적용할 후속 아이디어를 선별했다. Olma 코드를 그대로 복사하지 않고, 동적 페이지를 고정 시간만큼 무조건 기다리는 대신 유한한 관측 안정화 절차를 HALO의 `BrowserAdapter`에 적용한다. 페이지 관측의 내용·권한·증거 의미와 크기 제한은 바꾸지 않는다.

참조한 Olma 원본은 `songjiun10-collab/classi`의 브랜치 `claude/ai-assistant-creation-u0fsuo`, 커밋 `44d731d410abdd474fe0afa762d67641a33fa9ee`다. 핵심 참고 코드는 `olma/tools/browser.py`의 `_wait_for_response_stable()`(188–227행) 및 `tests/test_browser.py`의 안정화/기한 테스트다.

## 문제

HALO의 `BrowserAdapter.observe()`는 현재 bounded DOM snapshot을 한 번 수집해 반환한다. `navigate()`가 끝난 뒤 SPA나 비동기 페이지가 아직 로딩 중이면 이 관측은 초기 placeholder일 수 있다. 반대로 페이지마다 고정 sleep을 넣으면 이미 안정된 페이지까지 지연된다.

Olma의 응답 안정화는 텍스트 길이만 비교하므로 같은 길이의 내용 교체를 안정으로 오판할 수 있고, 일반 브라우저 작업에 그대로 적용하면 비용이 커진다. HALO는 host가 소유한 element ID, document epoch, 제한된 snapshot, 승인 및 저널 경계를 유지해야 한다.

## 설계

### 관측 시점과 완료 조건

- 안정화 검사는 문서 epoch가 마지막으로 관측된 epoch와 달라진 첫 `observe()`에서만 수행한다. 같은 문서 epoch의 후속 관측은 현재 동작처럼 한 번만 읽는다.
- `about:blank` 초기 관측은 그대로 즉시 반환한다.
- 첫 DOM snapshot은 기다리지 않고 즉시 수집한다. 명시적 로딩 신호가 있거나 의미 있는 본문/제목/요소가 전혀 없는 경우에만 안정화 폴링을 시작한다. 로딩 신호는 `aria-busy="true"` 또는 접근성 role `progressbar`처럼 DOM에서 확인 가능한 한정된 신호로 한다.
- 폴링 간격은 50ms, 최대 추가 대기시간은 600ms, 안정 판정은 의미 있는 snapshot이 연속 3회 동일하고 명시적 로딩 신호가 사라진 경우다. 시간 만료 시 마지막으로 수집한 snapshot을 반환한다. 만료는 관측 실패나 작업 성공으로 바꾸지 않는다.
- 비교 지문은 `url`, `title`, `text`, `elements`의 안정적 JSON 직렬화에 SHA-256을 적용해 만든다. 페이지 데이터는 비교만 하며 로그나 별도 영구 저장소에 쓰지 않는다.
- 생성자에 `settleEnabled`(boolean, 기본 `true`)와 선택적 `onObservationMetric(metric)`를 추가한다. 콜백에는 `{ settleMs, observationBytes, settleOutcome }`만 전달하고 URL·본문·요소명은 싣지 않는다. `settleOutcome`은 `stable`, `not_needed`, `deadline`, `disabled` 중 하나다. 콜백 예외는 관측 결과에 영향을 주지 않는다. metric은 테스트/벤치에서 주입하며 제품 로그에 자동 연결하지 않는다.
- 제공된 `AbortSignal`은 샘플 사이와 대기 중 확인한다. 취소되면 `BrowserAdapterError("observation_cancelled", ...)`로 중단하고 대기 timer/listener를 정리한다. 이미 시작한 Electron `executeJavaScript()` 호출 자체를 강제 종료한다고 주장하지 않는다. 현재 TaskController는 `observe()`에 signal을 전달하지 않으므로 이번 변경에서 task pause/stop 의미는 바꾸지 않는다.

### 제한과 안전 경계

- 기존 DOM 방문 수 500, 요소 100, 텍스트 UTF-8 12KiB 제한을 변경하지 않는다.
- 안정화는 read-only snapshot 반복 수집만 수행한다. 클릭/입력/탐색을 추가하거나 재시도하지 않는다.
- `documentEpoch`, `elementId`, `evidenceCandidate`, provenance, permission mode 및 approval queue semantics는 바꾸지 않는다. 안정화 완료는 정책 승인이나 성공 판정이 아니다.
- 기본값은 동작을 활성화한다. 다만 최초 샘플이 로딩 신호를 보이지 않고 의미 있는 내용을 포함하면 추가 대기 없이 반환하므로 정적 페이지 비용은 사실상 한 번의 기존 관측과 같다.
- 600ms 안에 나타나지 않는 지연 콘텐츠, shadow DOM 내부 전용 로딩 상태, canvas의 실제 시각적 완성은 보장하지 않는다. 이 경우 snapshot은 기존과 같이 부분 관측일 수 있다.

### 계측과 벤치마크

생산 관측 데이터나 URL을 로그에 남기지 않는다. 기존 결정론적 로컬 benchmark와 테스트에서만 다음을 기록한다.

- `observationSettleMs`: 첫 snapshot 시작부터 최종 snapshot 반환까지의 추가 wall time
- `observationBytes`: 반환된 observation JSON의 UTF-8 byte 수
- `settleOutcome`: `stable`, `not_needed`, `deadline`, `disabled` 중 결과
- fixture의 알려진 최종 marker가 관측되었는지 여부

현재 고정 fixture에서 정적 페이지와 지연 콘텐츠 페이지를 분리해 반복한다. 비교군은 안정화 비활성화와 활성화이며 같은 브라우저 adapter, planner, 승인 모드, journal 설정을 사용한다. 보고서는 성공 marker 비율, p50/p95 안정화 시간, 관측 바이트를 함께 보여준다. 이는 외부 모델 품질이나 공개 웹사이트 성능을 측정하는 벤치마크가 아니다.

## 파일 범위

- 수정: `apps/computer-browser/main/harness/browser-adapter.js` — epoch별 안정화, bounded polling, cancellation checks, digest 비교
- 수정: `apps/computer-browser/test/browser-adapter.test.js` — 지연 콘텐츠, 같은 길이 텍스트 교체, 정적 페이지, timeout, 취소, cap 불변 회귀
- 수정: `apps/computer-browser/integration/routine-vs-planner-benchmark.js` — fixture 결과에 정착 시간/관측 byte/marker 여부 추가
- 수정: `apps/computer-browser/test/routine-vs-planner-benchmark.test.js` — 비교 필드와 지표 계산 회귀
- 필요한 경우에만 수정: `apps/computer-browser/fixtures/` — delayed-content 결정론적 fixture

기존 routed-MCP, UI, renderer bundle, TaskHost, permission, journal 형식은 범위 밖이다. 이번 구현에서는 외부 의존성을 추가하지 않는다.

## 완료 및 검증 기준

1. 정적 콘텐츠는 폴링 없이 기존 시점에 반환된다.
2. loading signal/빈 초기 snapshot 뒤 지연된 콘텐츠가 표시되면 안정 조건이 충족된 최종 snapshot이 반환된다.
3. 같은 byte 길이로 본문이 교체되어도 digest 차이로 안정 판정이 리셋된다.
4. 최대 대기시간은 주입 가능한 시계/타이머를 사용한 테스트에서 600ms를 넘지 않고, timeout 시 마지막 snapshot을 반환한다.
5. abort 전에는 최종 결과를 반환하지 않고 중단하며, 열린 timer/listener가 남지 않는다.
6. observation node/element/text cap 및 document epoch/stale-action 테스트가 계속 통과한다.
7. 로컬 paired benchmark에서 marker 성공률, p50/p95 대기 및 observation bytes를 두 모드 모두 계산한다. 성능 향상을 선결 조건으로 주장하지 않고 결과와 제한을 보고한다.
8. 기존 focused 테스트와 전체 `apps/computer-browser` 테스트가 통과한다. 기존 dirty changes는 분리해 보존한다.

## Olma에서 이식하지 않는 항목

- 임의 CSS selector 기반 실행, blanket browser-action retry, browser 실패를 LLM 응답으로 대체하는 성공 fallback, 로그인 프로필 복제, 최근 task 전체의 평문 자동 주입, 기본 `0.0.0.0` unauthenticated API를 이식하지 않는다.
- Task history 및 custom-memory 관리 UX, OCR/CUA 통합, 공개 벤치마크는 유용한 별도 후속 후보이나 이 설계의 독립적인 범위이므로 여기 섞지 않는다.

## 알려진 검증 한계

Olma 원본 테스트는 현재 기본 Python 3.9에서 PEP 604 타입 표기 수집 오류가 발생했고, Python 3.12에는 pytest가 설치되어 있지 않아 실행되지 않았다. 코드 선별은 해당 브랜치의 정적 소스 검토를 포함하되, Olma 테스트 통과를 주장하지 않는다.
