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
const { PERMISSION_MODES, evaluateActionPolicy } = require("./permission-policy");
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
    const included = new WeakMap();
    const elements = [];
    const textParts = [];
    const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"]);
    const LANDMARK_TAGS = new Set(["MAIN", "NAV", "ASIDE", "HEADER", "FOOTER"]);
    const ROLE_TAGS = {
      MAIN: "main", NAV: "navigation", ASIDE: "complementary",
      HEADER: "banner", FOOTER: "contentinfo", FORM: "form",
      UL: "list", OL: "list", LI: "listitem", TABLE: "table",
      TR: "row", TH: "columnheader", TD: "cell", IMG: "img",
    };
    const root = document.body || document.documentElement;
    let textBytes = 0;
    let visited = 0;
    const clean = (value, max) => (typeof value === "string" ? value : "").replace(/\\s+/g, " ").trim().slice(0, max);
    const roleOf = (node) => {
      const explicit = clean(node.getAttribute("role"), 40).split(/\\s+/)[0];
      if (explicit && explicit !== "none" && explicit !== "presentation") return explicit;
      const tag = node.tagName;
      if (tag === "A" && node.getAttribute("href") !== null) return "link";
      if (tag === "BUTTON" || tag === "SUMMARY") return "button";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "SELECT") return node.getAttribute("multiple") !== null ? "listbox" : "combobox";
      if (tag === "INPUT") {
        const type = (node.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "submit", "reset", "image"].includes(type)) return type === "hidden" ? null : "button";
        return ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", search: "searchbox", range: "slider" })[type] || "textbox";
      }
      if (/^H[1-6]$/.test(tag)) return "heading";
      if (["MAIN", "NAV", "ASIDE"].includes(tag)) return ROLE_TAGS[tag];
      if ((tag === "HEADER" || tag === "FOOTER") && (!node.parentElement || node.parentElement === document.body)) return ROLE_TAGS[tag];
      if (tag === "FORM" && (node.getAttribute("aria-label") || node.getAttribute("aria-labelledby"))) return "form";
      if (ROLE_TAGS[tag]) return ROLE_TAGS[tag];
      if (["P", "LI", "LABEL", "DT", "DD", "FIGCAPTION"].includes(tag)) return "text";
      return null;
    };
    const nameOf = (node, role) => {
      const labelledBy = clean(node.getAttribute("aria-labelledby"), 300).split(/\\s+/).filter(Boolean);
      if (labelledBy.length) {
        const value = labelledBy.map((id) => document.getElementById?.(id)?.textContent || "").join(" ");
        if (clean(value, 180)) return clean(value, 180);
      }
      const aria = clean(node.getAttribute("aria-label"), 180);
      if (aria) return aria;
      if (node.labels && node.labels.length) {
        let value = "";
        let labelCount = 0;
        for (const label of node.labels) {
          if (labelCount++ >= 10) break;
          value += " " + (label.innerText || label.textContent || "");
        }
        value = clean(value, 180);
        if (value) return value;
      }
      if (node.tagName === "IMG") return clean(node.getAttribute("alt"), 180);
      if (node.tagName === "INPUT" && (node.getAttribute("type") || "").toLowerCase() === "image") return clean(node.getAttribute("alt"), 180);
      const placeholder = clean(node.getAttribute("placeholder"), 180);
      if (placeholder && ["textbox", "searchbox", "combobox"].includes(role)) return placeholder;
      const title = clean(node.getAttribute("title"), 180);
      if (title) return title;
      if (node.tagName === "INPUT" && ["button", "submit", "reset"].includes((node.getAttribute("type") || "").toLowerCase())) {
        return clean(node.getAttribute("value"), 180);
      }
      if (["main", "navigation", "complementary", "banner", "contentinfo", "form"].includes(role)) return "";
      if (["textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "switch"].includes(role)) return "";
      return clean(node.innerText || node.textContent || "", 180);
    };
    const utf8Length = (value) => {
      let bytes = 0;
      for (const char of value) {
        const point = char.codePointAt(0);
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      }
      return bytes;
    };
    const hidden = (node) => {
      for (let current = node; current; current = current.parentElement) {
        if (current.hasAttribute?.("hidden") || current.getAttribute("hidden") !== null || current.getAttribute("aria-hidden") === "true") return true;
      }
      let display = "";
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(node);
        display = style.display;
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
      }
      if (display !== "contents" && typeof node.getClientRects === "function" && node.getClientRects().length === 0) return true;
      return false;
    };
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && visited < ${maxNodesVisited}) {
        visited += 1;
        if (node.nodeType === 1) {
          const ownText = (node.childElementCount === 0 && !hidden(node) && node.tagName !== "INPUT" && node.tagName !== "TEXTAREA" && node.tagName !== "SELECT" ? (node.innerText || node.textContent || "") : "").trim().slice(0, 200);
          const role = roleOf(node);
          const isTextNode = ["P", "LI", "LABEL", "DT", "DD", "FIGCAPTION"].includes(node.tagName);
          const shouldInclude = role && !hidden(node) && (INTERACTIVE_TAGS.has(node.tagName) || LANDMARK_TAGS.has(node.tagName) || Boolean(ROLE_TAGS[node.tagName]) || /^H[1-6]$/.test(node.tagName) || Boolean(node.getAttribute("role")) || isTextNode);
          const name = shouldInclude && elements.length < ${maxElements} ? nameOf(node, role) : "";
          // A visible leaf represented by its accessible name does not also
          // consume the free-text channel. This avoids sending button/link/
          // heading labels twice while preserving unstructured page copy.
          if (ownText && !(name && name === ownText) && textBytes < ${maxTextBytes}) {
            const encoded = (textParts.length ? " " : "") + ownText;
            const encodedBytes = utf8Length(encoded);
            if (textBytes + encodedBytes <= ${maxTextBytes}) {
              textParts.push(ownText);
              textBytes += encodedBytes;
            }
          }
          if (shouldInclude && elements.length < ${maxElements}) {
            const index = elements.length;
            let parent = node.parentElement;
            while (parent && !included.has(parent)) parent = parent.parentElement;
            const entry = {
              index,
              role,
              name,
              parentIndex: parent ? included.get(parent) : null,
            };
            if (/^H[1-6]$/.test(node.tagName)) entry.level = Number(node.tagName.slice(1));
            if (node.tagName === "INPUT") {
              const type = (node.getAttribute("type") || "text").toLowerCase();
              entry.inputType = type;
            }
            if (node.disabled || node.getAttribute("disabled") !== null || node.getAttribute("aria-disabled") === "true") entry.disabled = true;
            if (node.required || node.getAttribute("required") !== null || node.getAttribute("aria-required") === "true") entry.required = true;
            if (node.checked || node.getAttribute("aria-checked") === "true" || node.getAttribute("aria-checked") === "mixed") entry.checked = node.getAttribute("aria-checked") === "mixed" ? "mixed" : true;
            if (node.getAttribute("aria-checked") === "false") entry.checked = false;
            if (node.getAttribute("aria-expanded") === "true" || node.getAttribute("aria-expanded") === "false") entry.expanded = node.getAttribute("aria-expanded") === "true";
            if (node.getAttribute("aria-pressed") === "true" || node.getAttribute("aria-pressed") === "false") entry.pressed = node.getAttribute("aria-pressed") === "true";
            if (node.getAttribute("aria-selected") === "true" || node.getAttribute("aria-selected") === "false") entry.selected = node.getAttribute("aria-selected") === "true";
            if (node.tagName === "A") {
              try {
                entry.href = new URL(node.getAttribute("href") || "", document.baseURI).href;
              } catch {
                entry.href = null;
              }
            }
            elements.push(entry);
            included.set(node, index);
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
    permissionMode = "browse",
    assignedOrigin,
  } = {}) {
    if (!view) throw new BrowserAdapterError("invalid_config", "view is required");
    this._view = view;
    if (!PERMISSION_MODES.includes(permissionMode)) throw new BrowserAdapterError("invalid_permission_mode", "permissionMode is invalid");
    this._permissionMode = permissionMode;
    if (assignedOrigin !== undefined && assignedOrigin !== null && (typeof assignedOrigin !== "string" || assignedOrigin.length === 0)) {
      throw new BrowserAdapterError("invalid_config", "assignedOrigin must be a non-empty string when provided");
    }
    // Child agents only (multi-agent background runtime plan, Task 4): the
    // host locks a child to the single origin it was dispatched into. This
    // is deliberately independent of permissionMode/evaluateActionPolicy --
    // those gate what the PLANNER can ask this adapter to do via execute(),
    // but a page can navigate itself (window.location, a meta-refresh, a
    // server redirect, a clicked link the page synthesizes) entirely outside
    // that path. Without this listener a page under "observe" permission
    // could still carry the child to an origin the parent never assigned it.
    this._assignedOrigin = assignedOrigin || null;
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
    if (this._assignedOrigin) {
      const rejectIfOffAssignedOrigin = (event, url) => {
        let origin;
        try {
          origin = new URL(url).origin;
        } catch {
          origin = null;
        }
        if (origin !== this._assignedOrigin) event.preventDefault();
      };
      listen("will-navigate", rejectIfOffAssignedOrigin);
      listen("will-redirect", rejectIfOffAssignedOrigin);
    }
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new BrowserAdapterError("invalid_permission_mode", "permissionMode is invalid");
    this._permissionMode = mode;
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

  // Main-process-only autofill primitive. The only page script performs a
  // bounded visible-field lookup and value/input/change events; it never
  // clicks submit, calls requestSubmit(), or returns either secret. The
  // origin is checked immediately before entering the page's main world.
  async fillCredential({ username, password, origin } = {}) {
    if (this._disposed) return { status: "failed", errorCode: "disposed" };
    if (typeof username !== "string" || typeof password !== "string" || !password || typeof origin !== "string") {
      return { status: "failed", errorCode: "invalid_credential" };
    }
    let expected;
    let current;
    try {
      expected = new URL(origin);
      current = new URL(this._view.webContents.getURL());
    } catch {
      return { status: "failed", errorCode: "invalid_origin" };
    }
    if (expected.protocol !== "https:" || current.protocol !== "https:" || expected.origin !== current.origin) {
      return { status: "failed", errorCode: "credential_origin_mismatch" };
    }
    const payload = JSON.stringify({ username, password }).replace(/</g, "\\u003c");
    const script = `(() => {
      const secret = ${payload};
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
      const passwords = inputs.filter((e) => e.type === "password");
      const users = inputs.filter((e) => e.type !== "password" && (e.autocomplete === "username" || e.type === "email" || /user|email|login/i.test(e.name + " " + e.id)));
      if (passwords.length !== 1 || users.length > 1 || (users.length === 0 && secret.username !== "")) return { status: "failed", errorCode: "credential_fields_ambiguous" };
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (users.length === 1) setValue(users[0], secret.username);
      setValue(passwords[0], secret.password);
      return { status: "ok", usernameFilled: users.length === 1, passwordFilled: true };
    })()`;
    try {
      const result = await this._view.webContents.executeJavaScript(script, true);
      if (result && result.status === "ok" && typeof result.usernameFilled === "boolean" && result.passwordFilled === true) return result;
      return { status: "failed", errorCode: result?.errorCode || "credential_fill_failed" };
    } catch {
      return { status: "failed", errorCode: "credential_fill_failed" };
    }
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
      elements: raw.elements.map((el, index) => {
        const { index: _index, parentIndex, ...entry } = el;
        return {
          ...entry,
          elementId: String(index),
          parentElementId: parentIndex === null || parentIndex === undefined ? null : String(parentIndex),
        };
      }),
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
    if (!evaluateActionPolicy(this._permissionMode, action.type).allowed) {
      return { status: "failed", errorCode: "permission_mode_denied" };
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
          // Harness v2 Phase 2 Task 4: also return the observation itself
          // (not just its id) so TaskController can reuse an in-batch
          // observe action's result instead of unconditionally re-observing
          // next turn (short profile only; see its own reuse/staleness gate).
          return { status: "ok", evidenceCandidate: { kind: "artifact", observationId: observation.id }, observation };
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
    // This is the one internal chokepoint both the agent path (execute()'s
    // navigate case) and _followLink() funnel through. userNavigate() (the
    // human path) already validates scheme/credentials before ever calling
    // _navigate() -- without the same check here, a planner proposal such as
    // file:///etc/passwd would load a local file into the task view. Mirror
    // userNavigate()'s exact allowlist so both paths fail identically.
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { status: "failed", errorCode: "invalid_url" };
    }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
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
    if (!current || current.role !== "link" || typeof current.href !== "string") {
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
