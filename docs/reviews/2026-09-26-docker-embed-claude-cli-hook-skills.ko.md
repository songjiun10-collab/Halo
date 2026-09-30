# Docker 게이트웨이 이미지에 Claude Code CLI·guard-hook·사고 스킬 내장 — 2026-09-26

버그 수정이 아니라 사용자가 명시적으로 요청한 기능 추가다. 게이트웨이
컨테이너 안에서 작업하는 사람·에이전트가 호스트와 동일한 안전 후크와
사고 스킬을 쓸 수 있도록, 이미지 빌드 단계에 Claude Code CLI와 사용자
소유의 두 GitHub 저장소를 설치한다.

## 요청과 결정 경위

"독커 안에 스킬 훅 내장"이라는 요청을 두 차례 `AskUserQuestion`으로
구체화했다.

1. "/goal"은 특정 파일·스킬명이 아니라 "목표를 찾아서"라는 뜻이었다.
2. 대상은 Halo 프로젝트의 실제 게이트웨이 Dockerfile/compose 컨테이너
   내부다 — 별도 devcontainer나 `.claude/` 프로젝트 설정이 아니다.
3. 게이트웨이 컨테이너에는 애초에 Claude Code 프로세스가 전혀 없다는
   점을 지적하자, 사용자는 "Dockerfile에 claude CLI 설치 + plugin
   install 명령 추가"를 명시적으로 선택했다 — 이 저장소의 다른 모든
   빌드 단계가 지키는 "네트워크 없이 재현 가능한 빌드" 원칙이 이
   계층에서는 깨진다는 점, 빌드 시간·이미지 크기가 늘어난다는 점을
   감수하기로 한 결정이다.

대상 저장소 두 개를 `gh api`로 먼저 확인했다.

- `songjiun10-collab/Hook`: `.claude-plugin/marketplace.json` +
  `plugin.json`을 갖춘 정식 Claude Code 마켓플레이스 플러그인
  (guard-hook). `requirements.txt`에 `mcp==2.0.0`, `pyotp==2.10.0`이
  명시돼 있다.
- `songjiun10-collab/Senior-thinking-skills`: `.claude-plugin` 매니페스트
  없음(404) — 각각 `SKILL.md`를 담은 29개 스킬 디렉터리로만 구성돼 있어,
  플러그인 설치가 아니라 Claude Code 스킬 디렉터리(`~/.claude/skills/`)에
  그대로 배치하면 되는 구조다.

## 발견한 문제와 수정

기존 `Dockerfile`은 `useradd --uid 10001 --gid halo --no-create-home
halo`로 서비스 사용자를 만들어 `$HOME`이 아예 없었다. 이 상태로 `claude
plugin install`을 실행하면 (a) `halo`로 실행 시 설정을 쓸 곳이 없어
실패하거나, (b) root로 실행 시 `/root/.claude/`에 설정이 남아 런타임
사용자(`halo`, UID 10001)가 읽을 수 없는 두 갈래 실패로 이어진다. 이를
`--create-home --home-dir /home/halo`로 바꾸고 `HOME=/home/halo` 환경
변수를 추가한 뒤, 플러그인 설치·스킬 clone 단계 자체를 `USER halo:halo`로
전환해서 실행해 홈 디렉터리 소유권과 실행 사용자를 일치시켰다.

## 변경 내용

[Dockerfile](../../Dockerfile)에 다음을 추가했다(기존 `WORKDIR
/app`/`COPY`/`CMD` 블록은 그대로 두고 그 앞에 삽입).

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && pip install --no-cache-dir mcp==2.0.0 pyotp==2.10.0
USER halo:halo
RUN yes | claude plugin marketplace add songjiun10-collab/hook \
    && yes | claude plugin install hook@hook \
    && git clone --depth 1 https://github.com/songjiun10-collab/Senior-thinking-skills.git \
        /home/halo/.claude/skills
USER root:root
```

`claude plugin marketplace add`/`plugin install`의 정확한 비대화형 CLI
계약(전용 플래그가 있는지, 확인 프롬프트를 실제로 내는지)을 확인할 방법이
없어, 표준적인 방어 기법인 `yes | ...`로 확인 프롬프트를 무해하게
우회하도록 했다 — 프롬프트가 없더라도 실패하지 않는다.

`.github/workflows/docker.yml`의 `timeout-minutes`를 10에서 20으로
올렸다. 이번 추가로 빌드 단계가 `apt-get`, `npm install -g`, 저장소
clone까지 새로 수행하므로 기존 10분 한도로는 빠듯할 수 있다는 판단이다.

[docs/DOCKER.ko.md](../DOCKER.ko.md)에 "개발자 도구: Claude Code CLI
내장" 절을 추가해 이 계층의 목적·범위·미검증 항목을 기록했다(기존
2026-09-25 검증 상태 문단은 그대로 두고 그 뒤에 2026-09-26 문단만
추가했다).

`compose.yaml`은 변경하지 않았다. `networks.gateway.internal: true`는
컨테이너 런타임 네트워크에만 적용되고 `docker compose up --build`의
빌드 단계 자체는 Docker의 일반 빌드 네트워크를 쓰므로, 이 설정이 새
네트워크 접근 단계를 막지는 않을 것으로 판단했다 — 다만 이 판단도
실제 빌드로 확인하지 못했다.

## 검증

**미검증.** 이 환경에는 Docker 데몬이 없어 `docker build`/`docker
compose up --build`를 한 번도 실행해보지 못했다. 확인이 필요한 항목:

1. `claude plugin marketplace add`/`claude plugin install`이 `yes |`
   파이프만으로 비대화형 환경에서 실제로 성공하는지, 아니면 별도
   플래그·환경 변수가 필요한지.
2. Debian bookworm 기본 저장소의 `nodejs`/`npm` 버전이 Claude Code CLI가
   요구하는 Node.js 18+ 조건을 만족하는지.
3. `git clone`으로 받은 `Senior-thinking-skills`의 디렉터리 구조가
   Claude Code의 스킬 디렉터리 탐색 규칙과 실제로 맞는지.
4. `.github/workflows/docker.yml`의 CI가 이 변경 이후 실제로 통과하는지
   (아직 재실행해 확인하지 않았다).

기존 게이트웨이 로직(`halo/*.py`)은 이번 변경에서 건드리지 않았으므로
Python 회귀 테스트(418개)는 이 변경과 무관하게 그대로 유지된다 — 별도로
재실행하지 않았다.

## 범위와 한계

- 게이트웨이 런타임은 이 계층을 전혀 참조하지 않는다. `CMD`는 여전히
  `python -m halo.dev_server`뿐이며 `claude` 바이너리를 실행 시 호출하지
  않는다.
- 이 추가는 "네트워크 없는 재현 가능한 빌드"라는 기존 설계 원칙에 대한
  의도적 예외이며, 사용자가 그 트레이드오프를 알고 명시적으로 선택했다.
- `claude plugin` CLI의 정확한 인자 계약을 실제로 확인하지 못했으므로,
  빌드가 실패하면 Dockerfile의 해당 두 줄만 조정하면 된다 — 나머지
  구조(홈 디렉터리, 사용자 전환, 네트워크 계층 분리)는 원인과 무관하게
  유효하다.

- [Dockerfile](../../Dockerfile)
- [docs/DOCKER.ko.md](../DOCKER.ko.md)
- [.github/workflows/docker.yml](../../.github/workflows/docker.yml)
