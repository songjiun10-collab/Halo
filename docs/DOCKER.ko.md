# Docker 로컬 개발 환경

기존 SHA-256 데모 게이트웨이를 Docker Compose로 실행한다. Docker Engine 또는
Docker Desktop과 Compose v2, 호스트 Python 3가 필요하다.
Python 표준 라이브러리의 단일 요청 처리 `wsgiref` 개발 서버를 사용하므로
인터넷 공개 서비스나 부하가 큰 운영 서버로 사용하지 않는다. 이 `compose.yaml`
단독 실행(로컬 개발)은 아래 내용 그대로 유지되며, `compose.prod.yaml` 오버레이를
추가로 얹는 별도 배포 경로는 [docs/DEPLOY.ko.md](DEPLOY.ko.md)에서 다룬다.

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

## 개발자 도구: Claude Code CLI 내장 (2026-09-26, 미검증)

게이트웨이 이미지의 런타임(`CMD`, `halo/dev_server.py`)은 Claude Code를 전혀
쓰지 않는다. 다만 이 컨테이너 안에서 사람이나 에이전트가 직접 작업할 때
호스트와 동일한 안전 후크·사고 스킬을 쓸 수 있도록, 이미지 빌드 단계에
다음을 추가로 설치한다.

- Node.js/npm과 `npm install -g @anthropic-ai/claude-code`.
- `songjiun10-collab/hook` 마켓플레이스의 guard-hook 플러그인
  (`claude plugin marketplace add` 후 `claude plugin install`)과, 그 MCP
  서버가 요구하는 `mcp==2.0.0`, `pyotp==2.10.0`.
- `songjiun10-collab/Senior-thinking-skills`의 스킬 디렉터리 전체를
  `halo` 사용자 홈(`/home/halo/.claude/skills`)에 clone.

이를 위해 `halo` 사용자를 `--no-create-home`에서 `--create-home`으로
바꿔 실제 `$HOME`을 만들고 `HOME=/home/halo` 환경 변수를 추가했으며,
플러그인 설치·clone 단계는 `USER halo:halo`로 전환한 뒤 실행해 홈 디렉터리
소유권과 실행 사용자가 일치하도록 했다. 이 계층만 빌드 중 npm
레지스트리·GitHub에 접근한다 — 이 저장소의 다른 모든 빌드 단계가 지키는
"네트워크 없는 재현 가능한 빌드" 원칙에 대한 의도적이고 범위가 한정된
예외다. `docker compose up --build`는 Compose의 런타임 네트워크 설정
(`networks.gateway.internal: true`)과 무관하게 Docker의 일반 빌드
네트워크를 쓰므로 이 단계 자체가 막히지는 않을 것으로 예상하지만, 이 역시
로컬에서 실행해보지 못했다.

**미검증 — 실제 빌드 결과가 다를 수 있다.** 이 환경에는 Docker 데몬이 없어
`docker build`를 한 번도 실행해보지 못했다. 특히 다음은 추정이며 확인이
필요하다.

- `claude plugin marketplace add`/`claude plugin install`의 정확한
  비대화형 동작. 현재는 확인 프롬프트를 방어적으로 우회하는 표준 기법인
  `yes | claude ...`를 썼을 뿐, 이 CLI가 실제로 그런 프롬프트를 내는지,
  또는 전용 비대화형 플래그를 요구하는지 확인하지 못했다.
- Debian bookworm 기본 저장소의 `nodejs`/`npm` 패키지 버전이 Claude Code
  CLI가 요구하는 Node.js 18+ 조건을 만족하는지.
- `git clone`이 `/home/halo/.claude/skills`에 스킬 디렉터리를 예상한 형태로
  배치하는지(하위 각 디렉터리가 `SKILL.md`를 담은 구조라고 가정했다).

`docker compose up --build`를 직접 실행해보고, 위 세 가지 중 어느 하나라도
실패하면 정확한 오류 메시지를 알려주기 바란다 — 그에 맞춰 Dockerfile을
수정한다.

## 검증 상태

2026-09-25 로컬에서는 HTTP 승인→실행→재생 거부, 파일 키 입력 검증,
private DB·sidecar, 기존 Gateway 회귀 24개를 확인했다.
Docker 실행 파일이 설치되어 있지 않아 이미지 빌드·Compose 실행은 미검증이다.
추가한 GitHub Actions `Docker development gateway`는 Linux에서 빌드·기동·
권한·스모크·재시작을 검사한다. 해당 CI 결과도 아직 확인하지 않았다.

2026-09-26 Claude Code CLI·플러그인·스킬 내장 추가분은 위 "개발자 도구"
절의 미검증 항목 그대로다. 이미지 빌드 시간·크기가 늘어나며, CI
워크플로도 이제 빌드 단계에서 npm·GitHub 네트워크 접근이 필요해진다는
점을 반영해 CI가 아직 이 변경 이후로 재실행되지 않았다면 결과를 다시
확인해야 한다.
