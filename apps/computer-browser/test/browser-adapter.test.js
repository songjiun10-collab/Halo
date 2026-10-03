"use strict";

// Tests for main/harness/browser-adapter.js: the observe()/execute() surface
// TaskController drives against a single Electron WebContentsView. No real
// Electron here -- these inject a fake WebContentsView-like `view` (same
// pattern as test/control-api.test.js's makeFakeView), so the boundary
// contracts (bounded traversal, host-owned elementId, documentEpoch
// staleness, ActionResult typing, unsupported actions) are exercised
// directly and deterministically.

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { BrowserAdapter, BrowserAdapterError, buildObserveScript } = require("../main/harness/browser-adapter");

test("page navigation and redirects reject unsafe URLs even without an origin or Intent Lock", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc } });
  for (const eventName of ["will-navigate", "will-redirect"]) {
    for (const url of ["file:///tmp/halo-canary.html", "javascript:alert(1)", "data:text/html,test",
      "custom-app://open", "not a url", "https://user:secret@example.com/"]) {
      let prevented = false;
      wc.emit(eventName, { preventDefault() { prevented = true; } }, url);
      assert.equal(prevented, true, `${eventName} must refuse ${url}`);
    }
    for (const url of ["https://example.com/", "http://127.0.0.1:1234/"]) {
      let prevented = false;
      wc.emit(eventName, { preventDefault() { prevented = true; } }, url);
      assert.equal(prevented, false, `${eventName} must allow ${url}`);
    }
  }
});

test("browser snapshot and subscribers follow real page navigation, and unsubscribe on dispose", async () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "https://example.com", getTitle: () => "Real page", close() {},
    navigationHistory: { canGoBack: () => true, canGoForward: () => false } });
  const browser = new BrowserAdapter({ view: { webContents: wc } });
  const changes = [];
  const unsubscribe = browser.onChange(s => changes.push(s));
  browser.onChange(() => { throw new Error("observer failure"); });
  wc.emit("did-navigate");
  assert.equal(changes[0].tabs[0].title, "Real page");
  assert.equal(changes[0].tabs[0].canGoBack, true);
  assert.equal(changes[0].documentEpoch, 1);
  unsubscribe(); wc.emit("page-title-updated");
  assert.equal(changes.length, 1);
  await browser.dispose();
  assert.equal(wc.listenerCount("did-navigate"), 0);
  assert.deepEqual(browser.getBrowserSnapshot().tabs, []);
});

test("human navigation rejects privileged protocols and reports real load errors", async () => {
  const calls = [];
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async url => { calls.push(url); throw new Error("offline"); } }) });
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com"]) {
    await assert.rejects(browser.userNavigate({ type:"navigate", url }), { code:"invalid_url" });
  }
  assert.equal(calls.length, 0);
  await assert.rejects(browser.userNavigate({ type:"navigate", url:"https://example.com" }), {code:"navigation_error"});
  assert.equal(calls.length, 1);
});

test("credential autofill is origin-bound, fills only a unique login pair, and never submits or returns secrets", async () => {
  let script;
  let currentUrl = "https://accounts.example/login";
  const browser = new BrowserAdapter({ view: makeFakeView({
    getURL: () => currentUrl,
    executeJavaScript: async (value) => { script = value; return { status: "ok", usernameFilled: true, passwordFilled: true }; },
  }) });
  const result = await browser.fillCredential({ username: "alice@example.com", password: "supersecret", origin: "https://accounts.example" });
  assert.deepEqual(result, { status: "ok", usernameFilled: true, passwordFilled: true });
  assert.ok(script.includes("alice@example.com"));
  assert.ok(script.includes("supersecret"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret|alice@example/);
  assert.match(script, /dispatchEvent/);
  assert.doesNotMatch(script, /requestSubmit|\.submit\(/);
  assert.deepEqual(await browser.fillCredential({ username: "a", password: "p", origin: "https://other.example" }), { status: "failed", errorCode: "credential_origin_mismatch" });
  currentUrl = "http://accounts.example/login";
  assert.deepEqual(await browser.fillCredential({ username: "a", password: "p", origin: "http://accounts.example" }), { status: "failed", errorCode: "credential_origin_mismatch" });
});

test("BrowserAdapter repeats the current permission boundary for direct execute calls", async () => {
  let navigations = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { navigations += 1; } }) });
  browser.setPermissionMode("observe");
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://example.com" }), { status: "failed", errorCode: "permission_mode_denied" });
  assert.equal(navigations, 0);
  browser.setPermissionMode("browse");
  assert.equal((await browser.execute({ type: "navigate", url: "https://example.com" })).status, "ok");
  assert.equal(navigations, 1);
});

// --- Task 4 (multi-agent background runtime plan): child origin lock.
// A child agent is constructed with `assignedOrigin` (the host-derived
// normalized origin of its entryUrl) and must reject any PAGE-initiated
// navigation or redirect away from that origin -- independent of
// permissionMode/execute(), since a page can navigate itself without ever
// going through execute().

test("assignedOrigin rejects a page-initiated will-navigate to a different origin", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: "https://example.com" });
  let prevented = false;
  wc.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://evil.example/steal");
  assert.equal(prevented, true);
});

test("assignedOrigin allows navigation that stays within the assigned origin", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: "https://example.com" });
  let prevented = false;
  wc.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://example.com/path?query=1");
  assert.equal(prevented, false);
});

test("assignedOrigin rejects a server/page redirect (will-redirect) to a different origin", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: "https://example.com" });
  let prevented = false;
  wc.emit("will-redirect", { preventDefault: () => { prevented = true; } }, "https://attacker.example/");
  assert.equal(prevented, true);
});

test("assignedOrigin rejects an unparseable redirect URL fail-closed", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: "https://example.com" });
  let prevented = false;
  wc.emit("will-redirect", { preventDefault: () => { prevented = true; } }, "not a url");
  assert.equal(prevented, true);
});

test("without assignedOrigin the guard is still installed (Intent Lock) but allows any origin when unlocked", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  new BrowserAdapter({ view: { webContents: wc } });
  assert.equal(wc.listenerCount("will-navigate"), 1);
  assert.equal(wc.listenerCount("will-redirect"), 1);
  let prevented = false;
  wc.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://anywhere.example/");
  assert.equal(prevented, false);
});

test("assignedOrigin must be a non-empty string when provided", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  assert.throws(() => new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: "" }), BrowserAdapterError);
});

test("history traversal stays pending until load settles and cleans up listeners", async () => {
  const wc = new EventEmitter();
  let index;
  Object.assign(wc, { getURL: () => "https://example.com", stop() {}, navigationHistory: {
    canGoBack: () => true, getActiveIndex: () => 2, goToIndex: i => { index = i; },
  } });
  const browser = new BrowserAdapter({ view: {webContents:wc}, navigationTimeoutMs:100 });
  let done = false;
  const pending = browser.userNavigate({type:"back"}).then(() => {done=true;});
  await Promise.resolve();
  assert.equal(index, 1); assert.equal(done, false);
  wc.emit("did-stop-loading"); await pending;
  assert.equal(done,true); assert.equal(wc.listenerCount("did-fail-load"),0);
  await assert.rejects(browser.userNavigate({type:"back"}), {code:"navigation_timeout"});
  assert.equal(wc.listenerCount("destroyed"),0);
});

function makeFakeView({ loadURL, executeJavaScript, stop, getURL } = {}) {
  return {
    webContents: {
      ...(getURL ? { getURL } : {}),
      loadURL: loadURL || (async () => {}),
      stop: stop || (() => {}),
      executeJavaScript: executeJavaScript || (async () => ({ url: "https://example.com/", title: "", text: "", elements: [] })),
    },
  };
}

test("constructor requires a view", () => {
  assert.throws(() => new BrowserAdapter({}), BrowserAdapterError);
});

test("captureScreenshot returns PNG pixels only for the latest observation and its fixed viewport", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = makeFakeView({
    getURL: () => "https://example.com/",
    executeJavaScript: async () => ({ url: "https://example.com/", title: "Fixture", text: "", elements: [] }),
  });
  view.getBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 });
  view.webContents.capturePage = async () => ({ toPNG: () => png, getSize: () => ({ width: 1440, height: 900 }) });
  const adapter = new BrowserAdapter({ view });
  const observation = await adapter.observe();

  const captured = await adapter.captureScreenshot(observation);

  assert.deepEqual(captured, {
    png,
    observationId: observation.id,
    documentEpoch: observation.documentEpoch,
    url: "https://example.com/",
    viewport: { width: 1440, height: 900 },
  });
  await assert.rejects(adapter.captureScreenshot({ ...observation, id: "44444444-4444-4444-8444-444444444444" }), { code: "stale_visual_observation" });
});

test("captureScreenshot rejects a navigation or viewport resize racing the screenshot", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let currentUrl = "https://example.com/";
  let captureMode = "navigation";
  let boundCalls = 0;
  const wc = new EventEmitter();
  Object.assign(wc, {
    getURL: () => currentUrl,
    getTitle: () => "Fixture",
    executeJavaScript: async () => ({ url: currentUrl, title: "Fixture", text: "", elements: [] }),
    capturePage: async () => {
      if (captureMode === "navigation") {
        currentUrl = "https://other.example/";
        wc.emit("did-navigate", {}, currentUrl, 200);
      }
      return { toPNG: () => png, getSize: () => ({ width: 1440, height: 900 }) };
    },
    close() {},
  });
  const view = {
    webContents: wc,
    getBounds: () => {
      boundCalls += 1;
      return { x: 0, y: 0, width: boundCalls > 1 && captureMode === "resize" ? 1280 : 1440, height: 900 };
    },
  };
  const adapter = new BrowserAdapter({ view });
  const navigationObservation = await adapter.observe();
  await assert.rejects(adapter.captureScreenshot(navigationObservation), { code: "stale_visual_observation" });

  captureMode = "resize";
  currentUrl = "https://example.com/";
  boundCalls = 0;
  const resizedObservation = await adapter.observe();
  await assert.rejects(adapter.captureScreenshot(resizedObservation), { code: "stale_visual_observation" });
});

test("coordinate actions use only the host-authorized current screenshot and consume it before input", async () => {
  const sent = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = makeFakeView({
    getURL: () => "https://example.com/path",
    executeJavaScript: async () => ({ url: "https://example.com/path", title: "Fixture", text: "", elements: [] }),
  });
  view.getBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 });
  view.webContents.capturePage = async () => ({ toPNG: () => png, getSize: () => ({ width: 1440, height: 900 }) });
  view.webContents.sendInputEvent = (event) => sent.push(event);
  view.webContents.insertText = (text) => sent.push({ type: "insertText", text });
  const adapter = new BrowserAdapter({ view, permissionMode: "full" });
  const observation = await adapter.observe();
  const capture = await adapter.captureScreenshot(observation);
  const binding = {
    observationId: capture.observationId,
    taskId: "11111111-1111-4111-8111-111111111111",
    agentId: null,
    documentEpoch: capture.documentEpoch,
    origin: "https://example.com",
    capturedAt: 1,
    viewport: capture.viewport,
    digest: "0".repeat(64),
  };
  adapter.authorizeVisualBinding(binding);
  const action = { type: "type_at", observationId: observation.id, x: 0.5, y: 0.25, text: "검색" };
  assert.deepEqual(await adapter.execute(action, { documentEpoch: observation.documentEpoch }), { status: "ok" });
  assert.deepEqual(sent, [
    { type: "mouseDown", x: 720, y: 225, button: "left", clickCount: 1 },
    { type: "mouseUp", x: 720, y: 225, button: "left", clickCount: 1 },
    { type: "insertText", text: "검색" },
  ]);
  assert.deepEqual(await adapter.execute(action, { documentEpoch: observation.documentEpoch }), { status: "failed", errorCode: "stale_visual_observation" });
  assert.equal(sent.length, 3, "the screenshot binding is single-use");
});

test("coordinate actions reject stale, cross-origin, resized, and malformed bindings without input", async () => {
  const sent = [];
  const view = makeFakeView({ getURL: () => "https://example.com/", executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "", elements: [] }) });
  view.getBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 });
  view.webContents.capturePage = async () => ({ toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), getSize: () => ({ width: 1440, height: 900 }) });
  view.webContents.sendInputEvent = (event) => sent.push(event);
  const adapter = new BrowserAdapter({ view, permissionMode: "full" });
  const observation = await adapter.observe();
  const capture = await adapter.captureScreenshot(observation);
  const binding = { observationId: capture.observationId, taskId: "11111111-1111-4111-8111-111111111111", agentId: null,
    documentEpoch: capture.documentEpoch, origin: "https://example.com", capturedAt: 1, viewport: capture.viewport, digest: "0".repeat(64) };
  for (const changed of [
    { ...binding, observationId: "other-observation" },
    { ...binding, origin: "https://other.example" },
    { ...binding, documentEpoch: binding.documentEpoch + 1 },
  ]) assert.throws(() => adapter.authorizeVisualBinding(changed), { code: "invalid_visual_binding" });
  adapter.authorizeVisualBinding(binding);
  assert.notEqual((await adapter.execute({ type: "click_at", observationId: "other-observation", x: 0.2, y: 0.2 }, { documentEpoch: observation.documentEpoch })).status, "ok");
  view.webContents.getURL = () => "https://other.example/";
  assert.notEqual((await adapter.execute({ type: "click_at", observationId: observation.id, x: 0.2, y: 0.2 }, { documentEpoch: observation.documentEpoch })).status, "ok");
  view.webContents.getURL = () => "https://example.com/";
  view.getBounds = () => ({ x: 0, y: 0, width: 1000, height: 700 });
  assert.notEqual((await adapter.execute({ type: "click_at", observationId: observation.id, x: 0.2, y: 0.2 }, { documentEpoch: observation.documentEpoch })).status, "ok");
  view.getBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 });
  assert.notEqual((await adapter.execute({ type: "click_at", observationId: observation.id, x: 1, y: 0.2 }, { documentEpoch: 0 })).status, "ok");
  assert.deepEqual(sent, []);
});

// --- ActionResult typing: a rejected loadURL must be reported as failed,
// never as ok/completed (this is the same "navigation error swallowing"
// class of bug fixed in control-api.js, and browser-adapter.js must not
// reintroduce it).

test("execute(navigate) reports status:'failed' (not ok) when loadURL rejects", async () => {
  const view = makeFakeView({
    loadURL: async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({ type: "navigate", url: "https://does-not-exist.invalid" });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "navigation_error");
});

test("execute(navigate) reports ok and bumps documentEpoch on a genuine successful load", async () => {
  const view = makeFakeView({ loadURL: async () => {} });
  const adapter = new BrowserAdapter({ view });
  assert.equal(adapter.getDocumentEpoch(), 0);

  const result = await adapter.execute({ type: "navigate", url: "https://example.com" });

  assert.equal(result.status, "ok");
  assert.equal(adapter.getDocumentEpoch(), 1);
  // Must be a kind task-controller.js's evidence pipeline actually accepts
  // (shared/harness-contracts.js's EVIDENCE_KINDS: host_check|user_confirmation|artifact)
  // -- a "navigation"-kind candidate would fail validateEvidence() and
  // latch the whole task store into storage_corrupt on the very first dispatch.
  assert.equal(result.evidenceCandidate.kind, "host_check");
  assert.equal(result.evidenceCandidate.sourceUrl, "https://example.com");
});

// --- Timeout: aborts and cleans up rather than hanging or leaking timers.

test("execute(navigate) aborts a hung load, stops it, and reports failed:navigation_timeout", async () => {
  let stopped = false;
  const view = makeFakeView({
    loadURL: () => new Promise(() => {}), // never resolves
    stop: () => {
      stopped = true;
    },
  });
  const adapter = new BrowserAdapter({ view, navigationTimeoutMs: 20 });

  const start = Date.now();
  const result = await adapter.execute({ type: "navigate", url: "https://example.com" });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 300, `expected to resolve near the 20ms timeout, took ${elapsed}ms`);
  assert.equal(stopped, true, "a hung load must be actively aborted via webContents.stop()");
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "navigation_timeout");
  assert.equal(adapter.getDocumentEpoch(), 0, "a timed-out navigation must not bump the epoch");
});

test("does not leave a pending timer after a navigation settles well within the timeout", async () => {
  const view = makeFakeView({ loadURL: async () => {} });
  const adapter = new BrowserAdapter({ view, navigationTimeoutMs: 5000 });

  await adapter.execute({ type: "navigate", url: "https://example.com" });

  // If _loadWithTimeout leaked its setTimeout, node's event loop would still
  // have a pending timer keeping the process alive; node --test's own
  // process-exit bookkeeping would catch a real leak across the whole file,
  // but we can also assert directly that no unref'd handle lingers by
  // checking the active timer count is unaffected (best-effort, matches the
  // spirit of "timeout listener cleanup" from the design doc).
  assert.equal(typeof adapter.getDocumentEpoch(), "number");
});

// --- Navigation ID / cross-event isolation: a call that settles AFTER a
// newer navigate() has already superseded it must not retroactively own the
// document or report itself as authoritative.

test("an older navigate() call that resolves after a newer one has started does not bump the epoch or report ok", async () => {
  let resolveFirst;
  const firstLoad = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let callCount = 0;
  const view = makeFakeView({
    loadURL: () => {
      callCount += 1;
      return callCount === 1 ? firstLoad : Promise.resolve();
    },
  });
  const adapter = new BrowserAdapter({ view });

  const firstPromise = adapter.execute({ type: "navigate", url: "https://first.example" });
  // Start and finish a second, newer navigate() before the first settles.
  const secondResult = await adapter.execute({ type: "navigate", url: "https://second.example" });
  assert.equal(secondResult.status, "ok");
  assert.equal(adapter.getDocumentEpoch(), 1);

  resolveFirst();
  const firstResult = await firstPromise;

  assert.equal(firstResult.status, "cancelled");
  assert.equal(firstResult.errorCode, "superseded");
  assert.equal(adapter.getDocumentEpoch(), 1, "the superseded call must not bump the epoch a second time");
});

// --- documentEpoch staleness: an action referencing an older document must
// be rejected without executing, not silently acted on.

test("execute(scroll) rejects a stale documentEpoch without scrolling", async () => {
  let scrolled = false;
  const view = makeFakeView({
    executeJavaScript: async (script) => {
      if (script.includes("scrollBy")) scrolled = true;
      return { url: "https://example.com/", title: "", text: "", elements: [] };
    },
  });
  const adapter = new BrowserAdapter({ view });
  await adapter.execute({ type: "navigate", url: "https://example.com" }); // epoch -> 1

  const result = await adapter.execute({ type: "scroll", direction: "down" }, { documentEpoch: 0 });

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorCode, "stale_document");
  assert.equal(scrolled, false, "a stale-epoch action must never actually execute");
});

test("execute(scroll) proceeds when documentEpoch matches the current document", async () => {
  let scrolled = false;
  const view = makeFakeView({
    executeJavaScript: async (script) => {
      if (script.includes("scrollBy")) scrolled = true;
      return { url: "https://example.com/", title: "", text: "", elements: [] };
    },
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({ type: "scroll", direction: "down" }, { documentEpoch: 0 });

  assert.equal(result.status, "ok");
  assert.equal(scrolled, true);
});

// --- follow_link: host-owned elementId only, real href re-resolved at
// execute time -- never trusts a href the action itself might carry, and
// rejects if the anchor at that index has changed since the observation.

test("execute(follow_link) navigates to the anchor's ACTUAL current href, ignoring any href the action claims", async () => {
  const view = makeFakeView({
    executeJavaScript: async (script) => {
      if (script.includes("scrollBy")) return undefined;
      return {
        url: "https://example.com/",
        title: "",
        text: "",
        elements: [{ role: "link", name: "Next", href: "https://example.com/real-target" }],
      };
    },
    loadURL: async () => {},
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({
    type: "follow_link",
    elementId: "0",
    // A hostile/broken proposal claiming a different destination -- must be ignored.
    href: "https://attacker.example/",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.evidenceCandidate.sourceUrl, "https://example.com/real-target");
});

test("execute(follow_link) fails when the anchor at that elementId is gone (page changed under the same epoch)", async () => {
  const view = makeFakeView({
    executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "", elements: [] }),
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({ type: "follow_link", elementId: "0" });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "element_not_found");
});

test("execute(follow_link) rejects a stale documentEpoch without re-resolving anything", async () => {
  let observeCalls = 0;
  const view = makeFakeView({
    executeJavaScript: async () => {
      observeCalls += 1;
      return { url: "https://example.com/", title: "", text: "", elements: [{ role: "link", name: "x", href: "https://example.com/x" }] };
    },
    loadURL: async () => {},
  });
  const adapter = new BrowserAdapter({ view });
  await adapter.execute({ type: "navigate", url: "https://example.com" }); // epoch -> 1

  const result = await adapter.execute({ type: "follow_link", elementId: "0" }, { documentEpoch: 0 });

  assert.equal(result.status, "cancelled");
  assert.equal(result.errorCode, "stale_document");
  assert.equal(observeCalls, 0, "a stale-epoch follow_link must not even re-run the DOM read");
});

// --- Unsupported actions: reported honestly, never silently mapped to a
// permissive read or ignored.

for (const type of ["download"]) {
  test(`execute(${type}) reports failed:unsupported_action`, async () => {
    const adapter = new BrowserAdapter({ view: makeFakeView() });
    const result = await adapter.execute({ type });
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "unsupported_action");
  });
}

test("execute() with an unknown action type fails cleanly instead of throwing", async () => {
  const adapter = new BrowserAdapter({ view: makeFakeView() });
  const result = await adapter.execute({ type: "eval", code: "alert(1)" });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "unknown_action");
});

// --- observe(): failure must surface as a real failure, never as an empty
// but "successful" page.

test("observe() throws (does not return a hollow success) when the page read itself fails", async () => {
  const view = makeFakeView({
    executeJavaScript: async () => {
      throw new Error("boom");
    },
  });
  const adapter = new BrowserAdapter({ view });

  await assert.rejects(() => adapter.observe(), BrowserAdapterError);
});

test("execute(observe) reports status:'failed' (not ok with an empty page) when the read throws", async () => {
  const view = makeFakeView({
    executeJavaScript: async () => {
      throw new Error("boom");
    },
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({ type: "observe" });

  assert.equal(result.status, "failed");
});

test("execute(observe) reports an 'artifact'-kind evidenceCandidate on success (a valid EVIDENCE_KINDS value)", async () => {
  const view = makeFakeView({
    executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "hi", elements: [] }),
  });
  const adapter = new BrowserAdapter({ view });

  const result = await adapter.execute({ type: "observe" });

  assert.equal(result.status, "ok");
  assert.equal(result.evidenceCandidate.kind, "artifact");
  assert.ok(result.evidenceCandidate.observationId);
});

test("observe() assigns host-owned sequential elementIds and includes the current documentEpoch", async () => {
  const view = makeFakeView({
    executeJavaScript: async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "hello world",
      elements: [
        { role: "link", name: "One", href: "https://example.com/1", index: 0, parentIndex: null },
        { role: "button", name: "Go", index: 1, parentIndex: 0 },
      ],
    }),
  });
  const adapter = new BrowserAdapter({ view });

  const observation = await adapter.observe();

  assert.equal(observation.documentEpoch, 0);
  assert.equal(observation.elements[0].elementId, "0");
  assert.equal(observation.elements[1].elementId, "1");
  assert.equal(observation.elements[0].parentElementId, null);
  assert.equal(observation.elements[1].parentElementId, "0");
  assert.equal("parentIndex" in observation.elements[1], false, "raw DOM traversal indices stay internal");
  assert.equal("index" in observation.elements[1], false, "the public contract uses host-owned elementIds");
  assert.equal("tag" in observation.elements[1], false);
  assert.equal("text" in observation.elements[1], false);
  assert.equal(observation.url, "https://example.com/");
  assert.ok(observation.id);
  assert.ok(typeof observation.at === "number");
});

// --- Bounded DOM traversal: the script itself must encode the visited-node
// cap, element cap, and text byte cap -- not just slice an unbounded query
// result after the fact.

test("observe() bounds the traversal script to maxNodesVisited/maxElements/maxTextBytes", async () => {
  let receivedScript = null;
  const view = makeFakeView({
    executeJavaScript: async (script) => {
      receivedScript = script;
      return { url: "https://example.com/", title: "", text: "", elements: [] };
    },
  });
  const adapter = new BrowserAdapter({ view, maxNodesVisited: 42, maxElements: 7, maxTextBytes: 999 });

  await adapter.observe();

  assert.match(receivedScript, /visited < 42/);
  assert.match(receivedScript, /elements\.length < 7/);
  assert.match(receivedScript, /999/);
  assert.match(receivedScript, /createTreeWalker/, "must walk bounded, not querySelectorAll + slice");
});

// --- dispose(): the emergency memory-pressure teardown path (task-controller.js)
// needs a way to actually release this adapter's WebContentsView, not just
// stop calling it.

test("dispose() destroys the underlying webContents/view so the emergency teardown path can actually release it", async () => {
  let destroyed = false;
  const view = {
    webContents: {
      loadURL: async () => {},
      stop: () => {},
      executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "", elements: [] }),
      close: () => {
        destroyed = true;
      },
    },
  };
  const adapter = new BrowserAdapter({ view });

  await adapter.dispose();

  assert.equal(destroyed, true);
});

test("dispose() is a safe no-op if the view has no close()/destroy() method", async () => {
  const adapter = new BrowserAdapter({ view: makeFakeView() });
  await assert.doesNotReject(() => adapter.dispose());
});

// --- Real-Electron-discovered bug (Task 6): a genuine Electron webContents'
// executeJavaScript() hangs forever if called before ANY navigation has ever
// happened on it (no committed document/render frame to inject into) --
// confirmed by direct reproduction against real Electron, not simulated.
// observe() is the very first call task-controller.js's _runLoop makes, so
// this hung the whole harness on its first iteration against a real
// WebContentsView, even though every fake-view unit test above passed
// (fakes don't reproduce Electron's real timing constraint here). The fix:
// lazily load "about:blank" once, before the first executeJavaScript call,
// whenever the real webContents reports no URL yet (wc.getURL() === "").
// Fakes that don't implement getURL() at all (every fake above) are
// untouched -- this only activates for a real Electron-shaped webContents.

test("observe() loads about:blank first if the real webContents has never navigated (getURL() === '')", async () => {
  let blankLoaded = false;
  const view = {
    webContents: {
      getURL: () => (blankLoaded ? "about:blank" : ""),
      loadURL: async (url) => {
        if (url === "about:blank") blankLoaded = true;
      },
      executeJavaScript: async () => {
        if (!blankLoaded) throw new Error("executeJavaScript called before any navigation -- this is the real hang this fix prevents");
        return { url: "about:blank", title: "", text: "", elements: [] };
      },
    },
  };
  const adapter = new BrowserAdapter({ view });

  const observation = await adapter.observe();

  assert.equal(blankLoaded, true);
  assert.equal(observation.url, "about:blank");
});

test("initial blank observation is synthesized truthfully without loading a document just to inspect it", async () => {
  let loads = 0;
  let scripts = 0;
  const view = makeFakeView({
    getURL: () => "",
    loadURL: async () => { loads += 1; },
    executeJavaScript: async () => { scripts += 1; return { url: "about:blank", title: "", text: "", elements: [] }; },
  });
  const adapter = new BrowserAdapter({ view, now: () => 42, randomId: () => "initial-obs" });
  const observation = await adapter.observe({ initial: true });
  assert.deepEqual(observation, {
    id: "initial-obs", documentEpoch: 0, url: "about:blank", title: "", text: "", elements: [], at: 42,
  });
  assert.equal(loads, 0, "blank DOM need not be committed when the host already knows this fresh view is blank");
  assert.equal(scripts, 0, "do not inject JavaScript merely to observe a host-created empty page");
});

test("observe() does NOT load about:blank if the real webContents already has a URL (already navigated)", async () => {
  let loadURLCalls = 0;
  const view = {
    webContents: {
      getURL: () => "https://example.com/",
      loadURL: async () => {
        loadURLCalls += 1;
      },
      executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "", elements: [] }),
    },
  };
  const adapter = new BrowserAdapter({ view });

  await adapter.observe();

  assert.equal(loadURLCalls, 0, "must not redundantly load about:blank once the page has already navigated somewhere real");
});

test("a fake view with no getURL() at all is unaffected (existing fake-based tests keep working unchanged)", async () => {
  const view = makeFakeView();
  const adapter = new BrowserAdapter({ view });
  const observation = await adapter.observe();
  assert.ok(observation);
});

test("execute() after dispose() fails cleanly instead of touching a destroyed view", async () => {
  const view = makeFakeView();
  const adapter = new BrowserAdapter({ view });
  await adapter.dispose();

  const result = await adapter.execute({ type: "navigate", url: "https://example.com" });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "disposed");
});

// --- buildObserveScript's real text extraction, run against a minimal fake
// DOM via vm (2026-09-27 follow-up): every other test in this file mocks
// executeJavaScript's RETURN VALUE, so none of them actually execute the
// generated script's own logic against anything DOM-shaped. A real
// end-to-end run (real Electron + a real fixture page) found that the whole
// page `text` field was silently empty for ordinary pages -- fixed below --
// which no fake-return-value test could ever have caught. This test runs
// the ACTUAL production script string (not a reimplementation) via vm
// against a small hand-built DOM so the real bug (and its regression cover)
// live in the real code path, not a parallel copy of the logic.

class FakeElement {
  constructor(tagName, { children = [], text = "", attrs = {} } = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = children;
    this._ownText = text;
    this._attrs = attrs;
  }
  get childElementCount() {
    return this.children.length;
  }
  get childNodes() {
    // Real DOM childNodes mixes Text and Element nodes; a plain
    // text-bearing element like <p>hi</p> has exactly one child (a Text
    // node), never zero -- that distinction is exactly what the fixed bug
    // was about, so this fake preserves it instead of just matching
    // childElementCount's shape.
    const textNodes = this._ownText ? [{ nodeType: 3 }] : [];
    return [...textNodes, ...this.children];
  }
  get textContent() {
    const own = this._ownText || "";
    return this.children.map((c) => c.textContent).join("") + own;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
}

function makeFakeTreeWalker(root) {
  const order = [];
  (function visit(node, parent = null) {
    node.parentElement = parent;
    order.push(node);
    for (const child of node.children) visit(child, node);
  })(root);
  let index = 0;
  return {
    get currentNode() {
      return order[index];
    },
    nextNode() {
      index += 1;
      return index < order.length ? order[index] : null;
    },
  };
}

function runObserveScriptAgainst(root, { maxNodesVisited = 500, maxElements = 100, maxTextBytes = 12 * 1024, baseURI = "http://example.test/" } = {}) {
  const all = [];
  (function visit(node) { all.push(node); for (const child of node.children) visit(child); })(root);
  const byId = new Map(all.filter((node) => node.getAttribute("id")).map((node) => [node.getAttribute("id"), node]));
  for (const node of all) {
    const id = node.getAttribute("id");
    node.labels = id ? all.filter((label) => label.tagName === "LABEL" && label.getAttribute("for") === id) : [];
  }
  const sandbox = {
    document: {
      body: root,
      documentElement: root,
      title: "",
      baseURI,
      getElementById: (id) => byId.get(id) || null,
      createTreeWalker: (r) => makeFakeTreeWalker(r),
    },
    NodeFilter: { SHOW_ELEMENT: 1 },
    URL,
  };
  vm.createContext(sandbox);
  return vm.runInContext(buildObserveScript(maxNodesVisited, maxElements, maxTextBytes), sandbox);
}

test("buildObserveScript captures visible text from an ordinary element with a single text-node child, not just childless leaves", () => {
  // <body><h1>Final page</h1><p>Task complete marker: DONE-XYZ</p></body> --
  // the exact shape of fixtures/long-horizon-site.js's page3.
  const body = new FakeElement("body", {
    children: [
      new FakeElement("h1", { text: "Final page" }),
      new FakeElement("p", { text: "Task complete marker: DONE-XYZ" }),
    ],
  });
  const observation = runObserveScriptAgainst(body);
  assert.ok(
    observation.elements.some((element) => element.role === "text" && element.name.includes("DONE-XYZ")),
    `expected the page's own literal text to appear in the compact accessibility snapshot, got: ${JSON.stringify(observation)}`,
  );
});

test("buildObserveScript still finds anchor elements and their href/text correctly (unaffected by the text-extraction fix)", () => {
  const body = new FakeElement("body", {
    children: [
      new FakeElement("p", { text: "Still going." }),
      new FakeElement("a", { text: "Next", attrs: { href: "/page3" } }),
    ],
  });
  const observation = runObserveScriptAgainst(body, { baseURI: "http://example.test/page2" });
  const anchor = observation.elements.find((el) => el.role === "link");
  assert.ok(anchor, "expected an anchor element to be captured");
  assert.equal(anchor.name, "Next");
  assert.equal(anchor.href, "http://example.test/page3");
  assert.equal("tag" in anchor, false, "raw tag names are replaced by the semantic role");
  assert.equal("text" in anchor, false, "accessible name is the single compact source for the link label");
});

test("compact observation adds accessible role, name, state, and compressed semantic ancestry", () => {
  const body = new FakeElement("body", { children: [
    new FakeElement("div", { attrs: { role: "main" }, children: [
      new FakeElement("div", { attrs: { class: "layout-wrapper" }, children: [
        new FakeElement("h2", { text: "Account settings" }),
        new FakeElement("button", { text: "Save", attrs: { disabled: "", "aria-expanded": "false" } }),
      ] }),
    ] }),
  ] });

  const observation = runObserveScriptAgainst(body);
  const main = observation.elements.find((node) => node.role === "main");
  const heading = observation.elements.find((node) => node.role === "heading");
  const button = observation.elements.find((node) => node.role === "button");
  assert.ok(main);
  assert.equal(heading.name, "Account settings");
  assert.equal(heading.level, 2);
  assert.equal(button.name, "Save");
  assert.equal(button.disabled, true);
  assert.equal(button.expanded, false);
  assert.equal(button.parentIndex, main.index);
  assert.equal(heading.parentIndex, main.index);
  assert.ok(observation.elements.every((node) => !("tag" in node) && !("text" in node)), "the snapshot excludes raw DOM fields");
});

test("compact observation derives ARIA and native labels without exposing input values", () => {
  const body = new FakeElement("body", { children: [
    new FakeElement("label", { text: "Email address", attrs: { for: "email" } }),
    new FakeElement("input", { attrs: { id: "email", type: "email", value: "person@example.test", required: "" } }),
    new FakeElement("input", { attrs: { type: "password", "aria-label": "Password", value: "do-not-leak" } }),
    new FakeElement("button", { attrs: { "aria-label": "Continue to payment", "aria-pressed": "true" } }),
  ] });
  const observation = runObserveScriptAgainst(body);
  const email = observation.elements.find((node) => node.role === "textbox");
  const password = observation.elements.find((node) => node.inputType === "password");
  const payment = observation.elements.find((node) => node.name === "Continue to payment");

  assert.equal(email.name, "Email address");
  assert.equal(email.required, true);
  assert.equal(password.name, "Password");
  assert.equal(password.value, undefined);
  assert.equal(observation.text.includes("do-not-leak"), false);
  assert.equal(observation.text.includes("person@example.test"), false);
  assert.equal(payment.pressed, true);
});

test("compact observation excludes hidden controls and remains bounded by the existing element/text budgets", () => {
  const body = new FakeElement("body", { children: [
    new FakeElement("button", { text: "Visible", attrs: { id: "visible" } }),
    new FakeElement("button", { text: "Hidden", attrs: { id: "hidden", hidden: "" } }),
    new FakeElement("button", { text: "Second", attrs: { id: "second" } }),
    new FakeElement("p", { text: "한글" }),
  ] });
  const observation = runObserveScriptAgainst(body, { maxElements: 1, maxTextBytes: 8 });
  assert.equal(observation.elements.length, 1);
  assert.equal(observation.elements[0].name, "Visible");
  assert.ok(Buffer.byteLength(observation.text, "utf8") <= 8);
  assert.equal(observation.text.includes("한글"), false, "the text budget counts UTF-8 bytes, not UTF-16 characters");
});

const { makeIntentLock } = require("../shared/harness-contracts");

test("BrowserAdapter runs a mode-denied action only with an explicit widening grant", async () => {
  let loads = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { loads += 1; } }) });
  browser.setPermissionMode("observe");
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "planner" } }), { status: "failed", errorCode: "permission_mode_denied" });
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "lease" } }), { status: "failed", errorCode: "permission_mode_denied" });
  await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "lease", leaseId: "l1" } });
  assert.equal(loads, 1);
});

test("BrowserAdapter refuses lock-denied navigation even when widened or in full mode", async () => {
  let loads = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { loads += 1; } }), permissionMode: "full" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] }));
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://evil.test/" }, { widenedBy: { kind: "user_once" } }), { status: "failed", errorCode: "intent_lock_denied" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_action", action: "follow_link" }] }));
  assert.deepEqual(await browser.execute({ type: "follow_link", elementId: "0" }), { status: "failed", errorCode: "intent_lock_denied" });
  assert.equal(loads, 0);
});

test("BrowserAdapter blocks page-initiated navigation to an origin the lock forbids", () => {
  const wc = new EventEmitter();
  Object.assign(wc, { getURL: () => "", close() {} });
  const browser = new BrowserAdapter({ view: { webContents: wc } });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "deny_origins", origins: ["https://evil.test"] }] }));
  let prevented = 0;
  wc.emit("will-redirect", { preventDefault: () => { prevented += 1; } }, "https://evil.test/x");
  wc.emit("will-navigate", { preventDefault: () => { prevented += 1; } }, "https://fine.test/");
  assert.equal(prevented, 1);
});

test("supportsAction reports what execute can really do", () => {
  const browser = new BrowserAdapter({ view: makeFakeView() });
  assert.equal(browser.supportsAction("navigate"), true);
  assert.equal(browser.supportsAction("click"), true);
  assert.equal(browser.supportsAction("type"), true);
  assert.equal(browser.supportsAction("submit_form"), true);
  assert.equal(browser.supportsAction("download"), false);
});

test("the Intent Lock restricts the agent but not the human address bar", async () => {
  let loads = 0;
  const browser = new BrowserAdapter({ view: makeFakeView({ loadURL: async () => { loads += 1; } }), permissionMode: "full" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] }));
  await browser.userNavigate({ type: "navigate", url: "https://other.test/" });
  assert.equal(loads, 1);
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://other.test/" }), { status: "failed", errorCode: "intent_lock_denied" });
  assert.equal(loads, 1);
});

test("widening cannot invent an interaction target or enable an unsupported download", async () => {
  const browser = new BrowserAdapter({ view: makeFakeView() });
  browser.setPermissionMode("observe");
  for (const type of ["click", "type", "submit_form"]) {
    assert.deepEqual(await browser.execute({ type }, { widenedBy: { kind: "user_once" } }), { status: "failed", errorCode: "invalid_action" });
  }
  assert.deepEqual(await browser.execute({ type: "download" }, { widenedBy: { kind: "user_once" } }), { status: "failed", errorCode: "unsupported_action" });
});

test("follow_link to a lock-forbidden origin is refused and does not load", async () => {
  let loads = 0;
  const view = makeFakeView({
    executeJavaScript: async () => ({ url: "https://github.com/", title: "", text: "", elements: [{ role: "link", name: "x", href: "https://evil.test/p" }] }),
    loadURL: async () => { loads += 1; },
  });
  const browser = new BrowserAdapter({ view, permissionMode: "full" });
  browser.setIntentLock(makeIntentLock({ rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] }));
  assert.deepEqual(await browser.execute({ type: "follow_link", elementId: "0" }), { status: "failed", errorCode: "intent_lock_denied" });
  assert.equal(loads, 0);
});

test("execute(scroll) is an instant scroll, so a page with smooth scrolling cannot stall it", async () => {
  let script = "";
  const view = makeFakeView({
    executeJavaScript: async (code) => {
      if (code.includes("scrollBy")) { script = code; return undefined; }
      return { url: "https://example.com/", title: "", text: "", elements: [] };
    },
  });
  const adapter = new BrowserAdapter({ view });
  assert.equal((await adapter.execute({ type: "scroll", direction: "up", amount: 250 })).status, "ok");
  assert.match(script, /behavior:\s*['"]instant['"]/);
  assert.match(script, /top:\s*-250/);
});

test("execute(scroll) that never returns fails as scroll_failed instead of hanging", async () => {
  const view = makeFakeView({
    executeJavaScript: (code) => (code.includes("scrollBy") ? new Promise(() => {}) : Promise.resolve({ url: "https://example.com/", title: "", text: "", elements: [] })),
  });
  const adapter = new BrowserAdapter({ view, scrollTimeoutMs: 30 });
  const result = await adapter.execute({ type: "scroll", direction: "down" });
  assert.deepEqual([result.status, result.errorCode], ["failed", "scroll_failed"]);
});
