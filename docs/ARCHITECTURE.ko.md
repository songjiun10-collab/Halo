# HALO 아키텍처와 구성 분리

문서 진입점은 [Computer Browser](../apps/computer-browser/README.md)와
[Container](../deploy/container/README.ko.md)로 나눈다. 현재 코드 위치와 실행
계약을 기준으로 책임을 정리한다.

## 현재 구성

```text
frontend/ React UI
  → computer-browser/preload/ 제한된 IPC
  → computer-browser/main/ipc.js
      → TaskHost → TaskController → BrowserAdapter → Chromium surface
      → ControlApi → legacy browser/demo surface

TaskController
  → planner provider: 관측을 받고 실행을 제안
  → policy / human approval / local Python approver
  → TaskStore: 목표, 이벤트, 실행 결과와 복구 상태

Docker Compose → halo/ gateway → SQLite + realm sidecar
              → /run/secrets 역할 키
```

브라우저의 로컬 Python 승인 서비스와 Docker HTTP 게이트웨이는 별도 실행
경로다. 현재 Compose를 켠 것만으로 브라우저 작업이 컨테이너에 격리되지는
않는다. Electron background service도 데스크톱 호스트 프로세스다.

## 책임과 경계

| 구성 | 소유 책임 | 경계를 넘어 전달하는 값 |
| --- | --- | --- |
| Renderer | 입력, 상태 표시, 승인·중단·takeover UI | 제한된 IPC 요청 |
| Electron host | TaskHost, TaskController, 정책, epoch, 자원 admission | 검증된 action과 관측 |
| Planner | 목표에 대한 다음 행동 제안 | 신뢰하지 않는 proposal |
| BrowserAdapter / surfaces | 관측, Chromium 실행, 문서 epoch와 세션 | 실행 결과와 evidence 후보 |
| 로컬 approver | 독립적인 승인 판정 | 요청에 대응하는 decision |
| Gateway container | 역할 키, 승인 토큰, claim/execute, 영속 DB | HTTP 요청·응답 |
| Research Core | `halo/`, `experiments/`, `rust/`의 연구·검증 구현 | 명시된 모듈·프로토콜 계약 |

Renderer와 페이지에 Node 권한을 주지 않는다. Main은 특권 호스트로 유지되며
IPC sender 검증과 입력 검증이 이 경계를 보호한다. 모델의 provenance 자기
신고는 권한 근거가 아니다. MCP 실행 제안은 권한 모드와 관계없이 사람의
승인 큐를 거친다.

## 폴더 구성

| 경로 | 역할 |
| --- | --- |
| `apps/computer-browser/` | 데스크톱 앱, runtime, preload, 브라우저 테스트 |
| `frontend/` | 앱이 사용하는 React 소스 |
| `deploy/container/` | 컨테이너 실행·운영 README |
| 루트 `Dockerfile`, `compose*.yaml` | 저장소 루트를 build context로 사용하는 실행 파일 |
| `halo/` | 게이트웨이와 안전 경계 구현 |
| `experiments/`, `rust/`, `artifacts/` | 연구 구현, 재현 자료와 측정 결과 |
| `docs/` | 공통 아키텍처, 배포, 설계·검토 기록 |

## 코드 재구성 순서

이번 변경은 README 진입점과 아키텍처 문서를 재구성한다. 아래 코드 이동은
후속 구현 범위이며 현재 적용 상태로 해석하지 않는다.

1. Runtime TypeScript 원본과 생성 JavaScript의 소유 관계를 유지한다.
   직접 생성 파일만 수정하는 경로를 없애고 build/check로 동기화한다.
2. 앱 bootstrap에서 browser runtime, local approver, provider 연결의 생성과
   종료 책임을 각각 분리한다. factory 계약과 shutdown 순서를 먼저 고정한다.
3. UI의 legacy ControlApi 호출과 TaskHost 호출을 구분한다. 호출부와 테스트를
   이전한 뒤 중복 상태·승인 큐를 줄인다.
4. 컨테이너 실행을 browser executor에 연결할 경우 task identity, capability,
   epoch, 취소, uncertain 결과와 evidence의 프로토콜을 먼저 정의한다.
   Docker socket이나 역할 키를 renderer·planner에 전달하지 않는다.
5. 물리적 폴더·저장소 분리는 imports, Python approver 경로, Compose context,
   renderer 출력, CI와 계약 테스트를 함께 이전하는 별도 변경으로 수행한다.

각 단계의 검증은 기존 goal/epoch, 승인 무효화, durable claim, crash recovery와
human takeover 계약을 보존하는 회귀 테스트를 포함한다. 구조 분리는 브라우저
세션이나 컨테이너 격리의 보안 보장을 추가로 입증하지 않는다.
