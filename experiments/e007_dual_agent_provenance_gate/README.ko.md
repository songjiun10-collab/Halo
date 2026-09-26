# E007 — 승인자·실행자 분리 에이전트와 독립 provenance 판정

> 2026-09-26. 이 문서는 이 실험 코드 한 번의 로컬 실행 결과만 기록한다.
> 프로덕션 `halo/authority.py`·`halo/gateway.py`의 보안 계약을 바꾸지
> 않으며, 아래 "정직한 한계"에 적지 않은 어떤 것도 검증했다고 주장하지
> 않는다.

## 배경

실제 배포된 게이트웨이(`halo/gateway.py`)는 승인자(`HALO_APPROVER_KEY`)와
실행자(`HALO_EXECUTOR_KEY`)를 정적 비밀키로만 구분한다 — 그 키를 사람이
쥐든 자동화된 프로세스가 쥐든 코드는 신경 쓰지 않는다. 다만 이 저장소에
유일하게 존재하던 자동화된 종단 간 예시 `tools/docker_smoke.py`는 **한
프로세스가 두 키를 모두 쥐고** 양쪽 역할을 스스로 연기할 뿐이라, "독립된 두
행위자"를 보여주지 못했다. 사용자가 "헤일로는 이제 AI만을 위한 공간"이라는
방향을 게이트웨이 접근 모델의 재설계로 구체화하면서, 두 역할을 각자 자기
키만 쥔 진짜 별도 프로세스로 나눠 실행하는 참조 구현을 요청했다.

## 가설 (Hypothesis)

실행자의 자기 신고(self-report) provenance 필드를 그대로 신뢰하는 승인자는
`provenance="trusted"`라는 자기주장을 그대로 통과시키지만, 호스트(승인자)가
독립적으로 분류한 `host_provenance`를 함께 쓰는 승인자는 동일한 요청을
`MONITORING_GAP`("Provenance self-assertion disagrees with host telemetry")로
잡아낸다. 이는 이 저장소에 이미 기록된 P9-B2 provenance-laundering 패턴을
승인/실행 경계에서 그대로 재현한 것이다.

## 설계 (Design)

- 승인자 AI의 유일한 판단 근거는 기존 `halo.safety_cases.evaluate_trace()` +
  `halo.policy.decide()`다 — 자유 형식 LLM 판단이나 자기 보고 문자열은
  어떤 경로로도 승인에 영향을 주지 않는다. 이미 설치된 `must_hook` Claude
  Code 플러그인을 조사한 결과, 그 플러그인이 시도한 유일한 "AI가 AI를
  승인"하는 패턴(`MEDIUM-APPROVE`)조차 제작자 스스로 "self-servable
  override 문제에서 한 단계 떨어져 있을 뿐"이라 문서화했고, 사람에게 묻는
  `ask()` 경로는 subagent 턴 안에서 조용히 allow로 새는 것도 확인됐다 —
  결정론적이고 검사 가능한 기존 정책 엔진을 쓰면 이 실패 유형이 구조적으로
  재현되지 않는다.
- `ApproverAgent`는 승인 키를 쥔 `GatewayClient`와, 호스트가 독립적으로
  실행자의 provenance를 분류하는 콜백(`classify_provenance`)을 받는다.
  `ExecutorAgent`는 실행 키를 쥔 `GatewayClient`만 가지며 승인 키를 읽는
  코드 경로가 아예 없다.
- `halo/authority.py`·`halo/gateway.py`·`halo/gateway_app.py`·
  `halo/dev_server.py`는 전혀 수정하지 않았다. `Gateway`의 `/approve`·
  `/execute`·`/revoke` 역할 분리는 그대로다.

## 채널

실행자→승인자 사이에는 평문 JSON(`ApprovalRequest`/`ApprovalDecision`)만
오가며, 키 값·정책 내부 `Event`/`Finding`은 절대 이 경계를 넘지 않는다.
단위 테스트·같은 프로세스 안 시나리오는 `LoopbackChannel`을, 실제 두
OS 프로세스 데모는 `UnixSocketChannel`(길이-프리픽스 JSON 프레이밍, 0700
디렉터리 하위, 매 경로 구성 요소에서 symlink 거부, 정확히 한 쌍의
request/decision만 주고받고 close)을 쓴다. `approver_process.py`/
`executor_process.py`는 자기 역할이 아닌 키 환경변수(`HALO_*_KEY` 또는
`HALO_*_KEY_FILE`)가 자신의 프로세스 환경에 존재하면 소켓을 열지 않고
즉시 종료한다.

## 실행

```bash
# 단위 테스트 + wsgiref 실서버 기반 HTTP 종단 간 테스트
.venv/bin/python -m pytest tests/test_e007_dual_agent_provenance_gate.py -v

# 실제 두 OS 프로세스 데모 (사전에 로컬 게이트웨이와 키 파일이 떠 있어야 한다)
python3 tools/init_docker_secrets.py  # 최초 1회
HALO_STATE_DIR=... python3 -m halo.dev_server &
python3 -m experiments.e007_dual_agent_provenance_gate.run_two_process_demo \
    --socket /tmp/e007.sock --gateway-host 127.0.0.1 --gateway-port 8080 \
    --approver-key-file .docker-secrets/approver_key \
    --executor-key-file .docker-secrets/executor_key --provenance trusted
```

## 시나리오

- **정상 흐름**: benign `compute`(sha256) 요청이 findings 없이 ALLOW되고
  실제 HTTP로 `/approve`+`/execute`까지 성공한다.
- **provenance-laundering 핵심 결과**: 자기신고 `trusted`·호스트분류
  `untrusted`인 동일 요청이 `MONITORING_GAP`으로 `DENY`된다. 같은 스위트
  안에서, 호스트 분류를 적용하지 않았다면(`host_provenance=None`) 동일
  요청이 실제로 `ALLOW`에 도달했음을 대조군으로 직접 증명한다.
- **강한 거부 신호**: `SECRET_EGRESS`(비밀 유출)·`PRIVILEGE_ESCALATION`
  (승인 없는 권한 변경)은 자기신고가 `approved=True`·`trusted`여도 무조건
  거부된다. `ApproverAgent`는 항상 `trusted_telemetry=False`로 호출하므로,
  가상의 권한 상승/외부 쓰기 이벤트는 host_provenance와 무관하게 항상
  거부된다(보수적 fail-closed 기본값).
- **REVIEW는 별도 결과**: ALLOW/DENY로 뭉개지지 않고 사유가 호출자에게
  그대로 전달된다.
- **역할 키 분리(양방향)**: 승인 키로 `/execute`, 실행 키로 `/approve`를
  시도하면 각각 403이다(`tools/docker_smoke.py`는 한 방향만 검사했다).
- **실제 2-프로세스**: 반대 역할 키가 자기 환경에 있으면 소켓조차 열지
  않고 종료하며, 정상 조합이면 두 개의 독립된 OS 프로세스가 소켓 하나로
  요청/판정을 주고받아 흐름을 완료한다.

## 측정한 것 / 확인한 것

2026-09-26 로컬 실행: `tests/test_e007_dual_agent_provenance_gate.py` 46개
통과(단위/와이어 형식 10개, 순수 판정 로직 8개, `wsgiref` 실서버 기반 HTTP
종단 간 6개, 실제 2-OS-프로세스 통합 10개, Unix 소켓 프레이밍·경로 방어
11개, `run_two_process_demo.py` 종단 간 1개). 전체 회귀 `.venv/bin/python -m
pytest -q` 464개 통과(기존 418개 + 이 실험 46개). `halo/authority.py`·
`halo/gateway.py`·`halo/gateway_app.py`·`halo/dev_server.py`는 수정하지
않았으므로 이 숫자는 그 모듈들의 기존 동작이 이 실험으로 바뀌지 않았다는
뜻이지, 그 모듈들을 이 실험이 새로 검증했다는 뜻은 아니다.

Claude가 핵심 판단 로직(`experiment.py`: `EventClaim`/`ApprovalRequest`/
`ApprovalDecision`/`GatewayClient`/`ApproverAgent`/`ExecutorAgent`)과
`channel.py`의 `Channel` 프로토콜·`LoopbackChannel`, 그리고 그 위의 단위·
HTTP 종단 간 테스트 26개를 작성했다. Codex가 실제 2-OS-프로세스 배관
(`channel.py`의 `UnixSocketChannel` — 소켓당 프레임 전체에 하나의 데드라인을
적용해 조금씩 흘려보내는 연결이 개별 `recv()` 타임아웃을 우회해 총 대기
시간을 무한정 늘리지 못하게 막는 처리 포함, `_process.py`,
`approver_process.py`, `executor_process.py`, `run_two_process_demo.py`)과
그 위의 테스트 20개를 작성했다 — 승인 판단이 `policy`/`safety_cases`
시맨틱스에 묶여 있는 반면
이 부분은 소켓 프레이밍·서브프로세스 관리가 중심이라, 이미 확정된
`ApproverAgent.serve_once(channel)`/`ExecutorAgent.run(request)` 인터페이스에
맞춰 독립적으로 작업할 수 있었다.

## 정직한 한계 (Honest limits)

- "AI가 AI를 승인한다"는 이 실험의 표현은 **정책 엔진이 승인한다**는
  뜻이지, 검증되지 않은 AI의 자유 판단이 승인한다는 뜻이 아니다.
  `ApproverAgent`의 유일한 판단 근거는 결정론적이고 검사 가능한
  `halo.policy.decide()`이며, 그 입력은 `halo.safety_cases.evaluate_trace()`의
  findings뿐이다. 자유 형식 LLM 프롬프트나 self-report 문자열은 어떤
  경로로도 승인 여부에 영향을 주지 않는다.
- `intent_id`는 여전히 추적용 식별자일 뿐이며(`halo/AUTHORITY.ko.md`), 이
  실험은 "호스트가 인증한 사용자 의도" 확인 요건을 대체하거나 충족하지
  않는다. 프로덕션 `Gateway` 배포에서 승인 키를 쥐는 호스트 서비스는
  (`halo/GATEWAY.ko.md`가 요구하는 대로) 여전히 별도로 사람의 인증된
  의도를 확인해야 하며, 이 실험의 `ApproverAgent`가 그 역할을 대신한다고
  주장하지 않는다.
- `ApproverAgent.classify_provenance`는 이 참조 구현에서 호스트가 설정한
  정적 콜백(CLI `--provenance` 인자)이다 — 실제 mTLS 클라이언트 인증서,
  프로세스 자격 증명, 네트워크 분리 같은 진짜 독립 채널을 구현하지 않았다.
  "자기 신고를 그대로 믿지 않는다"는 메커니즘을 보여주는 것이지, 프로덕션급
  attestation이 아니다.
- `ApproverAgent`는 항상 `trusted_telemetry=False`로 호출한다: 이 데모에는
  독립적으로 획득한 텔레메트리 채널이 없으므로, 가상의 권한 상승/외부 쓰기
  도구 호출은 host_provenance와 무관하게 항상 거부된다(설계상 보수적
  fail-closed이며 버그가 아니다).
- 데모 도구는 부작용 없는 `sha256` 계산 하나뿐이다. `PRIVILEGE_ESCALATION`/
  `SECRET_EGRESS` 관련 테스트는 `evaluate_trace`/`policy.decide()` 수준에서만
  검증되며, 그런 위험한 도구가 실제 `Gateway`에 등록되어 있지 않으므로 그
  경로는 HTTP 종단 간으로 실행되지 않는다.
- 이 실험은 `halo/AUTHORITY.ko.md`의 "기존 safety_cases/policy는 탐지
  평가기이며 그 ALLOW를 capability로 사용하지 않는다"는 기존 문서와 정면으로
  다른 방향(그 ALLOW를 실제 `/approve` 호출의 게이트로 사용)으로 간다는
  점을 숨기지 않는다 — 그것이 이 실험이 존재하는 이유이며, 프로덕션
  `Authority`/`Gateway` 자체의 계약이 바뀐 것은 아니다.
- `UnixSocketChannel`의 파일시스템 하드닝(0700 디렉터리, symlink 거부,
  uid 확인)은 "같은 uid로 실행되는 악의적 프로세스로부터의 격리"를
  보장하지 않는다 — 같은 사용자 권한을 가진 다른 프로세스가 소켓 파일
  자체를 미리 만들거나 경쟁 조건을 노리는 공격까지 막는다고 주장하지
  않는다(`channel.py`의 `UnixSocketChannel` 클래스 docstring 참고).

## 검증

```bash
cd /Users/songjiun/Halo
.venv/bin/python -m pytest tests/test_e007_dual_agent_provenance_gate.py -v   # 36 passed
.venv/bin/python -m pytest -q                                                  # 454 passed
```

- [experiment.py](experiment.py)
- [channel.py](channel.py)
- [approver_process.py](approver_process.py)
- [executor_process.py](executor_process.py)
- [run_two_process_demo.py](run_two_process_demo.py)
- [../../tests/test_e007_dual_agent_provenance_gate.py](../../tests/test_e007_dual_agent_provenance_gate.py)
