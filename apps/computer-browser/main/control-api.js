"use strict";

const { randomUUID } = require("crypto");
const { WebContentsView } = require("electron");
const { clampBrowserBounds } = require("../shared/clamp-bounds");
const { requestDecision } = require("./approver-client");

const URL_LIKE = /^https?:\/\/\S+$/i;
const MAX_PROMPT_LENGTH = 2000;
const MAX_TIMELINE = 200;
const MAX_QUEUE = 50;

/**
 * The executor. Owns the real embedded Chromium surface (WebContentsView)
 * and is the only thing in this app allowed to call navigate/click/type
 * against it. Every action an agent decides on its own (as opposed to a
 * human pressing a UI button) is routed through performGatedAction(), which
 * asks the separate approver process for a decision before anything runs.
 *
 * IMPORTANT: startTask() below runs one illustrative, hard-coded step (URL
 * extraction from the prompt) through the real ALLOW/REVIEW/DENY pipeline
 * against a real embedded page. It is NOT a multi-step LLM-driven planner --
 * wiring an actual agent loop that decides a sequence of clicks/reads is
 * future work (see docs/superpowers/specs/2026-09-26-computer-use-browser-design.md,
 * "정직한 한계"). What's real here is the approval boundary and the browser
 * control surface, not an autonomous browsing brain.
 */
class ControlApi {
  constructor({ window, socketPath }) {
    this._window = window;
    this._socketPath = socketPath;
    this._view = null;
    this._hasPage = false;
    this._page = { url: "", title: "", loadState: "idle", canGoBack: false, canGoForward: false, hasPage: false };
    this._task = { id: null, state: "idle" };
    this._approvalQueue = [];
    this._timeline = [];
    this._listeners = new Set();
    this._pendingBounds = null;
    this._lastBoundsKey = null;
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A listener throwing must never break the executor's own state machine.
      }
    }
  }

  getSnapshot() {
    return {
      page: { ...this._page },
      task: { ...this._task },
      // Only public fields cross the IPC boundary. Each queue item also
      // carries a private _execute closure (the deferred action to run on
      // approve()); that function reference must never be spread into the
      // structured-clone payload Electron sends to the renderer, or
      // ipcMain.handle throws a serialization error.
      approvalQueue: this._approvalQueue.map(({ id, summary, origin, action, reason, createdAt }) => ({
        id, summary, origin, action, reason, createdAt,
      })),
      timeline: this._timeline.map((item) => ({ ...item })),
    };
  }

  _pushTimeline(kind, message, status = "info") {
    this._timeline.push({ id: randomUUID(), at: new Date().toISOString(), kind, message, status });
    if (this._timeline.length > MAX_TIMELINE) this._timeline.shift();
  }

  _ensureView() {
    if (this._view) return this._view;
    this._view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    this._window.contentView.addChildView(this._view);
    this._view.setVisible(false);
    // A bounds update can arrive (from the renderer's ResizeObserver) before
    // any tab exists, when there is no view yet to apply it to. Without this,
    // that update is lost and a freshly created view sits at Electron's
    // default {0,0,0,0} bounds until the next *different* bounds message —
    // which may never come if the layout hasn't changed.
    if (this._pendingBounds) {
      this._view.setBounds(this._pendingBounds);
      this._lastBoundsKey = JSON.stringify(this._pendingBounds);
    }
    const wc = this._view.webContents;
    wc.on("did-start-navigation", () => this._syncPageState({ loadState: "loading" }));
    wc.on("did-navigate", (_e, url) => this._syncPageState({ url, loadState: "ready" }));
    wc.on("did-navigate-in-page", (_e, url) => this._syncPageState({ url }));
    wc.on("page-title-updated", (_e, title) => this._syncPageState({ title }));
    wc.on("did-fail-load", (_e, code, description) => {
      if (code !== -3) this._pushTimeline("navigation", `Load failed: ${description}`, "error");
      this._syncPageState({ loadState: "error" });
    });
    return this._view;
  }

  _syncPageState(patch) {
    const wc = this._view && this._view.webContents;
    this._page = {
      ...this._page,
      ...patch,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : this._page.canGoBack,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : this._page.canGoForward,
      hasPage: this._hasPage,
    };
    this._emit();
  }

  // --- Free actions: direct human intent via UI controls. No approval gate. ---

  async navigate(url) {
    if (typeof url !== "string" || url.trim().length === 0 || url.length > 8192) {
      throw new RangeError("navigate requires a non-empty, bounded URL string");
    }
    const target = URL_LIKE.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    this._ensureView();
    this._hasPage = true;
    this._view.setVisible(true);
    await this._view.webContents.loadURL(target);
    this._pushTimeline("navigation", `Navigated to ${target}`, "info");
    return this.getSnapshot();
  }

  async goBack() {
    if (this._view && this._view.webContents.navigationHistory.canGoBack()) {
      this._view.webContents.navigationHistory.goBack();
    }
    return this.getSnapshot();
  }

  async goForward() {
    if (this._view && this._view.webContents.navigationHistory.canGoForward()) {
      this._view.webContents.navigationHistory.goForward();
    }
    return this.getSnapshot();
  }

  async reload() {
    if (this._view) this._view.webContents.reload();
    return this.getSnapshot();
  }

  async newTab() {
    // Single-surface v1: "new tab" resets the one embedded view to a blank
    // page. Real multi-tab support is future work.
    this._ensureView();
    this._hasPage = false;
    this._view.setVisible(false);
    this._page = { url: "", title: "", loadState: "idle", canGoBack: false, canGoForward: false, hasPage: false };
    this._pushTimeline("navigation", "Opened a new tab", "info");
    this._emit();
    return this.getSnapshot();
  }

  setBrowserBounds(bounds) {
    const [contentWidth, contentHeight] = this._window.getContentSize();
    const clamped = clampBrowserBounds(bounds, contentWidth, contentHeight);
    // Always remember the latest requested bounds, even with no view yet --
    // _ensureView() applies this the moment a view is created. The
    // same-key skip below only guards against redundant native setBounds()
    // calls once we actually have a view to apply them to.
    this._pendingBounds = clamped;
    if (!this._view) return;
    const key = JSON.stringify(clamped);
    if (key === this._lastBoundsKey) return;
    this._lastBoundsKey = key;
    this._view.setBounds(clamped);
  }

  // --- Gated pipeline ---

  async performGatedAction(descriptor, execute) {
    // No `effect` field here: whether an action counts as a policy-relevant
    // effect (e.g. submit_form -> external_write) is derived server-side from
    // the action mapping table in approver_service.py, not taken from the
    // executor's own say-so -- an executor that could self-declare "no
    // effect" for something that really does write externally would defeat
    // the whole point of an independent approver.
    const decision = await requestDecision(this._socketPath, {
      request_id: randomUUID(),
      action: descriptor.action,
      origin: descriptor.origin || "",
      summary: descriptor.summary,
      self_provenance: descriptor.selfProvenance,
      source: descriptor.source,
      target_scope: descriptor.targetScope ?? null,
      contains_secret: Boolean(descriptor.containsSecret),
    });

    if (decision.decision === "allow") {
      this._pushTimeline(descriptor.action, descriptor.summary, "allow");
      await execute();
      return "allow";
    }
    if (decision.decision === "review") {
      if (this._approvalQueue.length >= MAX_QUEUE) {
        this._pushTimeline(descriptor.action, `${descriptor.summary} (queue full, denied)`, "deny");
        return "deny";
      }
      this._approvalQueue.push({
        id: descriptor.requestId,
        summary: descriptor.summary,
        origin: descriptor.origin || "",
        action: descriptor.action,
        reason: (decision.reasons || []).join("; "),
        createdAt: new Date().toISOString(),
        _execute: execute,
      });
      this._task = { ...this._task, state: "awaiting_approval" };
      this._emit();
      return "review";
    }
    this._pushTimeline(descriptor.action, `${descriptor.summary} — ${(decision.reasons || []).join("; ")}`, "deny");
    return decision.decision;
  }

  async startTask(prompt) {
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      throw new RangeError(`startTask requires a prompt of 1..${MAX_PROMPT_LENGTH} characters`);
    }
    this._task = { id: randomUUID(), state: "running" };
    this._pushTimeline("task", `Task started: ${prompt.slice(0, 120)}`, "info");
    this._emit();

    const trimmed = prompt.trim();
    if (URL_LIKE.test(trimmed)) {
      const requestId = randomUUID();
      const outcome = await this.performGatedAction(
        {
          requestId,
          action: "navigate",
          origin: this._page.url || "",
          summary: `Agent proposes to navigate to ${trimmed}`,
          selfProvenance: "trusted",
          source: "user_prompt",
          targetScope: "external",
        },
        () => this.navigate(trimmed),
      );
      if (outcome !== "review") this._task = { ...this._task, state: "completed" };
      this._emit();
      return this.getSnapshot();
    }

    this._pushTimeline(
      "task",
      "Prompt is not a directly actionable URL. A multi-step planning loop is not implemented yet — see design doc.",
      "info",
    );
    this._task = { ...this._task, state: "completed" };
    this._emit();
    return this.getSnapshot();
  }

  async pauseTask() {
    if (["running", "awaiting_approval"].includes(this._task.state)) {
      this._task = { ...this._task, state: "paused" };
      this._pushTimeline("task", "Task paused", "info");
      this._emit();
    }
    return this.getSnapshot();
  }

  async resumeTask() {
    if (this._task.state === "paused") {
      this._task = { ...this._task, state: "running" };
      this._pushTimeline("task", "Task resumed", "info");
      this._emit();
    }
    return this.getSnapshot();
  }

  async stopTask() {
    this._approvalQueue = [];
    this._task = { ...this._task, state: "stopped" };
    this._pushTimeline("task", "Task stopped", "info");
    this._emit();
    return this.getSnapshot();
  }

  async approve(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    this._pushTimeline(item.action, `${item.summary} (approved by reviewer)`, "allow");
    await item._execute();
    if (this._approvalQueue.length === 0) this._task = { ...this._task, state: "completed" };
    this._emit();
    return this.getSnapshot();
  }

  async deny(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    this._pushTimeline(item.action, `${item.summary} (denied by reviewer)`, "deny");
    if (this._approvalQueue.length === 0) this._task = { ...this._task, state: "completed" };
    this._emit();
    return this.getSnapshot();
  }
}

module.exports = { ControlApi };
