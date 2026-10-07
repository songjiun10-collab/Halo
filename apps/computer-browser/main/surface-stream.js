"use strict";

// Live view of the page showing in a trusted window, pushed as JPEG frames.
// Needs a page engine that can stream (the CDP pages of the Chromium runtime);
// otherwise start() answers false and the renderer keeps polling stills.
// Read-only and window-scoped: the same pixels captureSurface already returns.

const { findShowingView } = require("./surface-snapshot");

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 70;
const MIN_FRAME_GAP_MS = 33;
const CHANNEL = "halo:surfaceFrame";

function createSurfaceStreams() {
  const streams = new Map();

  async function stop(win) {
    const stream = streams.get(win);
    if (!stream) return false;
    streams.delete(win);
    clearTimeout(stream.timer);
    await stream.page.stopScreencast?.().catch(() => undefined);
    return true;
  }

  async function start(win) {
    await stop(win);
    const view = findShowingView(win);
    const page = view?.webContents;
    if (!page || typeof page.startScreencast !== "function") return false;
    const stream = { page, timer: null, pending: null, last: 0 };
    const flush = () => {
      stream.timer = null;
      const frame = stream.pending;
      stream.pending = null;
      if (!frame || streams.get(win) !== stream || win.isDestroyed()) return;
      stream.last = Date.now();
      win.webContents.send(CHANNEL, { frame: `data:image/jpeg;base64,${frame}` });
    };
    streams.set(win, stream);
    try {
      await page.startScreencast({ maxWidth: MAX_WIDTH, quality: JPEG_QUALITY }, (data) => {
        // Keep only the newest frame so a slow renderer never builds a backlog.
        stream.pending = data;
        if (stream.timer) return;
        stream.timer = setTimeout(flush, Math.max(0, MIN_FRAME_GAP_MS - (Date.now() - stream.last)));
      });
    } catch {
      if (streams.get(win) === stream) streams.delete(win);
      return false;
    }
    win.once?.("closed", () => { void stop(win); });
    return true;
  }

  return Object.freeze({ start, stop });
}

module.exports = { createSurfaceStreams };
