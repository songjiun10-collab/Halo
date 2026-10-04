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

function isShowing(view) {
  if (!view?.webContents || view.webContents.isDestroyed?.()) return false;
  if (typeof view.getVisible === "function" && !view.getVisible()) return false;
  const bounds = view.getBounds?.();
  // The direct browser view is parked at zero size rather than hidden.
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

async function captureVisibleSurface(win) {
  if (!win || win.isDestroyed()) return null;
  const view = (win.contentView?.children ?? []).find(isShowing);
  if (!view) return null;
  try {
    let image = await view.webContents.capturePage();
    if (!image || image.isEmpty()) return null;
    if (image.getSize().width > MAX_WIDTH) image = image.resize({ width: MAX_WIDTH, quality: "good" });
    return `data:image/jpeg;base64,${image.toJPEG(JPEG_QUALITY).toString("base64")}`;
  } catch {
    return null;
  }
}

module.exports = { captureVisibleSurface };
