# Halo 사이트 평가 (2026-10-08)

범위: `web/halo-homepage/index.html`(랜딩), `web/halo-console.html`(콘솔), `deploy/Caddyfile`.
방법: 정적 감사(HTML/CSS/JS·배포 설정 읽기). 실제 브라우저 렌더·Lighthouse·실서버 응답은
미검증이므로 수치는 대비 계산 1건 외에 주장하지 않는다.

## 요약

랜딩은 완성도 높은 비주얼이지만 **배포 경로에서 도달 불가**이고, 상호작용 일부가 실제로
동작하지 않는다(`style-hover`), JS가 없으면 본문이 보이지 않는다. 콘솔과 랜딩의 정체성
(연구 vs 상용)·언어(한/영)가 갈리고, 배포 설정에 placeholder와 사실과 다른 주석이 남아 있다.

## P0 — 깨짐

1. **홈페이지가 배포되지 않는다.** `deploy/Caddyfile:18-21`이 `handle /`에서 모든 경로를
   `/halo-console.html`로 rewrite하고 나머지는 404. `web/halo-homepage/index.html`은
   실서버에서 도달 불가. 랜딩과 콘솔이 한 URL에 겹쳐 있다.
2. **앵커 2개가 깨져 있다.** `halo-homepage/index.html`:
   `<section id="routines" id="guard" id="agents" …>` — 한 요소에 id 3개(중복 id, 첫 것만 유효).
   nav의 `#agents`·`#guard`는 이동하지 않는다.
3. **JS가 없으면 본문이 보이지 않는다.** CSS `[data-r]{opacity:0}` + `[data-r].in{opacity:1}`,
   유일한 `<script>`가 IntersectionObserver로 `.in`을 붙인다. `<noscript>` 폴백이 없다.
   JS 차단·오류·IntersectionObserver 부재 시 9개 reveal 블록이 opacity 0으로 남는다
   (`prefers-reduced-motion` 사용자만 예외로 보인다).
4. **모든 호버 상태가 죽어 있다.** `style-hover` 13곳(`color` 9, `border-color;background` 3,
   `background` 1)은 비표준 속성이고, 이를 처리하는 코드가 스크립트에 없다(스크립트는
   `[data-r]`만 다룬다). 네비·버튼 호버가 브라우저에서 동작하지 않는다.

## P1 — 신뢰/상용

5. **다운로드 CTA가 GitHub 릴리스로 간다.** `github.com/songjiun10-collab/Halo/releases/latest`
   (공개 저장소, ★1, 설명 없음). 상용 브라우저라면 서명·노타라이즈된 자사 도메인 배포,
   버전/체크섬, 업데이트 경로가 필요하다. 보안 리뷰의 C5/C6(미서명·업데이트 부재)와 같은 문제.
6. **콘솔의 원격 경로가 배포 설정과 모순된다.** `halo-console.html`의 스크립트가
   `fetch('/public/hash', …)`(runRemote)를 호출하는데, `Caddyfile` 주석은 "No API routes are
   wired up", "never calls fetch"라고 단언하고 실제 설정은 `/public/hash`를 404로 보낸다.
   주석·구현·배포가 서로 다르다.
7. **랜딩 메타데이터 부재.** 홈페이지에 description·Open Graph·Twitter 카드·canonical·
   favicon이 전무(콘솔엔 description 있음). 검색·공유 미리보기·탭 아이콘 품질이 떨어진다.
8. **브랜드/언어 분열.** 랜딩=영어 상용("The browser that works while you don't",
   "Download for macOS"), 콘솔=한국어 연구("승인과 실행 사이 / AI 컨테인먼트 연구").
   같은 사이트에서 제품 정체성과 연구 정체성이 섞인다.

## P2 — 품질/성능/접근성

9. **접근성**: `aria-*` 0, `<main>`/skip link 없음, 문서 개요가 h1 1 + h2 1뿐(섹션 제목이
   헤딩이 아님). 색 대비는 본문 `#858c86`/`#0c0e0d` ≈ 5.6:1로 AA 통과(직접 계산).
10. **성능**: Google Fonts 원격 로드(서드파티 요청·렌더 블로킹), 인라인 스타일 24KB,
    무한 애니메이션(`hGlow` 9s·`hFloat` 10s·`hRing` 5s), `backdrop-filter: blur(36px)`.
    `Caddyfile`에 `encode`가 없어 gzip/brotli 미적용(24KB/30KB HTML이 매 요청 원문 전송).
11. **배포 설정이 미완성**: `YOUR-EMAIL@example.com`, `REPLACE-ME.duckdns.org`,
    `REPLACE-WITH-ABSOLUTE-PATH-TO/Halo/web` placeholder. 보안 헤더는 HSTS + Server 제거뿐으로
    CSP·X-Content-Type-Options·Referrer-Policy 없음(인라인 스크립트/스타일이 있어 CSP는
    해시/nonce 필요).
12. `<img>` 0(전부 CSS/SVG 아트) → alt 이슈는 없으나 LCP 이미지·srcset 최적화 여지도 없다.

## 잘된 점

- `lang="en"`, viewport, `target="_blank"` 3/3에 `rel="noopener"`.
- `prefers-reduced-motion` 대응, 콘솔의 `color-scheme: dark` + description.
- 랜딩 카피가 제품 모델(승인·가시성)과 일관됨: "every action visible and every permission yours".

## 권고 (우선순위)

1. 배포 정합성: Caddyfile이 랜딩(`/`)과 콘솔(`/console`)을 분리 서빙. `/public/hash`를 실제로
   배선하거나 콘솔의 원격 경로와 Caddyfile 주석을 함께 제거.
2. 중복 id 수정, reveal을 "기본 가시 + JS가 숨김"으로 뒤집거나 `<noscript>` 폴백 추가.
3. `style-hover` 제거 → 실제 CSS `:hover`/`@media (hover:hover)`로.
4. 다운로드: 자사 도메인 + 서명/노타라이즈 + 버전·체크섬, 업데이트 경로 연결.
5. 홈페이지 메타(description/OG/Twitter/canonical/favicon) 추가, Caddyfile에 `encode zstd gzip`
   와 CSP·X-Content-Type-Options·Referrer-Policy 추가.
6. 브랜드/언어 통일(랜딩과 콘솔의 정체성 결정: 제품 vs 연구).

## 미검증

- 실제 브라우저 렌더링, Lighthouse/axe 수치, 실서버 응답 헤더, 모바일 실기기 확인은 하지 않았다.
- 배포 환경의 실제 Caddyfile이 저장소 사본과 다를 수 있다(placeholder가 그대로라면 미배포로 본다).

## 라이브 재검증 (2026-10-08, https://oxyism.com)

- 배포 실체는 **Cloudflare**다(레포 `deploy/Caddyfile`이 아님): `server: cloudflare`,
  `cf-cache-status: HIT`, `content-encoding: gzip`.
- 라이브 본문 = `web/halo-homepage/index.html` + Cloudflare 봇관리 주입 스크립트 1개
  (`/cdn-cgi/challenge-platform/...`). 로컬 사본과의 diff는 그 주입뿐이다.
- **P0 #1 철회**: 홈페이지는 실제로 배포되어 있다. 저장소 `deploy/Caddyfile`(9/26 작성)이 낡아
  랜딩을 서빙하지 않을 뿐이다 — 문서/설정 드리프트(P2)로 강등.
- **P0 #2/#3/#4는 라이브에서 그대로 재현**: 유효 id `top,routines,download,about` →
  `#agents`(4링크)·`#guard`(3링크) 깨짐, `noscript` 0, `style-hover` 13곳·`:hover` 규칙 0.
- **신규(라이브)**: `/`·`/console`·`/halo-console.html`·임의 경로가 전부 **200 + 홈페이지 본문**
  (소프트 404). 콘솔은 게시되지 않았다(Cloudflare SPA 폴백으로 보임).
- **신규(라이브 헤더)**: `strict-transport-security`·`content-security-policy`·
  `x-content-type-options`·`referrer-policy`가 모두 없다(gzip만 있음). 저장소 Caddyfile의 HSTS는
  실효가 없다.

## P0 조치 (2026-10-08, `web/halo-homepage/index.html`)

| 항목 | 조치 | 검증 |
|---|---|---|
| #2 깨진 앵커 | 섹션의 중복 id 3개 제거, 카드 3개에 `id="agents"/"guard"/"routines"` 부여 | 유효 id 6개(top·agents·guard·routines·download·about), 깨진 앵커 0 |
| #3 no-JS | head에 `<noscript><style>[data-r],…{opacity:1;transform:none}</style></noscript>` 추가 | `noscript` 1 |
| #4 죽은 호버 | `style-hover` 13곳 → 클래스(`h-hover-text` 9·`h-hover-card` 3·`h-hover-ghost` 1) + `:hover` 규칙 3개(`!important`로 인라인 스타일 override) | `style-hover` 0, `:hover` 3 |

- 헤드 `<style>` 중괄호 32/32 균형, 문서 내 중복 id 0, 다중 id 요소 0.
- **라이브 반영에는 재배포가 필요하다**(Cloudflare).
- 미검증: 실제 브라우저에서의 호버/JS-off 렌더 스크린샷(머신 부하로 브라우저 기동 불가).
