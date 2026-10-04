"use strict";

// Reads what a user tab shows once it has loaded and hands it to the activity
// journal. Runs only for the user's own tabs (never an agent's surface), only
// when Context Awareness is on, and never throws into the page lifecycle.
const READ_PAGE = `(() => {
  const sensitive = !!document.querySelector('input[type="password"], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="ssn" i]');
  if (sensitive) return { hasSensitiveField: true };
  const root = document.querySelector("article, main") || document.body;
  return { hasSensitiveField: false, excerpt: ((root && root.innerText) || "").slice(0, 1500) };
})()`;
const MIN_REPEAT_MS = 10_000;

function createPageVisitSink({ isEnabled, record, now = () => Date.now() }) {
  const lastSeen = new Map();
  return async function onPageVisit(webContents) {
    try {
      if (!(await isEnabled())) return;
      const url = webContents.getURL();
      const at = now();
      if (at - (lastSeen.get(url) ?? -Infinity) < MIN_REPEAT_MS) return;
      lastSeen.set(url, at);
      if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value);
      const page = await webContents.executeJavaScript(READ_PAGE);
      await record({ url, title: webContents.getTitle(), excerpt: page?.excerpt, hasSensitiveField: page?.hasSensitiveField === true });
    } catch { /* Context Awareness is best-effort and must never disturb browsing. */ }
  };
}

module.exports = { createPageVisitSink };
