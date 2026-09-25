# HALO LLM 도구 게이트웨이 운영 인계

## 구현

`halo.gateway_app:create_app`은 WSGI application factory다. 승인과 실행은
서로 다른 Bearer 자격 증명을 요구한다. 서비스는 모델과 별도 프로세스·
사용자로 실행하고, 모델에 승인 키·DB·서비스 코드 접근권을 부여하지 않는다.
모든 입력은 JSON 데이터이며 승인 역할로 인증한 `/approve`만 권한을 발급한다.
승인 키는 인증된 사용자 의도를 확인하는 호스트 서비스만 보유해야 한다.
이 서비스 자체가 최종 사용자 로그인·동의 UI를 제공하지는 않는다.

환경 설정:

- HALO_STATE_DIR: 서비스 사용자 소유 0700의 기존 절대 디렉터리. 신뢰된
  상위 디렉터리 아래 로컬 영속 디스크를 사용한다. NFS/공유 볼륨 금지.
- HALO_APPROVER_KEY / HALO_EXECUTOR_KEY: 각각 독립적으로 생성한 충분히
  무작위인 32자 이상의 ASCII 비밀. 운영 시 비밀 저장소로 주입한다.
- WSGI 서버는 신뢰된 TLS reverse proxy 뒤의 Unix socket 또는 loopback에
  bind한다. proxy에서 body 64KiB 제한, 요청 시간 제한, 역할별 속도 제한,
  동시 요청 제한을 설정한다. 키·요청 본문·응답 토큰을 로그에 남기지 않는다.

WSGI 서버의 factory 설정으로 `halo.gateway_app:create_app()`을 지정한다.
로컬 개발용 Docker Compose 실행은 [Docker 안내](../docs/DOCKER.ko.md)를 따른다.
TLS·인증 프록시는 이 저장소에 구성되지 않았다. 개발용 wsgiref 서버를
인터넷 서비스로 사용하지 않는다.

## API

모든 요청: POST, Content-Type application/json, Authorization Bearer 키.

Content-Length는 ASCII 십진 숫자만 허용하며 부호·공백·밑줄·전각 숫자는
거부한다. 명시적으로 같은 realm을 지정해도 승인자/실행자 키의 identity가
다르면 기존 grant를 사용할 수 없다. 키 교체 시 pending grant 재승인이 필요하다.

- `/approve` (승인자): `{"tool":"sha256","args":{"text":"hello"},"intent_id":"authenticated-request-id"}`
  응답: token, expires_in=60. 요청 필드를 모델 출력에서 자동으로 신뢰하지 않는다.
- `/execute` (실행자): `{"tool":"sha256","args":{"text":"hello"},"token":"issued-token"}`
- `/revoke` (승인자): `{"token":"issued-token"}`

`revoked:true`는 pending 권한을 실제 취소한 경우에만 반환한다.
이미 claimed/completed인 작업이나 없는 토큰은 false이며 실행 중 작업의
중단을 보장하지 않는다. 실행 후 도구 오류는 HTTP 503으로 반환하며
효과 발생 여부를 대조하기 전 새 승인으로 재시도하지 않는다.

알 수 없는 도구, 추가 필드, 중복 JSON 키, 다른 인자, 도구 버전 변경,
만료 및 사용된 토큰은 거부한다. 토큰 원문 대신 SHA-256을 DB에 저장한다.
검증기는 승인·실행 때 호출된다. 도구 어댑터는 신뢰된 호스트가 등록한다.
외부 효과 어댑터는 정확한 리소스 범위·상태 버전·실행 시점 재검사를
자체적으로 구현하고 OS 격리 경계를 갖춰야 한다. 임의 shell/eval 어댑터는 없다.

자동 adapter fingerprint는 Python 코드·중첩 코드 상수·JSON 직렬화 가능한
기본 인자를 묶는다. 같은 Python 런타임과 파일 배치에서 재시작해도 유지된다.
closure, 전역 변수, 외부 패키지·설정까지 자동 추적하는 배포 manifest는 아니다.
이 의존성이 바뀌면 호스트가 `revision` 또는 명시적 `fingerprint`를 변경해야 한다.
함수가 아닌 callable이나 직렬화 불가능한 기본 인자는 명시적 fingerprint를
지정해야 한다. 런타임·코드 배치 변경으로 기존 grant가 거부되는 것은 fail-closed다.

## 장애와 복구

토큰 claim과 사전 감사는 SQLite 트랜잭션에서 함께 커밋한 뒤 도구를 호출한다.
다중 worker가 같은 토큰을 동시에 제출해도 하나만 claim한다. 재시작 후에도
사용된 토큰은 실행되지 않는다. 도구 실행과 SQLite 결과 기록은 분산
트랜잭션이 아니므로 정확히 한 번 성공을 보장하지 않는다.

시계 watermark 검사와 상태 전이는 같은 `BEGIN IMMEDIATE` 트랜잭션 안에서
직렬화한다. 실행 후 clock rollback 또는 감사 기록 실패는 503이며, 실패 기록까지
실패해도 이미 커밋한 claim을 pending으로 복구하지 않는다. rollback 허용치는
유한한 0 이상의 값이어야 한다. 새 DB는 SQLite 연결 전 0600으로 생성한다.
DB만 있고 realm identity가 없으면 자동으로 복구·재발급하지 않고 시작을 거부한다.

claimed 또는 failed_or_uncertain 상태는 효과 발생 여부를 확인하기 전
새 토큰을 발급하여 재시도하지 않는다. HTTP 503도 효과 미발생을 뜻하지 않는다.
DB 백업을 복원하면 이전 pending 토큰이 살아날 수 있으므로 복원 전에 모든
pending 토큰을 폐기하고 실행 상태를 대조해야 한다. DB는 호스트 관리자에
대한 변조 방지 저장소가 아니다. 외부 불변 감사 저장소 연동은 별도다.

pending 권한은 최대 1024개다. 과거 grant/audit 행 보존으로 디스크는 계속
증가하므로 보존 정책과 용량 경보를 운영에서 설정해야 한다.

## 배포 판정

현재는 SHA-256 도구의 로컬 통합 검증까지 제공한다. 인증 프록시, TLS,
프로세스 격리, 외부 도구 어댑터, 외부 감사, 백업/복구 및 실제 호스트 부하
검증이 완료되지 않았으므로 인터넷 공개 운영 준비 완료로 판정하지 않는다.
메타데이터 노출이 남은 Seatbelt 실험 결과도 이 서비스의 격리 보증이 아니다.

검증 명령: `.venv/bin/python -m pytest tests/test_gateway.py tests/test_gateway_adversarial.py tests/test_authority.py -q`
