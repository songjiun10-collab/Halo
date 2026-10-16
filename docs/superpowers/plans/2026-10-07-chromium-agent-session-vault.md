# Chromium 에이전트 로그인 유지(세션 금고) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Chromium 엔진에서 에이전트(`persist:halo-agent-<uuid>`)가 한 번 로그인하면 다음 작업과 앱 재시작 뒤에도 로그인이 유지된다.

**Architecture:** `Target.createBrowserContext`로 만든 컨텍스트는 메모리 전용이라 쿠키가 사라진다. 에이전트용 영구 파티션에 한해 쿠키를 암호화 파일(세션 금고)에 저장하고, 컨텍스트를 만들 때 복원한다. 암호화는 기존 Keychain 저장소(`safeStorage` = `createKeychainStorage()`)를 쓴다. 비밀번호는 다루지 않는다. 사람이 로그인한 결과(세션 쿠키)만 재사용한다. Electron 런타임은 이미 `persist:` 파티션이 디스크에 남으므로 범위 밖이다.

**Tech Stack:** TypeScript(CommonJS, strict) → 생성 JS(`node tools/build-runtime.js`), CDP `Storage.getCookies/setCookies`, `node --test`.

## Global Constraints

- 작업 디렉터리 `/Users/songjiun/Halo/apps/computer-browser`.
- `main/harness/*.js` 중 `Generated from runtime-src` 파일은 직접 고치지 않는다. 새 TS 파일은 `tools/build-runtime.js` COHORTS harness `names`, `tsconfig.runtime-harness.json` `files`, `test/runtime-fixture.js` `harnessNames` 세 곳에 모두 등록한다.
- 금고 대상은 `^persist:halo-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` 파티션뿐이다. 일반 작업(`halo-task-*`), 자식(`halo-child-*`)은 저장·복원하지 않는다.
- 암호화를 쓸 수 없으면(`isEncryptionAvailable()` false, basic_text) 저장하지 않고 복원도 하지 않는다(fail closed). 평문 쿠키 파일을 만들지 않는다.
- 파일은 0600, 디렉터리 0700, 임시 파일에 쓰고 rename(원자적). 파일 하나 최대 1 MiB, 쿠키 최대 1500개. 한도 초과나 손상은 무시하고 빈 상태로 시작한다(앱이 죽지 않는다).
- 쿠키 값을 로그, 오류 메시지, journal에 남기지 않는다.
- 비활성화/보관 시 프로필 바이트는 유지한다(기존 정책). 새 삭제 기능은 만들지 않는다.
- 커밋하지 않는다(사용자가 요청할 때만).

---

### Task 1: 세션 금고 모듈 (`session-vault`)

**Files:**
- Create: `runtime-src/main/harness/session-vault.ts`
- Modify: `tools/build-runtime.js`, `tsconfig.runtime-harness.json`, `test/runtime-fixture.js` (이름 `'session-vault'` 등록)
- Test: `test/session-vault.test.js`

**Interfaces:**
- Produces: `createSessionVault(options: { dir: string; storage: { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string }; fs?: typeof import("node:fs") }): { isPersistentPartition(partition: string): boolean; load(partition: string): Promise<Cookie[]>; save(partition: string, cookies: Cookie[]): Promise<boolean>; clear(partition: string): Promise<void> }`
- `Cookie` = CDP cookie 객체(`name,value,domain,path,expires,httpOnly,secure,sameSite` 등). `load`는 검증을 통과한 쿠키만 돌려준다(http/https에 해당하는 domain, name/value 문자열, 세션 쿠키 `expires === -1`도 허용, 이미 만료된 것은 제외). `save`는 저장했으면 true, 암호화 불가·비대상 파티션·한도 초과면 false.
- 파일명은 파티션의 uuid + `.session`. 경로는 `dir` 밖으로 나갈 수 없다.

- [ ] **Step 1: 실패하는 테스트 작성** — 임시 디렉터리와 가짜 storage(XOR 등 가역 변환)로 다음을 검증한다: (a) save→load 왕복이 같은 쿠키를 돌려준다. (b) 비대상 파티션(`halo-task-1`, `persist:halo-agent-../x`)은 save false, load `[]`. (c) `isEncryptionAvailable()` false이면 save false이고 디스크에 파일이 생기지 않는다. (d) 디스크 파일에 쿠키 값(평문)이 들어 있지 않다. (e) 파일 권한 0600, 디렉터리 0700. (f) 손상된 파일/복호화 실패는 `[]`. (g) 만료된 쿠키와 검증 실패 쿠키(domain 비어 있음, value가 문자열 아님)는 load에서 제외. (h) 1500개 초과 save는 false. (i) clear가 파일을 지운다.
- [ ] **Step 2: 실패 확인** — `node --test test/session-vault.test.js` FAIL (모듈 없음).
- [ ] **Step 3: 구현** — `session-vault.ts`. JSON 직렬화 → `storage.encryptString` → tmp 파일 0600로 쓰고 rename. 읽기는 크기 한도 확인 후 복호화·JSON.parse·검증. 오류 메시지에 쿠키 값을 넣지 않는다.
- [ ] **Step 4: 등록·빌드·통과** — 세 곳에 등록 후 `node tools/build-runtime.js && node --test test/session-vault.test.js`, `node tools/build-runtime.js --check`.

### Task 2: `CdpEngine` 통합 (복원, 주기 저장, 해제 시 저장)

**Files:**
- Modify: `runtime-src/main/harness/cdp-engine.ts` (생성 JS는 빌드로)
- Test: `test/cdp-engine-session-vault.test.js` (가짜 transport 단위 테스트 + Chromium 통합 테스트, 바이너리 없으면 skip)

**Interfaces:**
- Consumes (Task 1): `createSessionVault(...)`의 `isPersistentPartition/load/save`.
- Produces: `CdpEngine.setSessionVault(vault | null)`, `CdpEngine.saveSessions(): Promise<void>`. 동작: (1) `contextFor(key, transport)`가 새 컨텍스트를 만든 직후, 해당 키가 영구 에이전트 파티션이면 `vault.load(partition)` 결과를 `Storage.setCookies({cookies, browserContextId})`로 복원한다(실패해도 컨텍스트 생성은 성공). (2) 영구 컨텍스트가 하나라도 있으면 30초마다 `saveSessions()`를 호출하는 타이머(`unref`)를 둔다. (3) `release()`는 컨텍스트를 닫기 전에 `saveSessions()`를 기다린 뒤 타이머를 지운다. (4) `saveSessions()`는 각 영구 컨텍스트의 `Storage.getCookies`를 `vault.save`로 저장한다. `vault`가 없으면 모든 동작이 이전과 같다. `contextKey`/`sessionFor`가 파티션 문자열을 키에서 복원할 수 있도록 영구 컨텍스트 맵 `persistentPartitions: Map<key, partition>`을 둔다.

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 transport(`send` 기록) + 가짜 vault로: (a) 영구 파티션 컨텍스트 생성 시 `Storage.setCookies`가 저장된 쿠키로 호출된다. (b) 일반 파티션은 호출되지 않는다. (c) `release()`가 `vault.save`를 컨텍스트 닫기 전에 호출하고 쿠키는 `Storage.getCookies` 결과다. (d) vault 없음이면 `Storage.*` 호출이 없다. (e) 복원 중 오류가 나도 컨텍스트 id를 돌려준다. (f) 타이머가 `release` 뒤에 남지 않는다. Chromium 통합: 임시 vault 디렉터리와 가짜 storage로, 로컬 http 서버가 `Set-Cookie: sid=abc; Max-Age=3600`을 주는 페이지를 영구 파티션으로 열고 `release()`, 새 엔진·같은 vault로 다시 열어 `document.cookie`/서버가 받은 `Cookie` 헤더에 `sid=abc`가 있는지 확인한다. 바이너리 없으면 skip. 끝나면 Chromium 프로세스가 남지 않아야 한다.
- [ ] **Step 2: 실패 확인** — FAIL.
- [ ] **Step 3: 구현** — 위 인터페이스대로. `Target.createBrowserContext` 이후 `Storage.setCookies`는 `browserContextId`를 넘긴다(기존 `chromium-session.ts` 방식 참고).
- [ ] **Step 4: 통과** — `node tools/build-runtime.js && node --test test/cdp-engine-session-vault.test.js test/cdp-engine.test.js`, `--check`.

### Task 3: 앱 연결과 전체 확인

**Files:**
- Modify: `main/index.js` (Chromium 런타임일 때만 금고 생성·연결), 필요하면 `main/harness/chromium-desktop.js`
- Test: `test/main-entrypoint-lifecycle.test.js`에 연결 확인 추가(기존 패턴 따름) 또는 새 `test/session-vault-wiring.test.js`

**Interfaces:**
- Consumes: Task 1 `createSessionVault`, Task 2 `cdpEngine.setSessionVault`.
- Behavior: `desktopRuntime.isChromium`일 때 `createSessionVault({ dir: path.join(app.getPath("userData"), "agent-sessions"), storage: safeStorage })`를 만들어 `cdpEngine.setSessionVault(vault)`를 호출한다. 앱 종료 경로(약 index.js:804 `cdpEngine.release()`)가 이미 `release()`를 부르므로 저장은 거기서 일어난다. Electron 런타임에서는 아무것도 하지 않는다.

- [ ] **Step 1: 실패하는 테스트** — 기존 `main-entrypoint-lifecycle` 테스트의 방식으로 Chromium 런타임에서 `setSessionVault`가 호출되고 Electron 런타임에서는 호출되지 않음을 확인한다. 기존 패턴으로 어렵다면 vault 생성 로직을 `main/session-vault-setup.js`의 작은 함수(`attachSessionVault({ app, safeStorage, cdpEngine, isChromium })`)로 빼서 그 함수를 테스트한다.
- [ ] **Step 2: 구현·연결**
- [ ] **Step 3: 전체 확인** — `node --test` 전체 통과(기존 1908개 + 신규), `node tools/build-runtime.js --check`, Chromium 프로세스 잔류 없음.
