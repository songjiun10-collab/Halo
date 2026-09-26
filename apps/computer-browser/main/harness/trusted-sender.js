"use strict";

// isTrustedSender (design doc section 7): "IPC sender는 해당 로컬 shell
// webContents의 main frame·로컬 UI URL과 일치해야 한다... remote
// WebContents에는 preload/Node/이 IPC를 노출하지 않는다." Wired into
// main/ipc.js for the harness's sensitive channels (goal amendment,
// approve/deny, confirmCriterion) -- the legacy start/pause/resume/stop
// channels predate this check and are unchanged.
//
// This is deliberately a pure function over plain event/window shapes (an
// Electron IpcMainInvokeEvent has a `.senderFrame` WebFrameMain; a
// BrowserWindow exposes `.isDestroyed()`/`.webContents.mainFrame`) so it can
// be unit-tested with no real Electron, and so the real objects Electron
// hands ipcMain.handle() need no adaptation to flow through it.
//
// What this catches: a subframe of the trusted shell renderer (e.g. a
// compromised or unexpectedly embedded remote iframe) shares the same
// webContents/process as the trusted top-level page but is a DIFFERENT
// frame object with a different (non-local) URL -- comparing the frame
// object identity against the window's own mainFrame, not just the
// webContents, is what rejects it. It does not defend against a compromised
// Electron main process itself (see approver_service.py's own docstring on
// this same boundary) -- only against content loaded into a frame that was
// never meant to hold this capability.
function isTrustedSender(event, win) {
  if (!event || !event.senderFrame) return false;
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
  const mainFrame = win.webContents && win.webContents.mainFrame;
  if (!mainFrame) return false;
  if (event.senderFrame !== mainFrame) return false;
  if (typeof mainFrame.url === "string" && !mainFrame.url.startsWith("file://")) return false;
  return true;
}

module.exports = { isTrustedSender };
