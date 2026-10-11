"use strict";

// Live view of the page showing in a trusted window, pushed as JPEG frames.
// Needs a page engine that can stream (the CDP pages of the Chromium runtime);
// otherwise start() answers false and the renderer keeps polling stills.
// Read-only and window-scoped: the same pixels captureSurface already returns.

const { findShowingView } = require("./surface-snapshot");
const { startSharpScreencast } = require("./sharp-screencast");

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 70;
const STILL_WIDTH = 3200;
const STILL_QUALITY = 80;
const MIN_FRAME_GAP_MS = 33;
const CHANNEL = "halo:surfaceFrame";
const AGENT_CHANNEL = "halo:agentFrame";

function createSurfaceStreams() {
  const streams = new Map();

  async function stop(win) {
    const stream = streams.get(win);
    if (!stream) return false;
    streams.delete(win);
    clearTimeout(stream.timer);
    await stream.stopCast?.();
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
      const stopCast = await startSharpScreencast(page, { stillWidth: STILL_WIDTH, stillQuality: STILL_QUALITY, plain: { maxWidth: MAX_WIDTH, quality: JPEG_QUALITY } }, (data) => {
        // Keep only the newest frame so a slow renderer never builds a backlog.
        stream.pending = data;
        if (stream.timer) return;
        stream.timer = setTimeout(flush, Math.max(0, MIN_FRAME_GAP_MS - (Date.now() - stream.last)));
      });
      stream.stopCast = stopCast;
    } catch {
      if (streams.get(win) === stream) streams.delete(win);
      return false;
    }
    win.once?.("closed", () => { void stop(win); });
    return true;
  }

  // Task-scoped, read-only mirror of the agent's hidden page. `open(taskId, onFrame)`
  // is the host's openFrameStream: it resolves to a stop function, or null when the
  // engine cannot stream (the renderer then polls stills).
  const agentStreams = new Map();

  async function stopAgent(win) {
    const stream = agentStreams.get(win);
    if (!stream) return false;
    agentStreams.delete(win);
    clearTimeout(stream.timer);
    await stream.stop?.().catch(() => undefined);
    return true;
  }

  async function startAgent(win, taskId, open) {
    await stopAgent(win);
    if (typeof taskId !== "string" || !taskId || typeof open !== "function") return false;
    const stream = { taskId, timer: null, pending: null, last: 0, stop: null };
    agentStreams.set(win, stream);
    const flush = () => {
      stream.timer = null;
      const frame = stream.pending;
      stream.pending = null;
      if (!frame || agentStreams.get(win) !== stream || win.isDestroyed()) return;
      stream.last = Date.now();
      win.webContents.send(AGENT_CHANNEL, { taskId, frame: `data:image/jpeg;base64,${frame}` });
    };
    let stop = null;
    try {
      stop = await open(taskId, (data) => {
        stream.pending = data;
        if (stream.timer) return;
        stream.timer = setTimeout(flush, Math.max(0, MIN_FRAME_GAP_MS - (Date.now() - stream.last)));
      });
    } catch { stop = null; }
    if (typeof stop !== "function") {
      if (agentStreams.get(win) === stream) agentStreams.delete(win);
      return false;
    }
    if (agentStreams.get(win) !== stream) { await stop().catch(() => undefined); return false; }
    stream.stop = stop;
    win.once?.("closed", () => { void stopAgent(win); });
    return true;
  }

  return Object.freeze({ start, stop, startAgent, stopAgent });
}

module.exports = { createSurfaceStreams };
