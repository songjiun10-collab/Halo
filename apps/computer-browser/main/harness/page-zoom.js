"use strict";

// Page zoom for the human browser (Mod+/Mod-/Mod+0) and the agent `zoom`
// action, shared so the two surfaces cannot drift.
//
// Mechanism: Chromium's CSS `zoom` property on the root element. Verified
// 2026-10-10 against the real TrialLean headless_shell:
//   - layout scales (getBoundingClientRect scales with the page),
//   - hit-testing scales the same way, so a forwarded click at normalized
//     coordinates still lands on the element the human/agent sees,
//   - getBoundingClientRect / innerWidth stay mutually consistent, so
//     observation geometry and click_at normalization remain exact,
//   - Page.captureScreenshot and the screencast show the zoomed rendering.
// Emulation.setPageScaleFactor was measured as a NO-OP for captures in this
// build, and Emulation.setDeviceMetricsOverride reflow needs the whole input /
// capture pipeline rewritten around a shrinking CSS viewport -- CSS zoom does
// not. Trade-off, stated honestly: this mutates the page's root style, and a
// page that replaces the root element's style attribute can drop the zoom; the
// human side re-applies on navigation, the agent side does not persist it.

const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

// Snap an arbitrary level to the step ladder inside the supported range.
function normalizeZoom(level) {
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  if (level < MIN_ZOOM || level > MAX_ZOOM) return null;
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) if (Math.abs(step - level) < Math.abs(best - level)) best = step;
  return best;
}

// Walk the ladder; at either end the end step is returned (like a browser).
function nextZoom(current, direction) {
  const from = normalizeZoom(current) ?? 1;
  if (direction === "reset") return 1;
  const index = ZOOM_STEPS.indexOf(from);
  if (direction === "in") return ZOOM_STEPS[Math.min(index + 1, ZOOM_STEPS.length - 1)];
  if (direction === "out") return ZOOM_STEPS[Math.max(index - 1, 0)];
  return null;
}

function zoomScript(level) {
  // Setting the property and reading it back distinguishes a real apply from a
  // page that cannot run scripts; the value is a constant from the ladder.
  return `(() => { try { document.documentElement.style.zoom = ${JSON.stringify(String(level))}; return document.documentElement.style.zoom || "1"; } catch { return null; } })()`;
}

async function applyPageZoom(wc, level) {
  const target = normalizeZoom(level);
  if (target === null) return { ok: false, level: null, errorCode: "invalid_zoom_level" };
  if (!wc || (typeof wc.isDestroyed === "function" && wc.isDestroyed())) {
    return { ok: false, level: null, errorCode: "zoom_target_unavailable" };
  }
  if (typeof wc.executeJavaScript !== "function") return { ok: false, level: null, errorCode: "zoom_unsupported" };
  try {
    const applied = await wc.executeJavaScript(zoomScript(target), true);
    if (applied === null || applied === undefined) return { ok: false, level: null, errorCode: "zoom_unsupported" };
    return { ok: true, level: target };
  } catch {
    return { ok: false, level: null, errorCode: "zoom_failed" };
  }
}

// Resolve a zoom action ({direction} or {level}) to a concrete level against
// the current one. Returns null for malformed actions.
function resolveZoomAction(action, current = 1) {
  if (typeof action?.direction === "string") {
    if (!["in", "out", "reset"].includes(action.direction)) return null;
    if (action.level !== undefined) return null; // exactly one of the two
    return nextZoom(current, action.direction);
  }
  if (action?.level !== undefined) return normalizeZoom(action.level);
  return null;
}

module.exports = { ZOOM_STEPS, MIN_ZOOM, MAX_ZOOM, normalizeZoom, nextZoom, applyPageZoom, resolveZoomAction };
