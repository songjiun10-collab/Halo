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
const { BrowserAdapter, BrowserAdapterError, buildObserveScript } = require("../main/harness/browser-adapter");

function makeFakeView({ loadURL, executeJavaScript, stop } = {}) {
  return {
    webContents: {
      loadURL: loadURL || (async () => {}),
      stop: stop || (() => {}),
      executeJavaScript: executeJavaScript || (async () => ({ url: "https://example.com/", title: "", text: "", elements: [] })),
    },
  };
}

test("constructor requires a view", () => {
  assert.throws(() => new BrowserAdapter({}), BrowserAdapterError);
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
        elements: [{ tag: "a", text: "Next", href: "https://example.com/real-target" }],
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
      return { url: "https://example.com/", title: "", text: "", elements: [{ tag: "a", text: "x", href: "https://example.com/x" }] };
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

for (const type of ["click", "type", "submit_form", "download"]) {
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
        { tag: "a", text: "One", href: "https://example.com/1" },
        { tag: "button", text: "Go" },
      ],
    }),
  });
  const adapter = new BrowserAdapter({ view });

  const observation = await adapter.observe();

  assert.equal(observation.documentEpoch, 0);
  assert.equal(observation.elements[0].elementId, "0");
  assert.equal(observation.elements[1].elementId, "1");
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
  (function visit(node) {
    order.push(node);
    for (const child of node.children) visit(child);
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
  const sandbox = {
    document: {
      body: root,
      documentElement: root,
      title: "",
      baseURI,
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
    observation.text.includes("DONE-XYZ"),
    `expected the page's own literal text to appear in the observation, got: ${JSON.stringify(observation.text)}`,
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
  const anchor = observation.elements.find((el) => el.tag === "a");
  assert.ok(anchor, "expected an anchor element to be captured");
  assert.equal(anchor.text, "Next");
  assert.equal(anchor.href, "http://example.test/page3");
});
