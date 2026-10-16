# Halowright 묶음 1 구현 계획 (효과 확인, locator와 자동 대기, 종료 전 보고 강제)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쓰기 동작이 효과를 확인한 뒤에만 `ok`를 반환하고, 이름 기반 locator가 자동 대기 후 실행되며, 자식 에이전트가 보고 없이 완료로 인정되지 않게 한다.

**Architecture:** `runtime-src/main/harness/`에 순수 TS 모듈 두 개(`effect-verifier.ts`, `halowright-locator.ts`)를 추가하고 `node tools/build-runtime.js`로 `main/harness/*.js`를 생성한다. `BrowserAdapter._coordinateAction`이 효과 확인을 부르고, `ChildAgentCoordinator`가 보드 보고 여부를 기록한다. 스펙: `docs/superpowers/specs/2026-10-07-halowright-design.md` 1, 2, 7절.

**Tech Stack:** TypeScript(CommonJS, strict) → 생성된 JS, `node --test`, CDP(`CdpEngine`) + 사용자 Chromium(`HALO_CHROMIUM` 또는 `~/chromium/src/out/Trial/Chromium.app`).

## Global Constraints

- 작업 디렉터리는 `/Users/songjiun/Halo/apps/computer-browser`. 이 디렉터리 기준 상대 경로를 쓴다.
- `main/harness/*.js` 중 `Generated from runtime-src` 헤더가 있는 파일은 직접 고치지 않는다. `runtime-src`를 고치고 `node tools/build-runtime.js`를 실행한다. 새 TS 파일은 `tools/build-runtime.js`의 `COHORTS`(harness `names`)와 `tsconfig.runtime-harness.json`의 `files` 둘 다에 등록한다.
- 새 코드는 TypeScript로 쓴다. 기존 JS 파일(`browser-adapter.js`, `child-agent-coordinator.js`)은 해당 부분만 최소 수정한다.
- 부작용이 있는 동작(전송, 클릭 후 제출)은 효과 미확인 시 자동 재시도하지 않는다. 읽기성 동작만 1회 재시도.
- 모델이 쓴 문자열은 호스트 프로세스에서 실행하지 않는다. 페이지 안 실행은 격리 월드(`executeJavaScriptInIsolatedWorld`)에서만 한다.
- 비밀값 입력과 CAPTCHA 우회는 다루지 않는다.
- 효과 확인 단계는 `webContents`에 `executeJavaScript`가 없으면(기존 테스트의 fake) 건너뛰고 기존과 같이 `ok`를 반환한다. 기존 테스트가 그대로 통과해야 한다.
- 커밋은 사용자가 요청할 때만 한다. 각 Task 끝의 커밋 단계는 사용자 승인 후에만 실행한다. 커밋 메시지 끝에 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

---

### Task 1: 효과 확인 모듈 (`effect-verifier`)

**Files:**
- Create: `runtime-src/main/harness/effect-verifier.ts`
- Modify: `tools/build-runtime.js` (harness `names`에 `'effect-verifier'` 추가), `tsconfig.runtime-harness.json` (`files`에 추가)
- Test: `test/effect-verifier.test.js`

**Interfaces:**
- Produces:
  - `interface PageSnapshot { url: string; title: string; nodes: number; textLength: number; focus: string; valueLength: number }`
  - `const PAGE_SNAPSHOT_SOURCE: string` (격리 월드에서 실행하면 `PageSnapshot` JSON 문자열을 반환하는 즉시 실행 함수 소스)
  - `diffSnapshots(before: PageSnapshot, after: PageSnapshot): string[]` (바뀐 필드 이름 목록, 같으면 `[]`)
  - `verifyEffect(options: { before: PageSnapshot; read: () => Promise<PageSnapshot | null>; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<{ observed: boolean; changed: string[] }>`
  - `parseSnapshot(raw: unknown): PageSnapshot | null`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/effect-verifier.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { diffSnapshots, verifyEffect, parseSnapshot } = require("../main/harness/effect-verifier");

const base = { url: "https://a.test/", title: "A", nodes: 10, textLength: 100, focus: "INPUT#q", valueLength: 3 };

test("diffSnapshots names exactly the fields that changed", () => {
  assert.deepEqual(diffSnapshots(base, { ...base }), []);
  assert.deepEqual(diffSnapshots(base, { ...base, valueLength: 0 }), ["valueLength"]);
  assert.deepEqual(diffSnapshots(base, { ...base, url: "https://a.test/r", title: "R" }), ["url", "title"]);
});

test("verifyEffect returns observed as soon as the page changes", async () => {
  const reads = [base, base, { ...base, valueLength: 0 }];
  const slept = [];
  const result = await verifyEffect({ before: base, read: async () => reads.shift() ?? base, sleep: async (ms) => { slept.push(ms); }, timeoutMs: 1000, intervalMs: 100 });
  assert.deepEqual(result, { observed: true, changed: ["valueLength"] });
  assert.equal(slept.length, 2);
});

test("verifyEffect reports not observed after the timeout when nothing changes", async () => {
  let reads = 0;
  const result = await verifyEffect({ before: base, read: async () => { reads += 1; return base; }, sleep: async () => {}, timeoutMs: 500, intervalMs: 100 });
  assert.deepEqual(result, { observed: false, changed: [] });
  assert.equal(reads, 5);
});

test("an unreadable page counts as a change only when it was readable before and now has a different url", async () => {
  const result = await verifyEffect({ before: base, read: async () => null, sleep: async () => {}, timeoutMs: 200, intervalMs: 100 });
  assert.equal(result.observed, false);
});

test("parseSnapshot accepts the page script's JSON and rejects anything else", () => {
  assert.deepEqual(parseSnapshot(JSON.stringify(base)), base);
  assert.equal(parseSnapshot("not json"), null);
  assert.equal(parseSnapshot(JSON.stringify({ url: 1 })), null);
  assert.equal(parseSnapshot(undefined), null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/effect-verifier.test.js`
Expected: FAIL (`Cannot find module '../main/harness/effect-verifier'`)

- [ ] **Step 3: 구현** — `runtime-src/main/harness/effect-verifier.ts`

```ts
"use strict";

// After a write action (Enter, click, typed text) the host looks at the page
// again and only calls the action "ok" when something it can measure changed.
// The measurement is the host's own; nothing the agent says about the result is used.

interface PageSnapshot { url: string; title: string; nodes: number; textLength: number; focus: string; valueLength: number }
interface EffectResult { observed: boolean; changed: string[] }
interface VerifyOptions {
  before: PageSnapshot;
  read: () => Promise<PageSnapshot | null>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

const FIELDS: readonly (keyof PageSnapshot)[] = ["url", "title", "nodes", "textLength", "focus", "valueLength"];

// Runs in the isolated world. Returns a JSON string so the value crosses the boundary unchanged.
const PAGE_SNAPSHOT_SOURCE = `(() => {
  const a = document.activeElement;
  const focus = a && a !== document.body ? a.tagName + (a.id ? "#" + a.id : a.getAttribute("name") ? "[" + a.getAttribute("name") + "]" : "") : "";
  const valueLength = a && typeof a.value === "string" ? a.value.length : -1;
  return JSON.stringify({
    url: location.href, title: document.title,
    nodes: document.getElementsByTagName("*").length,
    textLength: (document.body && document.body.innerText || "").length,
    focus, valueLength,
  });
})()`;

function parseSnapshot(raw: unknown): PageSnapshot | null {
  if (typeof raw !== "string") return null;
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const ok = typeof value.url === "string" && typeof value.title === "string" && typeof value.focus === "string"
    && Number.isFinite(value.nodes) && Number.isFinite(value.textLength) && Number.isFinite(value.valueLength);
  return ok ? { url: value.url, title: value.title, nodes: value.nodes, textLength: value.textLength, focus: value.focus, valueLength: value.valueLength } : null;
}

function diffSnapshots(before: PageSnapshot, after: PageSnapshot): string[] {
  return FIELDS.filter((field) => before[field] !== after[field]);
}

async function verifyEffect({ before, read, sleep, timeoutMs = 1500, intervalMs = 100 }: VerifyOptions): Promise<EffectResult> {
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await sleep(intervalMs);
    const after = await read().catch(() => null);
    if (!after) continue;
    const changed = diffSnapshots(before, after);
    if (changed.length > 0) return { observed: true, changed };
  }
  return { observed: false, changed: [] };
}

export = { PAGE_SNAPSHOT_SOURCE, parseSnapshot, diffSnapshots, verifyEffect };
```

Note: 이 파일은 `export =` 형태라 `PageSnapshot` 타입을 내보내지 않는다. 다른 TS 파일이 타입이 필요하면 그때 `import type`로 가져오지 말고 해당 파일에서 같은 모양을 다시 선언한다(기존 하네스 파일들의 관례).

- [ ] **Step 4: 빌드 등록 후 통과 확인**

`tools/build-runtime.js`의 harness `names` 배열 끝(`'browser-input'` 뒤)에 `'effect-verifier'`, `tsconfig.runtime-harness.json`의 `files` 끝에 `"runtime-src/main/harness/effect-verifier.ts"`를 추가한다.

Run: `node tools/build-runtime.js && node --test test/effect-verifier.test.js`
Expected: 5 tests PASS, `main/harness/effect-verifier.js`가 생성됨

- [ ] **Step 5: 런타임 일치 확인**

Run: `node tools/build-runtime.js --check`
Expected: 오류 없이 종료

- [ ] **Step 6: 커밋(사용자 승인 후)**

```bash
git add runtime-src/main/harness/effect-verifier.ts main/harness/effect-verifier.js tools/build-runtime.js tsconfig.runtime-harness.json test/effect-verifier.test.js
git commit -m "feat: effect verifier for write actions"
```

---

### Task 2: 좌표·키 동작에 효과 확인 연결

**Files:**
- Modify: `main/harness/browser-adapter.js` (`_coordinateAction`, 약 878-922행; 파일 상단 require 영역)
- Test: `test/browser-effect-verification.test.js`

**Interfaces:**
- Consumes (Task 1): `PAGE_SNAPSHOT_SOURCE`, `parseSnapshot`, `verifyEffect`.
- Produces: `press_key`(Enter만), `click_at`, `type_at`가 효과를 확인한다. 관찰되면 `{ status: "ok", effect: { observed: true, changed: [...] } }`, 관찰되지 않으면 `{ status: "uncertain", errorCode: "effect_not_observed" }`. `Tab`, `Escape`, `Backspace`, `ArrowDown`은 확인 없이 기존대로 `ok`. `webContents.executeJavaScript`가 없으면 기존 동작.

먼저 `main/harness/browser-adapter.js`를 열어 다음을 확인한다: `_coordinateAction`이 쓰는 `wc`는 `this._view.webContents`이고, 이 클래스가 격리 월드 실행을 부르는 기존 방식(`INTERACTION_WORLD_ID`와 `executeJavaScriptInIsolatedWorld`)을 `_interact` 안에서 어떻게 쓰는지(약 950-990행). 같은 호출 방식으로 스냅샷을 읽는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/browser-effect-verification.test.js`

테스트는 실제 `BrowserAdapter`에 fake view를 주고, 좌표 동작 직전 상태를 만들기 위해 `_visualBinding`/`_latestObservation`을 직접 세팅한다. 이 세팅 방법은 `test/text-computer-use.test.js`와 `test/browser-interactions.test.js`에서 `captureTextObservation` 호출 뒤의 상태를 쓰는 부분을 그대로 따라 한다(먼저 두 파일에서 `_visualBinding`을 만드는 헬퍼를 찾아 재사용한다).

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

// A fake page whose snapshot is scripted per read. `snapshots` is consumed in order; the last one repeats.
function fakeView(snapshots) {
  const events = [];
  let reads = 0;
  const webContents = {
    getURL: () => snapshots[0].url,
    sendInputEvent: (event) => { events.push(event); },
    insertText: () => {},
    selectAll: () => {},
    executeJavaScriptInIsolatedWorld: async () => JSON.stringify(snapshots[Math.min(reads++, snapshots.length - 1)]),
  };
  return { events, view: { webContents, getBounds: () => ({ width: 1440, height: 900 }) } };
}

const page = { url: "https://page.test/", title: "t", nodes: 10, textLength: 50, focus: "INPUT#q", valueLength: 4 };

async function adapterReady(snapshots) {
  const { events, view } = fakeView(snapshots);
  const adapter = new BrowserAdapter({ view });
  // Reuse the same setup the existing coordinate-action tests use to mint a valid visual binding.
  adapter._latestObservation = { id: "obs" };
  adapter._documentEpoch = 3;
  adapter._visualBinding = { observationId: "obs", documentEpoch: 3, origin: "https://page.test", viewport: { width: 1440, height: 900 } };
  return { adapter, events };
}

test("Enter that changes nothing is uncertain, not ok", async () => {
  const { adapter } = await adapterReady([page]);
  const result = await adapter.execute({ type: "press_key", observationId: "obs", key: "Enter" }, { documentEpoch: 3 });
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
});

test("Enter that clears the input is ok and reports what changed", async () => {
  const { adapter } = await adapterReady([page, page, { ...page, valueLength: 0 }]);
  const result = await adapter.execute({ type: "press_key", observationId: "obs", key: "Enter" }, { documentEpoch: 3 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.effect, { observed: true, changed: ["valueLength"] });
});

test("Tab is not checked for an effect", async () => {
  const { adapter } = await adapterReady([page]);
  const result = await adapter.execute({ type: "press_key", observationId: "obs", key: "Tab" }, { documentEpoch: 3 });
  assert.equal(result.status, "ok");
});

test("a page object without script execution keeps the old behavior", async () => {
  const { events, view } = fakeView([page]);
  delete view.webContents.executeJavaScriptInIsolatedWorld;
  const adapter = new BrowserAdapter({ view });
  adapter._latestObservation = { id: "obs" };
  adapter._documentEpoch = 3;
  adapter._visualBinding = { observationId: "obs", documentEpoch: 3, origin: "https://page.test", viewport: { width: 1440, height: 900 } };
  const result = await adapter.execute({ type: "press_key", observationId: "obs", key: "Enter" }, { documentEpoch: 3 });
  assert.equal(result.status, "ok");
  assert.ok(events.length > 0);
});
```

기존 coordinate 테스트가 쓰는 binding 필드가 위와 다르면(필드 이름, `taskId`/`agentId`/`digest` 요구 등) 그 테스트의 헬퍼를 가져와 쓴다. 이 단계의 목적은 "Enter가 효과 없으면 `uncertain`"이라는 동작을 고정하는 것이다.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/browser-effect-verification.test.js`
Expected: 첫 테스트 FAIL (현재는 `ok` 반환), 나머지 중 `effect` 필드 기대는 FAIL

- [ ] **Step 3: 구현**

`main/harness/browser-adapter.js` 상단 require 영역에 추가:

```js
const { PAGE_SNAPSHOT_SOURCE, parseSnapshot, verifyEffect } = require("./effect-verifier");
```

`BrowserAdapter` 클래스에 메서드를 추가한다(`_coordinateAction` 바로 위):

```js
  // Reads the host-measured page snapshot, or null when this page cannot run scripts
  // (a test double) or the read fails.
  async _readSnapshot(wc) {
    if (typeof wc.executeJavaScriptInIsolatedWorld !== "function") return null;
    try {
      const raw = await wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code: PAGE_SNAPSHOT_SOURCE }]);
      return parseSnapshot(Array.isArray(raw) ? raw[0] : raw);
    } catch { return null; }
  }

  // Wraps a write action: `perform` sends the input. ok only when the page measurably changed.
  async _withEffectCheck(wc, perform) {
    const before = await this._readSnapshot(wc);
    perform();
    if (!before) return { status: "ok" };
    const effect = await verifyEffect({ before, read: () => this._readSnapshot(wc), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    return effect.observed ? { status: "ok", effect } : { status: "uncertain", errorCode: "effect_not_observed" };
  }
```

`_coordinateAction`의 `try` 블록을 다음으로 바꾼다. 확인 대상은 `Enter`, `click_at`, `type_at`뿐이다.

```js
    try {
      if (normalized.type === "press_key") {
        const send = () => {
          wc.sendInputEvent({ type: "keyDown", keyCode: normalized.key });
          if (normalized.key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "Enter" });
          wc.sendInputEvent({ type: "keyUp", keyCode: normalized.key });
        };
        if (normalized.key !== "Enter") { send(); return { status: "ok" }; }
        return await this._withEffectCheck(wc, send);
      }
      return await this._withEffectCheck(wc, () => {
        // Hover first so pointer-driven widgets (menus, custom buttons) arm before the click.
        wc.sendInputEvent({ type: "mouseMove", x, y });
        wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        if (normalized.type === "type_at") {
          // Like ordinary type, typing replaces the field: select what the click focused, then insert.
          if (typeof wc.selectAll === "function") wc.selectAll();
          wc.insertText(normalized.text);
        }
      });
    } catch {
      return { status: "uncertain", errorCode: "coordinate_input_uncertain" };
    }
```

(주의: `this._visualBinding = null;`로 binding을 먼저 소모하는 기존 줄은 그대로 둔다. 재시도하지 않는 이유가 이 소모다. 읽기성 동작의 1회 재시도는 이 계층이 아니라 Task 3의 locator 동작에서 다룬다.)

- [ ] **Step 4: 통과와 회귀 확인**

Run: `node --test test/browser-effect-verification.test.js test/text-computer-use.test.js test/browser-interactions.test.js test/task-controller-interactions.test.js`
Expected: 모두 PASS. 기존 테스트가 `ok`를 기대하면서 fake에 `executeJavaScriptInIsolatedWorld`가 있으면 새 규칙 때문에 실패할 수 있다. 그 경우 해당 테스트의 fake에 변화하는 스냅샷을 주도록 고치고, 고친 이유를 Task 보고서에 적는다.

- [ ] **Step 5: 커밋(사용자 승인 후)**

```bash
git add main/harness/browser-adapter.js test/browser-effect-verification.test.js
git commit -m "feat: Enter and coordinate actions report uncertain when no effect is observed"
```

---

### Task 3: locator 해석과 자동 대기 (`halowright-locator`)

**Files:**
- Create: `runtime-src/main/harness/halowright-locator.ts`
- Modify: `tools/build-runtime.js`, `tsconfig.runtime-harness.json` (`'halowright-locator'` 등록)
- Test: `test/halowright-locator.test.js` (Chromium이 없으면 skip)

**Interfaces:**
- Produces:
  - `type LocatorSpec = { role: string; name?: string; nth?: number } | { label: string; nth?: number } | { text: string; nth?: number } | { placeholder: string; nth?: number }`
  - `validateLocator(value: unknown): LocatorSpec` (잘못된 모양이면 `HalowrightError("invalid_locator")` 던짐)
  - `locatorResolveSource(spec: LocatorSpec): string` (격리 월드에서 실행하면 `ResolveResult` JSON 문자열)
  - `type ResolveResult = { status: "resolved"; x: number; y: number; tag: string } | { status: "not_found" } | { status: "ambiguous"; count: number; candidates: string[] } | { status: "not_actionable"; reason: "hidden" | "disabled" | "covered" | "moving" }`
  - `waitForActionable(options: { resolve: (spec: LocatorSpec) => Promise<ResolveResult | null>; spec: LocatorSpec; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }): Promise<ResolveResult & { waitedMs: number }>` — `resolved`가 연속 두 번 같은 좌표로 나와야(stable) `resolved`를 반환한다. 타임아웃이면 마지막 결과를 그대로 반환한다. `ambiguous`는 기다리지 않고 즉시 반환한다.
  - `class HalowrightError extends Error { code: string }`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/halowright-locator.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { validateLocator, locatorResolveSource, waitForActionable, HalowrightError } = require("../main/harness/halowright-locator");
const { CdpEngine } = require("../main/harness/cdp-engine");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

test("validateLocator accepts the four forms and rejects the rest", () => {
  assert.deepEqual(validateLocator({ role: "button", name: "Save" }), { role: "button", name: "Save" });
  assert.deepEqual(validateLocator({ label: "Email", nth: 1 }), { label: "Email", nth: 1 });
  assert.deepEqual(validateLocator({ text: "Sign in" }), { text: "Sign in" });
  assert.deepEqual(validateLocator({ placeholder: "Search" }), { placeholder: "Search" });
  for (const bad of [null, "button", {}, { role: 1 }, { role: "button", css: "#a" }, { text: "x", nth: -1 }, { text: "x".repeat(300) }, { role: "button", name: "a", label: "b" }]) {
    assert.throws(() => validateLocator(bad), (error) => error instanceof HalowrightError && error.code === "invalid_locator");
  }
});

test("waitForActionable returns resolved only after two identical positions", async () => {
  const results = [{ status: "not_found" }, { status: "resolved", x: 1, y: 2, tag: "BUTTON" }, { status: "resolved", x: 5, y: 6, tag: "BUTTON" }, { status: "resolved", x: 5, y: 6, tag: "BUTTON" }];
  const out = await waitForActionable({ resolve: async () => results.shift(), spec: { text: "x" }, sleep: async () => {}, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(out.status, "resolved");
  assert.deepEqual([out.x, out.y], [5, 6]);
});

test("waitForActionable stops at once on an ambiguous locator and returns the last state on timeout", async () => {
  const ambiguous = await waitForActionable({ resolve: async () => ({ status: "ambiguous", count: 2, candidates: ["a", "b"] }), spec: { text: "x" }, sleep: async () => { throw new Error("must not wait"); }, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(ambiguous.status, "ambiguous");
  const covered = await waitForActionable({ resolve: async () => ({ status: "not_actionable", reason: "covered" }), spec: { text: "x" }, sleep: async () => {}, timeoutMs: 300, intervalMs: 100 });
  assert.deepEqual({ status: covered.status, reason: covered.reason }, { status: "not_actionable", reason: "covered" });
});

const FIXTURE = `<!doctype html><title>fx</title>
<label for="em">Email</label><input id="em" placeholder="you@x.test">
<button id="save">Save</button><button id="save2">Save</button>
<button id="off" disabled>Off</button>
<button id="late" style="display:none">Later</button><script>setTimeout(() => { document.getElementById("late").style.display = "inline-block"; }, 400)</script>
<div style="position:relative"><button id="under">Under</button><div style="position:absolute;inset:0;background:#fff"></div></div>
<a href="#x">Docs link</a>`;

test("the page script resolves by role, label, text and placeholder and rejects unusable targets", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(FIXTURE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const page = engine.createPage("halo-task-locator");
  await page.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const resolve = async (spec) => {
    const raw = await page.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: locatorResolveSource(spec) }]);
    return JSON.parse(Array.isArray(raw) ? raw[0] : raw);
  };
  assert.equal((await resolve({ role: "link", name: "Docs link" })).status, "resolved");
  assert.equal((await resolve({ label: "Email" })).tag, "INPUT");
  assert.equal((await resolve({ placeholder: "you@x.test" })).status, "resolved");
  assert.equal((await resolve({ role: "button", name: "Save" })).status, "ambiguous");
  assert.equal((await resolve({ role: "button", name: "Save", nth: 1 })).status, "resolved");
  assert.deepEqual(await resolve({ role: "button", name: "Off" }), { status: "not_actionable", reason: "disabled" });
  assert.deepEqual(await resolve({ role: "button", name: "Under" }), { status: "not_actionable", reason: "covered" });
  assert.equal((await resolve({ role: "button", name: "Nope" })).status, "not_found");
  // The late button appears after ~400 ms; auto-wait must find it without the caller sleeping.
  const waited = await waitForActionable({ resolve, spec: { role: "button", name: "Later" }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs: 3000, intervalMs: 100 });
  assert.equal(waited.status, "resolved");
  assert.ok(waited.waitedMs >= 300);
});
```

`CdpEngine.createPage()`가 돌려주는 객체에서 `webContents`가 어떻게 노출되는지(`page.webContents`인지 `page` 자체가 `CdpWebContents`인지)를 `test/cdp-engine.test.js`와 `runtime-src/main/harness/cdp-web-contents.ts`의 `createCdpView`에서 먼저 확인하고, 위 코드의 `page.webContents`를 그에 맞게 고친다. `executeJavaScriptInIsolatedWorld(worldId, scripts)`의 반환 모양(`cdp-web-contents.ts` 약 370행)도 확인해 `raw` 처리 줄을 맞춘다.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/halowright-locator.test.js`
Expected: FAIL (`Cannot find module`)

- [ ] **Step 3: 구현** — `runtime-src/main/harness/halowright-locator.ts`

```ts
"use strict";

// A locator names an element the way a person would (role+name, label, text, placeholder).
// Nothing here is a selector or code: the host builds the page script itself and only
// splices in JSON-encoded strings, so a model-supplied name can never become script.

type LocatorSpec =
  | { role: string; name?: string; nth?: number }
  | { label: string; nth?: number }
  | { text: string; nth?: number }
  | { placeholder: string; nth?: number };

type ResolveResult =
  | { status: "resolved"; x: number; y: number; tag: string }
  | { status: "not_found" }
  | { status: "ambiguous"; count: number; candidates: string[] }
  | { status: "not_actionable"; reason: "hidden" | "disabled" | "covered" | "moving" };

class HalowrightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "HalowrightError"; this.code = code; }
}

const MAX_TEXT = 200;
const ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "heading", "tab", "menuitem", "option", "switch"];

function validateLocator(value: unknown): LocatorSpec {
  const fail = (why: string): never => { throw new HalowrightError("invalid_locator", why); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("locator must be an object");
  const spec = value as Record<string, unknown>;
  const keys = Object.keys(spec);
  const forms = ["role", "label", "text", "placeholder"].filter((key) => key in spec);
  if (forms.length !== 1) return fail("exactly one of role, label, text, placeholder");
  const allowed = new Set([forms[0], "nth", ...(forms[0] === "role" ? ["name"] : [])]);
  if (keys.some((key) => !allowed.has(key))) return fail("unknown field");
  const str = (key: string): string => {
    const v = spec[key];
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT) return fail(`${key} must be 1..${MAX_TEXT} characters`);
    return v;
  };
  if ("nth" in spec && !(Number.isInteger(spec.nth) && (spec.nth as number) >= 0 && (spec.nth as number) < 50)) return fail("nth must be 0..49");
  const nth = "nth" in spec ? { nth: spec.nth as number } : {};
  if (forms[0] === "role") {
    const role = str("role");
    if (!ROLES.includes(role)) return fail("unsupported role");
    return { role, ...("name" in spec ? { name: str("name") } : {}), ...nth };
  }
  return { [forms[0]]: str(forms[0]), ...nth } as LocatorSpec;
}

// Runs in the isolated world and returns a ResolveResult as JSON.
function locatorResolveSource(spec: LocatorSpec): string {
  return `((spec) => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const IMPLICIT = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=url],input[type=tel],input[type=password],textarea,[role=textbox]", checkbox: "input[type=checkbox],[role=checkbox]", radio: "input[type=radio],[role=radio]", combobox: "select,[role=combobox]", heading: "h1,h2,h3,h4,h5,h6,[role=heading]", tab: "[role=tab]", menuitem: "[role=menuitem]", option: "option,[role=option]", switch: "[role=switch]" };
    const nameOf = (el) => norm(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("placeholder"));
    let list = [];
    if (spec.role) list = [...document.querySelectorAll(IMPLICIT[spec.role])].filter((el) => spec.name === undefined || nameOf(el) === norm(spec.name));
    else if (spec.label) list = [...document.querySelectorAll("input,textarea,select")].filter((el) => (el.labels && [...el.labels].some((l) => norm(l.innerText) === norm(spec.label))) || norm(el.getAttribute("aria-label")) === norm(spec.label));
    else if (spec.placeholder) list = [...document.querySelectorAll("[placeholder]")].filter((el) => norm(el.getAttribute("placeholder")) === norm(spec.placeholder));
    else if (spec.text) list = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && norm(el.innerText || el.textContent) === norm(spec.text));
    const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ":" + nameOf(el).slice(0, 40);
    if (list.length === 0) return JSON.stringify({ status: "not_found" });
    const index = spec.nth === undefined ? (list.length === 1 ? 0 : -1) : spec.nth;
    if (index === -1) return JSON.stringify({ status: "ambiguous", count: list.length, candidates: list.slice(0, 5).map(label) });
    const el = list[index];
    if (!el) return JSON.stringify({ status: "not_found" });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") return JSON.stringify({ status: "not_actionable", reason: "hidden" });
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return JSON.stringify({ status: "not_actionable", reason: "disabled" });
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) return JSON.stringify({ status: "not_actionable", reason: "covered" });
    return JSON.stringify({ status: "resolved", x, y, tag: el.tagName });
  })(${JSON.stringify(spec)})`;
}

interface WaitOptions {
  resolve: (spec: LocatorSpec) => Promise<ResolveResult | null>;
  spec: LocatorSpec;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

async function waitForActionable({ resolve, spec, sleep, timeoutMs = 5000, intervalMs = 100 }: WaitOptions): Promise<ResolveResult & { waitedMs: number }> {
  let last: ResolveResult = { status: "not_found" };
  let previous: { x: number; y: number } | null = null;
  let waited = 0;
  for (;;) {
    const current = (await resolve(spec).catch(() => null)) ?? last;
    last = current;
    if (current.status === "ambiguous") return { ...current, waitedMs: waited };
    if (current.status === "resolved") {
      if (previous && previous.x === current.x && previous.y === current.y) return { ...current, waitedMs: waited };
      previous = { x: current.x, y: current.y };
    } else previous = null;
    if (waited >= timeoutMs) break;
    await sleep(intervalMs);
    waited += intervalMs;
  }
  return last.status === "resolved" ? { status: "not_actionable", reason: "moving", waitedMs: waited } : { ...last, waitedMs: waited };
}

export = { HalowrightError, validateLocator, locatorResolveSource, waitForActionable };
```

- [ ] **Step 4: 빌드 등록 후 통과 확인**

`tools/build-runtime.js`의 harness `names`에 `'halowright-locator'`, `tsconfig.runtime-harness.json`의 `files`에 `"runtime-src/main/harness/halowright-locator.ts"`를 추가한다.

Run: `node tools/build-runtime.js && node --test test/halowright-locator.test.js`
Expected: Chromium이 있으면 4개 PASS, 없으면 마지막 하나는 SKIP이고 나머지 PASS

- [ ] **Step 5: 런타임 일치와 타입 확인**

Run: `node tools/build-runtime.js --check`
Expected: 오류 없음

- [ ] **Step 6: 커밋(사용자 승인 후)**

```bash
git add runtime-src/main/harness/halowright-locator.ts main/harness/halowright-locator.js tools/build-runtime.js tsconfig.runtime-harness.json test/halowright-locator.test.js
git commit -m "feat: halowright locator resolution with auto-wait"
```

---

### Task 4: `hw_step` 실행기 (locator → 대기 → 동작 → 효과 확인)

**Files:**
- Create: `runtime-src/main/harness/halowright.ts`
- Modify: `tools/build-runtime.js`, `tsconfig.runtime-harness.json` (`'halowright'` 등록)
- Test: `test/halowright.test.js`

**Interfaces:**
- Consumes: Task 1 (`PAGE_SNAPSHOT_SOURCE`, `parseSnapshot`, `verifyEffect`), Task 3 (`validateLocator`, `locatorResolveSource`, `waitForActionable`, `HalowrightError`).
- Produces: `runHwStep(wc: WebContentsLike, step: unknown, options?: { sleep?, timeoutMs? }): Promise<StepResult>` where `StepResult = { status: "ok" | "failed" | "uncertain"; errorCode?: string; effect?: { observed: boolean; changed: string[] }; candidates?: string[] }`. `step`은 `{ locator, op: "click" | "fill", text? }`. `fill`은 `text`가 필수이고 UTF-8 4096바이트 이하. 이 단계는 effect 분류와 승인 연동을 하지 않는다(그건 묶음 3의 8단계). `BrowserAdapter.execute`에 `hw_step`을 연결하는 일도 이 묶음 범위 밖이므로, `runHwStep`은 독립 모듈로 두고 어댑터 연결은 다음 묶음에서 한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/halowright.test.js`

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runHwStep } = require("../main/harness/halowright");

// A scripted page: resolve answers come from `resolves`, snapshots from `snapshots`.
function fakePage({ resolves, snapshots }) {
  const events = [];
  const texts = [];
  let snap = 0;
  const wc = {
    sendInputEvent: (e) => { events.push(e); },
    insertText: (t) => { texts.push(t); },
    selectAll: () => {},
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("location.href")) return JSON.stringify(snapshots[Math.min(snap++, snapshots.length - 1)]);
      return JSON.stringify(resolves.shift() ?? { status: "not_found" });
    },
  };
  return { wc, events, texts };
}

const page = { url: "https://p.test/", title: "t", nodes: 5, textLength: 10, focus: "", valueLength: -1 };
const hit = { status: "resolved", x: 10, y: 20, tag: "BUTTON" };
const opts = { sleep: async () => {}, timeoutMs: 500 };

test("click resolves, clicks the center and is ok when the page changes", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, title: "after" }] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(events.map((e) => e.type), ["mouseMove", "mouseDown", "mouseUp"]);
  assert.deepEqual(result.effect, { observed: true, changed: ["title"] });
});

test("a click that changes nothing is uncertain and is not repeated", async () => {
  const { wc, events } = fakePage({ resolves: [hit, hit], snapshots: [page] });
  const result = await runHwStep(wc, { locator: { text: "Go" }, op: "click" }, opts);
  assert.equal(result.status, "uncertain");
  assert.equal(result.errorCode, "effect_not_observed");
  assert.equal(events.filter((e) => e.type === "mouseDown").length, 1);
});

test("an ambiguous locator fails with candidates and sends no input", async () => {
  const { wc, events } = fakePage({ resolves: [{ status: "ambiguous", count: 2, candidates: ["button#a:save", "button#b:save"] }], snapshots: [page] });
  const result = await runHwStep(wc, { locator: { role: "button", name: "Save" }, op: "click" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "locator_ambiguous");
  assert.deepEqual(result.candidates, ["button#a:save", "button#b:save"]);
  assert.equal(events.length, 0);
});

test("a target that never becomes actionable fails with the reason", async () => {
  const { wc, events } = fakePage({ resolves: Array(20).fill({ status: "not_actionable", reason: "covered" }), snapshots: [page] });
  const result = await runHwStep(wc, { locator: { text: "Go" }, op: "click" }, opts);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "not_actionable_covered");
  assert.equal(events.length, 0);
});

test("fill clicks the field, selects, inserts and checks the value changed", async () => {
  const { wc, texts } = fakePage({ resolves: [hit, hit], snapshots: [page, { ...page, valueLength: 5 }] });
  const result = await runHwStep(wc, { locator: { label: "Email" }, op: "fill", text: "a@b.c" }, opts);
  assert.equal(result.status, "ok");
  assert.deepEqual(texts, ["a@b.c"]);
});

test("malformed steps fail before touching the page", async () => {
  const { wc, events } = fakePage({ resolves: [], snapshots: [page] });
  for (const step of [null, { op: "click" }, { locator: { text: "x" }, op: "drag" }, { locator: { text: "x" }, op: "fill" }, { locator: { text: "x" }, op: "fill", text: "y".repeat(5000) }, { locator: { css: "#a" }, op: "click" }]) {
    const result = await runHwStep(wc, step, opts);
    assert.equal(result.status, "failed");
    assert.match(result.errorCode, /^invalid_/);
  }
  assert.equal(events.length, 0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/halowright.test.js`
Expected: FAIL (`Cannot find module '../main/harness/halowright'`)

- [ ] **Step 3: 구현** — `runtime-src/main/harness/halowright.ts`

```ts
"use strict";

// One Halowright step: find the element by name, wait until it can be used, act on it,
// then check that the page really changed. Approval and effect classification happen
// above this layer; this module never decides whether an action is allowed.

const verifier = require("./effect-verifier") as {
  PAGE_SNAPSHOT_SOURCE: string;
  parseSnapshot(raw: unknown): any;
  verifyEffect(options: { before: any; read: () => Promise<any>; sleep: (ms: number) => Promise<void>; timeoutMs?: number }): Promise<{ observed: boolean; changed: string[] }>;
};
const locators = require("./halowright-locator") as {
  HalowrightError: new (code: string, message: string) => Error & { code: string };
  validateLocator(value: unknown): any;
  locatorResolveSource(spec: any): string;
  waitForActionable(options: any): Promise<any>;
};

const WORLD_ID = 1001;
const MAX_FILL_BYTES = 4096;

interface WebContentsLike {
  sendInputEvent(event: Record<string, unknown>): void;
  insertText?(text: string): void;
  selectAll?(): void;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<any>;
}
interface StepResult {
  status: "ok" | "failed" | "uncertain";
  errorCode?: string;
  effect?: { observed: boolean; changed: string[] };
  candidates?: string[];
}
interface StepOptions { sleep?: (ms: number) => Promise<void>; timeoutMs?: number }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runScript(wc: WebContentsLike, code: string): Promise<any> {
  const raw = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
  return Array.isArray(raw) ? raw[0] : raw;
}

async function runHwStep(wc: WebContentsLike, step: unknown, options: StepOptions = {}): Promise<StepResult> {
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 5000;
  const input = step as { locator?: unknown; op?: unknown; text?: unknown } | null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { status: "failed", errorCode: "invalid_step" };
  if (input.op !== "click" && input.op !== "fill") return { status: "failed", errorCode: "invalid_op" };
  if (input.op === "fill" && (typeof input.text !== "string" || Buffer.byteLength(input.text, "utf8") > MAX_FILL_BYTES)) return { status: "failed", errorCode: "invalid_text" };
  let spec: any;
  try { spec = locators.validateLocator(input.locator); }
  catch (error: any) { return { status: "failed", errorCode: error?.code === "invalid_locator" ? "invalid_locator" : "invalid_step" }; }

  const resolve = async (s: any) => {
    const raw = await runScript(wc, locators.locatorResolveSource(s));
    try { return JSON.parse(raw); } catch { return null; }
  };
  const target = await locators.waitForActionable({ resolve, spec, sleep, timeoutMs });
  if (target.status === "ambiguous") return { status: "failed", errorCode: "locator_ambiguous", candidates: target.candidates };
  if (target.status === "not_found") return { status: "failed", errorCode: "locator_not_found" };
  if (target.status !== "resolved") return { status: "failed", errorCode: `not_actionable_${target.reason}` };

  const read = async () => verifier.parseSnapshot(await runScript(wc, verifier.PAGE_SNAPSHOT_SOURCE));
  const before = await read().catch(() => null);
  const { x, y } = target;
  wc.sendInputEvent({ type: "mouseMove", x, y });
  wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  if (input.op === "fill") {
    wc.selectAll?.();
    wc.insertText?.(input.text as string);
  }
  if (!before) return { status: "ok" };
  const effect = await verifier.verifyEffect({ before, read, sleep });
  // A click or fill is not retried: it may already have had a side effect.
  return effect.observed ? { status: "ok", effect } : { status: "uncertain", errorCode: "effect_not_observed" };
}

export = { runHwStep };
```

- [ ] **Step 4: 빌드 등록 후 통과 확인**

`tools/build-runtime.js`와 `tsconfig.runtime-harness.json`에 `halowright` 등록.

Run: `node tools/build-runtime.js && node --test test/halowright.test.js test/halowright-locator.test.js test/effect-verifier.test.js`
Expected: 모두 PASS

- [ ] **Step 5: 커밋(사용자 승인 후)**

```bash
git add runtime-src/main/harness/halowright.ts main/harness/halowright.js tools/build-runtime.js tsconfig.runtime-harness.json test/halowright.test.js
git commit -m "feat: halowright hw_step runner (locator, wait, act, verify)"
```

---

### Task 5: 종료 전 보고 강제

**Files:**
- Modify: `main/harness/child-agent-coordinator.js` (`_postToBoard` 약 1213행, `_retireChild` 약 929-950행, `_childState`/`getPlanSummary` 약 413-460행, 생성자 약 130-140행)
- Test: `test/child-agent-coordinator.test.js`에 추가 (또는 새 파일 `test/child-report-required.test.js`)

**Interfaces:**
- Produces:
  - 생성자에 `this._reportedChildren = new Set()` (보드나 mailbox로 `progress`/`handoff`를 보낸 자식 id 집합)
  - 자식이 `completed`로 끝났는데 `_reportedChildren`에 없으면 `_terminalChildren`의 기록이 `{ outcome: "completed", reported: false }`가 된다. 보고가 있으면 `reported: true`.
  - `getPlanSummary(parentTaskId)`의 각 agent에 `reported: boolean`(종료한 자식만; 아직 도는 자식은 생략)과, `reported === false`이면 `unreported: true`.
  - `outcome` 문자열 자체는 바꾸지 않는다(다른 코드가 `"completed"`를 그대로 비교한다).

먼저 `main/harness/child-agent-coordinator.js`에서 `getPlanSummary`가 agent 객체를 만드는 부분(약 417-440행)을 끝까지 읽고, `terminal`을 쓰는 곳에서 새 필드를 추가할 위치를 정한다. 그리고 `test/child-agent-coordinator.test.js`에서 자식을 실제로 시작시켜 `completed`까지 보내는 기존 테스트(`startChild`나 controller fake를 쓰는 것)를 찾아 같은 방식으로 fixture를 만든다.

- [ ] **Step 1: 실패하는 테스트 작성**

기존 테스트의 fixture 헬퍼를 재사용해 두 시나리오를 만든다.

```js
test("a child that finishes without any progress or handoff report is marked unreported", async () => {
  // fixture: same setup as the existing test that drives a child to "completed";
  // here the child never calls sendChildMessage with kind progress/handoff.
  const { coordinator, parent, childId, finishChild } = await childFixture();
  await finishChild(childId, "completed");
  const summary = await coordinator.getPlanSummary(parent.taskId);
  const agent = summary.agents.find((a) => a.agentId === childId);
  assert.equal(agent.status, "completed");
  assert.equal(agent.reported, false);
  assert.equal(agent.unreported, true);
});

test("a child that posted a progress report before finishing is marked reported", async () => {
  const { coordinator, parent, childId, finishChild, sendReport } = await childFixture();
  await sendReport(childId, { messageKind: "progress", text: "searched three pages, nothing found" });
  await finishChild(childId, "completed");
  const agent = (await coordinator.getPlanSummary(parent.taskId)).agents.find((a) => a.agentId === childId);
  assert.equal(agent.reported, true);
  assert.equal(agent.unreported, undefined);
});

test("a stopped child is not reported as unreported", async () => {
  const { coordinator, parent, childId, finishChild } = await childFixture();
  await finishChild(childId, "stopped");
  const agent = (await coordinator.getPlanSummary(parent.taskId)).agents.find((a) => a.agentId === childId);
  assert.equal(agent.unreported, undefined);
});
```

`childFixture`, `finishChild`, `sendReport`는 이 파일에 새로 만들되, 기존 테스트의 자식 시작과 종료 방식, 그리고 자식→부모 메시지 전송 API(`sendChildMessage` 또는 이 파일에서 `_mailbox.send`를 부르는 공개 메서드 — 약 1150-1205행의 메서드 이름을 확인해서 쓴다)를 그대로 따른다. 위 세 시나리오의 기대값은 바꾸지 않는다.

- [ ] **Step 2: 실패 확인**

Run: `node --test test/child-agent-coordinator.test.js`
Expected: 새 테스트 FAIL (`agent.reported`가 `undefined`)

- [ ] **Step 3: 구현**

생성자(`_terminalChildren` 선언 근처, 약 135행)에 추가:

```js
    // Children that sent their parent at least one progress or handoff report.
    this._reportedChildren = new Set();
```

`_postToBoard`가 아니라 **전송 성공 직후**(보드 게시가 실패해도 보고는 한 것이므로)에 기록한다. `const sent = await this._mailbox.send(envelope);` 바로 다음 줄에서:

```js
      const sent = await this._mailbox.send(envelope);
      if (senderTaskId === childTaskId && (proposal.messageKind === "progress" || proposal.messageKind === "handoff")) this._reportedChildren.add(childTaskId);
```

`_retireChild`의 `_terminalChildren.set` 줄(약 940행)을 바꾼다:

```js
    this._terminalChildren.set(childId, {
      outcome: controllerState === "completed" ? "completed" : "stopped",
      reported: this._reportedChildren.has(childId),
    });
```

`getPlanSummary`의 agent 객체(약 417행 `return {` 안)에 추가:

```js
        ...(terminal && terminal.outcome === "completed" ? { reported: terminal.reported === true } : {}),
        ...(terminal && terminal.outcome === "completed" && terminal.reported !== true ? { unreported: true } : {}),
```

(`terminal`은 이 `map` 안에서 이미 `this._terminalChildren.get(childId)`로 정의되어 있다. 정의되어 있지 않으면 같은 줄을 추가한다.)

`_retireChild` 이후 약 1003행에서 `{ outcome: retirement.terminalOutcome }`로 덮어쓰는 부분이 `reported`를 잃지 않도록 같은 모양으로 맞춘다:

```js
        this._terminalChildren.set(live.store.taskId, { outcome: retirement.terminalOutcome, reported: this._reportedChildren.has(live.store.taskId) });
```

- [ ] **Step 4: 통과와 회귀 확인**

Run: `node --test test/child-agent-coordinator.test.js test/child-agent-coordinator-*.test.js test/child-plan-summary.test.js`
Expected: 모두 PASS. 기존 테스트가 `getPlanSummary` 결과를 `deepEqual`로 비교하며 새 필드 때문에 깨지면, 그 기대값에 `reported: false`와 `unreported: true`를 추가하고 이유를 보고서에 적는다.

- [ ] **Step 5: 프론트 표시(별도 확인)**

이번 Task는 호스트 측 기록까지다. 프론트의 `frontend/src/session/child-agents.ts`와 팀 뷰가 `unreported`를 보여 주는 일은 묶음 3(자원 해제와 UI)에서 한다. 여기서는 필드가 요약에 실리는지만 확인한다.

- [ ] **Step 6: 전체 회귀**

Run: `npm test`
Expected: 새로 만든 테스트를 포함해 모두 통과. 이전 세션에서 이미 실패하던 `main-entrypoint-lifecycle`(18)과 `host-settings`(2)는 이 작업과 무관하므로 새 실패가 아닌지 이름으로 구분해 보고한다.

- [ ] **Step 7: 커밋(사용자 승인 후)**

```bash
git add main/harness/child-agent-coordinator.js test/child-agent-coordinator.test.js
git commit -m "feat: mark finished child agents that never reported"
```

---

## 자체 검토

- 스펙 1절(효과 확인): Task 1, 2. 2절(locator, 자동 대기, 모호성, epoch): locator와 안정성·가림·비활성·모호성은 Task 3, 4. **epoch 재확인과 에이전트 단위 격리는 이 묶음에서 `runHwStep`이 `BrowserAdapter`에 연결되는 다음 묶음에서 한다**(`runHwStep`은 독립 모듈). 7절(보고 강제): Task 5는 "완료로 인정하지 않는다"의 1단계로 `unreported` 기록과 요약 노출까지만 한다. 부모가 `unreported` 자식을 `awaiting_verification`에서 막는 정책 연결은 묶음 3.
- 아직 빠진 것(다음 묶음): `hw_step`을 `BrowserAdapter.execute`/planner 계약에 연결, effect 분류와 승인 연동, MCP 우선 라우팅, 팀 통신, 자원 해제, `evaluate`, 영구 프로필.
- 타입 일관성: `PageSnapshot`, `verifyEffect`, `ResolveResult`, `StepResult`의 이름과 모양은 Task 1→2→3→4에서 같게 썼다.
- 확인이 필요한 가정(구현 시 먼저 읽고 맞출 것): `BrowserAdapter`의 binding 필드와 `INTERACTION_WORLD_ID` 사용 방식(Task 2), `createPage()` 반환 객체의 `webContents` 노출과 `executeJavaScriptInIsolatedWorld` 반환 모양(Task 3), `ChildAgentCoordinator`의 자식→부모 메시지 API 이름과 `getPlanSummary`의 `terminal` 변수(Task 5). 각 Task 상단에 읽을 위치를 적었다.
