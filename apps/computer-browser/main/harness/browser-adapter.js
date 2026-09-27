"use strict";

// BrowserAdapter (design doc sections 6-7): the real execution surface a
// TaskController drives -- observe()/execute() against a single Electron
// WebContentsView. This is deliberately a *separate* module from the legacy
// main/control-api.js executor rather than a wrapper around it: ControlApi
// owns its own approval queue/timeline UI state for the fixed 2-step demo,
// and coupling the new long-horizon harness to that would tangle two
// different lifecycles. The `view` (an Electron WebContentsView, or an
// injected fake in tests) is owned by whoever constructs this adapter --
// typically the same host code that owns the ControlApi instance for a
// given window.
//
// Contract (BrowserAdapter.observe/execute in the design doc):
//   observe({signal}) -> Observation
//   execute(action, {signal, documentEpoch}) -> ActionResult
//   ActionResult = {status:"ok"|"failed"|"cancelled"|"uncertain", evidenceCandidate?, errorCode?}
//
// Trust boundary this file is responsible for (section 6-7):
//   - The model only ever gets a host-assigned `elementId` (an index into
//     the bounded element list from the most recent observe()), never a
//     free-form CSS selector or eval string. follow_link re-resolves the
//     ACTUAL current href for that elementId at execute time -- it never
//     trusts an href the proposal itself might carry.
//   - click/type/submit_form/download are not wired to any policy mapping
//     yet and are reported as unsupported rather than silently ignored or
//     mapped to something misleadingly permissive.
//   - documentEpoch is bumped on every navigation. An action that names a
//     documentEpoch (follow_link/scroll/observe act on "the page as of
//     epoch N") is rejected as stale if the adapter has since navigated
//     away from that epoch -- this is what makes a proposal based on an
//     old observation harmless once the page has moved on.
//   - source/selfProvenance classification is NOT this module's job -- see
//     task-controller.js's _dispatchActionsBatch, which hardcodes
//     source:"page_content" for every planner-proposed action regardless of
//     what the action object itself claims.

const MAX_NODES_VISITED = 500; // design doc section 6: "최대 500개 방문 노드"
const MAX_ELEMENTS = 100; // section 6: "100개 element"
const MAX_TEXT_BYTES = 12 * 1024; // section 6: "text 12 KiB"
const NAVIGATION_TIMEOUT_MS = 30000; // matches control-api.js's existing bound
const UNSUPPORTED_ACTIONS = new Set(["click", "type", "submit_form", "download"]);
const SUPPORTED_ACTIONS = new Set(["navigate", "follow_link", "scroll", "observe"]);

class BrowserAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserAdapterError";
    this.code = code;
  }
}

// Bounded, bytewise-capped DOM read. Uses a TreeWalker so the *visit* count
// is capped (not just the returned list) -- collecting all
// querySelectorAll() matches and slicing afterward would still walk the
// entire tree for a pathologically large page. Element text/href pulled
// straight from the (untrusted) page must never be treated as anything but
// display data -- this script only ever runs inline JS WE wrote, never
// anything the page or the model supplied.
//
// Inside the generated script, `ownText` is captured only when
// childElementCount === 0 -- i.e. no ELEMENT children -- not when
// childNodes.length === 0 (no children AT ALL). An ordinary text-bearing
// element like <p>hello</p> has exactly one child (a Text node), so
// childNodes.length is 1, never 0; the original childNodes.length===0
// check therefore matched almost no real elements and silently produced an
// empty page `text` field for any ordinary page. Found via a real Electron
// run against fixtures/long-horizon-site.js: page3's own literal
// "DONE-XYZ" completion marker never appeared in the observation at all,
// which blocked every real 3-page journey from ever reaching "finish"
// (2026-09-27 follow-up; see test/browser-adapter.test.js's vm-based
// regression test that runs this exact script string against a fake DOM).
function buildObserveScript(maxNodesVisited, maxElements, maxTextBytes) {
  return `(() => {
    const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "H1", "H2", "H3"]);
    const root = document.body || document.documentElement;
    const elements = [];
    const textParts = [];
    let textBytes = 0;
    let visited = 0;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && visited < ${maxNodesVisited}) {
        visited += 1;
        if (node.nodeType === 1) {
          const ownText = (node.childElementCount === 0 ? (node.textContent || "") : "").trim().slice(0, 200);
          if (ownText && textBytes < ${maxTextBytes}) {
            const encoded = ownText + " ";
            if (textBytes + encoded.length <= ${maxTextBytes}) {
              textParts.push(ownText);
              textBytes += encoded.length;
            }
          }
          if (INTERACTIVE_TAGS.has(node.tagName) && elements.length < ${maxElements}) {
            const entry = { tag: node.tagName.toLowerCase(), text: (node.textContent || "").trim().slice(0, 120) };
            if (node.tagName === "A") {
              try {
                entry.href = new URL(node.getAttribute("href") || "", document.baseURI).href;
              } catch {
                entry.href = null;
              }
            }
            elements.push(entry);
          }
        }
        node = walker.nextNode();
      }
    }
    return {
      url: document.baseURI,
      title: document.title || "",
      text: textParts.join(" ").slice(0, ${maxTextBytes}),
      elements,
    };
  })()`;
}

class BrowserAdapter {
  constructor({
    view,
    now,
    navigationTimeoutMs,
    maxNodesVisited,
    maxElements,
    maxTextBytes,
    randomId,
  } = {}) {
    if (!view) throw new BrowserAdapterError("invalid_config", "view is required");
    this._view = view;
    this._now = typeof now === "function" ? now : Date.now;
    this._navigationTimeoutMs = typeof navigationTimeoutMs === "number" ? navigationTimeoutMs : NAVIGATION_TIMEOUT_MS;
    this._maxNodesVisited = typeof maxNodesVisited === "number" ? maxNodesVisited : MAX_NODES_VISITED;
    this._maxElements = typeof maxElements === "number" ? maxElements : MAX_ELEMENTS;
    this._maxTextBytes = typeof maxTextBytes === "number" ? maxTextBytes : MAX_TEXT_BYTES;
    this._randomId = typeof randomId === "function" ? randomId : () => `obs-${this._navSeq}-${this._observeSeq}`;
    // documentEpoch: bumped on every navigation. Any action bound to an
    // older epoch is stale by construction once this changes.
    this._documentEpoch = 0;
    // Monotonic per-navigate() sequence number for cross-event isolation: a
    // did-navigate/did-fail-load event tagged with an older sequence must
    // never resolve/settle a newer, still-in-flight navigate() call.
    this._navSeq = 0;
    this._observeSeq = 0;
    this._disposed = false;
    this._readyEnsured = false;
    this._listeners = new Set();
    this._pageListeners = [];
    const wc = view.webContents;
    const listen = (name, listener) => {
      if (typeof wc.on !== "function") return;
      wc.on(name, listener);
      this._pageListeners.push([name, listener]);
    };
    listen("did-navigate", () => { this._documentEpoch += 1; this._emitBrowserChange(); });
    listen("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame !== false) { this._documentEpoch += 1; this._emitBrowserChange(); }
    });
    listen("page-title-updated", () => this._emitBrowserChange());
    listen("did-stop-loading", () => this._emitBrowserChange());
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitBrowserChange() {
    if (this._disposed) return;
    const snapshot = this.getBrowserSnapshot();
    for (const listener of this._listeners) {
      try { listener(snapshot); } catch { /* Observers cannot interrupt navigation. */ }
    }
  }

  getBrowserSnapshot() {
    const wc = this._view.webContents;
    if (this._disposed || wc.isDestroyed?.()) {
      return { tabs: [], activeTabId: null, documentEpoch: this._documentEpoch };
    }
    const history = wc.navigationHistory || wc;
    return {
      tabs: [{ id: "page", url: wc.getURL?.() || "about:blank", title: wc.getTitle?.() || "",
        canGoBack: Boolean(history.canGoBack?.()), canGoForward: Boolean(history.canGoForward?.()) }],
      activeTabId: "page",
      documentEpoch: this._documentEpoch,
    };
  }

  // Only TaskHost's serialized, drained human-control path calls this.
  async userNavigate(action) {
    if (this._disposed) throw new BrowserAdapterError("disposed", "browser has been closed");
    if (!action || !["navigate", "back", "forward"].includes(action.type)) {
      throw new BrowserAdapterError("invalid_action", "unknown browser command");
    }
    if (action.type === "navigate") {
      let url;
      try { url = new URL(action.url); } catch { throw new BrowserAdapterError("invalid_url", "Enter an http or https address"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new BrowserAdapterError("invalid_url", "Only http and https addresses without credentials are supported");
      }
      const result = await this._navigate(url.href);
      if (result.status !== "ok") throw new BrowserAdapterError(result.errorCode, "Could not open this page");
    } else {
      const wc = this._view.webContents;
      const history = wc.navigationHistory || wc;
      const back = action.type === "back";
      if (back ? history.canGoBack?.() : history.canGoForward?.()) {
        // Electron history traversal returns void. Hold the host's admission
        // barrier until the load event (or timeout), not just the method call.
        if (typeof history.goToIndex !== "function" || typeof history.getActiveIndex !== "function") {
          throw new BrowserAdapterError("unsupported_action", "Navigation history is unavailable");
        }
        await this._traverseHistory(wc, history, history.getActiveIndex() + (back ? -1 : 1));
      }
    }
    this._emitBrowserChange();
    return this.getBrowserSnapshot();
  }

  _traverseHistory(wc, history, index) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        wc.removeListener("did-stop-loading", loaded);
        wc.removeListener("did-fail-load", failed);
        wc.removeListener("destroyed", destroyed);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = (_event, _code, _description, _url, isMainFrame) => {
        if (isMainFrame !== false) finish(new BrowserAdapterError("navigation_error", "Could not load history entry"));
      };
      const destroyed = () => finish(new BrowserAdapterError("disposed", "Browser closed during navigation"));
      const timer = setTimeout(() => {
        finish(new BrowserAdapterError("navigation_timeout", "History navigation timed out"));
        wc.stop();
      }, this._navigationTimeoutMs);
      wc.on("did-stop-loading", loaded);
      wc.on("did-fail-load", failed);
      wc.on("destroyed", destroyed);
      try { history.goToIndex(index); } catch (error) { finish(error); }
    });
  }

  getDocumentEpoch() {
    return this._documentEpoch;
  }

  // A real Electron webContents' executeJavaScript() hangs forever if
  // called before ANY navigation has ever committed a document -- confirmed
  // by direct reproduction against real Electron (Task 6). observe() is the
  // very first call task-controller.js's loop makes, so without this a
  // brand-new task would hang on its first iteration. wc.getURL() reports
  // "" only for a webContents that has never navigated; loading "about:blank"
  // once gives it a real committed document to inject into. Fakes that
  // don't implement getURL() at all (most of this file's own unit tests)
  // are unaffected -- this only ever activates for a real Electron-shaped
  // webContents.
  async _ensureReadyForScriptExecution(wc) {
    if (this._readyEnsured) return;
    this._readyEnsured = true;
    if (typeof wc.getURL !== "function") return;
    if (wc.getURL()) return;
    try {
      await wc.loadURL("about:blank");
    } catch {
      // best-effort -- if this fails, the subsequent executeJavaScript call
      // will surface its own real error rather than hanging silently.
    }
  }

  async observe({ signal, initial = false } = {}) {
    void signal; // no cancellable long-running observe op yet -- accepted for interface symmetry
    if (this._disposed) {
      throw new BrowserAdapterError("disposed", "observe() called after dispose()");
    }
    const wc = this._view.webContents;
    if (initial && this._documentEpoch === 0 && typeof wc.getURL === "function" && ["", "about:blank"].includes(wc.getURL())) {
      this._observeSeq += 1;
      return {
        id: this._randomId(),
        documentEpoch: this._documentEpoch,
        url: "about:blank",
        title: "",
        text: "",
        elements: [],
        at: this._now(),
      };
    }
    await this._ensureReadyForScriptExecution(wc);
    this._observeSeq += 1;
    let raw;
    try {
      raw = await wc.executeJavaScript(buildObserveScript(this._maxNodesVisited, this._maxElements, this._maxTextBytes), true);
    } catch (error) {
      // Observation failure must never be reported as an empty-but-successful
      // page -- the caller (task-controller.js) needs to see this as a real
      // failure, not silently proceed with a hollow Observation as if the
      // page were simply blank.
      throw new BrowserAdapterError("observe_failed", `observe() failed: ${error && error.message}`);
    }
    return {
      id: this._randomId(),
      documentEpoch: this._documentEpoch,
      url: raw.url,
      title: raw.title,
      text: raw.text,
      elements: raw.elements.map((el, index) => ({ elementId: String(index), ...el })),
      at: this._now(),
    };
  }

  // Emergency memory-pressure teardown (task-controller.js): actually
  // releases the WebContentsView rather than just no longer calling it.
  // Electron's WebContentsView doesn't expose a single documented
  // "destroy" -- webContents.close() is what actually tears down the
  // renderer process; tolerate a fake/older shape exposing .destroy()
  // instead, and tolerate having neither (a no-op, never throws) so a
  // dispose() call from within a best-effort teardown path never itself
  // becomes the reason teardown fails.
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const wc = this._view && this._view.webContents;
    for (const [name, listener] of this._pageListeners) wc?.removeListener?.(name, listener);
    this._listeners.clear();
    if (wc && typeof wc.close === "function") {
      wc.close();
    } else if (wc && typeof wc.destroy === "function") {
      wc.destroy();
    }
  }

  async execute(action, { signal, documentEpoch } = {}) {
    void signal;
    if (this._disposed) {
      return { status: "failed", errorCode: "disposed" };
    }
    if (!action || typeof action.type !== "string") {
      return { status: "failed", errorCode: "invalid_action" };
    }
    if (UNSUPPORTED_ACTIONS.has(action.type)) {
      return { status: "failed", errorCode: "unsupported_action" };
    }
    if (!SUPPORTED_ACTIONS.has(action.type)) {
      return { status: "failed", errorCode: "unknown_action" };
    }
    // navigate() starts a brand-new document, so it is never itself bound to
    // a prior documentEpoch. Every other action acts ON the current
    // document, so a caller-supplied documentEpoch that no longer matches
    // means the proposal was based on a page that has since navigated away
    // -- reject without executing rather than act on stale context.
    if (action.type !== "navigate" && documentEpoch != null && documentEpoch !== this._documentEpoch) {
      return { status: "cancelled", errorCode: "stale_document" };
    }

    switch (action.type) {
      case "navigate":
        return this._navigate(action.url);
      case "follow_link":
        return this._followLink(action.elementId);
      case "scroll":
        return this._scroll(action.direction, action.amount);
      case "observe":
        try {
          const observation = await this.observe({ signal });
          // "artifact": the observation itself (bounded page text/elements)
          // is the evidence -- see shared/harness-contracts.js's EVIDENCE_KINDS.
          return { status: "ok", evidenceCandidate: { kind: "artifact", observationId: observation.id } };
        } catch (error) {
          return { status: "failed", errorCode: error.code || "observe_failed" };
        }
      default:
        return { status: "failed", errorCode: "unknown_action" };
    }
  }

  async _navigate(url) {
    if (typeof url !== "string" || url.trim().length === 0) {
      return { status: "failed", errorCode: "invalid_url" };
    }
    const wc = this._view.webContents;
    const mySeq = ++this._navSeq;
    const epochBeforeLoad = this._documentEpoch;
    const outcome = await this._loadWithTimeout(wc, url, mySeq);
    // Cross-event isolation: if a NEWER navigate() call has already started
    // since this one's load settled/timed out, this call's result must not
    // retroactively bump the epoch or be reported as authoritative -- the
    // newer call owns the document now.
    if (mySeq !== this._navSeq) {
      return { status: "cancelled", errorCode: "superseded" };
    }
    if (outcome.outcome === "ok") {
      if (this._documentEpoch === epochBeforeLoad) this._documentEpoch += 1;
      this._emitBrowserChange();
      // "host_check": the host itself (not the model, not the page) directly
      // observed this navigation complete -- see shared/harness-contracts.js's
      // EVIDENCE_KINDS. verifyCriterion() still requires a "host"-kind
      // criterion's own hostVerifier callback to independently confirm this
      // before it counts as verified; emitting the candidate is not itself
      // an approval of anything.
      return { status: "ok", evidenceCandidate: { kind: "host_check", sourceUrl: url } };
    }
    if (outcome.outcome === "timeout") {
      return { status: "failed", errorCode: "navigation_timeout" };
    }
    return { status: "failed", errorCode: "navigation_error" };
  }

  // Races loadURL() against a timer, exactly as control-api.js's
  // _loadWithTimeout does, but scoped to `mySeq` so a listener left over
  // from an aborted/timed-out earlier call can never be mistaken for this
  // one's completion. The timer is always cleared before returning --
  // nothing is left pending after this function settles (no leaked timer,
  // no leaked listener: loadURL()'s own promise is the only listener here).
  async _loadWithTimeout(wc, url) {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ outcome: "timeout" }), this._navigationTimeoutMs);
    });
    const ready = wc.loadURL(url).then(() => ({ outcome: "ok" })).catch(() => ({ outcome: "error" }));
    const result = await Promise.race([ready, timedOut]);
    clearTimeout(timer);
    if (result.outcome === "timeout") {
      wc.stop();
    }
    return result;
  }

  // follow_link never trusts a href carried by the action/proposal itself --
  // it re-resolves the CURRENT href for the host-assigned elementId by
  // re-running the exact same bounded traversal used by observe() and
  // reading whatever is at that index right now. If the page has mutated
  // since the referencing observation (a different anchor is now at that
  // index, or it's gone) this either follows a different real link on the
  // CURRENT page or fails outright -- it never falls back to a model-
  // supplied URL.
  async _followLink(elementId) {
    if (typeof elementId !== "string" || elementId.length === 0) {
      return { status: "failed", errorCode: "invalid_element_id" };
    }
    const index = Number(elementId);
    if (!Number.isInteger(index) || index < 0) {
      return { status: "failed", errorCode: "invalid_element_id" };
    }
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    let raw;
    try {
      raw = await wc.executeJavaScript(buildObserveScript(this._maxNodesVisited, this._maxElements, this._maxTextBytes), true);
    } catch (error) {
      return { status: "failed", errorCode: "observe_failed" };
    }
    const current = raw.elements[index];
    if (!current || current.tag !== "a" || typeof current.href !== "string") {
      return { status: "failed", errorCode: "element_not_found" };
    }
    return this._navigate(current.href);
  }

  async _scroll(direction, amount) {
    const dir = direction === "up" ? "up" : "down";
    const delta = typeof amount === "number" && amount > 0 ? amount : 600;
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    try {
      await wc.executeJavaScript(`window.scrollBy(0, ${dir === "up" ? -delta : delta});`, true);
    } catch (error) {
      return { status: "failed", errorCode: "scroll_failed" };
    }
    return { status: "ok" };
  }
}

module.exports = { BrowserAdapter, BrowserAdapterError, MAX_NODES_VISITED, MAX_ELEMENTS, MAX_TEXT_BYTES, buildObserveScript };
