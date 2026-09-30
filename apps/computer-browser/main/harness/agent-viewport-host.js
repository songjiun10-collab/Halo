"use strict";

// AgentViewportHost (P0 agent viewport / background isolation): a hidden,
// fixed-1440x900 WebContentsView that becomes the REAL execution target for
// a task's autonomous observe()/execute() calls -- separate from the
// per-task VISIBLE WebContentsView the user actually sees and drives via
// taskBrowserAction (main/index.js's makeHarnessBrowser). One hidden view is
// created per attached task, never one shared across the whole app, and it
// is torn down together with that task's own browser -- exactly the same
// lifecycle the visible view already has -- so it never accumulates across
// task history and never contends with a second, concurrently-running
// task's own hidden view.
//
// Scope note (chat 2026-09-28): the design doc's "one reusable agent view,
// shared for the active task" phrasing is deliberately NOT implemented
// literally here. TaskController's `browser` dependency is fixed at
// construction time with no runtime swap API, and task-controller.js is
// off-limits for this change -- a single view reassigned across tasks on
// foreground switch is not achievable without touching that file. Per-task
// scoping still gives every task's autonomous execution a real, isolated,
// fixed-viewport hidden view (the actual P0 requirement); it trades away the
// "single renderer total" memory optimization for zero cross-task
// contention and zero task-controller.js risk. If true global reuse is
// still wanted later, it needs either an explicit product decision that
// only one task executes autonomously at a time, or a narrow, reviewed
// addition to task-controller.js to let its browser dependency be swapped.
//
// How the agent page is exposed on takeover (visual re-navigation into a
// user-visible surface) is out of scope here, per instruction -- this file
// only makes autonomous execution real against the hidden view; it does not
// implement any "show agent page" action.

const { BrowserWindow, WebContentsView } = require("electron");
const { BrowserAdapter } = require("./browser-adapter");

const AGENT_WIDTH = 1440;
const AGENT_HEIGHT = 900;

// Mirrors main/index.js's makeHarnessBrowser hardening recipe exactly (deny
// popups, deny permissions, block non-http(s) navigation, block downloads) --
// the hidden agent view carries the identical untrusted-page threat model as
// the visible one, so it gets the identical fail-closed policy.
function applyBrowserHardening(webContents) {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  webContents.session.on("will-download", (event) => event.preventDefault());
}

class AgentViewportHost {
  constructor({ createWindow, createView } = {}) {
    this._createWindow = createWindow || ((opts) => new BrowserWindow(opts));
    this._createView = createView || ((opts) => new WebContentsView(opts));
    this._hosts = new Map(); // taskId -> {host, view, adapter}
    // Task 4 (multi-agent background runtime plan): keyed by childId, always
    // separate from `_hosts` -- a child's hidden view is never the same
    // record as its parent's own, even though both may share one partition.
    this._childHosts = new Map(); // childId -> {host, view, adapter}
  }

  // Shared by ensure()/ensureChild(): builds one hidden, fixed-size,
  // never-shown host + view pair on the given session partition.
  _createHiddenViewPair(partition) {
    const host = this._createWindow({
      show: false,
      width: AGENT_WIDTH,
      height: AGENT_HEIGHT,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition },
    });
    const view = this._createView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition },
    });
    applyBrowserHardening(view.webContents);
    host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
    view.setVisible(true);
    return { host, view };
  }

  // Synchronous by design: every makeBrowser(taskId) factory in this
  // codebase (main/index.js's makeHarnessBrowser) is called synchronously
  // from task-host.js's _attach(), with no await. Electron's
  // BrowserWindow/WebContentsView constructors are themselves synchronous;
  // only navigation is async, and BrowserAdapter's own
  // _ensureReadyForScriptExecution already tolerates a never-navigated view.
  //
  // Reuse: calling this again for a taskId that already has a hidden view
  // returns the SAME adapter (design doc: "reused only for the same active
  // task"), never a second renderer for that task.
  ensure(taskId) {
    const existing = this._hosts.get(taskId);
    if (existing) return existing.adapter;
    const partition = `halo-task-${taskId}`;
    // show:false + never calling .show()/.focus() anywhere in this class is
    // what keeps this window permanently invisible and non-focus-stealing --
    // Electron does not auto-show or auto-focus a show:false BrowserWindow
    // (verified by Codex's integration/agent-viewport-spike.js, read-only).
    const { host, view } = this._createHiddenViewPair(partition);
    const adapter = new BrowserAdapter({ view });
    this._hosts.set(taskId, { host, view, adapter });
    return adapter;
  }

  hasView(taskId) {
    return this._hosts.has(taskId);
  }

  // Task 4 (multi-agent background runtime plan): one hidden view per CHILD
  // agent -- its own WebContentsView/BrowserAdapter, never shared with the
  // parent's or a sibling's -- on the SAME session partition as the PARENT
  // task (`halo-task-${parentTaskId}`, not a partition of the child's own),
  // so the child inherits the parent's existing login/cookie state rather
  // than starting a fresh, logged-out session. `assignedOrigin` (the host-
  // derived normalized origin of the child's entryUrl) is passed straight
  // into BrowserAdapter so its redirect/navigate lock is active from
  // construction. permissionMode is always "observe" here, not a parameter
  // -- Global Constraints: child policy is exactly observe+scroll, and this
  // is the one call site that constructs a child's adapter.
  ensureChild(parentTaskId, childId, { assignedOrigin } = {}) {
    const existing = this._childHosts.get(childId);
    if (existing) return existing.adapter;
    const partition = `halo-task-${parentTaskId}`;
    const { host, view } = this._createHiddenViewPair(partition);
    const adapter = new BrowserAdapter({ view, assignedOrigin, permissionMode: "observe" });
    this._childHosts.set(childId, { host, view, adapter });
    return adapter;
  }

  hasChildView(childId) {
    return this._childHosts.has(childId);
  }

  // Tears down BOTH the BrowserAdapter (removes its page listeners, closes
  // the webContents) AND the hidden host BrowserWindow that contains it.
  // The host is destroyed even if adapter.dispose() throws -- a failed
  // adapter teardown must never leak the underlying hidden window/renderer.
  async _disposeEntry(map, id) {
    const entry = map.get(id);
    if (!entry) return;
    map.delete(id);
    try {
      await entry.adapter.dispose?.();
    } finally {
      try {
        entry.host.destroy();
      } catch {
        // Best-effort teardown; a window already gone is not a safety issue.
      }
    }
  }

  async dispose(taskId) {
    await this._disposeEntry(this._hosts, taskId);
  }

  async disposeChild(childId) {
    await this._disposeEntry(this._childHosts, childId);
  }

  async disposeAll() {
    await Promise.allSettled([
      ...[...this._hosts.keys()].map((taskId) => this.dispose(taskId)),
      ...[...this._childHosts.keys()].map((childId) => this.disposeChild(childId)),
    ]);
  }
}

// Composes a single `browser` object satisfying the FULL contract
// task-controller.js/task-host.js expect from their one `browser` dependency
// (observe/execute/userNavigate/dispose/onChange/getBrowserSnapshot), by
// routing autonomous actions to the hidden agent adapter and every
// user-facing/manual concern to the existing visible adapter -- statically,
// by construction, never conditionally at call time:
//
//   - observe/execute: task-controller.js's autonomous run loop calls these
//     ONLY from its own dispatch path (task-controller.js:684,875) -- never
//     from userNavigate(). Routing them to `agentAdapter` makes hidden-view-
//     backed autonomous execution the actual behavior, not an unused
//     parallel resource: this is the P0 requirement.
//   - userNavigate: task-controller.js only ever reaches this method when
//     isUserControlled() is already true (i.e. after takeOver()/pause()),
//     and rejects before calling it otherwise (task-controller.js:207,
//     unmodified). Routing it to `visibleAdapter` means a manual user
//     action (taskBrowserAction) can never operate on a view the user
//     cannot see -- there is no shared code path that could leak it to the
//     hidden adapter instead. This is the fail-closed definition requested
//     for "which view does a user action manipulate."
//   - getBrowserSnapshot/onChange: task-host.js forwards these straight into
//     the existing halo:taskEvent `browser` field and getTaskBrowser() IPC
//     response the renderer already consumes. Routing them to
//     `visibleAdapter` keeps that existing contract byte-for-byte identical
//     to today: the renderer keeps seeing the user's own visible page, never
//     a live mirror of the agent's hidden page (design doc: "must not claim
//     DOM/runtime state is mirrored").
//   - dispose: tears down both surfaces. `disposeAgent` (when provided) is
//     used instead of calling `agentAdapter.dispose()` directly so the
//     caller can also destroy the hidden BrowserWindow container
//     (AgentViewportHost.dispose(taskId)), not just the adapter.
function makeDualSurfaceBrowser({ agentAdapter, visibleAdapter, disposeAgent }) {
  if (!agentAdapter || !visibleAdapter) {
    throw new TypeError("makeDualSurfaceBrowser requires agentAdapter and visibleAdapter");
  }
  return {
    observe: (...args) => agentAdapter.observe(...args),
    execute: (...args) => agentAdapter.execute(...args),
    setPermissionMode: (mode) => {
      agentAdapter.setPermissionMode?.(mode);
      visibleAdapter.setPermissionMode?.(mode);
    },
    userNavigate: (...args) => visibleAdapter.userNavigate(...args),
    fillCredential: (...args) => visibleAdapter.fillCredential(...args),
    getBrowserSnapshot: (...args) => visibleAdapter.getBrowserSnapshot(...args),
    onChange: (...args) => visibleAdapter.onChange(...args),
    dispose: async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => (disposeAgent ? disposeAgent() : agentAdapter.dispose?.())),
        Promise.resolve().then(() => visibleAdapter.dispose?.()),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

module.exports = {
  AgentViewportHost,
  makeDualSurfaceBrowser,
  applyBrowserHardening,
  AGENT_WIDTH,
  AGENT_HEIGHT,
};
