"use strict";

// The Task Branch runner (see task-branch-manager.js): reads each offered page
// in its own hidden, observe-only child surface and reports a short excerpt.
// It never clicks, types or submits; the only thing it can do to a page is
// load it and read it. Each step gets a fresh surface that is always disposed.

const EXCERPT_CHARS = 500;

function createBranchRunner({ makeBrowser }) {
  if (typeof makeBrowser !== "function") throw new TypeError("createBranchRunner requires makeBrowser");
  return async function runBranch({ branchId, steps, signal, report }) {
    for (let index = 0; index < steps.length; index += 1) {
      if (signal.aborted) return;
      const step = steps[index];
      const origin = new URL(step.url).origin;
      let browser = null;
      try {
        browser = makeBrowser(`${branchId}-${index}`, origin);
        await browser.userNavigate({ type: "navigate", url: step.url });
        if (signal.aborted) return;
        const observation = await browser.observe({ signal });
        if (signal.aborted) return;
        const title = typeof observation?.title === "string" ? observation.title : "";
        const body = typeof observation?.text === "string" ? observation.text : "";
        const excerpt = `${title ? `${title}: ` : ""}${body}`.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
        report({ url: typeof observation?.url === "string" ? observation.url : step.url, text: excerpt ? `${step.purpose ? `${step.purpose} — ` : ""}${excerpt}` : "" });
      } catch {
        // An unreachable page is simply not reported; the branch moves on.
      } finally {
        try { await browser?.dispose?.(); } catch { /* best effort teardown */ }
      }
    }
  };
}

module.exports = { createBranchRunner, EXCERPT_CHARS };
