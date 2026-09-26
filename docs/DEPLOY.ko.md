# 배포: Mac을 서버로 게이트웨이 인터넷 공개 (1단계 — 프로덕션 서버 + TLS + DDNS)

## 범위

이 문서는 `halo.gateway`를 실제로 인터넷에 노출하기 위한 1단계 구성을
다룬다: 개발용 `wsgiref` 서버를 gunicorn으로 교체하고, TLS reverse proxy를
앞단에 두고, 무료 동적 DNS로 안정적인 호스트네임을 확보한다. **공개 API
래퍼(인증 없는 엔드포인트)는 이번 배치에 포함되지 않는다** — 이유는 아래
"정직한 한계"와 "2단계(범위 밖)"를 참고한다.

`halo/GATEWAY.ko.md`·`README.md`·`docs/DOCKER.ko.md`의 기존 경고("wsgiref를
인터넷 서비스로 쓰지 말라")는 이 문서가 무시하는 대상이 아니라, 이 문서가
채우는 정확한 전제조건이다. 이 배포 이후에도 `halo/GATEWAY.ko.md`의 "배포
판정"(인터넷 공개 운영 준비 완료로 판정하지 않음)은 바뀌지 않는다.

`halo/authority.py`·`halo/gateway.py`·`halo/gateway_app.py`·`halo/dev_server.py`는
이 작업으로 전혀 수정되지 않았다.

## 아키텍처

```
Internet
  -> 집 라우터 (수동 포트포워딩 80,443 -> 이 Mac)
  -> Caddy (Homebrew, 이 Mac에 네이티브 설치, TLS 종료 + 리버스 프록시, 0.0.0.0:80/443)
  -> 127.0.0.1:8080 (기존 compose.yaml의 포트 매핑 그대로, 변경 없음)
  -> Docker 컨테이너 (기존 하드닝 전부 유지: read_only, cap_drop, 리소스 제한, 내부 네트워크)
  -> gunicorn (신규)
  -> halo.wsgi:application
  -> halo.gateway.Gateway.handle()
  -> SQLite (gateway-state 볼륨, 기존 그대로)
```

DuckDNS 갱신은 launchd가 5분마다 별도 실행해 `*.duckdns.org` 레코드가 이
Mac의 현재 공인 IP를 가리키도록 유지한다. 이 갱신 경로는 게이트웨이
요청 경로와 완전히 분리되어 있다 — 게이트웨이가 죽어도 DNS 갱신은 계속되고,
DNS 갱신이 실패해도 이미 연결된 세션에는 영향이 없다.

## 구현된 파일

- [`halo/wsgi.py`](../halo/wsgi.py) — gunicorn용 프로덕션 WSGI 엔트리포인트.
  `dev_server.application()`을 호출하기 전에 `os.umask(0o077)`을 설정한다
  (gunicorn의 `--umask`는 pidfile에만 적용되고 애플리케이션이 만드는
  파일에는 적용되지 않으므로 별도로 필요). `dev_server.py`가 이미 제공하는
  `/healthz`, `load_role_keys()`(Docker secrets 파일 기반 키 로딩)를 그대로
  재사용하며 그 파일들은 손대지 않는다.
- [`Dockerfile`](../Dockerfile) — 기존 `pip install` 줄에 `gunicorn==26.2.0`을
  추가했다. 기존 `CMD`(dev용 wsgiref 서버 실행)는 그대로 남아 있어서
  `docker compose up`을 오버레이 없이 실행하면 지금까지와 동일하게 로컬
  개발용으로 동작한다.
- [`compose.prod.yaml`](../compose.prod.yaml) — 오버레이 전용 파일. `command`를
  gunicorn 호출로 교체하고 `restart: unless-stopped`만 추가한다. 기존
  `compose.yaml`의 하드닝 필드(`read_only`, `cap_drop`, 리소스 제한, 시크릿,
  헬스체크, 네트워크)는 재선언하지 않으므로 그대로 유지된다. 실행:
  ```sh
  docker compose -f compose.yaml -f compose.prod.yaml up --build -d
  ```
  `--worker-tmp-dir=/dev/shm`는 선택이 아니라 필수다 — `compose.yaml`이
  `read_only: true`를 설정하므로 gunicorn sync worker의 하트비트 파일이
  쓸 수 있는 tmpfs가 필요하다.
- [`deploy/Caddyfile`](../deploy/Caddyfile) — 1단계 구성. DuckDNS
  호스트네임(플레이스홀더), 자동 HTTPS, `request_body { max_size 64KB }`.
  **지금은 공개 라우트가 하나도 없으므로 모든 경로를 404로 응답한다** —
  `/approve`·`/execute`·`/revoke`·`/healthz`는 이 Mac의 loopback으로만
  계속 접근한다(`compose.yaml`의 `127.0.0.1:8080:8080` 매핑은 이 작업으로
  바뀌지 않았다). 접근 로그는 남긴다(공개 라우트가 없으므로 로그 경로에
  민감정보가 실리지 않는다 — 유일한 남용 감시 수단).
- [`tools/duckdns_update.py`](../tools/duckdns_update.py) — stdlib만 사용.
  `~/.duckdns/token`·`~/.duckdns/domain`(둘 다 0600, 소유자·정규 파일 확인
  후에만 신뢰 — symlink는 `lstat()`로 거부)에서 읽어 DuckDNS 갱신 URL을
  호출한다. 토큰은 코드·plist·로그 어디에도 남기지 않는다. 검증:
  `tests/test_wsgi.py`, `tests/test_duckdns_update.py`.
- [`deploy/com.halo.duckdns-update.plist`](../deploy/com.halo.duckdns-update.plist) —
  launchd LaunchDaemon 템플릿(5분 간격, `RunAtLoad`). `REPLACE-WITH-*`
  자리를 실제 macOS 사용자명·`which python3` 결과로 채운 뒤 설치한다.
  Caddy 자체의 launchd 등록은 `sudo brew services start caddy`가 자동
  생성하므로 별도 plist를 작성하지 않는다.

## 설치 절차 (요약)

```sh
# 1) 컨테이너 이미지에 gunicorn 반영 + 프로덕션 오버레이로 기동
docker compose -f compose.yaml -f compose.prod.yaml up --build -d
docker compose exec -T gateway python tools/docker_smoke.py

# 2) Caddy 설치 (LaunchDaemon으로, 부팅 시 자동 시작 + 80/443 바인딩)
brew install caddy
sudo cp deploy/Caddyfile /opt/homebrew/etc/Caddyfile   # REPLACE-ME 채운 뒤 복사
sudo brew services start caddy

# 3) DuckDNS 토큰/도메인을 개인 파일로 저장 (본인이 생성한 값)
mkdir -m 0700 -p ~/.duckdns
printf '%s' 'your-subdomain' > ~/.duckdns/domain
chmod 0600 ~/.duckdns/domain
printf '%s' 'your-token' > ~/.duckdns/token
chmod 0600 ~/.duckdns/token
python3 tools/duckdns_update.py   # 수동으로 1회 확인

# 4) launchd 등록 (REPLACE-WITH-* 채운 plist)
sudo cp deploy/com.halo.duckdns-update.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/com.halo.duckdns-update.plist
sudo chmod 644 /Library/LaunchDaemons/com.halo.duckdns-update.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.halo.duckdns-update.plist
```

## 사용자가 직접 해야 하는 것 (어시스턴트가 대신할 수 없음)

1. DuckDNS 계정 생성 + 토큰 발급 — 계정 생성 자체는 대신할 수 없다.
2. **CGNAT 여부를 포트포워딩 시도 전에 먼저 확인한다** — 라우터 관리자
   페이지가 보여주는 공인 IP와 `https://icanhazip.com` 같은 외부 서비스가
   보여주는 IP가 다르면 CGNAT이며, 이 경우 포트포워딩 자체가 불가능해
   이 계획 전체가 성립하지 않는다(Cloudflare Tunnel 등 다른 아키텍처 필요).
3. ISP 약관에 개인 서버 운영·80/443 포트 제한이 있는지 확인한다.
4. 집 라우터 관리자 페이지에서 외부 80·443 포트를 이 Mac의 LAN IP로
   포워딩하고, 그 LAN IP에 DHCP 예약을 설정한다(재부팅 후 IP가 바뀌어
   포워딩이 깨지는 것을 방지).
5. macOS 방화벽에서 Caddy 인바운드 연결을 허용한다.
6. 이 Mac이 절전 모드에 들어가지 않도록 설정하고 전원 연결을 유지한다.
7. Docker Desktop을 로그인 시 자동 실행되도록 설정한다.
8. 배포 후 반드시 **집 밖 네트워크(예: 휴대폰 데이터)에서 접속을
   테스트**한다 — 같은 공유기 안에서는 NAT hairpin을 지원하지 않아 정상
   작동도 실패처럼 보일 수 있다.

## 2단계 (범위 밖 — 별도 승인 필요)

`halo/public_api.py`(인증 없는 `POST /public/hash {"text"} -> {"sha256"}`
엔드포인트)는 설계만 되어 있고 이번 배치에 구현되지 않았다. 이유: 요청마다
승인자 키로 `/approve`, 실행자 키로 `/execute`를 거치며 매번 실제 fsync
디스크 쓰기가 최소 3회 발생하고, `halo/GATEWAY.ko.md`에 이미 기록된 대로
audit 테이블에는 회전·정리 메커니즘이 없다 — 인증 없이 공개하면 무제한
디스크 증가·요청 폭주로 이어지는 실제 남용 벡터다. 1단계가 실제로 안정적으로
동작하는지 먼저 확인한 뒤, 별도로 승인받고 rate limit·요청 상한을 갖춘
상태에서만 진행한다.

## 정직한 한계

- 스톡 Caddy(`brew install caddy`)는 body 크기 제한과 업스트림별 대략적인
  동시성 제한(`max_requests`)만 제공한다. IP별·역할별 실제 rate limit은
  `caddy-ratelimit` 플러그인을 넣은 커스텀 `xcaddy` 빌드가 필요하며 이번
  배치에는 포함되지 않았다.
- 단일 Mac·단일 가정용 회선 구성이다 — 이중화, SLA, 장애 자동 알림이
  없다. 정전·재부팅·ISP 장애 시 사람이 직접 개입해야 복구된다.
- gunicorn 다중 워커의 SQLite 동시 접근은 `BEGIN IMMEDIATE` 트랜잭션으로
  손상 위험은 없지만(잠기면 503로 fail-closed), 실제 부하 상황에서의
  동시 요청 검증은 이 저장소 어디에서도 수행된 적이 없다. 배포 후
  `database is locked`/503이 자주 보이면 `compose.prod.yaml`의
  `--workers=2`를 `--workers=1`로 낮춘다(기존 wsgiref와 동일한 단일 요청
  처리이지만 gunicorn의 크래시·타임아웃 감시는 그대로 얻는다).
- 이번 배치는 기존 인증된 라우트만 TLS 뒤로 옮긴다 — 새 공개 엔드포인트는
  없다(2단계는 위 참고, 별도 승인 후 진행).
- `halo/GATEWAY.ko.md`의 기존 "배포 판정" 갭(외부 불변 감사, 백업/복구,
  OS 수준 도구 격리 등)은 이 작업과 무관하게 그대로 남는다.
- **실제 배포는 이 세션에서 검증되지 않았다(미검증).** 이 세션에는 Docker
  데몬도, 대상 라우터·macOS 시스템 설정에 대한 접근도 없다. 아래 검증
  명령 중 Python 테스트만 이 세션에서 실행·확인했고, Docker/Caddy/DuckDNS/
  launchd를 포함하는 실제 배포 전체 경로는 사용자가 자신의 Mac·네트워크에서
  위 체크리스트를 완료한 뒤 직접 확인해야 한다.

## 검증 명령

```sh
# 이 세션에서 실행·확인됨
.venv/bin/python -m pytest tests/test_wsgi.py tests/test_duckdns_update.py -v
.venv/bin/python -m pytest -q   # 전체 회귀

# 사용자가 자신의 Mac에서 직접 확인해야 함 (미검증)
docker compose -f compose.yaml -f compose.prod.yaml up --build -d
docker compose exec -T gateway python tools/docker_smoke.py
curl https://<duckdns-hostname>/healthz   # 배포 후: 404가 기대값(1단계는 공개 라우트 없음)
```
