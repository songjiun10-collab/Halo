# Renderer Lifecycle Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the live renderer and window count that agents and tabs cost today: one shared hidden window for agent views, discard and restore of idle user tabs, and a cheaper, faster live mirror of the agent's page.

**Architecture:** `AgentViewportHost` keeps one lazily created hidden `BrowserWindow` that holds every agent view instead of one window per view. `ControlApi` keeps tab records (`{ id, title, url }`) alive while destroying the view of an idle inactive tab, and recreates it on selection. The mirror capture gets a change fingerprint so an unchanged page costs no JPEG encode and no React re-render, and its poll interval drops.

**Tech Stack:** Electron 44.4.5 (CommonJS main process), node:test, React + TypeScript frontend (`frontend/`).

Source spec: `docs/superpowers/specs/2026-10-05-renderer-lifecycle-design.md`. This plan is Phase 1 only and deliberately excludes (a) lazy creation of a task's visible view, which touches `BrowserSurfaces`, the visible adapter contract and `makeHarnessBrowser` and needs its own plan, and (b) `stopPainting` for hidden views, which must be verified against `capturePage()` in a real Electron first.

## Global Constraints

- Run tests from `/Users/songjiun/Halo/apps/computer-browser` with `node --test test/<file>`; the full suite is `npm test` (it runs `check:runtime` first).
- Existing public behaviour must not change: `ensure()` still returns the same adapter for the same task, `dispose()` still tears down the adapter and its renderer, and `getSnapshot().tabs` keeps `id`, `title`, `url` (a `discarded` boolean is added, never removed or renamed).
- Never discard the active tab, an audible tab, a blank tab (no url) or a tab that is the origin of a queued action (`item._originTabId`).
- New code is plain JS in `main/` (that is where these files live); no mass conversion.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not touch the other-session WIP files listed in `git status` (task-host.js, task-controller.js, strategy-learning*, SettingsPanel.tsx, etc.). `frontend/src/App.tsx` already has uncommitted changes from another session: stage only the hunk this plan changes (`git add -p`).

---

### Task 1: One shared hidden window for agent views

**Files:**
- Modify: `apps/computer-browser/main/harness/agent-viewport-host.js` (constructor, `_createHiddenViewPair`, `_disposeEntry`)
- Test: `apps/computer-browser/test/agent-viewport-host.test.js`

**Interfaces:**
- Consumes: existing `createWindow(opts)` / `createView(opts)` injection in the `AgentViewportHost` constructor; the fake window in the test has `contentView.addChildView`, `children`, `destroy()`, `destroyed`.
- Produces: `AgentViewportHost` keeps `this._sharedHost` (the one hidden window or `null`) and `this._sharedViewCount`. Every `_hosts` / `_childHosts` entry still has `{ host, view, adapter, ... }` where `host` is now the shared window. The shared window is destroyed when its last view is disposed and recreated on demand.

- [ ] **Step 1: Add the removeChildView seam to the test fake and write the failing tests**

In `test/agent-viewport-host.test.js`, change `fakeCreateWindow` so the fake window records removals:

```js
    const win = {
      opts,
      destroyed: false,
      contentView: {
        addChildView: (v) => children.push(v),
        removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
      },
      children,
      destroy() { this.destroyed = true; },
    };
```

Append these tests at the end of the file:

```js
test("every agent view lives in one shared hidden window", () => {
  const { host, windows, views } = setup();
  host.ensure("task-a");
  host.ensure("task-b");
  host.ensureChild("task-a", "child-1", { assignedOrigin: "https://example.com", execution: "host" });
  assert.equal(windows.length, 1, "one hidden window, not one per view");
  assert.equal(windows[0].children.length, 3);
  assert.equal(views.length, 3);
  assert.equal(windows[0].opts.show, false);
  assert.equal(windows[0].opts.width, AGENT_WIDTH);
  assert.equal(windows[0].opts.height, AGENT_HEIGHT);
});

test("disposing one view keeps the shared window, disposing the last one destroys it", async () => {
  const { host, windows } = setup();
  host.ensure("task-a");
  host.ensure("task-b");
  await host.dispose("task-a");
  assert.equal(windows[0].destroyed, false);
  assert.equal(windows[0].children.length, 1);
  await host.dispose("task-b");
  assert.equal(windows[0].destroyed, true);
});

test("a view created after the shared window was destroyed gets a fresh window", async () => {
  const { host, windows } = setup();
  host.ensure("task-a");
  await host.dispose("task-a");
  host.ensure("task-b");
  assert.equal(windows.length, 2);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[1].destroyed, false);
  assert.equal(windows[1].children.length, 1);
});
```

`setup()` currently returns `{ host, views, windows }`; if its return value lacks any of these names, add them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/agent-viewport-host.test.js`
Expected: the three new tests FAIL (`windows.length` is 2 or 3, not 1).

- [ ] **Step 3: Implement the shared window**

In the `AgentViewportHost` constructor, after `this._childHosts = new Map();` add:

```js
    // One hidden window holds every agent view. A BrowserWindow per view cost a
    // window and a webContents each; the views are independent renderers either
    // way, so the container is shared and destroyed with its last view.
    this._sharedHost = null;
    this._sharedViewCount = 0;
```

Replace `_createHiddenViewPair` with:

```js
  _acquireHiddenHost() {
    const gone = !this._sharedHost || this._sharedHost.destroyed === true || this._sharedHost.isDestroyed?.() === true;
    if (gone) {
      this._sharedHost = this._createWindow({
        show: false,
        width: AGENT_WIDTH,
        height: AGENT_HEIGHT,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this._sharedViewCount = 0;
    }
    this._sharedViewCount += 1;
    return this._sharedHost;
  }

  _releaseHiddenHost(host, view) {
    try {
      host.contentView.removeChildView?.(view);
    } catch {
      // The view may already be gone with its webContents.
    }
    if (host !== this._sharedHost) {
      try { host.destroy(); } catch { /* best effort */ }
      return;
    }
    this._sharedViewCount -= 1;
    if (this._sharedViewCount <= 0) {
      this._sharedHost = null;
      this._sharedViewCount = 0;
      try { host.destroy(); } catch { /* a window already gone is not a safety issue */ }
    }
  }

  _createHiddenViewPair(partition) {
    const host = this._acquireHiddenHost();
    const view = this._createView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, offscreen: true },
    });
    applyBrowserHardening(view.webContents);
    host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
    view.setVisible(true);
    return { host, view };
  }
```

Replace the `finally` block of `_disposeEntry` so it releases through the shared-window bookkeeping:

```js
    } finally {
      this._releaseHiddenHost(entry.host, entry.view);
    }
```

(The `try { await entry.adapter.dispose?.(); }` part stays as is.)

- [ ] **Step 4: Run the test file**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/agent-viewport-host.test.js test/agent-viewport-memory-integration.test.js`
Expected: all PASS. If an older test asserted one window per view (for example `windows.length === 2` for two tasks), update that assertion to the shared-window expectation; do not weaken a test that checks hardening, partitions or teardown.

- [ ] **Step 5: Commit**

```bash
cd /Users/songjiun/Halo && git add apps/computer-browser/main/harness/agent-viewport-host.js apps/computer-browser/test/agent-viewport-host.test.js
git commit -m "Agent views share one hidden window instead of one window each

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Discard and restore idle user tabs

**Files:**
- Modify: `apps/computer-browser/main/control-api.js` (`_createTab`, new `_buildTabView`, `selectTab`, `closeTab`, `getSnapshot`, new `discardTab`, `discardIdleTabs`)
- Modify: `apps/computer-browser/main/index.js` (idle sweep timer next to `createWindow`)
- Test: `apps/computer-browser/test/control-api.test.js`

**Interfaces:**
- Consumes: `ControlApi._now` (injected clock, defaults to `Date.now`), `this._window.contentView.addChildView/removeChildView`, queue items carrying `_originTabId` in `this._queue`.
- Produces: tab records `{ id, title, url, view, lastActiveAt }` where `view` is `null` when discarded; `discardTab(tabId) -> boolean`; `discardIdleTabs(idleMs) -> number` (count discarded); `getSnapshot().tabs[i].discarded` boolean; `selectTab()` restores a discarded tab by creating a new view and loading `tab.url`.

- [ ] **Step 1: Confirm the queue field name and the real close method**

Run:
```bash
cd /Users/songjiun/Halo/apps/computer-browser && grep -n "_queue" main/control-api.js | head -5
cat > /tmp/wc-shape.js <<'EOF'
const { app, WebContentsView } = require("electron");
app.whenReady().then(() => { const v = new WebContentsView(); console.log("SHAPE destroy:", typeof v.webContents.destroy, "close:", typeof v.webContents.close); app.quit(); });
EOF
./node_modules/.bin/electron /tmp/wc-shape.js 2>/dev/null | grep SHAPE
```
Expected: the queue array name is printed (the plan below uses `this._queue`; if it differs, use the real name everywhere in Step 3), and SHAPE shows which of `destroy`/`close` exist on a real `webContents`. If `destroy` is `undefined`, the existing `closeTab()` calls to `webContents.destroy?.()` are silent no-ops that leak the renderer; Step 3's `_closeView` fixes that too and the commit message must say so.

- [ ] **Step 2: Write the failing tests**

Append to `test/control-api.test.js` (it already has `makeApi`, `fakeViews`, `makeFakeWebContentsView`, `FakeWebContents`; add `close() { this.closed = true; }` and `isCurrentlyAudible() { return this.audible === true; }` to `FakeWebContents`, and `removeChildView(v) { this.removed = (this.removed || []).concat(v); }` where the tests build `api._window`):

```js
test("an idle inactive tab is discarded: its view closes, its record stays, selecting it restores the page", async () => {
  let clock = 1_000;
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { now: () => clock });
  const removed = [];
  api._window = { contentView: { addChildView() {}, removeChildView: (v) => removed.push(v) } };
  api.setBrowserBounds = (bounds) => { api._pendingBounds = bounds; };

  const first = await api.navigate("https://first.example");
  await api.newTab();
  clock += 11 * 60_000;
  const discarded = api.discardIdleTabs(10 * 60_000);
  assert.equal(discarded, 1);
  const snap = api.getSnapshot();
  assert.equal(snap.tabs[0].discarded, true);
  assert.equal(snap.tabs[0].url, "https://first.example/");
  assert.equal(snap.tabs[1].discarded, false);
  assert.equal(removed.length, 1);
  assert.equal(fakeViews.at(-2).webContents.closed, true);

  const restored = await api.selectTab(first.tabs[0].id);
  assert.equal(restored.page.url, "https://first.example/");
  assert.equal(api.getSnapshot().tabs[0].discarded, false);
  assert.equal(fakeViews.at(-1).webContents.url, "https://first.example/");
});

test("the active tab, blank tabs, audible tabs and queued-action origin tabs are never discarded", async () => {
  let clock = 1_000;
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { now: () => clock });
  api._window = { contentView: { addChildView() {}, removeChildView() {} } };
  const first = await api.navigate("https://a.example");
  const second = await api.newTab();
  await api.navigate("https://b.example");
  const third = await api.newTab();
  clock += 60 * 60_000;
  const tabA = first.tabs[0].id;
  const tabB = second.tabs[1].id;
  fakeViews.at(-3).webContents.audible = true;
  assert.equal(api.discardTab(third.activeTabId), false, "active tab");
  assert.equal(api.discardTab(tabA), false, "audible tab");
  fakeViews.at(-3).webContents.audible = false;
  api._queue.push({ _originTabId: tabA });
  assert.equal(api.discardTab(tabA), false, "origin of a queued action");
  api._queue.length = 0;
  assert.equal(api.discardTab(tabB), true);
  assert.equal(api.discardTab(tabB), false, "already discarded");
});

test("closing a discarded tab works and does not touch a missing view", async () => {
  let clock = 1_000;
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { now: () => clock });
  api._window = { contentView: { addChildView() {}, removeChildView() {} } };
  const first = await api.navigate("https://a.example");
  await api.newTab();
  clock += 60 * 60_000;
  api.discardIdleTabs(10 * 60_000);
  const after = await api.closeTab(first.tabs[0].id);
  assert.equal(after.tabs.length, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/control-api.test.js`
Expected: the three new tests FAIL (`discardIdleTabs is not a function`).

- [ ] **Step 4: Implement**

In `main/control-api.js`, replace `_createTab` with a split version. The listener wiring moves into `_buildTabView(tab)` unchanged in behaviour:

```js
  _closeView(view) {
    this._window.contentView.removeChildView?.(view);
    const wc = view.webContents;
    if (typeof wc.close === "function") wc.close();
    else wc.destroy?.();
  }

  _buildTabView(tab) {
    const view = new this._WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    this._window.contentView.addChildView(view);
    view.setVisible(false);
    // A bounds update can arrive (from the renderer's ResizeObserver) before
    // any tab exists, when there is no view yet to apply it to. Without this,
    // that update is lost and a freshly created view sits at Electron's
    // default {0,0,0,0} bounds until the next *different* bounds message —
    // which may never come if the layout hasn't changed.
    if (this._pendingBounds) {
      view.setBounds(this._pendingBounds);
      this._lastBoundsKey = JSON.stringify(this._pendingBounds);
    }
    tab.view = view;
    const wc = view.webContents;
    wc.on("did-start-navigation", () => { if (this._view === view) this._syncPageState({ loadState: "loading" }); });
    wc.on("did-navigate", (_e, url) => { tab.url = url; if (this._view === view) this._syncPageState({ url, loadState: "ready" }); });
    wc.on("did-navigate-in-page", (_e, url) => { tab.url = url; if (this._view === view) this._syncPageState({ url }); });
    wc.on("did-finish-load", () => { this._onPageVisit?.(wc); });
    wc.on("page-title-updated", (_e, title) => { tab.title = title; if (this._view === view) this._syncPageState({ title }); });
    wc.on("did-fail-load", (_e, code, description) => {
      if (this._view !== view) return;
      if (code !== -3) this._pushTimeline("navigation", `Load failed: ${description}`, "error");
      this._syncPageState({ loadState: "error" });
    });
    return view;
  }

  _createTab() {
    if (this._view) this._view.setVisible(false);
    const tab = { id: randomUUID(), title: "New tab", url: "", view: null, lastActiveAt: this._now() };
    const view = this._buildTabView(tab);
    this._tabs.push(tab);
    this._activeTabId = tab.id;
    this._view = view;
    this._page = { url: tab.url, title: tab.title, loadState: "idle", canGoBack: false, canGoForward: false, hasPage: false };
    this._emit();
    return view;
  }

  // Frees the renderer of an inactive tab while keeping its record (id, title,
  // url). selectTab() brings it back by loading the saved url on a new view.
  discardTab(tabId) {
    const tab = this._tabs.find((candidate) => candidate.id === tabId);
    if (!tab || !tab.view || !tab.url) return false;
    if (tab.id === this._activeTabId || tab.view === this._view) return false;
    if (tab.view.webContents.isCurrentlyAudible?.()) return false;
    if (this._queue.some((item) => item._originTabId === tab.id)) return false;
    tab.view.setVisible(false);
    this._closeView(tab.view);
    tab.view = null;
    return true;
  }

  discardIdleTabs(idleMs) {
    const cutoff = this._now() - idleMs;
    let count = 0;
    for (const tab of this._tabs) {
      if (tab.view && tab.lastActiveAt <= cutoff && this.discardTab(tab.id)) count += 1;
    }
    if (count > 0) this._emit();
    return count;
  }
```

In `getSnapshot()` change the tabs line to:

```js
      tabs: this._tabs.map(({ id, title, url, view }) => ({ id, title, url, discarded: !view })),
```

In `selectTab`, restore before the existing `if (this._view !== tab.view)` block, and stamp activity:

```js
    if (!tab.view) {
      this._buildTabView(tab);
      tab.view.webContents.loadURL(tab.url).catch(() => {});
    }
    tab.lastActiveAt = this._now();
```

In `closeTab`, replace the two `tab.view.webContents.destroy?.()` branches with `_closeView`, guarded for a discarded tab:

```js
    if (tab.view === this._view) {
      const next = this._tabs[Math.min(index, this._tabs.length - 1)];
      tab.view.setVisible(false);
      this._closeView(tab.view);
      this._view = null;
      await this.selectTab(next.id);
    } else if (tab.view) {
      this._closeView(tab.view);
    }
```

(Delete the now-duplicated `removeChildView` calls in `closeTab`; `_closeView` does it.)

In `main/index.js`, inside `createWindow` right after `const controlApi = new ControlApi(...)`, add the sweep and clear it on close:

```js
  const tabSweep = setInterval(() => controlApi.discardIdleTabs(10 * 60_000), 60_000);
  win.once("closed", () => clearInterval(tabSweep));
```

- [ ] **Step 5: Run the tests**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/control-api.test.js`
Expected: all PASS, including the three new tests and every existing tab test.

- [ ] **Step 6: Verify against a real Electron**

Run:
```bash
cd /Users/songjiun/Halo/apps/computer-browser && cat > /tmp/discard-real.js <<'EOF'
const { app, BrowserWindow, WebContentsView } = require("electron");
const { ControlApi } = require("/Users/songjiun/Halo/apps/computer-browser/main/control-api");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  const api = new ControlApi({ window: win, socketPath: "/tmp/none.sock", requestDecision: async () => ({ decision: "allow", reasons: [] }) });
  const a = await api.navigate("about:blank").catch(() => null);
  await api.newTab(); await api.newTab();
  const tabs = api.getSnapshot().tabs;
  const before = app.getAppMetrics().length;
  console.log("DISCARD", tabs.map((t) => t.discarded), "first ok:", api.discardTab(tabs[0].id), "metrics", before, app.getAppMetrics().length);
  app.quit();
});
EOF
./node_modules/.bin/electron /tmp/discard-real.js 2>&1 | grep -E "DISCARD|Error" | head
```
Expected: a `DISCARD` line without a stack trace. (`about:blank` has no url, so `discardTab` returns `false` here; this step only proves the real `WebContentsView` path of `_buildTabView` and `_closeView` runs without throwing. If it throws, fix before committing.)

- [ ] **Step 7: Commit**

```bash
cd /Users/songjiun/Halo && git add apps/computer-browser/main/control-api.js apps/computer-browser/main/index.js apps/computer-browser/test/control-api.test.js
git commit -m "Discard idle inactive tabs and restore them on selection

Tabs keep their id, title and url while their renderer is closed. Closing a tab
now uses webContents.close() so its renderer is really released.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cheaper, faster agent mirror

**Files:**
- Modify: `apps/computer-browser/main/harness/agent-viewport-host.js` (`captureFrame`)
- Modify: `frontend/src/App.tsx` (the `setInterval` at the agent-frame effect, line ~254)
- Test: `apps/computer-browser/test/agent-viewport-host.test.js`

**Interfaces:**
- Consumes: `view.webContents.capturePage()` returning a `nativeImage`-like object with `isEmpty()`, `getSize()`, `resize()`, `toBitmap()`, `toJPEG(q)`.
- Produces: `captureFrame(taskId)` still returns a `data:image/jpeg;base64,...` string or `null`. When the page is unchanged since the previous capture for that task it returns the **same string** without resizing or encoding, so React's `setAgentFrame` sees an identical value and skips the re-render and image decode. The mirror interval becomes 250 ms.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-viewport-host.test.js`:

```js
function fakeImage(bytes, { width = 1440 } = {}) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height: 900 }),
    toBitmap: () => Buffer.from(bytes),
    resize() { return this; },
    toJPEG: () => Buffer.from(`jpeg:${bytes.join(",")}`),
  };
}

test("captureFrame returns the previous frame without re-encoding when the page is unchanged", async () => {
  const { host, views } = setup();
  host.ensure("task-a");
  let encodes = 0;
  let next = fakeImage([1, 2, 3, 4]);
  const original = next.toJPEG;
  views[0].webContents.capturePage = async () => {
    const image = next;
    image.toJPEG = (...args) => { encodes += 1; return original(...args); };
    return image;
  };
  const first = await host.captureFrame("task-a");
  const second = await host.captureFrame("task-a");
  assert.equal(first, second);
  assert.equal(encodes, 1, "an unchanged page is encoded once");
  next = fakeImage([9, 9, 9, 9]);
  const third = await host.captureFrame("task-a");
  assert.notEqual(third, first);
  assert.equal(encodes, 2);
});

test("captureFrame fingerprints are per task", async () => {
  const { host, views } = setup();
  host.ensure("task-a");
  host.ensure("task-b");
  views[0].webContents.capturePage = async () => fakeImage([1, 1, 1, 1]);
  views[1].webContents.capturePage = async () => fakeImage([1, 1, 1, 1]);
  const a = await host.captureFrame("task-a");
  const b = await host.captureFrame("task-b");
  assert.ok(a && b);
  await host.dispose("task-a");
  assert.equal(await host.captureFrame("task-a"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/agent-viewport-host.test.js`
Expected: the first new test FAILS (`encodes` is 2 at the first assertion).

- [ ] **Step 3: Implement the fingerprint**

In `agent-viewport-host.js`, add near the top of the file (below the other `require`s):

```js
const { createHash } = require("node:crypto");

// A change fingerprint of a downscaled copy of the page. It is cheap enough to
// run every poll and is only used to decide whether to repeat the JPEG encode.
function frameFingerprint(image) {
  const small = image.resize({ width: 64, quality: "good" });
  return createHash("sha1").update(small.toBitmap()).digest("hex");
}
```

Add `this._lastFrames = new Map(); // taskId -> { fingerprint, dataUrl }` to the constructor. Replace `captureFrame` with:

```js
  async captureFrame(taskId) {
    const view = this._hosts.get(taskId)?.view;
    if (!view || view.webContents.isDestroyed()) return null;
    try {
      const image = await view.webContents.capturePage();
      if (!image || image.isEmpty()) return null;
      const fingerprint = frameFingerprint(image);
      const last = this._lastFrames.get(taskId);
      if (last && last.fingerprint === fingerprint) return last.dataUrl;
      const sized = image.getSize().width > 1200 ? image.resize({ width: 1200, quality: "good" }) : image;
      const dataUrl = `data:image/jpeg;base64,${sized.toJPEG(65).toString("base64")}`;
      this._lastFrames.set(taskId, { fingerprint, dataUrl });
      return dataUrl;
    } catch {
      return null;
    }
  }
```

In `_disposeEntry`, drop the cached frame: add `this._lastFrames.delete(id);` right after `map.delete(id);`.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/songjiun/Halo/apps/computer-browser && node --test test/agent-viewport-host.test.js`
Expected: all PASS.

- [ ] **Step 5: Poll faster in the frontend**

In `frontend/src/App.tsx`, in the agent-frame effect change only the interval value:

```tsx
    const id = window.setInterval(() => void tick(), 250)
```

(was `600`). Because `captureFrame` now returns the identical string for an unchanged page, `setAgentFrame(frame)` is a no-op for React and costs no render or decode.

- [ ] **Step 6: Typecheck, build and run the suite**

Run:
```bash
cd /Users/songjiun/Halo/apps/computer-browser && npm test 2>&1 | tail -8
cd /Users/songjiun/Halo/frontend && npx tsc --noEmit 2>&1 | tail -5
```
Expected: the node test run ends with no failures (record the pass count in the commit body); `tsc` prints nothing.

- [ ] **Step 7: Measure the cost of the faster mirror in a real Electron**

Run the existing isolated harness variant with a 250 ms interval and the fingerprint (adapt `cap.js` from the session scratchpad: set the interval to 250, call the new `frameFingerprint` before encoding) and confirm the focused video still shows `dropped: 0` and `mainLagMaxMs` stays within 15 ms of the no-capture baseline. If it does not, raise the interval to 400 ms in `App.tsx` and say so in the commit message.

- [ ] **Step 8: Commit**

```bash
cd /Users/songjiun/Halo && git add apps/computer-browser/main/harness/agent-viewport-host.js apps/computer-browser/test/agent-viewport-host.test.js
git add -p frontend/src/App.tsx   # stage ONLY the 600 -> 250 hunk
git commit -m "Agent mirror skips unchanged frames and refreshes every 250 ms

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- Spec coverage (Phase 1): shared hidden window (Task 1); user-tab discard and restore with the never-discard rules audible / active / blank / queued-origin (Task 2); mirror change (Task 3, as cadence plus fingerprint rather than a picture-in-picture panel, because the mirror only replaces the view of the task the user is watching). Excluded on purpose and stated at the top: lazy visible view, `stopPainting`.
- Placeholder scan: every code step has the code; the only conditional is Task 2 Step 1, which resolves the queue field name and the `destroy`/`close` question against the real code before the implementation step uses them.
- Type consistency: `discardTab(tabId) -> boolean`, `discardIdleTabs(idleMs) -> number`, `getSnapshot().tabs[i].discarded`, `AgentViewportHost._sharedHost/_sharedViewCount/_lastFrames`, `frameFingerprint(image)` are used with the same names in tests and implementation.
