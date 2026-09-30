"use strict";

// Native WebContentsViews sit above renderer DOM. A modal/chat must hide the
// selected native page, and switching tasks must hide every other page first.
// This module owns layout only; TaskController remains the execution authority.
const MIN_CHROME_HEIGHT = 94; // 42px tab strip + 52px toolbar, before outer padding.

class BrowserSurfaces {
  constructor(win, { isUserControlled = () => false } = {}) {
    this._win = win;
    this._isUserControlled = isUserControlled;
    this._views = new Map();
    this._request = null;
    this._resize = () => this._layout();
    win.on("resize", this._resize);
    win.once("closed", () => { this._request = null; this._views.clear(); });
  }

  register(taskId, view) {
    const old = this._views.get(taskId);
    if (old) { old.setVisible(false); this._win.contentView.removeChildView(old); }
    this._views.set(taskId, view);
    this._win.contentView.addChildView(view);
    view.setVisible(false);
    const guardInput = (event) => {
      if (this._request?.taskId !== taskId || !this._request?.bounds.visible || !this._isUserControlled(taskId)) {
        event.preventDefault();
      }
    };
    view.webContents.on("before-input-event", guardInput);
    view.webContents.on("before-mouse-event", guardInput);
    view.webContents.once("destroyed", () => {
      if (this._views.get(taskId) !== view) return;
      this._views.delete(taskId);
      if (!this._win.isDestroyed()) this._win.contentView.removeChildView(view);
    });
    this._layout();
  }

  setViewport(taskId, bounds) {
    if (!bounds || typeof bounds.visible !== "boolean" ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
        bounds.width < 0 || bounds.height < 0) throw new Error("Invalid viewport bounds");
    if (taskId !== null && !this._views.has(taskId) && bounds.visible) throw new Error("Task has no browser surface");
    this._request = { taskId, bounds: { ...bounds } };
    this._layout();
    return { visible: Boolean(taskId && bounds.visible && this._views.has(taskId)) };
  }

  _layout() {
    if (this._win.isDestroyed()) return;
    for (const view of this._views.values()) view.setVisible(false);
    const request = this._request;
    if (!request?.taskId || !request.bounds.visible) return;
    const view = this._views.get(request.taskId);
    if (!view || view.webContents.isDestroyed()) return;
    const [width, height] = this._win.getContentSize();
    const b = request.bounds;
    const x = Math.max(0, Math.min(width, Math.round(b.x)));
    const y = Math.max(MIN_CHROME_HEIGHT, Math.min(height, Math.round(b.y)));
    const right = Math.max(x, Math.min(width, Math.round(b.x + b.width)));
    const bottom = Math.max(y, Math.min(height, Math.round(b.y + b.height)));
    if (right <= x || bottom <= y) return;
    view.setBounds({ x, y, width: right - x, height: bottom - y });
    view.setVisible(true);
  }
}

module.exports = { BrowserSurfaces, MIN_CHROME_HEIGHT };
