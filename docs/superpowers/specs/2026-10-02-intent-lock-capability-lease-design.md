# Intent Lock + Capability Lease — 설계

날짜: 2026-10-02 · 상태: 사용자 승인된 방향, 구현 계획 작성됨

> 구현 계획(`docs/superpowers/plans/2026-10-02-intent-lock-capability-lease.md`)에서 바뀐 점: `deny_payment_forms` 보류(adapter가 type/submit 미지원), notes는 기존 `goal.constraints` 재사용, Lend 상한 = 기본값(10분·3회), lease는 재시작 시 복원하지 않음, mode가 거부한 지원 액션은 승인창으로 올림(사용자 결정 "모드도 넓힘"). 계획 쪽 내용이 우선한다.

## 목적

Halo의 보안 구조를 설정값이 아니라 task 단위의 런타임 primitive로 만든다.

- **Intent Lock**: task 시작 시 사용자가 정한 불변 조건을 host가 별도로 저장하고, Agent·Team·Planner 누구도 수정할 수 없게 한다. 긴 작업에서 모델이 목표를 재해석하는 것을 막는 goal checksum.
- **Capability Lease**: 권한을 영구 소유가 아니라 "이 task · 이 origin · N분 · 최대 M회"로 빌려준다. 기간·횟수·task 종료 시 자동 소멸.

이 두 가지는 이후 스펙(Halo Field, Continuity Capsule, Agent Relay, Task Branches)의 기반이다.

## 범위 밖

- Halo Field 시각화(이 스펙의 lease/lock 데이터를 그리기만 하면 되도록 데이터 형태만 정한다).
- agent 간·task 간 lease 이전(Capsule/Relay 스펙).
- 자유 문장 불변 조건을 모델이 액션마다 판정하는 방식(결정론적 보장이 없어 채택하지 않음).
- MCP 도구 호출 경로: 이미 모든 MCP 호출이 사람 승인 큐를 거치므로 이번에는 Lock의 `deny_action`/origin 규칙만 브라우저 액션에 적용한다. MCP 확장은 후속.

## 1. 판정 순서

모든 브라우저 액션은 `apps/computer-browser/main/harness/browser-adapter.js`의 정책 게이트(현재 `evaluateActionPolicy(this._permissionMode, action.type)`) 한 곳을 지난다. 이를 순수 함수 `evaluateGate`로 대체한다.

```
evaluateGate({ lock, mode, leases, action, origin, now }) →
  { outcome: "allow" | "human_review" | "deny", approval, decidedBy, leaseId?, reason }

① Intent Lock 정형 규칙  — 위반이면 deny(decidedBy:"lock"). 어떤 mode·lease·full 모드로도 통과 불가.
② 기본 mode              — 기존 evaluateActionPolicy 결과.
③ Lease                  — ②가 deny 또는 human_review일 때만 조회. 유효한(미만료·usesLeft>0·action·origin 일치) lease가 있으면
                           allow(decidedBy:"lease", leaseId). 여러 개면 만료가 가장 이른 것을 쓴다.
```

- Lease는 권한을 **넓히기만**, Lock은 **좁히기만** 한다. Lock이 항상 이긴다.
- `download` 등 adapter가 지원하지 않는 액션은 lease로도 열리지 않는다(`UNSUPPORTED_ACTIONS` 검사가 게이트보다 먼저).
- `decidedBy`는 기존 task journal 이벤트에 기록되어 provenance가 된다.
- `evaluateGate`는 I/O 없는 순수 함수다. lease 차감은 호출자(task-controller)가 durable하게 수행한다(5절).

## 2. Intent Lock

### 데이터

```
lock: {
  rules: Rule[],          // host가 강제
  notes: string[],        // 완료 시 확인 (각 ≤ 280자, 최대 8개)
  digest: string          // sha256(canonical JSON of {rules, notes}), hex 64
}
Rule =
  | { kind: "deny_action", action: "navigate"|"follow_link"|"click"|"type"|"submit_form" }
  | { kind: "allow_origins", origins: string[] }   // 있으면 이 origin 밖으로 navigate/follow_link 및 그 밖의 액션 금지
  | { kind: "deny_origins", origins: string[] }
  | { kind: "deny_payment_forms" }
```

- origin은 기존 adapter의 origin 정규화(scheme+host+port)를 재사용하고, 저장 시 정규화된 값만 받는다.
- `deny_payment_forms`: 현재 문서의 대상 폼/필드에 `autocomplete`가 `cc-*`이거나 name/id가 card·cvc·cvv·iban·expiry 패턴이면 해당 폼에 대한 `type`/`submit_form`을 deny. 휴리스틱이므로 UI에 "결제 폼으로 보이는 입력 차단"으로 정직하게 표시한다.
- 규칙 종류는 위 4개로 고정. 알 수 없는 kind는 저장 시 거부.

### 생성·변경

- task 시작 composer에서 설정한다. 템플릿 칩(결제 금지 / 폼 제출 금지 / 이 사이트만)과 자유 문장 입력.
- 저장 위치: task-store의 goal 레코드(goal version과 함께). `checkpoint.json` payload에도 포함.
- **쓰기 경로는 사용자 IPC 하나뿐**이다. planner 명령·MCP·room·child agent 경로에는 lock을 쓰는 API가 존재하지 않는다(테스트로 고정).
- 사용자가 lock을 바꾸면 기존 goal amendment와 동일하게 goal version이 올라가고, 진행 중 proposal/approval은 기존 규칙대로 무효화된다.
- 로드 시 digest를 재계산해 불일치하면 `storage_corrupt`로 fail-closed.

### 자유 문장(notes)

- planner 컨텍스트에 "사용자 고정 조건(수정 불가)" 블록으로 읽기 전용 포함.
- task 완료 판정 때 기존 criteria 확인 흐름에 체크 항목으로 붙어 사용자가 확인한다.
- UI는 🔒 **강제**(rules)와 ☑ **완료 시 확인**(notes)을 분리 표시한다. notes를 host가 강제한다고 표시하지 않는다.

## 3. Capability Lease

### 데이터

```
Lease: { id, taskId, action, origin, expiresAt, usesLeft, grantedAt, grantedBy: "user", revokedAt? }
```

- `action`은 mode가 막거나 사람 승인을 요구하는 액션 중 하나(`click`|`type`|`submit_form`|`navigate`|`follow_link`).
- `origin`은 정규화된 단일 origin. 와일드카드 없음.
- 기간 상한 60분, 횟수 상한 20회(host가 검증).
- task-store의 해당 task 레코드에 저장되고 journal에 `lease_granted`/`lease_used`/`lease_revoked`/`lease_expired` 이벤트로 남는다.

### 발급

- **승인창에서만** 발급한다. 기존 Allow / Deny 옆에 **Lend…**.
- 기본값은 현재 요청에서 파생: 이 액션 · 이 origin · 10분 · 3회.
- 사용자는 기간·횟수를 **줄이기만** 가능하다. 액션·origin을 바꾸거나 넓히는 UI는 없다.
- Lend를 누르면 현재 요청도 승인되며, 그 실행이 1회로 차감된다.
- agent/planner는 lease를 만들 수 없고, 일반 승인 요청만 할 수 있다.

### 소멸

다음 중 하나면 즉시 무효:
- `now >= expiresAt` (host의 단조 시계 기준으로 판정, 저장은 wall-clock ISO와 함께)
- `usesLeft == 0`
- 사용자가 칩에서 회수
- task 종료·취소·인계
- **goal version 증가**(의도가 바뀌면 빌려준 권한도 회수)

## 4. UI

- **composer**: Lock 템플릿 칩 + 자유 문장 입력. 설정된 lock은 task 헤더에 🔒 아이콘과 개수로 표시, 클릭 시 rules/notes 목록.
- **승인창**: Lend… 버튼 → 범위 축소 슬라이더(기간, 횟수)와 요약 문구 `submit_form · github.com · 10분 · 3회`.
- **Lease 칩**: task 헤더/툴바에 `Atlas borrowed: submit · github.com · 8 min · 2 left`. 클릭 → 회수 확인.
- **Lock 위반 안내**: deny 시 활동 로그에 "🔒 사용자 고정 조건으로 차단: 폼 제출 금지"처럼 어떤 규칙인지 표시.
- 디자인 토큰만 사용, 기존 컴포넌트(hx-perm 카드, hx-switch) 재사용.

## 5. 내구성·오류 처리

- lease 차감은 **액션 실행 전에** journal에 `lease_used`를 durable하게 append한 뒤 실행한다. 실행 중 크래시 시 횟수는 복원되지 않는다(execution_uncertain과 같은 보수적 원칙).
- 재시작 복구 시 lease는 journal 재생으로 재구성하고, 만료된 것은 `lease_expired`를 기록하며 버린다.
- lock/lease 레코드 형식 오류는 `storage_corrupt` → task를 열지 않음(fail-closed).
- 기존 goal/epoch/admission/approval/durable journal/execution_uncertain 경계는 그대로 둔다. 이 기능은 새 자동 실행 우회를 만들지 않는다. lease로 허용되는 것은 사용자가 승인창에서 명시적으로 빌려준 범위뿐이다.
- `browser-adapter.js`·`permission-policy.js`·`task-store.js`·`task-controller.js`는 현재 `runtime-src`에서 컴파일되는 파일이 아니므로 직접 수정한다. 새 모듈을 `runtime-src`에 둘 경우에만 `npm run build:runtime`으로 컴파일하고 산출물은 손대지 않는다.

## 6. 테스트

- `evaluateGate` 단위:
  - Lock > Lease > mode 우선순위, full 모드에서도 Lock 적용.
  - 만료 경계(`now == expiresAt`은 무효), usesLeft 경계, origin 불일치, 여러 lease 중 가장 이른 만료 선택.
  - unsupported 액션은 lease로 열리지 않음.
- `deny_payment_forms` 휴리스틱: cc-autocomplete, cvc name, 일반 검색 폼(오탐 없음).
- task-store:
  - lock digest 변조 → `storage_corrupt`.
  - `lease_used` 후 크래시 재시작 → 횟수 미복원.
  - goal version 증가 → 모든 lease 무효.
- IPC/권한: planner·MCP·room 경로에 lock/lease 쓰기 API가 없음을 확인하는 테스트.
- 프론트(SSR): Lend 범위 축소만 가능, 🔒/☑ 분리 표시, lease 칩 렌더링, 위반 안내 문구.
