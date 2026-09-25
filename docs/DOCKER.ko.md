# Docker 로컬 개발 환경

기존 SHA-256 데모 게이트웨이를 Docker Compose로 실행한다. Docker Engine 또는
Docker Desktop과 Compose v2, 호스트 Python 3가 필요하다.
Python 표준 라이브러리의 단일 요청 처리 `wsgiref` 개발 서버를 사용하므로
인터넷 공개 서비스나 부하가 큰 운영 서버로 사용하지 않는다.

## 실행

저장소 루트에서 처음 한 번 역할 키를 생성한다.

```sh
python3 tools/init_docker_secrets.py
docker compose up --build --wait
docker compose exec -T gateway python tools/docker_smoke.py
```

스모크 검사는 승인, 잘못된 역할의 실행 거부, SHA-256 결과, 토큰 재생 거부를
실제 HTTP로 확인한다. 키·토큰·요청 본문은 출력하지 않는다.
호스트 주소는 `http://127.0.0.1:8080`이다. `GET /healthz`는 애플리케이션이
시작되었는지 확인하며 매 요청 DB 상태나 보안성을 검증하는 엔드포인트는 아니다.

```sh
docker compose ps
docker compose logs --tail=30 gateway
docker compose down
```

`down` 후에도 `gateway-state` named volume에 상태를 유지한다. 다시 시작할 때는
기존 키를 유지하고 `docker compose up --build --wait`를 사용한다.
키 생성기는 기존 파일이 있으면 거부하며 자동 교체하지 않는다.
코드 수정은 이미지를 다시 빌드해야 반영된다.

## 권한과 저장 범위

- UID/GID 10001, 읽기 전용 루트 파일시스템, capability 전부 제거,
  no-new-privileges, 프로세스 수·메모리·CPU 제한을 적용한다.
- 컨테이너의 8080 포트를 호스트의 **127.0.0.1**에만 공개한다.
  내부 Docker 네트워크를 사용하며 호스트 디렉터리·Docker 소켓을 공유하지 않는다.
- `/state/private`는 서비스 사용자 소유 0700이다. DB와 realm identity sidecar를
  같은 볼륨에 보관한다. SQLite journal도 이 디렉터리를 사용한다.
- `.docker-secrets`는 호스트 사용자 소유 0700이며 Git·이미지에서 제외된다.
  Compose의 파일 secret은 호스트 파일 권한을 유지하므로 키 파일은 0444로
  생성한다. 호스트에서는 상위 디렉터리가 접근을 제한하고, 컨테이너에서는
  서비스 UID가 `/run/secrets`의 파일을 읽는다. 이 컨테이너 안에는 신뢰하지
  않는 모델·스크립트를 함께 실행하지 않는다.
- 서버는 `_KEY_FILE`에서 키를 읽는다. 같은 역할에 `_KEY` 환경 변수까지
  지정하면 모호한 설정으로 시작을 거부한다. 기본 요청 로그는 비활성화한다.
- 이미지에는 `halo/*.py`와 스모크 도구만 포함한다. 연구 데이터와 전체 개발
  requirements는 설치하지 않는다. `python:3.12-slim` 태그는 불변 digest가
  아니므로 재현 가능한 배포가 필요하면 검증한 이미지 digest를 별도로 고정한다.

## 재시작·복구 주의사항

키와 DB 절대 경로(`/state/private/gateway.sqlite3`)를 유지해야 같은 realm
identity를 읽을 수 있다. 기존 볼륨에 키만 바꾸면 시작이 거부된다.
키 회전은 별도 마이그레이션 작업이며 이 개발 실행기가 자동 처리하지 않는다.
DB만 복사하거나 sidecar를 삭제하지 않는다. 전체 상태 복사도 B2의 snapshot
재생 방지를 보장하지 않는다.

시계가 저장된 watermark보다 과거면 시작이 거부될 수 있다. 호스트/VM 시간을
확인하고 상태를 조사해야 하며, DB 삭제로 자동 복구하지 않는다. pending grant를
다른 호스트로 옮겨 계속 쓰는 운영은 제공하지 않는다.

이 Compose 구성은 SHA-256 게이트웨이 개발용이다. 기존 B1 샌드박스의 metadata
노출이나 B2 외부 감사·복구 문제를 해결했다는 증거가 아니다.

## 검증 상태

2026-09-25 로컬에서는 HTTP 승인→실행→재생 거부, 파일 키 입력 검증,
private DB·sidecar, 기존 Gateway 회귀 24개를 확인했다.
Docker 실행 파일이 설치되어 있지 않아 이미지 빌드·Compose 실행은 미검증이다.
추가한 GitHub Actions `Docker development gateway`는 Linux에서 빌드·기동·
권한·스모크·재시작을 검사한다. 해당 CI 결과도 아직 확인하지 않았다.
