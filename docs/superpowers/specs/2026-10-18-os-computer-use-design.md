# OS 컴퓨터유즈 설계 (1단계: 관찰 + 클릭/입력, 앱 허용 목록 기반)

상태: 사용자 승인(2026-10-18, "관찰 + 클릭/입력", "ㄱㄱ"). 구현 전 설계.

## 목표

브라우저 밖의 macOS 앱을 에이전트가 보고(관찰) 조작(클릭/입력)할 수 있게 한다.
브라우저 컴퓨터유즈가 이미 가진 안전 구조(`screen-map`, `effect-classifier`,
approver, 사용자 승인)를 그대로 재사용한다. 새로 만드는 것은 (a) OS 백엔드
경계, (b) OS 전용 정책(앱 허용 목록, 보호 창), (c) 두 가지를 잇는 얇은 어댑터다.

## 비목표 (이번 범위 밖)

- 실제 사용자 앱을 시험 중에 조작하는 것. 시험은 가짜 백엔드와 별도 테스트 앱만 쓴다.
- macOS 손쉬운 사용/화면 기록 권한을 코드가 대신 설정하는 것. 사용자가 직접 허용한다.
- 시스템 설정, 키체인, 비밀번호 입력 창 조작(영구 DENY).
- 다중 모니터, 가상 데스크톱 전환, 드래그앤드롭(후속).

## 구조

```
planner ─ action(os_click_at/os_type/os_press_key) ─▶ OsComputerUse (어댑터)
                                                      ├─ os-policy      앱 허용 목록, 보호 창 DENY, 최대 액션 수
                                                      ├─ effect-classifier  기존 모듈 재사용 (AUTO/ASK/DENY)
                                                      ├─ approval gate  기존 action-gate / approver
                                                      └─ OsBackend (인터페이스)
                                                           ├─ FakeOsBackend   시험용, 결정적
                                                           └─ MacOsBackend    screencapture + AX + CGEvent 헬퍼
```

### OsBackend 인터페이스

```ts
interface OsWindow { app: string; bundleId: string; title: string; pid: number; focused: boolean }
interface OsControl { role: string; name: string; x: number; y: number; w: number; h: number; secure?: boolean; disabled?: boolean }
interface OsObservation { id: string; window: OsWindow; controls: OsControl[]; screenshotPng?: Uint8Array }
interface OsBackend {
  observe(): Promise<OsObservation>
  click(x: number, y: number): Promise<void>   // 0..1 정규화 좌표, 관찰 시점의 창 기준
  typeText(text: string): Promise<void>
  pressKey(key: string): Promise<void>
}
```

좌표는 관찰한 창의 0..1 정규화 값이다(브라우저 `click_at`와 같은 계약). 창 이동·크기
변경·포커스 변경이 있으면 관찰은 stale로 처리하고 거절한다(관찰 id 불일치).

## 정책 (os-policy)

1. **앱 허용 목록:** 사용자가 명시한 bundleId만 관찰·입력 가능. 목록이 비어 있으면
   아무것도 하지 않는다(기본 거부).
2. **영구 DENY:** 비밀번호/보안 입력(`secure`), 시스템 설정, 키체인, 터미널,
   Halo 자신의 창. 이름이 비슷한 허용 앱이어도 bundleId로만 판단한다(창 제목은 신뢰하지 않음).
3. **effect 판정:** 클릭 지점 컨트롤을 `classifyTarget`으로 분류한다.
   navigation/input → AUTO(approver 판단), effect → ASK, irreversible/blocked → DENY,
   분류 불가 → ASK(fail closed). 컨트롤이 가려졌거나 비활성이면 거절.
4. **타이핑:** 포커스된 컨트롤이 `secure`이거나 텍스트 입력 역할이 아니면 거절.
   민감 값 규칙(`pii-tiers`)은 브라우저와 동일하게 적용한다.
5. **한도:** 과제당 최대 OS 액션 수, 액션 간 최소 간격, 연속 실패 시 중단.
6. **전역 정지:** 사용자가 누르면 즉시 백엔드를 해제하는 정지 신호(후속 구현은 단축키 헬퍼).
7. **로그:** 모든 OS 액션을 실제 실행 전에 durable 로그에 남긴다(`action_started` 패턴).

## 신뢰 경계

- 화면 텍스트, 컨트롤 이름, 창 제목은 모두 **신뢰할 수 없는 데이터**다. 플래너에게는
  `authority: untrusted_page_derived`로 전달하고, 호스트는 그 안의 지시를 실행하지 않는다.
- 헬퍼 프로세스는 좌표·키·문자열만 받는다. 앱이나 URL 같은 의미 있는 명령은 받지 않는다.

## 시험

- `FakeOsBackend`로 정책 전 경로를 결정적으로 시험: 허용 목록 밖 앱, 보호 창, secure
  필드 타이핑, 가려진 컨트롤, effect 이름(Delete/Send/Buy), stale 관찰, 한도 초과.
- 어댑터가 `action_started`를 실행 전에 남기는지, 거절된 액션은 백엔드를 호출하지 않는지.
- 실제 macOS 백엔드는 이 단계에서 구현하지 않는다(스텁은 `unsupported`를 던짐).
  사용자 확인 후 별도 스펙으로 진행한다.

## 구현 순서

1. `runtime-src/main/harness/os-policy.ts` (순수 함수, TS) + 시험
2. `OsComputerUse` 어댑터 + `FakeOsBackend` + 시험
3. 권한 정책/action-safety/approver 표/플래너 스키마에 `os_*` 액션 선언
4. (사용자 확인 후) `MacOsBackend`와 헬퍼

## 열린 질문

- 앱 허용 목록의 UI(설정 화면 vs 과제별 선언)는 이번에 정하지 않는다. 우선 설정 값으로만 받는다.
- 헬퍼 구현 언어는 Swift를 가정하나, 서명/배포 방식은 후속에서 정한다.
