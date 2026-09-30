"use strict";

const DEFAULT_DEADLINE_MS = 12000;
const MAX_ELEMENTS = 12;

class ObservationCancelled extends Error {
  constructor() {
    super("observation_cancelled");
    this.code = "observation_cancelled";
  }
}

function liveUrl(browser) {
  if (typeof browser.getBrowserSnapshot !== "function") return undefined;
  try {
    const snapshot = browser.getBrowserSnapshot();
    const tab = snapshot?.tabs?.find((t) => t.id === snapshot.activeTabId);
    return typeof tab?.url === "string" ? tab.url : undefined;
  } catch {
    return undefined;
  }
}

function liveEpoch(browser) {
  if (typeof browser.getDocumentEpoch !== "function") return undefined;
  try { return browser.getDocumentEpoch(); } catch { return undefined; }
}

// Keep stable host element IDs but drop unrelated GitHub chrome. A kept
// element whose parent was dropped gets a null parent so the compact tree
// never references an ID the model cannot see.
function compactElements(elements, pageUrl) {
  const prefix = new URL(pageUrl).pathname.split("/").slice(0, 3).join("/") + "/";
  const kept = (Array.isArray(elements) ? elements : []).filter((element) => {
    try { const url = new URL(element.href); return url.origin === "https://github.com" && url.pathname.startsWith(prefix); }
    catch { return false; }
  }).slice(0, MAX_ELEMENTS);
  const ids = new Set(kept.map((element) => element.elementId));
  return kept.map((element) => (element.parentElementId != null && !ids.has(element.parentElementId)
    ? { ...element, parentElementId: null } : element));
}

// Only the host constructs this wrapper. Existing browser actions, handles,
// evidence candidates and approval semantics continue through the adapter.
function makeMcpBrowserObservation({ browser, connector, onMetric = () => {}, deadlineMs = DEFAULT_DEADLINE_MS }) {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) throw new Error("invalid_deadline");
  let disposed = false;
  const pending = new Set();
  const metric = (value) => { try { onMetric(value); } catch { /* Metrics have no authority. */ } };
  const fallback = (observation, code, extra = {}) => { metric({ source: "browser_fallback", code, ...extra }); return observation; };

  async function enrich(observation, signal) {
    if (disposed || signal?.aborted) throw new ObservationCancelled();
    const epoch = liveEpoch(browser);
    const url = liveUrl(browser);
    // Without an authoritative epoch and URL we cannot prove an asynchronous
    // result still describes this page. Keep the DOM observation.
    if (epoch === undefined || url === undefined || observation?.documentEpoch !== epoch || observation?.url !== url) return observation;

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    pending.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    // Whoever settles first wins; a connector that ignores abort can never
    // hold the observation past the deadline, dispose or caller abort.
    const aborted = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(timedOut ? "deadline" : "aborted"), { once: true }));
    try {
      let outcome;
      try {
        outcome = await Promise.race([
          Promise.resolve().then(() => connector.readFile(observation.url, { signal: controller.signal })).then((result) => ({ result })),
          aborted,
        ]);
      } catch (error) {
        if (disposed || signal?.aborted) throw new ObservationCancelled();
        if (timedOut) return fallback(observation, "deadline");
        // Missing capabilities, revoked login, connection errors and a busy
        // shared broker all retain the browser observation.
        return fallback(observation, error?.code || "connector_error");
      }
      if (disposed || signal?.aborted) throw new ObservationCancelled();
      if (outcome === "deadline") return fallback(observation, "deadline");
      if (outcome === "aborted") throw new ObservationCancelled();
      const { result } = outcome;
      if (!result) return observation;
      if (liveEpoch(browser) !== epoch || liveUrl(browser) !== url) return fallback(observation, "navigation_race");

      const enriched = { ...observation, text: String(result.text), elements: compactElements(observation.elements, observation.url),
        connector: { authority: "untrusted_connector", sourceUrl: result.sourceUrl, server: result.server,
          tool: result.tool, truncated: result.truncated === true, range: result.range } };
      const domObservationBytes = Buffer.byteLength(JSON.stringify(observation));
      const connectorObservationBytes = Buffer.byteLength(JSON.stringify(enriched));
      // A larger connector observation is not a context saving; keep the DOM.
      if (connectorObservationBytes >= domObservationBytes) {
        return fallback(observation, "not_smaller", { domObservationBytes, connectorObservationBytes });
      }
      metric({ source: "codex_mcp", latencyMs: result.latencyMs, sourceBytes: result.sourceBytes,
        truncated: result.truncated === true, domObservationBytes, connectorObservationBytes });
      return enriched;
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  return new Proxy(browser, {
    get(target, property) {
      if (property === "observe") return async (options = {}) => enrich(await target.observe(options), options.signal);
      if (property === "execute") return async (action, options = {}) => {
        const result = await target.execute(action, options);
        if (result?.status === "ok" && result.observation) return { ...result, observation: await enrich(result.observation, options.signal) };
        return result;
      };
      if (property === "dispose") return async () => {
        disposed = true;
        for (const controller of pending) controller.abort();
        await target.dispose?.();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

module.exports = { makeMcpBrowserObservation, compactElements, DEFAULT_DEADLINE_MS };
