"use strict";

// Find-in-page for the page surfaces the host owns. Two engines:
//   - Electron webContents: findInPage() + "found-in-page" (counts included),
//   - the Chromium CDP page (CdpWebContents): window.find() via
//     executeJavaScript, which scrolls to and selects the match but reports
//     only found/not-found and has no all-matches highlight.
// Human Mod+F and the agent "find" action share this so the two surfaces cannot
// drift. Read-only: it never dispatches an action or writes to the page DOM
// beyond the selection/scroll every browser's find performs.

const MAX_QUERY_CHARS = 200;
const MAX_QUERY_BYTES = 256;
const ELECTRON_FIND_TIMEOUT_MS = 2000;

function normalizeQuery(query) {
  if (typeof query !== "string") return null;
  const cleaned = query.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_QUERY_CHARS);
  if (!cleaned.trim()) return null;
  if (Buffer.byteLength(cleaned, "utf8") > MAX_QUERY_BYTES) return null;
  return cleaned;
}

// Returns { ok, found, matches?, active? }. ok=false is a transport/target
// failure (the caller decides the error code); found=false is a real
// "no match on this page".
async function findInPageOn(wc, query, { forward = true } = {}) {
  const text = normalizeQuery(query);
  if (!text) return { ok: false, found: false, errorCode: "invalid_find_query" };
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) {
    return { ok: false, found: false, errorCode: "find_target_unavailable" };
  }
  if (typeof wc.findInPage === "function") {
    // Electron: the count arrives on the next found-in-page for this request.
    return await new Promise((resolve) => {
      let requestId = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.removeListener?.("found-in-page", onFound);
        resolve(result);
      };
      const onFound = (_event, result) => {
        if (!result || result.requestId !== requestId) return;
        finish({ ok: true, found: (result.matches ?? 0) > 0, matches: result.matches ?? 0, active: result.activeMatchOrdinal ?? 0 });
      };
      const timer = setTimeout(() => finish({ ok: false, found: false, errorCode: "find_timeout" }), ELECTRON_FIND_TIMEOUT_MS);
      wc.on?.("found-in-page", onFound);
      try {
        requestId = wc.findInPage(text, { forward, findNext: true });
      } catch {
        finish({ ok: false, found: false, errorCode: "find_failed" });
      }
    });
  }
  if (typeof wc.executeJavaScript === "function") {
    // Repeated calls continue from the current selection, so "next" cycles
    // forward and "prev" backward exactly like a find bar's arrows.
    const script = `(() => { try { if (typeof window.find !== "function") return null; return !!window.find(${JSON.stringify(text)}, false, ${forward ? "false" : "true"}, true, false, true, false); } catch { return null; } })()`;
    try {
      const found = await wc.executeJavaScript(script, true);
      if (found === null || found === undefined) return { ok: false, found: false, errorCode: "find_unsupported" };
      return { ok: true, found: found === true };
    } catch {
      return { ok: false, found: false, errorCode: "find_failed" };
    }
  }
  return { ok: false, found: false, errorCode: "find_unsupported" };
}

module.exports = { MAX_QUERY_CHARS, MAX_QUERY_BYTES, normalizeQuery, findInPageOn };
