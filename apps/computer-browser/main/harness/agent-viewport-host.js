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

const { installAgentRequestFilter } = require("./agent-request-filter");
const { BrowserWindow, WebContentsView } = require("../desktop-runtime");
const { createHash } = require("node:crypto");
const { BrowserAdapter } = require("./browser-adapter");
const { createScreenshotAttachment } = require("./computer-use-contract");
const { captureFrameJpeg } = require("./frame-capture");
const { buildScreenMap } = require("./screen-map");
const { ParkableView, SurfacePool, wakeOnUse } = require("./renderer-lifecycle");

const AGENT_WIDTH = 1440;
const AGENT_HEIGHT = 900;
const AGENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function agentBrowserPartition(agentId) {
  if (typeof agentId !== "string" || !AGENT_UUID_RE.test(agentId)) {
    const error = new TypeError("Agent browser profile owner must be a host-validated UUID");
    error.code = "invalid_agent_profile";
    throw error;
  }
  return `persist:halo-agent-${agentId}`;
}

function childBrowserPartition(childId) {
  if (typeof childId !== "string" || childId.length === 0 || childId.length > 256) {
    const error = new TypeError("Child browser profile owner must be a non-empty host identity");
    error.code = "invalid_child_profile";
    throw error;
  }
  // A non-persistent partition keeps sibling/parent cookies and storage
  // separate without leaving child credentials on disk after app shutdown.
  // Hash the host identity so it cannot inject Electron partition syntax.
  const digest = createHash("sha256").update(childId, "utf8").digest("hex");
  return `halo-child-${digest}`;
}

function agentOwnerFromOptions(options) {
  if (options === undefined) return null;
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some((key) => key !== "agentId")) {
    const error = new TypeError("Agent viewport options contain unknown fields");
    error.code = "invalid_agent_profile";
    throw error;
  }
  if (!Object.hasOwn(options, "agentId")) return null;
  agentBrowserPartition(options.agentId);
  return options.agentId;
}

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
  installAgentRequestFilter(webContents.session);
}

// A change fingerprint of a downscaled copy of the page. It is cheap enough to
// run every poll and only decides whether to repeat the JPEG encode.
function frameFingerprint(image) {
  const small = image.resize({ width: 64, quality: "good" });
  return createHash("sha1").update(small.toBitmap()).digest("hex");
}

class AgentViewportHost {
  // `createPage(partition)` swaps the whole Electron window/view pair for an
  // externally owned browser page (the Chromium engine). The page must already
  // enforce the hardening below itself; it is built synchronously and may finish
  // starting in the background.
  constructor({ createWindow, createView, createPage, lifecycle, onIdle } = {}) {
    const onIdleBrowser = typeof onIdle === "function" ? onIdle : undefined;
    // `lifecycle` (pool policy, or true for defaults) lets idle agent surfaces freeze and be
    // discarded under a live-renderer cap; off by default so a plain host is unchanged.
    this._pool = lifecycle ? new SurfacePool(lifecycle === true ? {} : lifecycle, { onIdle: onIdleBrowser }) : null;
    this._pool?.start();
    this._createPage = typeof createPage === "function" ? createPage : null;
    this._createWindow = createWindow || ((opts) => new BrowserWindow(opts));
    this._createView = createView || ((opts) => new WebContentsView(opts));
    this._hosts = new Map(); // taskId -> {host, view, adapter}
    // Task 4 (multi-agent background runtime plan): keyed by childId, always
    // separate from `_hosts` -- a child's hidden view and session partition
    // are never shared with its parent or a sibling.
    this._childHosts = new Map(); // childId -> {host, view, adapter}
    // One hidden window holds every agent view. A BrowserWindow per view cost a
    // window and a webContents each; the views stay independent renderers, so
    // only the container is shared, and it is destroyed with its last view.
    this._sharedHost = null;
    this._sharedViewCount = 0;
    this._lastFrames = new Map(); // taskId -> {fingerprint, dataUrl}
  }

  _acquireHiddenHost() {
    const sh = this._sharedHost;
    const gone = !sh || sh.destroyed === true || sh.isDestroyed?.() === true;
    if (gone) {
      this._sharedHost = this._createWindow({
        show: false,
        width: AGENT_WIDTH,
        height: AGENT_HEIGHT,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this._sharedViewCount = 0;
    }
    this._sharedViewCount += 1;
    return this._sharedHost;
  }

  _releaseHiddenHost(host, view) {
    try {
      host.contentView.removeChildView?.(view);
    } catch {
      // The view may already be gone with its webContents.
    }
    if (host !== this._sharedHost) {
      try { host.destroy(); } catch { /* best effort */ }
      return;
    }
    this._sharedViewCount -= 1;
    if (this._sharedViewCount <= 0) {
      this._sharedHost = null;
      this._sharedViewCount = 0;
      try {
        host.destroy();
      } catch {
        // Best-effort teardown; a window already gone is not a safety issue.
      }
    }
  }

  // Shared by ensure()/ensureChild(): builds one hidden, fixed-size,
  // never-shown view on the shared hidden window, on the given session partition.
  _createHiddenViewPair(partition) {
    if (!this._pool) return this._rawViewPair(partition);
    const view = new ParkableView({
      lazy: true,
      getSession: () => require("../desktop-runtime").session.fromPartition(partition),
      width: AGENT_WIDTH,
      height: AGENT_HEIGHT,
      create: () => {
        const pair = this._rawViewPair(partition);
        return { view: pair.view, dispose: () => this._releaseHiddenHost(pair.host, pair.view) };
      },
    });
    return { host: { contentView: { removeChildView() {} }, destroy() {} }, view };
  }

  async relieveMemory(level) {
    return this._pool ? this._pool.relieve(level) : 0;
  }

  surfaceCounts() {
    return this._pool ? this._pool.counts() : null;
  }

  _rawViewPair(partition) {
    // A null page means the Electron engine is selected right now.
    const page = this._createPage ? this._createPage(partition) : null;
    if (page) return { host: { contentView: { removeChildView() {} }, destroy() {} }, view: page };
    const host = this._acquireHiddenHost();
    const view = this._createView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition, offscreen: true },
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
  ensure(taskId, options = undefined) {
    const agentId = agentOwnerFromOptions(options);
    const existing = this._hosts.get(taskId);
    if (existing) {
      if (existing.agentId !== agentId) {
        const error = new Error("task browser profile binding changed after view construction");
        error.code = "agent_profile_binding_changed";
        throw error;
      }
      return existing.adapter;
    }
    const partition = agentId ? agentBrowserPartition(agentId) : `halo-task-${taskId}`;
    // show:false + never calling .show()/.focus() anywhere in this class is
    // what keeps this window permanently invisible and non-focus-stealing --
    // Electron does not auto-show or auto-focus a show:false BrowserWindow
    // (verified by Codex's integration/agent-viewport-spike.js, read-only).
    const { host, view } = this._createHiddenViewPair(partition);
    const adapter = new BrowserAdapter({ view });
    if (this._pool) wakeOnUse(adapter, view);
    this._pool?.register(`task:${taskId}`, view);
    this._hosts.set(taskId, { host, view, adapter, agentId });
    return adapter;
  }

  hasView(taskId) {
    return this._hosts.has(taskId);
  }

  // A read-only still of what the agent's hidden page shows right now, for the
  // user's live view of the agent working. Pixels only; no page content leaves.
  async captureFrame(taskId) {
    const view = this._hosts.get(taskId)?.view;
    if (!view || view.webContents.isDestroyed()) return null;
    // A parked or frozen surface is not woken for the mirror: the last frame stands.
    if (typeof view.isLive === "function" && !view.isLive()) return this._lastFrames.get(taskId)?.dataUrl ?? null;
    try {
      if (typeof view.webContents.captureJpeg === "function") {
        const jpeg = await captureFrameJpeg(view.webContents, { maxWidth: 1200, quality: 65 });
        if (!jpeg || this._hosts.get(taskId)?.view !== view) return null;
        const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
        this._lastFrames.set(taskId, { fingerprint: null, dataUrl });
        return dataUrl;
      }
      const image = await view.webContents.capturePage();
      if (!image || image.isEmpty()) return null;
      // An unchanged page returns the previous string untouched, so the caller's
      // state update is a no-op and nothing is re-encoded, re-rendered or re-decoded.
      const fingerprint = frameFingerprint(image);
      const last = this._lastFrames.get(taskId);
      if (last && last.fingerprint === fingerprint) return last.dataUrl;
      const sized = image.getSize().width > 1200 ? image.resize({ width: 1200, quality: "good" }) : image;
      const jpeg = typeof sized.encodeJpegAsync === "function" ? await sized.encodeJpegAsync(65) : sized.toJPEG(65);
      const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      this._lastFrames.set(taskId, { fingerprint, dataUrl });
      return dataUrl;
    } catch {
      return null;
    }
  }

  async captureComputerUseObservation(taskId, observation) {
    const entry = this._hosts.get(taskId);
    if (!entry) {
      const error = new Error("task-owned agent viewport is unavailable");
      error.code = "visual_view_unavailable";
      throw error;
    }
    const capture = await entry.adapter.captureScreenshot(observation);
    if (capture.observationId !== observation?.id || capture.documentEpoch !== observation?.documentEpoch || capture.url !== observation?.url) {
      const error = new Error("screenshot no longer matches the current observation");
      error.code = "stale_visual_observation";
      throw error;
    }
    const result = await createScreenshotAttachment({
      png: capture.png,
      taskId,
      agentId: entry.agentId,
      observation: { id: capture.observationId, documentEpoch: capture.documentEpoch, url: capture.url },
      viewport: capture.viewport,
      capturedAt: Date.now(),
    });
    // The same DOM geometry the text mode uses, kept host-side so a coordinate
    // click can be judged by the control it lands on. If it cannot be read the
    // list is empty, which sends every coordinate click to the human.
    let screenTargets = [];
    try {
      const geometry = await entry.adapter.captureScreenGeometry(observation);
      screenTargets = buildScreenMap(Array.isArray(observation.elements) ? observation.elements : [], geometry.boxes).targets;
    } catch { screenTargets = []; }
    try {
      entry.adapter.authorizeVisualBinding(result.binding);
      return { ...result, screenTargets };
    } catch (error) {
      await result.attachment.dispose();
      throw error;
    }
  }

  // Text computer use for planners without image input: the same one-use
  // visual binding as a screenshot, but its digest covers the text screen map
  // the planner will read instead of a PNG.
  async captureTextObservation(taskId, observation) {
    const entry = this._hosts.get(taskId);
    if (!entry) {
      const error = new Error("task-owned agent viewport is unavailable");
      error.code = "visual_view_unavailable";
      throw error;
    }
    const geometry = await entry.adapter.captureScreenGeometry(observation);
    const screenMap = buildScreenMap(Array.isArray(observation.elements) ? observation.elements : [], geometry.boxes);
    const binding = Object.freeze({
      observationId: geometry.observationId,
      taskId,
      agentId: entry.agentId,
      documentEpoch: geometry.documentEpoch,
      origin: new URL(geometry.url).origin,
      capturedAt: Date.now(),
      viewport: Object.freeze({ ...geometry.viewport }),
      digest: createHash("sha256").update(screenMap.text).digest("hex"),
    });
    entry.adapter.authorizeVisualBinding(binding);
    return { binding, screenMap };
  }

  // One hidden view per child. Host-executed children preserve the existing
  // parent session; Docker-selected children receive a child-only in-memory
  // partition. `assignedOrigin` (the host-
  // derived normalized origin of the child's entryUrl) is passed straight
  // into BrowserAdapter so its redirect/navigate lock is active from
  // construction. permissionMode is always "observe" here, not a parameter
  // -- Global Constraints: child policy is exactly observe+scroll, and this
  // is the one call site that constructs a child's adapter.
  ensureChild(parentTaskId, childId, { assignedOrigin, execution = "host" } = {}) {
    if (execution !== "host" && execution !== "docker" && execution !== "isolated") {
      const error = new TypeError("Child execution mode must be host, docker or isolated");
      error.code = "invalid_child_execution";
      throw error;
    }
    const existing = this._childHosts.get(childId);
    if (existing) {
      if (existing.parentTaskId !== parentTaskId || existing.execution !== execution || existing.assignedOrigin !== assignedOrigin) {
        const error = new Error("child browser profile binding changed after view construction");
        error.code = "child_profile_binding_changed";
        throw error;
      }
      return existing.adapter;
    }
    // "isolated" (Task Branches) and "docker" get a throwaway partition: no cookies from the parent.
    const partition = execution === "docker" || execution === "isolated" ? childBrowserPartition(childId) : `halo-task-${parentTaskId}`;
    const { host, view } = this._createHiddenViewPair(partition);
    const adapter = new BrowserAdapter({ view, assignedOrigin, permissionMode: "observe" });
    if (this._pool) wakeOnUse(adapter, view);
    this._pool?.register(`child:${childId}`, view);
    this._childHosts.set(childId, { host, view, adapter, parentTaskId, assignedOrigin, execution });
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
    this._pool?.unregister(`${map === this._childHosts ? "child" : "task"}:${id}`);
    this._lastFrames.delete(id);
    try {
      await entry.adapter.dispose?.();
    } finally {
      this._releaseHiddenHost(entry.host, entry.view);
    }
  }

  async dispose(taskId) {
    await this._disposeEntry(this._hosts, taskId);
  }

  async disposeChild(childId) {
    await this._disposeEntry(this._childHosts, childId);
  }

  async disposeAll() {
    this._pool?.stop();
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
function makeDualSurfaceBrowser({ agentAdapter, visibleAdapter, disposeAgent, captureComputerUseObservation, captureTextObservation }) {
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
    // The Intent Lock restricts the agent only: the hidden agent adapter
    // enforces it on execute() and on page-initiated navigation, while the
    // user's visible surface (and its redirects) stays unlocked.
    setIntentLock: (lock) => agentAdapter.setIntentLock?.(lock),
    // What execute() can really do is the agent adapter's answer. Unknown
    // (no supportsAction on it) stays undefined rather than a guess.
    supportsAction: (type) => (typeof agentAdapter.supportsAction === "function" ? agentAdapter.supportsAction(type) : undefined),
    ...(typeof captureComputerUseObservation === "function"
      ? { captureComputerUseObservation: (...args) => captureComputerUseObservation(...args) }
      : {}),
    ...(typeof captureTextObservation === "function"
      ? { captureTextObservation: (...args) => captureTextObservation(...args) }
      : {}),
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
  agentBrowserPartition,
  childBrowserPartition,
};
