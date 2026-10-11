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
//   - Interactions resolve one-use DOM references captured in an isolated
//     world, not a re-traversed index. Downloads need a host file broker.
//   - documentEpoch is bumped on every navigation. An action that names a
//     documentEpoch (follow_link/scroll/observe act on "the page as of
//     epoch N") is rejected as stale if the adapter has since navigated
//     away from that epoch -- this is what makes a proposal based on an
//     old observation harmless once the page has moved on.
//   - source/selfProvenance classification is NOT this module's job -- see
//     task-controller.js's _dispatchActionsBatch, which hardcodes
//     source:"page_content" for every planner-proposed action regardless of
//     what the action object itself claims.

// Design doc section 6 said 500, which on real doc pages (MDN: ~1500 light-DOM
// nodes before the article tail, plus shadow roots) never reached the article
// body. Visiting nodes is cheap; the planner-facing bounds are maxElements and
// maxTextBytes, which are unchanged.
const MAX_NODES_VISITED = 3000;
const MAX_ELEMENTS = 100; // section 6: "100개 element"
const HEADING_RESERVE = 40; // extra headings kept after MAX_ELEMENTS is reached
const MAX_TEXT_BYTES = 12 * 1024; // section 6: "text 12 KiB"
// Element names are capped in the page script by CHARACTERS (180), which lets
// CJK names reach ~540 UTF-8 bytes each. The context packet sends up to 140
// elements per turn, so names are additionally capped in BYTES here: ASCII
// names keep their full 180 (equal), CJK names are bounded at 60 characters.
// Measured on namu.wiki (2026-10-09): names over 120 chars held 2,006 bytes
// before this cap. Nothing validates on the name text itself (interaction
// fingerprints are computed in-page from the live DOM, not from this copy).
const MAX_ELEMENT_NAME_BYTES = 180;
function utf8ByteCap(value, maxBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}
// A PDF tab shows nothing to page scripts, so its text comes from the file.
const MAX_PDF_TEXT_BYTES = 2 * MAX_TEXT_BYTES;
// Computer-use screenshots are captured from the logical agent viewport
// (1440x900 by default). The attachment is rendered at this cap instead of at
// full viewport pixels. Measured 2026-10-09 with macOS Vision OCR (accurate
// mode) against a dense console page (artifacts/screenshot-resolution/):
// label recall is 98% at 1440, 95% at 1280, then falls off a cliff -- 51% at
// 1024, 41% at 896, 20% at 768, 5% at 640. 1280 keeps legibility while Claude
// image tokens drop 1,728 -> 1,366 (-21%); lower caps save more tokens but
// measurably lose control labels, so they are not the default.
const SCREENSHOT_MAX_WIDTH = 1280;
const { extractPdfText, formatPdfObservationText, looksLikePdfUrl } = require("./pdf-text");
const NAVIGATION_TIMEOUT_MS = 30000; // matches control-api.js's existing bound
const { randomUUID } = require("node:crypto");
const INTERACTION_WORLD_ID = 1001;
const MAX_INPUT_BYTES = 4096;
// evaluate bounds: the expression is page code, so it stays short enough to
// review in an approval prompt, and its answer fits the planner context.
const MAX_EXPRESSION_CHARS = 2000;
const MAX_EXPRESSION_BYTES = 4096;
const EVALUATE_RESULT_BYTES = 4096;
const { PERMISSION_MODES, evaluateActionPolicy } = require("./permission-policy");
const { evaluateLock } = require("../../shared/harness-contracts");
const { validateCoordinateAction } = require("./computer-use-contract");
const { PAGE_SNAPSHOT_SOURCE, parseSnapshot, verifyEffect } = require("./effect-verifier");
const { findInPageOn } = require("./find-in-page");
const { applyPageZoom, resolveZoomAction } = require("./page-zoom");
const { copySelectionOn } = require("./selection-copy");
const systemClipboard = require("./system-clipboard");
const { runHwStep, validateStep, gateActionFor } = require("./halowright");
const { classifyTarget } = require("./effect-classifier");

// The http(s) origin of a URL string, or null.
function bareOrigin(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}
const UNSUPPORTED_ACTIONS = new Set(["download"]);
const INTERACTION_ACTIONS = new Set(["click", "type", "submit_form"]);
const SUPPORTED_ACTIONS = new Set(["navigate", "follow_link", "scroll", "find", "zoom", "select_all", "copy", "observe", "click_at", "type_at", "press_key", "hw_step", "evaluate", ...INTERACTION_ACTIONS]);

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
function buildObserveScript(maxNodesVisited, maxElements, maxTextBytes, binding = null) {
  return `(() => {
    const included = new WeakMap();
    const elements = [];
    const boundNodes = [];
    const textParts = [];
    const visibilityCache = new WeakMap();
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
      let isHidden = false;
      for (let current = node; current; current = current.parentElement) {
        if (current.hasAttribute?.("hidden") || current.getAttribute("hidden") !== null || current.getAttribute("aria-hidden") === "true") {
          isHidden = true;
          break;
        }
      }
      let display = "";
      if (!isHidden && typeof getComputedStyle === "function") {
        const style = getComputedStyle(node);
        display = style.display;
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") isHidden = true;
      }
      if (!isHidden && display !== "contents" && typeof node.getClientRects === "function" && node.getClientRects().length === 0) isHidden = true;
      return isHidden;
    };
    // Memoize only the synchronous scan; retained action bindings must recheck live DOM.
    const observedHidden = (node) => {
      if (!visibilityCache.has(node)) visibilityCache.set(node, hidden(node));
      return visibilityCache.get(node);
    };
    const formInfo = (node) => {
      const form = node.tagName === "FORM" ? node : node.form;
      if (!form) return null;
      try {
        return {
          action: new URL(node.hasAttribute("formaction") ? node.getAttribute("formaction") : form.action || form.getAttribute("action") || document.baseURI, document.baseURI).href,
          method: (node.getAttribute("formmethod") || form.method || "get").toLowerCase(),
          target: node.getAttribute("formtarget") || form.getAttribute("target") || "_self",
        };
      } catch { return { action: "", method: "", target: "" }; }
    };
    const fingerprint = (node) => JSON.stringify({
      tag: node.tagName, role: roleOf(node), name: nameOf(node, roleOf(node)),
      type: node.getAttribute("type"), href: node.getAttribute("href"),
      form: formInfo(node), disabled: !!node.disabled || node.getAttribute("aria-disabled") === "true",
      readonly: !!node.readOnly || node.getAttribute("readonly") !== null,
    });
    if (root) {
      // Open shadow roots (web components such as MDN's compat table) are
      // queued and walked after the light DOM, under the same visit cap.
      const roots = [root];
      for (let rootIndex = 0; rootIndex < roots.length && visited < ${maxNodesVisited}; rootIndex += 1) {
      const walker = document.createTreeWalker(roots[rootIndex], NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && visited < ${maxNodesVisited}) {
        visited += 1;
        if (node.nodeType === 1) {
          if (node.shadowRoot && roots.length < 64) roots.push(node.shadowRoot);
          const ownText = (node.childElementCount === 0 && !observedHidden(node) && node.tagName !== "INPUT" && node.tagName !== "TEXTAREA" && node.tagName !== "SELECT" ? (node.innerText || node.textContent || "") : "").trim().slice(0, 200);
          const role = roleOf(node);
          const isTextNode = ["P", "LI", "LABEL", "DT", "DD", "FIGCAPTION"].includes(node.tagName);
          const shouldInclude = role && !observedHidden(node) && (INTERACTIVE_TAGS.has(node.tagName) || LANDMARK_TAGS.has(node.tagName) || Boolean(ROLE_TAGS[node.tagName]) || /^H[1-6]$/.test(node.tagName) || Boolean(node.getAttribute("role")) || isTextNode);
          // Headings get a small reserve past the element cap: on long articles the
          // nav and table-of-contents links fill the cap before the first section title.
          const withinCap = elements.length < ${maxElements} || (/^H[1-6]$/.test(node.tagName) && elements.length < ${maxElements} + ${HEADING_RESERVE});
          const name = shouldInclude && withinCap ? nameOf(node, role) : "";
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
          if (shouldInclude && withinCap) {
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
              // Show what a text field currently holds so the planner can tell a typed query landed.
              if (["text", "search", "email", "url", "tel", "number"].includes(type) && typeof node.value === "string" && node.value) entry.value = clean(node.value, 120);
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
            const form = formInfo(node);
            if (form && (node.tagName === "FORM" || ["submit", "image"].includes((node.getAttribute("type") || (node.tagName === "BUTTON" ? "submit" : "")).toLowerCase()))) {
              entry.formAction = form.action;
              entry.formMethod = form.method;
            }
            // PageAgent-style observation extras: hierarchy depth and live scroll
            // distances, so a text-only planner can tell nested controls from
            // top-level ones and see which region actually scrolls. Read-only:
            // neither field is used for validation, gating or authorization.
            let depth = 0;
            for (let cursor = parent; cursor && included.has(cursor); cursor = cursor.parentElement) depth += 1;
            entry.depth = Math.min(depth, 12);
            if (typeof node.clientHeight === "number" && typeof node.scrollHeight === "number") {
              const scrollable = {
                up: Math.max(0, Math.round(node.scrollTop || 0)),
                down: Math.max(0, Math.round(node.scrollHeight - node.clientHeight - (node.scrollTop || 0))),
                left: Math.max(0, Math.round(node.scrollLeft || 0)),
                right: Math.max(0, Math.round(node.scrollWidth - node.clientWidth - (node.scrollLeft || 0))),
              };
              if (scrollable.up + scrollable.down + scrollable.left + scrollable.right > 0) entry.scrollable = scrollable;
            }
            elements.push(entry);
            boundNodes.push({ node, identity: fingerprint(node) });
            included.set(node, index);
          }
        }
        node = walker.nextNode();
      }
      }
    }
    ${binding ? `globalThis[${JSON.stringify(binding.key)}] = {
      token: ${JSON.stringify(binding.token)}, url: document.baseURI,
      nodes: boundNodes, fingerprint, hidden, formInfo,
    };` : ""}
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
    interactionTimeoutMs = 5000,
    scrollTimeoutMs = 5000,
    maxNodesVisited,
    maxElements,
    maxTextBytes,
    randomId,
    permissionMode = "browse",
    assignedOrigin,
    writeClipboard,
    evaluateLeases,
    taskId,
  } = {}) {
    if (!view) throw new BrowserAdapterError("invalid_config", "view is required");
    this._view = view;
    // Optional: when set, `evaluate` runs only under an origin-scoped, expiring,
    // use-limited lease for this task (EvaluateLeases); every use/denial is audited there.
    this._evaluateLeases = evaluateLeases && typeof evaluateLeases.authorize === "function" ? evaluateLeases : null;
    this._leaseTaskId = typeof taskId === "string" ? taskId : null;
    this._writeClipboard = typeof writeClipboard === "function" ? writeClipboard : systemClipboard.writeText;
    this._scrollTimeoutMs = Number.isFinite(scrollTimeoutMs) && scrollTimeoutMs > 0 ? scrollTimeoutMs : 5000;
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
    this._intentLock = null;
    // While a widened navigation runs, the origin the user granted it for:
    // a redirect elsewhere is refused (see rejectIfBlocked and _navigate).
    this._widenedPin = null;
    this._now = typeof now === "function" ? now : Date.now;
    this._navigationTimeoutMs = typeof navigationTimeoutMs === "number" ? navigationTimeoutMs : NAVIGATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(interactionTimeoutMs) || interactionTimeoutMs <= 0 || interactionTimeoutMs > 60000) throw new BrowserAdapterError("invalid_config", "interactionTimeoutMs must be 1..60000");
    this._interactionTimeoutMs = interactionTimeoutMs;
    this._pendingInteraction = null;
    this._maxNodesVisited = typeof maxNodesVisited === "number" ? maxNodesVisited : MAX_NODES_VISITED;
    this._maxElements = typeof maxElements === "number" ? maxElements : MAX_ELEMENTS;
    this._maxTextBytes = typeof maxTextBytes === "number" ? maxTextBytes : MAX_TEXT_BYTES;
    // Observation IDs cross task/view boundaries in the host. Per-adapter
    // counters collide (every fresh view starts at obs-0-1), which can bind a
    // visual attachment to another task's observation. Use an unguessable,
    // globally unique host ID unless a deterministic test factory is supplied.
    this._randomId = typeof randomId === "function" ? randomId : () => randomUUID();
    // documentEpoch: bumped on every navigation. Any action bound to an
    // older epoch is stale by construction once this changes.
    this._documentEpoch = 0;
    this._latestObservation = null;
    this._visualBinding = null;
    // Monotonic per-navigate() sequence number for cross-event isolation: a
    // did-navigate/did-fail-load event tagged with an older sequence must
    // never resolve/settle a newer, still-in-flight navigate() call.
    this._navSeq = 0;
    this._observeSeq = 0;
    this._disposed = false;
    this._interactionKey = `halo_interaction_${randomUUID()}`;
    this._interactionBinding = null;
    this._readyEnsured = false;
    this._listeners = new Set();
    this._pageListeners = [];
    const wc = view.webContents;
    this._downloadSession = wc.session;
    this._rejectDownload = (_event, item, source) => {
      // Browser tasks have no approved host file broker yet. Downloads
      // initiated indirectly by click/navigation must not escape that fact.
      if (source === wc || (source?.id !== undefined && source.id === wc.id)) item.cancel();
    };
    this._downloadSession?.on?.("will-download", this._rejectDownload);
    const listen = (name, listener) => {
      if (typeof wc.on !== "function") return;
      wc.on(name, listener);
      this._pageListeners.push([name, listener]);
    };
    listen("did-navigate", (_event, _url, httpResponseCode) => { this._lastHttpStatus = Number.isInteger(httpResponseCode) ? httpResponseCode : null; this._documentEpoch += 1; this._interactionBinding = null; this._latestObservation = null; this._visualBinding = null; this._emitBrowserChange(); });
    listen("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame !== false) { this._documentEpoch += 1; this._interactionBinding = null; this._latestObservation = null; this._visualBinding = null; this._emitBrowserChange(); }
    });
    listen("page-title-updated", () => this._emitBrowserChange());
    listen("did-stop-loading", () => this._emitBrowserChange());
    // Page-initiated navigation (location changes, meta-refresh, server
    // redirects) never passes through execute(), so both the child-agent
    // origin pin and the user's Intent Lock are enforced here as well.
    const rejectIfBlocked = (event, url) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        event.preventDefault();
        return;
      }
      // Apply the same URL boundary as _navigate to redirects and page
      // navigation, even when this task has no origin pin or Intent Lock.
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        event.preventDefault();
        return;
      }
      const origin = parsed.origin;
      if (this._assignedOrigin && origin !== this._assignedOrigin) { event.preventDefault(); return; }
      if (this._widenedPin && origin !== this._widenedPin.origin) { this._widenedPin.violated = true; event.preventDefault(); return; }
      if (!evaluateLock(this._intentLock, { action: "navigate", targetOrigin: origin }).allowed) event.preventDefault();
    };
    listen("will-navigate", rejectIfBlocked);
    listen("will-redirect", rejectIfBlocked);
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new BrowserAdapterError("invalid_permission_mode", "permissionMode is invalid");
    this._permissionMode = mode;
  }

  setIntentLock(lock) {
    this._intentLock = lock ?? null;
  }

  supportsAction(type) {
    return SUPPORTED_ACTIONS.has(type);
  }

  // Only AgentViewportHost calls this after creating a private attachment.
  // Planner/renderer payloads cannot mint screenshot authorization.
  authorizeVisualBinding(binding) {
    const bounds = this._view.getBounds?.();
    if (this._visualBinding || !binding || typeof binding !== "object" || binding.observationId !== this._latestObservation?.id ||
        binding.documentEpoch !== this._documentEpoch || bareOrigin(binding.origin) !== binding.origin ||
        binding.origin !== bareOrigin(this._latestObservation?.url) ||
        !binding.viewport || !Number.isSafeInteger(binding.viewport.width) || !Number.isSafeInteger(binding.viewport.height) ||
        binding.viewport.width < 1 || binding.viewport.height < 1 || binding.viewport.width > 8192 || binding.viewport.height > 8192 ||
        !/^[0-9a-f]{64}$/.test(binding.digest) ||
        typeof binding.taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.taskId) ||
        (binding.agentId !== null && (typeof binding.agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.agentId))) ||
        !bounds || bounds.width !== binding.viewport.width || bounds.height !== binding.viewport.height) {
      throw new BrowserAdapterError("invalid_visual_binding", "visual binding does not match the current observation");
    }
    this._visualBinding = Object.freeze({ ...binding, viewport: Object.freeze({ ...binding.viewport }) });
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
      const result = await this._navigate(url.href, { enforceLock: false });
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
    if (this._pendingInteraction) throw new BrowserAdapterError("interaction_pending", "previous interaction has not settled");
    void signal; // no cancellable long-running observe op yet -- accepted for interface symmetry
    if (this._disposed) {
      throw new BrowserAdapterError("disposed", "observe() called after dispose()");
    }
    const wc = this._view.webContents;
    if (initial && this._documentEpoch === 0 && typeof wc.getURL === "function" && ["", "about:blank"].includes(wc.getURL())) {
      this._visualBinding = null;
      this._observeSeq += 1;
      const observation = {
        id: this._randomId(),
        documentEpoch: this._documentEpoch,
        url: "about:blank",
        title: "",
        text: "",
        elements: [],
        at: this._now(),
      };
      this._latestObservation = { id: observation.id, documentEpoch: observation.documentEpoch, url: observation.url };
      return observation;
    }
    await this._ensureReadyForScriptExecution(wc);
    this._observeSeq += 1;
    const observationEpoch = this._documentEpoch;
    const binding = typeof wc.executeJavaScriptInIsolatedWorld === "function"
      ? { key: this._interactionKey, token: randomUUID() } : null;
    this._interactionBinding = null;
    let raw;
    try {
      const script = buildObserveScript(this._maxNodesVisited, this._maxElements, this._maxTextBytes, binding);
      raw = binding
        ? await wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code: script }], false)
        : await wc.executeJavaScript(script, true);
    } catch (error) {
      // Observation failure must never be reported as an empty-but-successful
      // page -- the caller (task-controller.js) needs to see this as a real
      // failure, not silently proceed with a hollow Observation as if the
      // page were simply blank.
      throw new BrowserAdapterError("observe_failed", `observe() failed: ${error && error.message}`);
    }
    if (observationEpoch !== this._documentEpoch) throw new BrowserAdapterError("stale_document", "page navigated during observation");
    if (binding) this._interactionBinding = { ...binding, epoch: observationEpoch, url: raw.url, elements: raw.elements };
    const observation = {
      id: this._randomId(),
      documentEpoch: this._documentEpoch,
      url: raw.url,
      title: raw.title,
      text: raw.text,
      // Only error responses are surfaced, so ordinary observations stay unchanged.
      ...(this._lastHttpStatus >= 400 ? { httpStatus: this._lastHttpStatus } : {}),
      elements: raw.elements.map((el, index) => {
        const { index: _index, parentIndex, depth, ...entry } = el;
        return {
          ...entry,
          elementId: String(index),
          // Absence means "no included parent" / "depth 0": the fields are
          // omitted when they carry no information (measured: a flat page sent
          // 140 x "parentElementId":null + "depth":0 = 4,620 bytes per turn).
          ...(parentIndex === null || parentIndex === undefined ? {} : { parentElementId: String(parentIndex) }),
          ...(Number.isInteger(depth) && depth > 0 ? { depth } : {}),
          ...(typeof entry.name === "string" ? { name: utf8ByteCap(entry.name, MAX_ELEMENT_NAME_BYTES) } : {}),
        };
      }),
      at: this._now(),
    };
    const pdfText = await this._readPdfTextIfEmpty(wc, raw);
    if (pdfText) observation.text = pdfText;
    this._visualBinding = null;
    this._latestObservation = { id: observation.id, documentEpoch: observation.documentEpoch, url: observation.url };
    return observation;
  }

  // The PDF viewer leaves the document empty. Only an empty page, or a URL that
  // names a .pdf, is worth one extra request; the file is checked for the PDF
  // signature before it is parsed, so any other empty page costs one discarded fetch.
  async _readPdfTextIfEmpty(wc, raw) {
    const fetchImpl = typeof wc.session?.fetch === "function" ? (url, init) => wc.session.fetch(url, init) : null;
    if (!fetchImpl || typeof raw?.url !== "string") return "";
    const empty = (!raw.text || !raw.text.trim()) && Array.isArray(raw.elements) && raw.elements.length === 0;
    if (!empty && !looksLikePdfUrl(raw.url)) return "";
    try {
      const result = await extractPdfText(raw.url, { fetchImpl });
      if (process.env.HALO_DEBUG_ACTIONS) console.log(`[browser-adapter] pdf text url=${raw.url} pages=${result?.pageCount ?? "none"} scanned=${result?.scanned ?? "-"}`);
      return result ? formatPdfObservationText(result, { maxBytes: MAX_PDF_TEXT_BYTES }) : "";
    } catch {
      // Reading is best effort: a failure leaves the observation as it was.
      return "";
    }
  }

  // Text computer use: viewport-normalized boxes for the current observation's
  // bound nodes, read (never consumed) from the isolated-world binding. Only
  // AgentViewportHost turns this into a visual binding.
  async captureScreenGeometry(observation) {
    if (this._disposed) throw new BrowserAdapterError("disposed", "captureScreenGeometry() called after dispose()");
    if (this._pendingInteraction) throw new BrowserAdapterError("interaction_pending", "cannot read geometry while an interaction is unsettled");
    const latest = this._latestObservation;
    const binding = this._interactionBinding;
    if (!observation || !latest || !binding || observation.id !== latest.id || observation.documentEpoch !== latest.documentEpoch ||
        observation.url !== latest.url || this._documentEpoch !== latest.documentEpoch || binding.epoch !== this._documentEpoch) {
      throw new BrowserAdapterError("stale_visual_observation", "screen geometry requires the current host observation");
    }
    const wc = this._view.webContents;
    const bounds = this._view.getBounds?.();
    if (!bounds || !Number.isSafeInteger(bounds.width) || !Number.isSafeInteger(bounds.height) || bounds.width < 1 || bounds.height < 1 ||
        typeof wc.executeJavaScriptInIsolatedWorld !== "function" || typeof wc.getURL !== "function" || wc.getURL() !== observation.url) {
      throw new BrowserAdapterError("visual_unavailable", "browser surface cannot provide screen geometry");
    }
    let boxes;
    try {
      boxes = await wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code: `(() => {
        const state = globalThis[${JSON.stringify(binding.key)}];
        if (!state || state.token !== ${JSON.stringify(binding.token)} || state.url !== document.baseURI) return null;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (!(vw > 0 && vh > 0)) return null;
        const out = [];
        state.nodes.forEach((entry, index) => {
          const node = entry.node;
          if (!node?.isConnected || state.hidden(node)) return;
          const r = node.getBoundingClientRect();
          const left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, vw), bottom = Math.min(r.bottom, vh);
          if (!(right - left > 0 && bottom - top > 0)) return;
          const hit = document.elementFromPoint(Math.min((left + right) / 2, vw - 1), Math.min((top + bottom) / 2, vh - 1));
          out.push({ elementId: String(index), x: left / vw, y: top / vh, w: (right - left) / vw, h: (bottom - top) / vh,
            covered: !(hit && (hit === node || node.contains(hit) || hit.contains(node))) });
        });
        return out;
      })()` }], false);
    } catch {
      throw new BrowserAdapterError("screenshot_failed", "browser surface geometry read failed");
    }
    if (!Array.isArray(boxes) || this._disposed || this._documentEpoch !== latest.documentEpoch || this._interactionBinding !== binding ||
        wc.getURL() !== observation.url) {
      throw new BrowserAdapterError("stale_visual_observation", "browser surface changed during geometry read");
    }
    return { observationId: observation.id, documentEpoch: observation.documentEpoch, url: observation.url, viewport: { width: bounds.width, height: bounds.height }, boxes };
  }

  async captureScreenshot(observation) {
    if (this._disposed) throw new BrowserAdapterError("disposed", "captureScreenshot() called after dispose()");
    if (this._pendingInteraction) throw new BrowserAdapterError("interaction_pending", "cannot capture a screenshot while an interaction is unsettled");
    const latest = this._latestObservation;
    if (!observation || !latest || observation.id !== latest.id || observation.documentEpoch !== latest.documentEpoch ||
        observation.url !== latest.url || this._documentEpoch !== latest.documentEpoch) {
      throw new BrowserAdapterError("stale_visual_observation", "screenshot requires the current host observation");
    }
    const wc = this._view.webContents;
    const bounds = this._view.getBounds?.();
    if (!bounds || !Number.isSafeInteger(bounds.width) || !Number.isSafeInteger(bounds.height) || bounds.width < 1 || bounds.height < 1 ||
        typeof wc.capturePage !== "function" || typeof wc.getURL !== "function") {
      throw new BrowserAdapterError("visual_unavailable", "browser surface cannot provide a bounded screenshot");
    }
    const before = {
      epoch: this._documentEpoch,
      navigation: this._navSeq,
      url: wc.getURL(),
      width: bounds.width,
      height: bounds.height,
    };
    if (before.url !== observation.url) throw new BrowserAdapterError("stale_visual_observation", "browser URL changed after observation");
    let image;
    try {
      // CDP pages can render the capture smaller at capture time; the Electron
      // fallback (and fakes) ignore the second argument. Normalized geometry is
      // unaffected, so the logical viewport stays the binding's viewport.
      const scale = wc.isCdp === true && before.width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / before.width : undefined;
      image = await wc.capturePage({ x: 0, y: 0, width: before.width, height: before.height }, scale ? { scale } : undefined);
    } catch {
      throw new BrowserAdapterError("screenshot_failed", "browser surface screenshot capture failed");
    }
    const afterBounds = this._view.getBounds?.();
    if (this._disposed || this._documentEpoch !== before.epoch || this._navSeq !== before.navigation || wc.getURL() !== before.url ||
        !afterBounds || afterBounds.width !== before.width || afterBounds.height !== before.height) {
      throw new BrowserAdapterError("stale_visual_observation", "browser surface changed during screenshot capture");
    }
    if (!image || typeof image.toPNG !== "function" || typeof image.getSize !== "function") {
      throw new BrowserAdapterError("screenshot_failed", "browser screenshot was not a native image");
    }
    const imageSize = image.getSize();
    const ratioX = imageSize.width / before.width;
    const ratioY = imageSize.height / before.height;
    if (!Number.isSafeInteger(imageSize.width) || !Number.isSafeInteger(imageSize.height) || imageSize.width < 1 || imageSize.height < 1 ||
        !Number.isFinite(ratioX) || !Number.isFinite(ratioY) || Math.abs(ratioX - ratioY) > 0.02) {
      throw new BrowserAdapterError("screenshot_failed", "screenshot dimensions do not match the browser viewport");
    }
    let png;
    try { png = image.toPNG(); }
    catch { throw new BrowserAdapterError("screenshot_failed", "browser screenshot could not be encoded as PNG"); }
    if (!Buffer.isBuffer(png) || png.length === 0) throw new BrowserAdapterError("screenshot_failed", "browser screenshot PNG is empty");
    return {
      png,
      observationId: latest.id,
      documentEpoch: latest.documentEpoch,
      url: before.url,
      viewport: { width: before.width, height: before.height },
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
    this._interactionBinding = null;
    this._visualBinding = null;
    const wc = this._view && this._view.webContents;
    this._downloadSession?.removeListener?.("will-download", this._rejectDownload);
    for (const [name, listener] of this._pageListeners) wc?.removeListener?.(name, listener);
    this._listeners.clear();
    if (wc && typeof wc.close === "function") {
      wc.close();
    } else if (wc && typeof wc.destroy === "function") {
      wc.destroy();
    }
  }

  async execute(action, { signal, documentEpoch, widenedBy } = {}) {
    if (signal?.aborted) return { status: "cancelled", errorCode: "aborted" };
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
    // hw_step performs an elementId action's effect under a locator; the
    // adapter's own lock/mode check judges it as that action, and a malformed
    // step never reaches the gate.
    if (action.type === "hw_step") {
      const valid = validateStep(action.step);
      if (!valid.ok) {
        return { status: "failed", errorCode: valid.errorCode };
      }
    }
    const gateAction = action.type === "hw_step" ? gateActionFor(action.step.op) : action.type;
    if (!evaluateLock(this._intentLock, { action: gateAction }).allowed) {
      return { status: "failed", errorCode: "intent_lock_denied" };
    }
    // A mode-denied action runs only when the task controller passes the
    // grant the user gave (Allow once on a widened request, or a lease).
    // A grant may carry the origin it was given for; when it does, the
    // action may only land there. A malformed origin voids the grant.
    const grantOrigin = widenedBy?.origin;
    const originOk = grantOrigin === undefined || (typeof grantOrigin === "string" && bareOrigin(grantOrigin) === grantOrigin);
    const widened = !!widenedBy && originOk && (widenedBy.kind === "user_once" || (widenedBy.kind === "lease" && typeof widenedBy.leaseId === "string" && widenedBy.leaseId.length > 0));
    if (!evaluateActionPolicy(this._permissionMode, gateAction).allowed && !widened) {
      return { status: "failed", errorCode: "permission_mode_denied" };
    }
    const expectedOrigin = widened && typeof grantOrigin === "string" ? grantOrigin : null;
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
        return this._navigate(action.url, { expectedOrigin });
      case "follow_link":
        return this._followLink(action.elementId, { expectedOrigin });
      case "click":
      case "type":
      case "submit_form":
        return this._interact(action, { signal, documentEpoch, expectedOrigin });
      case "click_at":
      case "type_at":
      case "press_key":
        return this._coordinateAction(action, { signal, documentEpoch, expectedOrigin });
      case "hw_step":
        return this._hwStep(action, { signal, documentEpoch });
      case "evaluate":
        if (this._evaluateLeases && !widened) {
          const origin = bareOrigin(this._view.webContents.getURL());
          if (!origin || !this._evaluateLeases.authorize(this._leaseTaskId, origin).allowed) {
            return { status: "failed", errorCode: "evaluate_not_leased" };
          }
        }
        return this._evaluate(action, { signal, expectedOrigin });
      case "scroll":
        return this._scroll(action.direction, action.amount);
      case "find":
        return this._find(action);
      case "zoom":
        return this._zoom(action);
      case "select_all":
        return this._selectAll();
      case "copy":
        return this._copy();
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

  // Reads the host-measured page snapshot, or null when this page cannot run scripts
  // (a test double) or the read fails.
  async _readSnapshot(wc) {
    if (typeof wc.executeJavaScriptInIsolatedWorld !== "function") return null;
    try {
      const raw = await wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code: PAGE_SNAPSHOT_SOURCE }], false);
      return parseSnapshot(Array.isArray(raw) ? raw[0] : raw);
    } catch { return null; }
  }

  // Wraps a write action: `perform` sends the input. ok only when the page measurably changed.
  async _withEffectCheck(wc, perform) {
    const before = await this._readSnapshot(wc);
    if (!before && typeof wc.executeJavaScriptInIsolatedWorld === "function") return { status: "failed", errorCode: "effect_unverifiable" };
    perform();
    if (!before) return { status: "ok" };
    const effect = await verifyEffect({ before, read: () => this._readSnapshot(wc), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    return effect.observed ? { status: "ok", effect } : { status: "uncertain", errorCode: "effect_not_observed" };
  }

  async _coordinateAction(action, { signal, documentEpoch, expectedOrigin }) {
    let normalized;
    try { normalized = validateCoordinateAction(action); }
    catch (error) { return { status: "failed", errorCode: error.code || "invalid_coordinate_action" }; }
    const binding = this._visualBinding;
    const stale = () => ({ status: "failed", errorCode: "stale_visual_observation" });
    if (!binding || binding.observationId !== normalized.observationId ||
        binding.observationId !== this._latestObservation?.id || binding.documentEpoch !== this._documentEpoch ||
        (documentEpoch != null && binding.documentEpoch !== documentEpoch)) return stale();
    const wc = this._view.webContents;
    const currentUrl = typeof wc.getURL === "function" ? wc.getURL() : null;
    const bounds = this._view.getBounds?.();
    if (!currentUrl || bareOrigin(currentUrl) !== binding.origin ||
        (expectedOrigin && (expectedOrigin !== binding.origin || bareOrigin(currentUrl) !== expectedOrigin)) ||
        !bounds || bounds.width !== binding.viewport.width || bounds.height !== binding.viewport.height) return stale();
    if (signal?.aborted) return { status: "cancelled", errorCode: "aborted" };
    if (typeof wc.sendInputEvent !== "function" || (normalized.type === "type_at" && typeof wc.insertText !== "function")) {
      return { status: "failed", errorCode: "unsupported_action" };
    }

    const x = normalized.type === "press_key" ? 0 : Math.floor(normalized.x * binding.viewport.width);
    const y = normalized.type === "press_key" ? 0 : Math.floor(normalized.y * binding.viewport.height);
    // Consume before the first Chromium call. A lost result must never replay
    // the same approved visual action.
    this._visualBinding = null;
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
  }

  // Halowright step: the planner names an element (role/name, label, text,
  // placeholder or testid) instead of binding an elementId, and the host
  // resolves it at execution time, waits until it is actionable, then acts and
  // verifies the effect (halowright.js). The host's gate runs twice: the
  // controller classifies the locator before dispatch (lock, mode, lease,
  // approval), and `authorize` below re-checks the *resolved* element and the
  // live origin before any input -- a missing or failing callback sends
  // nothing. Secrets stay with the person: a fill that resolves to a password
  // field is refused here.
  async _hwStep(action, { signal, documentEpoch }) {
    if (Object.keys(action).some(key => !["type", "step"].includes(key))) return { status: "failed", errorCode: "invalid_action" };
    const valid = validateStep(action.step);
    if (!valid.ok) return { status: "failed", errorCode: valid.errorCode };
    const step = action.step;
    const gateAction = gateActionFor(step.op);
    const wc = this._view.webContents;
    const origin = bareOrigin(wc.getURL?.() || "");
    if (this._assignedOrigin && origin !== this._assignedOrigin) return { status: "failed", errorCode: "assigned_origin_mismatch" };
    if (!evaluateLock(this._intentLock, { action: gateAction, targetOrigin: origin }).allowed) return { status: "failed", errorCode: "intent_lock_denied" };
    await this._ensureReadyForScriptExecution(wc);
    if (signal?.aborted) return { status: "cancelled", errorCode: "aborted" };
    const epoch = this._documentEpoch;
    const authorize = ({ target }) => {
      if (this._disposed || this._documentEpoch !== epoch) return false;
      const currentOrigin = bareOrigin(this._view.webContents.getURL?.() || "");
      if (this._assignedOrigin && currentOrigin !== this._assignedOrigin) return false;
      if (!evaluateLock(this._intentLock, { action: gateAction, targetOrigin: currentOrigin }).allowed) return false;
      const resolved = { role: target?.role, name: target?.name, covered: false, disabled: false };
      if (step.op === "fill" && target?.inputType === "password") return false;
      if (step.op === "fill" && resolved.role !== undefined && classifyTarget(resolved, "type_at").gate === "deny") return false;
      if (["click", "check", "uncheck", "select"].includes(step.op) && classifyTarget(resolved, "click_at").gate === "deny") return false;
      return true;
    };
    try {
      return await runHwStep(wc, step, { authorize });
    } catch (error) {
      return { status: "uncertain", errorCode: error?.code || "execute_threw" };
    }
  }

  async _interact(action, { signal, documentEpoch, expectedOrigin }) {
    const keys = action.type === "type" ? ["type", "elementId", "text"] : ["type", "elementId"];
    if (Object.keys(action).some(key => !keys.includes(key)) ||
        typeof action.elementId !== "string" || !/^(0|[1-9][0-9]*)$/.test(action.elementId) ||
        (action.type === "type" && (typeof action.text !== "string" || Buffer.byteLength(action.text, "utf8") > MAX_INPUT_BYTES))) {
      return { status: "failed", errorCode: "invalid_action" };
    }
    const binding = this._interactionBinding;
    if (!binding) return { status: "failed", errorCode: "observation_required" };
    if (binding.epoch !== this._documentEpoch || (documentEpoch != null && documentEpoch !== binding.epoch)) {
      return { status: "cancelled", errorCode: "stale_document" };
    }
    const entry = binding.elements[Number(action.elementId)];
    if (!entry) return { status: "failed", errorCode: "element_not_found" };
    const targetUrl = action.type === "type" ? binding.url : entry.formAction || entry.href || binding.url;
    const origin = bareOrigin(targetUrl);
    if (!origin || new URL(targetUrl).username || new URL(targetUrl).password) return { status: "failed", errorCode: "invalid_url" };
    if (expectedOrigin && (origin !== expectedOrigin || bareOrigin(binding.url) !== expectedOrigin)) return { status: "failed", errorCode: "widened_origin_mismatch" };
    if (this._assignedOrigin && origin !== this._assignedOrigin) return { status: "failed", errorCode: "assigned_origin_mismatch" };
    if (!evaluateLock(this._intentLock, { action: action.type, targetOrigin: origin }).allowed) return { status: "failed", errorCode: "intent_lock_denied" };
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    if (signal?.aborted) return { status: "cancelled", errorCode: "aborted" };
    if (this._disposed || this._interactionBinding !== binding || this._documentEpoch !== binding.epoch) return { status: "cancelled", errorCode: "stale_document" };
    // Consume before dispatch. Losing the renderer/result cannot make the
    // same snapshot eligible for a second side effect.
    this._interactionBinding = null;
    let timer;
    try {
      const operation = wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code: `(() => {
        const key = ${JSON.stringify(binding.key)}, token = ${JSON.stringify(binding.token)};
        const state = globalThis[key]; delete globalThis[key];
        const action = ${JSON.stringify(action)};
        const failed = errorCode => ({ status: "failed", errorCode });
        if (!state || state.token !== token || state.url !== document.baseURI) return failed("stale_element");
        const entry = state.nodes[Number(action.elementId)], node = entry?.node;
        const valid = () => node?.isConnected && !state.hidden(node) && !node.disabled &&
          !node.matches?.(":disabled") && node.getAttribute("aria-disabled") !== "true" &&
          state.fingerprint(node) === entry.identity;
        if (!valid()) return failed("stale_element");
        let started = false;
        try {
          if (action.type === "type") {
            const type = (node.getAttribute("type") || "text").toLowerCase();
            if (!(node.tagName === "TEXTAREA" || (node.tagName === "INPUT" && ["text", "search", "email", "url", "tel", "number"].includes(type)))) return failed("unsupported_input");
            if (node.readOnly || node.hasAttribute("readonly")) return failed("readonly_element");
            const prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) return failed("unsupported_input");
            started = true; node.focus();
            if (!valid()) return { status: "uncertain", errorCode: "target_changed_during_focus" };
            if (!node.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertReplacementText", data: action.text }))) return failed("input_cancelled");
            if (!valid()) return { status: "uncertain", errorCode: "target_changed_before_input" };
            setter.call(node, action.text);
            node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: action.text }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (action.type === "submit_form") {
            // Script-driven search boxes (e.g. GitHub) use role=form/search on a
            // plain element; submit them through their own visible Search button.
            if (node.tagName !== "FORM" && !node.form && ["form", "search"].includes(node.getAttribute("role") || "")) {
              const control = [...node.querySelectorAll("button, [role=button], input[type=submit]")]
                .find((el) => /search|submit|go|검색/i.test(el.getAttribute("aria-label") || el.textContent || el.value || ""));
              const field = node.querySelector("input:not([type=hidden]):not([type=password]):not([type=file]), [role=combobox], [role=searchbox]");
              if ((!control || control.disabled) && !field) return failed("unsupported_form");
              if (!valid()) return failed("stale_element");
              started = true;
              if (control && !control.disabled) HTMLElement.prototype.click.call(control);
              else {
                field.focus();
                for (const type of ["keydown", "keypress", "keyup"]) field.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
              }
              return { status: "ok" };
            }
            const form = node.tagName === "FORM" ? node : node.form;
            const info = state.formInfo(node);
            if (!form || !info || !["get", "post"].includes(info.method) || !["", "_self"].includes(info.target)) return failed("unsupported_form");
            const submitter = node.tagName === "FORM" ? undefined : node;
            if (submitter && !["submit", "image"].includes((node.getAttribute("type") || (node.tagName === "BUTTON" ? "submit" : "")).toLowerCase())) return failed("invalid_submitter");
            // CSS validity inspection has no invalid-event side effects.
            if (form.matches?.(":invalid")) return failed("form_invalid");
            if (!valid()) return failed("stale_element");
            started = true; HTMLFormElement.prototype.requestSubmit.call(form, submitter);
          } else {
            const allowed = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "searchbox", "combobox"];
            if (!allowed.includes(state.nodes[Number(action.elementId)].node.getAttribute("role") || ${JSON.stringify(entry.role)}) ||
                (node.tagName === "INPUT" && ["file", "password"].includes((node.getAttribute("type") || "").toLowerCase())) || node.hasAttribute("download")) return failed("unsupported_click");
            const info = state.formInfo(node);
            if (info && !["", "_self"].includes(info.target)) return failed("unsupported_form");
            // Full pointer/mouse sequence before activation, so controls that
            // listen for pointerdown/mousedown (custom menus, sliders, canvas
            // widgets) behave as they do under a real cursor. Adapted from
            // PageAgent (github.com/alibaba/page-agent, MIT). Activation itself
            // stays the single HTMLElement.prototype.click call the adapter's
            // effect check already reasons about, and no gate or policy moves.
            const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
            if (rect && rect.width > 0 && rect.height > 0 && typeof PointerEvent === "function") {
              const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
              const doc = node.ownerDocument;
              const hit = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(cx, cy) : null;
              const pointerTarget = hit && (hit === node || node.contains(hit)) ? hit : node;
              const pointerInit = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 };
              const mouseInit = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };
              pointerTarget.dispatchEvent(new PointerEvent("pointerover", pointerInit));
              pointerTarget.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", isPrimary: true }));
              pointerTarget.dispatchEvent(new MouseEvent("mouseover", mouseInit));
              pointerTarget.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, composed: true, clientX: cx, clientY: cy }));
              pointerTarget.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
              pointerTarget.dispatchEvent(new MouseEvent("mousedown", mouseInit));
              if (typeof node.focus === "function") node.focus({ preventScroll: true });
              pointerTarget.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0 }));
              pointerTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 0 }));
            }
            started = true; HTMLElement.prototype.click.call(node);
            if (["INPUT", "TEXTAREA"].includes(node.tagName) || node.isContentEditable) node.focus();
          }
          return { status: "ok" };
        } catch { return started ? { status: "uncertain", errorCode: "interaction_uncertain" } : failed("interaction_failed"); }
      })()` }], true);
      this._pendingInteraction = operation;
      const settle = () => { if (this._pendingInteraction === operation) this._pendingInteraction = null; };
      // Both arms handle rejection; no unhandled finally-derived promise.
      operation.then(settle, settle);
      return await Promise.race([operation, new Promise(resolve => {
        timer = setTimeout(() => resolve({ status: "uncertain", errorCode: "interaction_timeout" }), this._interactionTimeoutMs);
      })]);
    } catch {
      return { status: "uncertain", errorCode: "interaction_uncertain" };
    } finally {
      clearTimeout(timer);
    }
  }

  // enforceLock:false is for the human path only (userNavigate): the Intent Lock
  // restricts the agent, never the person driving the address bar.
  async _navigate(url, { enforceLock = true, expectedOrigin = null } = {}) {
    this._visualBinding = null;
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
    if (enforceLock && !evaluateLock(this._intentLock, { action: "navigate", targetOrigin: parsed.origin }).allowed) {
      return { status: "failed", errorCode: "intent_lock_denied" };
    }
    if (expectedOrigin && parsed.origin !== expectedOrigin) {
      return { status: "failed", errorCode: "widened_origin_mismatch" };
    }
    const wc = this._view.webContents;
    const mySeq = ++this._navSeq;
    this._latestObservation = null;
    const epochBeforeLoad = this._documentEpoch;
    const pin = expectedOrigin ? { origin: expectedOrigin, violated: false } : null;
    this._widenedPin = pin;
    let outcome;
    try {
      outcome = await this._loadWithTimeout(wc, url, mySeq);
    } finally {
      if (this._widenedPin === pin) this._widenedPin = null;
    }
    if (pin?.violated) {
      return { status: "failed", errorCode: "widened_origin_mismatch" };
    }
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
    const ready = wc.loadURL(url).then(() => ({ outcome: "ok" })).catch((error) => { if (process.env.HALO_DEBUG_ACTIONS) console.error("[navigate-fail]", String(error?.message ?? error).slice(0, 200)); return { outcome: "error" }; });
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
  async _followLink(elementId, { expectedOrigin = null } = {}) {
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
    return this._navigate(current.href, { expectedOrigin });
  }

  async _scroll(direction, amount) {
    const dir = direction === "up" ? "up" : "down";
    const delta = typeof amount === "number" && amount > 0 ? amount : 600;
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    // Instant, not the page's own scroll-behavior: on a page with CSS smooth
    // scrolling in a hidden view the animation never finishes and the script
    // call never returns. The timeout is the backstop for anything else.
    let timer;
    try {
      await Promise.race([
        wc.executeJavaScript(`window.scrollBy({ top: ${dir === "up" ? -delta : delta}, left: 0, behavior: "instant" });`, true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("scroll timed out")), this._scrollTimeoutMs); }),
      ]);
    } catch (error) {
      return { status: "failed", errorCode: "scroll_failed" };
    } finally {
      clearTimeout(timer);
    }
    return { status: "ok" };
  }

  // Read-only page search (contracts/BROWSER-INTERACTIONS.md): scrolls to and
  // selects the next/previous occurrence of text and reports found true/false.
  // Repeated calls continue from the current selection, so a planner can walk
  // matches without scrolling blind through a long page.
  async _find(action) {
    if (typeof action.text !== "string") return { status: "failed", errorCode: "invalid_action" };
    const forward = action.direction !== "prev";
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    const result = await findInPageOn(wc, action.text, { forward });
    if (!result.ok) return { status: "failed", errorCode: result.errorCode ?? "find_failed" };
    return { status: "ok", found: result.found };
  }

  // Read-only page zoom (CSS zoom; see page-zoom.js for the measured
  // trade-offs). Layout, hit-testing, observation geometry and captures scale
  // together, so normalized coordinates stay exact. Not persisted across
  // navigations: a new document starts at 1x.
  async _zoom(action) {
    const level = resolveZoomAction(action, this._zoomLevel ?? 1);
    if (level === null) return { status: "failed", errorCode: "invalid_action" };
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    const result = await applyPageZoom(wc, level);
    if (!result.ok) return { status: "failed", errorCode: result.errorCode ?? "zoom_failed" };
    this._zoomLevel = result.level;
    return { status: "ok", level: result.level };
  }

  // Selection and clipboard. select_all is selection-only (read-only); copy
  // writes the selection to the OS clipboard and returns its text (bounded) so
  // the planner can paste it elsewhere with a later type action. HALO never
  // reads the user's clipboard.
  async _selectAll() {
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    if (typeof wc.selectAll !== "function") return { status: "failed", errorCode: "unsupported_action" };
    try {
      wc.selectAll();
      return { status: "ok" };
    } catch {
      return { status: "failed", errorCode: "select_all_failed" };
    }
  }

  async _copy() {
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    const result = await copySelectionOn(wc, this._writeClipboard);
    if (!result.ok) return { status: "failed", errorCode: result.errorCode ?? "copy_failed" };
    return { status: "ok", chars: result.chars, text: result.text };
  }

  // One read-only JavaScript expression in the page's isolated world. The
  // model's expression runs as page code -- that is why the controller
  // always routes evaluate through a human approval and no lease can
  // authorize it. Expression-only by construction (a statement is a syntax
  // error, reported as evaluate_threw, never retried); the value must
  // survive a page-side JSON round-trip or the step is uncertain.
  async _evaluate(action, { signal } = {}) {
    const expression = action?.expression;
    if (typeof expression !== "string" || expression.length === 0 || expression.length > MAX_EXPRESSION_CHARS ||
        Buffer.byteLength(expression, "utf8") > MAX_EXPRESSION_BYTES) {
      return { status: "failed", errorCode: "invalid_expression" };
    }
    const wc = this._view.webContents;
    await this._ensureReadyForScriptExecution(wc);
    if (signal?.aborted) return { status: "cancelled", errorCode: "aborted" };
    const code = `JSON.stringify((() => { let value; try { value = (${expression}); } catch (error) { return { ok: false, error: String((error && error.message) || error).slice(0, 200) }; } try { JSON.stringify(value); } catch { return { ok: false, error: "not_serializable" }; } return { ok: true, value }; })())`;
    let raw;
    try {
      raw = await wc.executeJavaScriptInIsolatedWorld(INTERACTION_WORLD_ID, [{ code }], false);
    } catch {
      return { status: "uncertain", errorCode: "evaluate_uncertain" };
    }
    let parsed = null;
    try { parsed = JSON.parse(Array.isArray(raw) ? raw[0] : raw); } catch { /* handled below */ }
    if (!parsed || typeof parsed !== "object") return { status: "uncertain", errorCode: "evaluate_uncertain" };
    if (parsed.ok !== true) {
      return { status: "uncertain", errorCode: parsed.error === "not_serializable" ? "evaluate_not_serializable" : "evaluate_threw" };
    }
    const text = typeof parsed.value === "string" ? parsed.value : JSON.stringify(parsed.value);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= EVALUATE_RESULT_BYTES) {
      return { status: "ok", evaluateResult: { authority: "untrusted_page", value: text, truncated: false } };
    }
    let end = EVALUATE_RESULT_BYTES;
    const source = Buffer.from(text, "utf8");
    while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
    return { status: "ok", evaluateResult: { authority: "untrusted_page", value: source.subarray(0, end).toString("utf8"), truncated: true } };
  }
}

module.exports = { BrowserAdapter, BrowserAdapterError, MAX_NODES_VISITED, MAX_ELEMENTS, MAX_TEXT_BYTES, buildObserveScript };
