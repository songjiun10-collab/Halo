"use strict";

// Text-selection read + copy for the human Mod+C path and the agent `copy`
// action, shared so the two surfaces cannot drift. Reading uses
// window.getSelection() in the page's main world; writing goes to the OS
// clipboard through the injected writer (system-clipboard.js in production),
// so tests never touch the user's real clipboard.

const MAX_SELECTION_CHARS = 1024 * 1024;
const MAX_RETURN_CHARS = 16384;

async function readSelection(wc) {
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) {
    return { ok: false, errorCode: "selection_target_unavailable" };
  }
  if (typeof wc.executeJavaScript !== "function") return { ok: false, errorCode: "selection_unsupported" };
  const script = `(() => { try { if (typeof window.getSelection !== "function") return null; return String(window.getSelection() || "").slice(0, ${MAX_SELECTION_CHARS}); } catch { return null; } })()`;
  try {
    const text = await wc.executeJavaScript(script, true);
    if (text === null || text === undefined) return { ok: false, errorCode: "selection_unsupported" };
    return { ok: true, text: String(text) };
  } catch {
    return { ok: false, errorCode: "selection_failed" };
  }
}

// Returns { ok, chars, text } where text is the copied selection truncated to
// MAX_RETURN_CHARS (the planner needs it to paste elsewhere; the clipboard
// itself holds the bounded full selection).
async function copySelectionOn(wc, writeText) {
  const selection = await readSelection(wc);
  if (!selection.ok) return { ok: false, chars: 0, errorCode: selection.errorCode };
  const text = selection.text;
  if (text.length === 0) return { ok: true, chars: 0, text: "" };
  if (typeof writeText !== "function" || !writeText(text)) return { ok: false, chars: 0, errorCode: "clipboard_write_failed" };
  return { ok: true, chars: text.length, text: text.slice(0, MAX_RETURN_CHARS) };
}

module.exports = { MAX_SELECTION_CHARS, MAX_RETURN_CHARS, readSelection, copySelectionOn };
