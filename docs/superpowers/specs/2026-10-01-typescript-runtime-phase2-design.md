# HALO TypeScript 런타임 전환 — 2단계 설계

상태: 구현 전 사용자 검토용. 1단계 커밋은 `c2ea9fc`.

## 의도와 성공 기준

사용자가 요청한 2단계는 타입 주석 추가가 아니라 실제 `.ts` 소스를
컴파일한 JavaScript로 브라우저 런타임을 실행하는 전환이다.
전체 런타임을 한 번에 바꾸지 않고, 1단계에서 검사한 공통 계약 네 모듈부터
전환한다. 공개 함수·상수·오류 동작, 승인 경계, journal 데이터 형식은 유지한다.
이번 단계에서 controller·provider·preload·frontend는 전환하지 않는다.

성공 조건:

- 네 모듈의 편집 원본은 실제 TS이며 `strict` 검사에 통과한다.
- 기존 Node/Electron 소비자는 컴파일된 CommonJS JS를 같은 경로로 읽는다.
- 원본과 커밋된 JS 산출물의 불일치를 쓰기 없이 발견한다.
- 계약 경계의 잘못된 입력, 지연 순환 로딩, 공개 export 목록을 검증한다.
- 전체 브라우저 테스트를 실행하고 간헐 실패까지 그대로 기록한다.

## 검토한 대안

1. **기존 JS 경로에 컴파일 산출물 유지 — 선택.** TS와 배포 산출물을 함께
   버전 관리한다. 기존 require 경로와 직접 Node 테스트가 유지되지만,
   중복 수동 편집을 막기 위한 산출물 일치 검사가 필요하다.
2. 별도 dist 디렉터리와 기존 경로의 forwarding shim. 배포 산출물 분리가
   깔끔하지만 fresh clone의 직접 실행, 추가 배포 파일, shim과 실제 모듈의
   순환 참조·정체성 문제를 이번 단계에서 함께 해결해야 한다.
3. 런타임 TS 로더 또는 전체 ESM 전환. 시작 의존성과 로딩 동작까지 바뀌므로
   단계적 이행 목표에 맞지 않는다. 이번 단계에서는 사용하지 않는다.

## 파일 배치와 원본의 소유권

TS 원본:

- `apps/computer-browser/runtime-src/shared/harness-contracts.ts`
- `apps/computer-browser/runtime-src/shared/task-profile-contracts.ts`
- `apps/computer-browser/runtime-src/shared/harness-profile.ts`
- `apps/computer-browser/runtime-src/shared/capability-registry.ts`

컴파일 결과는 기존 `apps/computer-browser/shared/`의 같은 이름 `.js` 네 개다.
각 파일에는 생성 파일이며 TS 원본을 수정해야 한다는 표시를 붙인다.
TS와 JS는 서로 다른 구현 두 개가 아니라 원본과 결정적 산출물이다.
기존 `main/index.js` 진입점과 나머지 수동 작성 JS 파일은 유지한다.

## 모듈 로딩과 타입

출력 형식은 CommonJS, 대상은 ES2022, strict와 noEmitOnError를 유지한다.
현재 패키지의 고정 TypeScript 6.0.2를 사용하며 새 런타임 의존성은 없다.

공개 export key 집합을 그대로 유지한다. `export =` 또는 이에 상응하는
CommonJS 출력으로 불필요한 `__esModule` export가 추가되지 않게 한다.
기존 `harness-contracts` → `task-profile-contracts` 호출은 검증 함수 안에서의
지연 require를 유지한다. 이를 정적 값 import로 끌어올리지 않는다.
타입 전용 참조는 실행 시 import를 추가하지 않아야 한다.

오류 클래스의 타입 전용 필드는 `declare code: string | undefined`처럼 써서
컴파일 결과에 새 class field를 만들지 않는다. 기존 name/code 속성 생성 순서와
JSON 직렬화를 보존한다. 정적 의존 모듈은 typed CommonJS import를 쓰고,
순환 검증 호출은 함수 안의 typed require를 유지한다.

type-tests는 생성 JS가 아니라 TS 원본을 타입 소비자로 읽도록 변경한다.
생성 JS의 주석에서 타입을 다시 추론하는 방식은 쓰지 않는다.
이번 단계는 declaration/sourceMap/importHelpers를 방출하지 않는다.
파일 목록 네 개, allowJs:false, LF 줄바꿈, 주석 유지와 compiler 버전을
고정한다. TS 자체를 Node의 type stripping으로 실행하지 않는다.

외부 입력은 unknown에서 실제 검증으로 좁힌다. 타입을 맞추기 위해 입력을
기본값으로 바꾸거나 강제 변환하지 않는다. 오류의 string | undefined code
동작도 1단계에서 고친 표현 그대로 유지한다. 승인·provenance·journal은
타입 시스템이 아니라 기존 런타임 검증으로 계속 보호한다.

## 빌드와 산출물 검사

브라우저 패키지의 전용 명령을 추가한다:

- `build:runtime`: 네 TS 모듈을 임시 디렉터리에서 컴파일한 뒤 정확히 네
  생성 파일만 갱신하는 명시적 개발자 작업이다. 앱과 background service를
  종료한 상태에서 실행한다. 실행 중인 앱을 임의로 종료하지 않는다.
- `check:runtime`: 같은 컴파일 결과와 커밋된 JS를 바이트 비교한다.
  불일치·누락·컴파일 오류는 비정상 종료하고 저장소에는 쓰지 않는다.
- `typecheck`: TS 원본과 compile-only 타입 테스트를 검사한다.
- `npm test`: 먼저 산출물 일치를 검사하고 기존 `node --test`를 실행한다.
  직접 `node --test`는 커밋된 JS로 계속 실행되지만 일치 검사까지는 하지 않는다.

기존 전체 `build`는 쓰기 없는 check:runtime을 성공시킨 다음 frontend를
빌드한다. `start`와 renderer e2e도 이 경로를 사용한다. 즉, 앱 시작·테스트가
조용히 생성 JS를 수정하지 않는다. TS 변경 후에는 별도로 build:runtime을
실행해야 하며, 그 전에는 기본 명령이 stale artifact 오류로 종료한다.

컴파일 중 타입 오류가 있으면 기존 산출물을 전혀 갱신하지 않는다.
임시 파일은 OS 임시 디렉터리 하위의 새 private 디렉터리를 사용한다.
입출력 경로는 CLI 사용자 입력이나 glob에서 받지 않고 고정 목록으로 제한한다.
소스·목적지 symlink는 거부하고, 재생성 범위 밖 파일은 삭제하지 않는다.
부모 디렉터리도 확인한다. 컴파일 전후 소스·설정의 digest가 달라지면
새 산출물을 게시하지 않고 실패한다. 결정적 출력에 timestamp나 임시 경로를 넣지 않는다.

같은 checkout의 동시 생성은 fail-fast 잠금으로 거부한다.
컴파일 완료 후 개별 파일은 임시 sibling 파일과 rename으로 교체한다.
네 파일 전체가 한 번에 교체되는 원자성을 주장하지 않는다: 중간 실패 시
혼합 산출물이 남을 수 있고, check가 이를 거부하며 정상 재빌드로 복구한다.
기존 실행 프로세스를 hot reload하지 않는다. 쓰기 빌드는 앱·background service가
정지된 개발 환경에서만 지원한다. 프로세스 이름 검색으로 완전한 정지를 증명하거나
여러 파일 교체의 원자성을 보장한다고 주장하지 않는다. 기본 launch/test는 쓰기 없이
검사하므로 이 제약을 우회해 실행 중인 서비스 파일을 갱신하지 않는다.
생성 작업 중 앱 재시작은 피한다.
이 검사는 개발·배포 무결성 도구이지 악의적인 checkout 변조에 대한 서명 검증이 아니다.

## 검증과 CI

- 공개 export key, 함수 호출 및 오류 결과를 기준 커밋과 비교한다.
- export key 순서와 오류 인스턴스 key 순서까지 확인한다. __esModule을 추가하지
  않는다. 컴파일에 따른 스택 트레이스 줄 번호 변화는 허용하며 문서에 명시한다.
- 양쪽 순서에서 모듈을 로드하고 지연 journal 검증을 실제 호출한다.
- 컴파일 실패 시 기존 JS 보존, stale/missing 산출물 발견, 검사 모드의
  무쓰기, 동시 생성과 symlink 거부를 disposable fixture로 검증한다.
- TS 소비자의 정상 입력 타입과 잘못된 입력 타입을 compile-only 테스트로 검사한다.
- 전체 로컬 macOS 브라우저 suite와 최소 Electron 실제 실행을 검증한다.
  기존 메모리 샘플·잠금 경합의 간헐 실패는 사라졌다고 추정하지 않는다.
- 기존 Python/Rust workflow는 유지한다. 별도 browser 타입/산출물 검사 job은
  Node 24에서 compiler 의존성을 설치하고 typecheck/check를 실행한다.
  Electron 전체 suite가 Linux headless 환경에서도 검증됐다고 주장하지 않는다.
- npm을 우회하는 직접 Electron 스크립트와 LaunchAgent는 커밋된 JS를 쓴다.
  준비·배포 시 일치 검사가 필요하며, 그 경로 자체에 runtime compiler를
  주입하거나 모든 수동 실행을 검사한다고 주장하지 않는다.

## 협업 범위

설계 승인 후 Claude는 네 TS 원본 변환만 담당한다. Codex는 compiler 설정,
build/check 도구와 테스트, npm·CI 연결, 문서와 최종 생성 JS 통합을 담당한다.
Claude가 생성 JS를 수동 편집하지 않고 Codex가 TS 원본을 동시에 수정하지 않는다.
서로의 결과가 일치할 때만 최종 빌드·검증·커밋을 진행한다.

## 후속 범위

이 단계가 끝나도 전체 Halo가 TS로 바뀐 것은 아니다. MCP provider/broker,
controller/scheduler, main/preload 전환은 각각 다음 단계로 남긴다.
이번 단계의 산출물 검사를 통과했다고 전체 기능·보안 완료로 표시하지 않는다.
