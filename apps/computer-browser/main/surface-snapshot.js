"use strict";

// A native WebContentsView always draws above the renderer DOM, so the
// renderer hides the page while a Halo overlay is open. Before hiding it, it
// asks for a still image of whatever page is showing and paints that in the
// page slot instead, so the page does not vanish behind the overlay.
//
// Read-only: nothing here navigates, clicks or exposes page content beyond
// the pixels already on the user's screen, and only the trusted Halo window
// can ask (main/ipc.js).

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 70;
const { captureFrameJpeg } = require("./harness/frame-capture");

function isShowing(view) {
  if (!view?.webContents || view.webContents.isDestroyed?.()) return false;
  if (typeof view.getVisible === "function" && !view.getVisible()) return false;
  const bounds = view.getBounds?.();
  // The direct browser view is parked at zero size rather than hidden.
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

function findShowingView(win) {
  if (!win || win.isDestroyed()) return null;
  return (win.contentView?.children ?? []).find(isShowing) ?? null;
}

async function captureVisibleSurface(win) {
  if (!win || win.isDestroyed()) return null;
  const view = (win.contentView?.children ?? []).find(isShowing);
  if (!view) return null;
  try {
    const jpeg = await captureFrameJpeg(view.webContents, { maxWidth: MAX_WIDTH, quality: JPEG_QUALITY });
    if (!jpeg || win.isDestroyed() || !(win.contentView?.children ?? []).includes(view) || !isShowing(view)) return null;
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

module.exports = { captureVisibleSurface, findShowingView };
