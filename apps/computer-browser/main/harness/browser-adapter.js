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
          const ownText = (node.childNodes.length === 0 ? (node.textContent || "") : "").trim().slice(0, 200);
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
  }

  getDocumentEpoch() {
    return this._documentEpoch;
  }

  async observe({ signal } = {}) {
    void signal; // no cancellable long-running observe op yet -- accepted for interface symmetry
    const wc = this._view.webContents;
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

  async execute(action, { signal, documentEpoch } = {}) {
    void signal;
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
    const outcome = await this._loadWithTimeout(wc, url, mySeq);
    // Cross-event isolation: if a NEWER navigate() call has already started
    // since this one's load settled/timed out, this call's result must not
    // retroactively bump the epoch or be reported as authoritative -- the
    // newer call owns the document now.
    if (mySeq !== this._navSeq) {
      return { status: "cancelled", errorCode: "superseded" };
    }
    if (outcome.outcome === "ok") {
      this._documentEpoch += 1;
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
    try {
      await wc.executeJavaScript(`window.scrollBy(0, ${dir === "up" ? -delta : delta});`, true);
    } catch (error) {
      return { status: "failed", errorCode: "scroll_failed" };
    }
    return { status: "ok" };
  }
}

module.exports = { BrowserAdapter, BrowserAdapterError, MAX_NODES_VISITED, MAX_ELEMENTS, MAX_TEXT_BYTES };
