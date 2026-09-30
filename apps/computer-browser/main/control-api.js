"use strict";

const { randomUUID } = require("crypto");
const { performance } = require("node:perf_hooks");
const { WebContentsView } = require("electron");
const { clampBrowserBounds } = require("../shared/clamp-bounds");
const { looksLikeCaptcha } = require("../shared/captcha-heuristics");
const { summarizeMetrics } = require("../shared/metrics");
const { requestDecision } = require("./approver-client");

const URL_LIKE = /^https?:\/\//i;
const MAX_PROMPT_LENGTH = 2000;
const MAX_TIMELINE = 200;
const MAX_QUEUE = 50;
const MAX_METRICS = 500;
// Pacing floor between agent-initiated (gated) actions ONLY -- never applied
// to a human's own direct navigate/back/forward/reload/newTab. This is about
// being a slow, low-volume automated client (fewer, spaced-out requests), not
// about evading a site's bot detection. If a real CAPTCHA still shows up
// despite this, the response is to pause and hand off to a human (see
// looksLikeCaptcha() below), never to solve, bypass, or spoof around it.
const MIN_AGENT_ACTION_INTERVAL_MS = 2000;
// navigate()'s loadURL() has no built-in bound -- a hanging/slow-loading
// page would otherwise wait forever, wedging performGatedAction()'s caller
// (startTask()) and any pending resume indefinitely. Past this, the load is
// actively aborted via webContents.stop() rather than just given up on, so
// it doesn't keep running in the background.
const NAVIGATION_TIMEOUT_MS = 30000;
// _findFirstOutboundLink() reads the page's own DOM -- bound how many
// anchors it walks so a pathological page (huge or adversarially large
// anchor count) can't turn a "read one link" op into an unbounded scan.
const MAX_DOM_LINKS_SCANNED = 500;

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
  constructor({
    window,
    socketPath,
    requestDecision: requestDecisionOverride,
    minAgentActionIntervalMs,
    navigationTimeoutMs,
    navigationWaitUntil,
    maxDomLinksScanned,
    now,
    webContentsViewClass = WebContentsView,
  } = {}) {
    this._window = window;
    this._WebContentsView = webContentsViewClass;
    this._socketPath = socketPath;
    // Injectable seams for tests only (defaults are the real Unix-socket
    // client / the real pacing floor / metrics clock). Production callers
    // never pass these.
    this._requestDecision = requestDecisionOverride || requestDecision;
    this._minAgentActionIntervalMs =
      typeof minAgentActionIntervalMs === "number" ? minAgentActionIntervalMs : MIN_AGENT_ACTION_INTERVAL_MS;
    this._navigationTimeoutMs =
      typeof navigationTimeoutMs === "number" ? navigationTimeoutMs : NAVIGATION_TIMEOUT_MS;
    // "load" (default, unchanged behavior) or "dom-ready" -- see
    // _loadWithTimeout()'s comment for the tradeoff.
    this._navigationWaitUntil = navigationWaitUntil === "dom-ready" ? "dom-ready" : "load";
    this._maxDomLinksScanned =
      typeof maxDomLinksScanned === "number" ? maxDomLinksScanned : MAX_DOM_LINKS_SCANNED;
    this._now = typeof now === "function" ? now : Date.now;
    this._lastAgentActionAt = -Infinity;
    this._agentActionStartChain = Promise.resolve();
    // Structured latency samples ({kind, ms, outcome, at, ...}) for
    // getMetricsSummary() -- see shared/metrics.js. Never exposed via
    // getSnapshot(); read only through the dedicated method/IPC channel.
    this._metrics = [];
    this._taskStartedAt = null;
    this._view = null;
    this._tabs = [];
    this._activeTabId = null;
    this._hasPage = false;
    this._page = {
      url: "", title: "", loadState: "idle", canGoBack: false, canGoForward: false, hasPage: false,
      // Best-effort, informational only -- see shared/captcha-heuristics.js.
      captchaSuspected: false,
    };
    // pauseReason distinguishes a human's own pauseTask() ("user") from an
    // automatic pause because the current page looks like a CAPTCHA/anti-bot
    // challenge ("captcha") -- the two need different resume UX (see
    // resumeTask() vs resumeAfterCaptcha()).
    this._task = { id: null, state: "idle", pauseReason: null };
    this._approvalQueue = [];
    this._timeline = [];
    this._listeners = new Set();
    this._pendingBounds = null;
    this._lastBoundsKey = null;
    // Bumped by stopTask() so an approver round-trip that was already in
    // flight when stop happened can recognize it is stale once it resolves.
    this._stopEpoch = 0;
    // At most one gated action is ever in flight at a time in this
    // reference implementation (startTask() awaits each performGatedAction()
    // before issuing the next), so a single slot is enough to hold a
    // decision that arrived while paused.
    this._deferredDecision = null;
    // Wake functions for any performGatedAction() call currently sleeping out
    // the pacing floor (_paceAgentAction) -- stopTask() calls each of these
    // so a stop lands immediately instead of only being noticed after the
    // full pacing interval elapses and execute() has already been allowed to
    // run (see the epoch re-check right after the pacing await, below).
    this._pendingPaceWaiters = new Set();
    // Actions that already crossed the allow boundary. TAKE OVER waits for
    // these executions to settle before returning the visible page to manual
    // control; a decision still waiting on the approver is invalidated by
    // _stopEpoch instead and is deliberately not part of this set.
    this._inFlightAgentActions = new Set();
    // { step: "step1"|"step2", trimmed, epoch } | null -- set by startTask()/
    // _runStepTwo() right before a gated call that has a further step after
    // it, so a pause/CAPTCHA interruption (before OR after that call's
    // execute() runs) can genuinely be resumed into the rest of the SAME
    // task via _afterStepOutcome(), instead of resuming just flipping
    // _task.state back to "running" with nothing left to actually do.
    this._taskCursor = null;
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
      tabs: this._tabs.map(({ id, title, url }) => ({ id, title, url })),
      activeTabId: this._activeTabId,
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

  // kind: "decision_wait" | "execute" | "navigation" | "dom_read" |
  // "queue_wait" | "task_total". `extra` carries per-record context such as
  // `action`/`outcome` -- outcome absent means "ok"; a specific value
  // ("timeout", "error", "review", "deny", "cancelled", ...) is what lets
  // getMetricsSummary() report per-stage failure reasons, not just timing.
  _recordMetric(kind, ms, extra = {}) {
    this._metrics.push({ kind, ms, at: this._now(), ...extra });
    if (this._metrics.length > MAX_METRICS) this._metrics.shift();
  }

  // Grouped {count, p50, p95, outcomes} per metric kind -- see
  // shared/metrics.js for the math. This is main-process-side timing only
  // (decision round-trip, execute()/navigation, DOM read, approval queue
  // wait, whole-task wall time). Renderer paint/snapshot-render latency is
  // out of scope here -- it can only be measured from inside whatever
  // renderer eventually lands, not from this process.
  getMetricsSummary() {
    return summarizeMetrics(this._metrics);
  }

  _recordTaskTotal(outcome) {
    if (this._taskStartedAt != null) {
      this._recordMetric("task_total", this._now() - this._taskStartedAt, { outcome });
      this._taskStartedAt = null;
    }
  }

  _markTaskCompleted() {
    this._task = { ...this._task, state: "completed" };
    this._recordTaskTotal("completed");
  }

  _ensureView() {
    if (this._view) return this._view;
    return this._createTab();
  }

  _createTab() {
    if (this._view) this._view.setVisible(false);
    const view = new this._WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    this._window.contentView.addChildView(view);
    view.setVisible(false);
    // A bounds update can arrive (from the renderer's ResizeObserver) before
    // any tab exists, when there is no view yet to apply it to. Without this,
    // that update is lost and a freshly created view sits at Electron's
    // default {0,0,0,0} bounds until the next *different* bounds message —
    // which may never come if the layout hasn't changed.
    if (this._pendingBounds) {
      view.setBounds(this._pendingBounds);
      this._lastBoundsKey = JSON.stringify(this._pendingBounds);
    }
    const tab = { id: randomUUID(), title: "New tab", url: "", view };
    this._tabs.push(tab);
    this._activeTabId = tab.id;
    this._view = view;
    const wc = view.webContents;
    wc.on("did-start-navigation", () => { if (this._view === view) this._syncPageState({ loadState: "loading" }); });
    wc.on("did-navigate", (_e, url) => { tab.url = url; if (this._view === view) this._syncPageState({ url, loadState: "ready" }); });
    wc.on("did-navigate-in-page", (_e, url) => { tab.url = url; if (this._view === view) this._syncPageState({ url }); });
    wc.on("page-title-updated", (_e, title) => { tab.title = title; if (this._view === view) this._syncPageState({ title }); });
    wc.on("did-fail-load", (_e, code, description) => {
      if (this._view !== view) return;
      if (code !== -3) this._pushTimeline("navigation", `Load failed: ${description}`, "error");
      this._syncPageState({ loadState: "error" });
    });
    this._page = { url: tab.url, title: tab.title, loadState: "idle", canGoBack: false, canGoForward: false, hasPage: false };
    this._emit();
    return view;
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
    this._page.captchaSuspected = looksLikeCaptcha(this._page.url, this._page.title);
    // Never solved, clicked through, or routed around here -- see
    // shared/captcha-heuristics.js. The only response to a suspected
    // challenge is to stop advancing an active task and hand the (already
    // human-interactive) browser surface to the user. A task that isn't
    // actively trying to make progress (idle/paused/stopped/completed) has
    // nothing to preserve, so it's left alone.
    if (this._page.captchaSuspected && ["running", "awaiting_approval"].includes(this._task.state)) {
      this._task = { ...this._task, state: "paused", pauseReason: "captcha" };
      this._pushTimeline(
        "task",
        "A CAPTCHA/anti-bot challenge was detected. Task paused -- please solve it directly in the browser, then resume.",
        "info",
      );
    }
    this._emit();
  }

  // Pacing floor for agent-initiated (gated) actions -- see
  // MIN_AGENT_ACTION_INTERVAL_MS. The very first agent action is never
  // delayed (_lastAgentActionAt starts at -Infinity); only a second action
  // arriving too soon after the last one waits out the remainder. Callers
  // hold the dispatch-start chain while waiting so requests cannot share a
  // pacing slot.
  async _paceAgentAction() {
    while (this._lastAgentActionAt !== -Infinity) {
      const wait = this._minAgentActionIntervalMs - (performance.now() - this._lastAgentActionAt);
      if (wait <= 0) break;
      const timerElapsed = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._pendingPaceWaiters.delete(wakeEarly);
          resolve(true);
        }, wait);
        const wakeEarly = () => {
          clearTimeout(timer);
          resolve(false);
        };
        this._pendingPaceWaiters.add(wakeEarly);
      });
      // setTimeout may run a fraction early. Recheck against the monotonic
      // deadline so the configured floor is not shortened; an explicit stop
      // still wakes the wait immediately and is handled by the caller's epoch
      // check after this method returns.
      if (!timerElapsed) break;
    }
  }

  // --- Free actions: direct human intent via UI controls. No approval gate. ---

  async navigate(url) {
    if (typeof url !== "string" || url.trim().length === 0 || url.length > 8192) {
      throw new RangeError("navigate requires a non-empty, bounded URL string");
    }
    const target = this._normalizeAddress(url.trim());
    this._ensureView();
    this._hasPage = true;
    this._view.setVisible(true);
    const start = this._now();
    const { outcome } = await this._loadWithTimeout(target);
    this._recordMetric("navigation", this._now() - start, { outcome, waitUntil: this._navigationWaitUntil });
    if (outcome === "timeout") {
      this._pushTimeline(
        "navigation",
        `Navigation to ${target} did not finish within ${this._navigationTimeoutMs}ms; aborted.`,
        "error",
      );
      this._syncPageState({ loadState: "error" });
    } else if (outcome === "error") {
      // loadURL() itself rejected (bad DNS, refused connection, etc.) --
      // must never be reported as if the navigation succeeded. did-fail-load
      // (see _ensureView) also fires for this and pushes its own timeline
      // entry with the real error description; this one guarantees the
      // caller-visible outcome is honest even if that listener race loses.
      this._pushTimeline("navigation", `Navigation to ${target} failed to load.`, "error");
      this._syncPageState({ loadState: "error" });
    } else {
      this._pushTimeline("navigation", `Navigated to ${target}`, "info");
    }
    return this.getSnapshot();
  }

  _normalizeAddress(input) {
    if (URL_LIKE.test(input)) {
      const parsed = new URL(input);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError("Only HTTP and HTTPS pages can be opened");
      return parsed.href;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^(localhost|[\w.-]+\.\w+):\d+(?:\/|$)/i.test(input)) {
      throw new TypeError("Only HTTP and HTTPS addresses can be opened");
    }
    if (/\s/.test(input) || !/^(localhost|[\w.-]+\.\w+)(?::\d+)?(?:\/|$)/i.test(input)) {
      return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
    }
    const parsed = new URL(`https://${input}`);
    return parsed.href;
  }

  // loadURL() has no built-in bound (see Electron's webContents docs -- its
  // promise only settles on did-finish-load, i.e. the FULL page including
  // subresources). A slow or hanging page would otherwise keep
  // performGatedAction()'s caller (startTask(), or a resume) waiting
  // indefinitely. This races the chosen readiness signal against a timer;
  // on timeout it calls webContents.stop() to actually abort the in-flight
  // load rather than just walking away from it. A genuine fast failure (bad
  // DNS, refused connection, etc.) is unaffected -- it settles via
  // loadURL()'s own rejection (already surfaced by the did-fail-load
  // listener wired up in _ensureView()) well before the timer fires.
  //
  // _navigationWaitUntil ("load" by default, or "dom-ready"): Electron's
  // loadURL() promise only resolves at did-finish-load, which -- per
  // Playwright's own guidance against waiting on networkidle -- is often a
  // stricter readiness bar than an automation step actually needs. For a
  // step that only reads the DOM for outbound links (this app's only
  // page-content read), the earlier "dom-ready" event (DOMContentLoaded)
  // is frequently enough and measurably faster, at the honest cost of
  // possibly missing anchors a page injects via script AFTER DOMContentLoaded
  // (a completeness/speed tradeoff, not a security one -- the approval gate
  // and pacing floor are unaffected either way). Left at "load" by default:
  // there is no real measured evidence yet that switching the default is
  // safe for this app's actual pages (see bench/navigation-readiness-bench.js
  // for the deterministic, simulated comparison this is based on).
  async _loadWithTimeout(target) {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ outcome: "timeout" }), this._navigationTimeoutMs);
    });
    const wc = this._view.webContents;
    let ready;
    if (this._navigationWaitUntil === "dom-ready") {
      ready = new Promise((resolve) => wc.once("dom-ready", () => resolve({ outcome: "ok" })));
      wc.loadURL(target).catch(() => {}); // failure still reported via did-fail-load
    } else {
      // loadURL()'s rejection must reach the caller as a real "error" outcome
      // -- previously this .catch(() => false) made a genuine load failure
      // (bad DNS, refused connection) indistinguishable from success, and
      // navigate() would push a false "Navigated to X" success message.
      ready = wc.loadURL(target).then(() => ({ outcome: "ok" })).catch(() => ({ outcome: "error" }));
    }
    const result = await Promise.race([ready, timedOut]);
    clearTimeout(timer);
    if (result.outcome === "timeout") {
      wc.stop();
    }
    return result;
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
    this._createTab();
    this._hasPage = false;
    this._pushTimeline("navigation", "Opened a new tab", "info");
    this._emit();
    return this.getSnapshot();
  }

  async selectTab(tabId) {
    const tab = this._tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new RangeError("Unknown browser tab");
    if (this._view !== tab.view) {
      if (this._view) this._view.setVisible(false);
      this._view = tab.view;
      this._activeTabId = tab.id;
      if (this._pendingBounds) tab.view.setBounds(this._pendingBounds);
      tab.view.setVisible(Boolean(tab.url));
      const wc = tab.view.webContents;
      this._hasPage = Boolean(tab.url);
      this._page = {
        url: tab.url, title: tab.title, loadState: wc.isLoading?.() ? "loading" : "ready",
        canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), hasPage: this._hasPage,
        captchaSuspected: looksLikeCaptcha(tab.url, tab.title),
      };
      this._emit();
    }
    return this.getSnapshot();
  }

  async closeTab(tabId) {
    if (this._tabs.length <= 1) throw new Error("Cannot close the last tab");
    const index = this._tabs.findIndex((candidate) => candidate.id === tabId);
    if (index < 0) throw new RangeError("Unknown browser tab");
    const [tab] = this._tabs.splice(index, 1);
    if (tab.view === this._view) {
      const next = this._tabs[Math.min(index, this._tabs.length - 1)];
      tab.view.setVisible(false);
      this._window.contentView.removeChildView?.(tab.view);
      tab.view.webContents.destroy?.();
      this._view = null;
      await this.selectTab(next.id);
    } else {
      this._window.contentView.removeChildView?.(tab.view);
      tab.view.webContents.destroy?.();
    }
    this._pushTimeline("navigation", `Closed tab ${tab.title || tab.url || "New tab"}`, "info");
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

  // True if stopTask() has run since `epoch` was captured. Every await point
  // in the gated pipeline (waiting on the approver, waiting on execute()
  // itself, waiting on page reads) is a place stopTask() can interleave;
  // each such point must re-check this before writing a terminal _task.state,
  // or a stop that happened mid-flight gets silently overwritten back to
  // "completed" once the in-flight work finally resolves.
  _stopHappenedSince(epoch) {
    return epoch !== this._stopEpoch;
  }

  async _executeAgentAction(execute, epoch, beforeDispatch = () => true) {
    if (this._stopHappenedSince(epoch)) return false;

    const previousStart = this._agentActionStartChain;
    let releaseStart;
    this._agentActionStartChain = new Promise((resolve) => { releaseStart = resolve; });
    await previousStart;

    let execution;
    try {
      if (this._stopHappenedSince(epoch)) return false;
      await this._paceAgentAction();
      if (this._stopHappenedSince(epoch) || !beforeDispatch()) return false;

      // Invoke synchronously before yielding, then register its promise in
      // the same turn. Record the timestamp after invocation so a subsequent
      // action's deadline is anchored at the actual dispatch start, not at
      // pre-dispatch work performed by the caller.
      try {
        execution = Promise.resolve(execute());
      } catch (error) {
        execution = Promise.reject(error);
      }
      this._lastAgentActionAt = performance.now();
      this._inFlightAgentActions.add(execution);
    } finally {
      releaseStart();
    }

    try {
      await execution;
      return true;
    } finally {
      this._inFlightAgentActions.delete(execution);
    }
  }

  async performGatedAction(descriptor, execute) {
    // No `effect` field here: whether an action counts as a policy-relevant
    // effect (e.g. submit_form -> external_write) is derived server-side from
    // the action mapping table in approver_service.py, not taken from the
    // executor's own say-so -- an executor that could self-declare "no
    // effect" for something that really does write externally would defeat
    // the whole point of an independent approver.
    const stopEpoch = this._stopEpoch;
    const decisionStart = this._now();
    let decision;
    try {
      decision = await this._requestDecision(this._socketPath, {
        request_id: randomUUID(),
        action: descriptor.action,
        origin: descriptor.origin || "",
        summary: descriptor.summary,
        self_provenance: descriptor.selfProvenance,
        source: descriptor.source,
        target_scope: descriptor.targetScope ?? null,
        contains_secret: Boolean(descriptor.containsSecret),
      });
    } catch (error) {
      // A transport failure, timeout, or (per approver-client.js's schema
      // validation) a malformed response must never propagate as an
      // uncaught rejection out of startTask()/approve() -- that would leave
      // the task stuck "running" with no timeline entry and no state
      // transition. Fail closed: treat it exactly like an explicit deny.
      this._recordMetric("decision_wait", this._now() - decisionStart, { action: descriptor.action, outcome: "error" });
      if (this._stopHappenedSince(stopEpoch)) return "cancelled";
      this._pushTimeline(descriptor.action, `${descriptor.summary} — approver failure: ${error && error.message}`, "deny");
      return "deny";
    }
    this._recordMetric("decision_wait", this._now() - decisionStart, {
      action: descriptor.action,
      outcome: decision.decision,
    });

    // stopTask() bumps _stopEpoch and does not wait for outstanding
    // requestDecision() calls to unwind. Without this check, a decision that
    // arrives after the user already stopped the task -- including "allow"
    // -- would still execute, and a "review" would re-populate the queue
    // stopTask() just cleared, silently undoing the stop. Discard instead.
    if (this._stopHappenedSince(stopEpoch)) {
      this._pushTimeline(descriptor.action, `${descriptor.summary} (decision arrived after stop; discarded)`, "info");
      this._emit();
      return "cancelled";
    }

    // Symmetric guard for pause: an approver round-trip already in flight
    // when pauseTask() ran must not execute (or silently queue) once it
    // resolves, or "pause" would not actually pause anything. Hold it and
    // let resumeTask() apply it explicitly.
    if (this._task.state === "paused") {
      this._deferredDecision = { descriptor, execute, decision };
      this._pushTimeline(descriptor.action, `${descriptor.summary} (decision held: task is paused)`, "info");
      this._emit();
      return "paused";
    }

    return this._applyDecision(descriptor, execute, decision, stopEpoch);
  }

  async _applyDecision(descriptor, execute, decision, epoch) {
    if (decision.decision === "allow") {
      let skippedOutcome = "cancelled";
      let executeStart = null;
      const didExecute = await this._executeAgentAction(execute, epoch, () => {
        if (this._task.state === "paused") {
          this._deferredDecision = { descriptor, execute, decision };
          this._pushTimeline(descriptor.action, `${descriptor.summary} (decision held: task is paused)`, "info");
          this._emit();
          skippedOutcome = "paused";
          return false;
        }
        // A review round-trip or pacing wait is a real await point; verify
        // the approved target is still selected immediately before dispatch.
        if (descriptor.originTabId != null && descriptor.originTabId !== this._activeTabId) {
          this._pushTimeline(descriptor.action, `${descriptor.summary} (cancelled: the target tab changed before this action ran)`, "info");
          skippedOutcome = "tab_changed";
          return false;
        }
        this._pushTimeline(descriptor.action, descriptor.summary, "allow");
        executeStart = this._now();
        return true;
      });
      if (!didExecute) {
        if (this._stopHappenedSince(epoch)) {
          this._pushTimeline(descriptor.action, `${descriptor.summary} (task stopped while waiting to pace; not dispatched)`, "info");
        }
        return skippedOutcome;
      }
      if (executeStart === null) return "cancelled";
      this._recordMetric("execute", this._now() - executeStart, { action: descriptor.action });
      // stopTask() can run while execute() itself is in flight (e.g. a real
      // navigate() awaiting loadURL()) -- the decision was legitimately
      // "allow" and execute() already ran for real, but the *caller* must
      // not treat this as a clean "allow" and go on to overwrite _task.state
      // with "completed" once stopTask() already set it to "stopped".
      if (this._stopHappenedSince(epoch)) {
        this._pushTimeline(descriptor.action, `${descriptor.summary} (task was stopped while this action was executing)`, "info");
        return "cancelled";
      }
      // Symmetric case: execute() (e.g. the navigate() this action just ran)
      // can itself be what triggers _syncPageState() to auto-pause for a
      // suspected CAPTCHA -- or a human's own pauseTask() can land in this
      // same window. Either way execute() already ran for real; the caller
      // must not advance to a further step or overwrite the paused state.
      if (this._task.state === "paused") {
        return "paused";
      }
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
        // Precise, clock-injectable timestamp for the queue_wait metric --
        // never exposed via getSnapshot() (see its explicit field allowlist).
        _createdAtMs: this._now(),
        _execute: execute,
        // Same tab-drift guard as the immediate-allow path (see
        // originTabId in startTask()) -- a REVIEW item can sit in the queue
        // indefinitely, so this matters even more here than for a pacing wait.
        _originTabId: descriptor.originTabId ?? null,
      });
      this._task = { ...this._task, state: "awaiting_approval" };
      this._emit();
      return "review";
    }
    this._pushTimeline(descriptor.action, `${descriptor.summary} — ${(decision.reasons || []).join("; ")}`, "deny");
    return decision.decision;
  }

  // Reads the just-loaded page for exactly one outbound link. This is a
  // fixed extraction script WE control, run via executeJavaScript against
  // the embedded page -- not eval of anything the page supplies. Finding a
  // link is a read, not a decision; whether to follow it still goes through
  // performGatedAction() like any other page_content-sourced action. The
  // anchor scan is capped at this._maxDomLinksScanned (MAX_DOM_LINKS_SCANNED
  // by default) so a page with a pathologically large anchor count can't
  // turn this into an unbounded DOM walk.
  async _findFirstOutboundLink() {
    if (!this._view) return null;
    const start = this._now();
    let outcome = "not_found";
    try {
      const result = await this._view.webContents.executeJavaScript(
        `(() => {
          const base = document.baseURI;
          const anchors = document.querySelectorAll("a[href]");
          const limit = Math.min(anchors.length, ${this._maxDomLinksScanned});
          for (let i = 0; i < limit; i++) {
            const a = anchors[i];
            try {
              const url = new URL(a.getAttribute("href"), base);
              if ((url.protocol === "http:" || url.protocol === "https:") && url.href !== base) {
                return { href: url.href, text: (a.textContent || "").trim().slice(0, 80) };
              }
            } catch {}
          }
          return null;
        })()`,
        true,
      );
      outcome = result ? "found" : "not_found";
      return result;
    } catch {
      outcome = "error";
      return null;
    } finally {
      this._recordMetric("dom_read", this._now() - start, { outcome });
    }
  }

  async startTask(prompt) {
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
      throw new RangeError(`startTask requires a prompt of 1..${MAX_PROMPT_LENGTH} characters`);
    }
    this._task = { id: randomUUID(), state: "running", pauseReason: null };
    this._taskCursor = null;
    this._taskStartedAt = this._now();
    this._pushTimeline("task", `Task started: ${prompt.slice(0, 120)}`, "info");
    this._emit();
    // Captured once: every await below is a point where a concurrent
    // stopTask() can run, so every terminal _task.state write in this
    // function must check against this same epoch first.
    const epoch = this._stopEpoch;

    const trimmed = prompt.trim();
    if (!URL_LIKE.test(trimmed)) {
      this._pushTimeline(
        "task",
        "Prompt is not a directly actionable URL. A multi-step planning loop is not implemented yet — see design doc.",
        "info",
      );
      this._markTaskCompleted();
      this._emit();
      return this.getSnapshot();
    }

    // Step 1: navigate where the user's own prompt pointed. source is
    // honestly "user_prompt" here, so this can only ever resolve to allow
    // or deny -- never review (agreement between self-claim and the host
    // rule is guaranteed for a genuine user-typed destination). _taskCursor
    // records that "step2 comes next" *before* the gated call, so that if a
    // pause/CAPTCHA interrupts it (before OR after its execute() runs -- see
    // performGatedAction/_applyDecision), resumeTask()/resumeAfterCaptcha()
    // can actually continue into step 2 instead of just flipping the task
    // back to "running" with nothing left to do.
    this._taskCursor = { step: "step1", trimmed, epoch };
    const initialOutcome = await this.performGatedAction(
      {
        requestId: randomUUID(),
        action: "navigate",
        origin: this._page.url || "",
        summary: `Agent proposes to navigate to ${trimmed}`,
        selfProvenance: "trusted",
        source: "user_prompt",
        targetScope: "external",
        // Captured now, not re-read at execute() time: a decision round-trip
        // or the pacing wait can take seconds, long enough for a human to
        // switch tabs via selectTab() in the meantime. Without this, a
        // proposal made about tab A could silently execute against whatever
        // tab happens to be active once the approver/pacing wait resolves --
        // see the originTabId check in _applyDecision()/approve().
        originTabId: this._activeTabId,
      },
      () => this.navigate(trimmed),
    );
    return this._afterStepOutcome("step1", initialOutcome, trimmed, epoch);
  }

  // Shared continuation point for both a step's *normal* completion (called
  // directly from startTask()/_runStepTwo) and a *resumed* one (called from
  // resumeTask() once a pause/CAPTCHA interruption has cleared) -- so both
  // paths behave identically instead of resuming being a second, drifting
  // copy of this logic.
  async _afterStepOutcome(step, outcome, trimmed, epoch) {
    // this._stopHappenedSince(epoch) covers both a decision discarded before
    // execute() ran ("cancelled") AND stopTask() landing while execute()
    // itself was still in flight (still "allow", but stale by the time we
    // get here) -- either way stopTask() already owns _task.state
    // ("stopped") and this must not overwrite it. "paused" is separate and
    // epoch-unchanged: _taskCursor (still set to this same step) stays put
    // so a later resume can pick up exactly here.
    if (this._stopHappenedSince(epoch) || outcome === "paused") {
      return this.getSnapshot();
    }
    this._taskCursor = null;
    if (outcome === "review") {
      // _applyDecision already queued it and set state to "awaiting_approval".
      // Not reachable for step1 in practice (user_prompt source only ever
      // resolves allow/deny), but handled rather than assumed impossible.
      // Chaining a REVIEW'd step1 into step2 after approve() is out of scope
      // for this fixed-script reference implementation -- see design doc.
      return this.getSnapshot();
    }
    if (step === "step1") {
      if (outcome !== "allow") {
        this._markTaskCompleted();
        this._emit();
        return this.getSnapshot();
      }
      return this._runStepTwo(trimmed, epoch);
    }
    // step === "step2": the last step in this fixed 2-step demo -- there is
    // nothing further to run regardless of outcome.
    this._markTaskCompleted();
    this._emit();
    return this.getSnapshot();
  }

  // Step 2: this is the part of the demo that actually exercises review —
  // the agent looks at the page it just loaded (untrusted content it did
  // not author) and proposes ONE follow-up hop, honestly labeled
  // source="page_content". A well-behaved placeholder agent reports this
  // truthfully, which is exactly what reaches review rather than being
  // silently auto-executed. Still not a real planner: exactly one hop, no
  // loop, no step budget, no LLM call — see design doc. Called both from
  // startTask() directly and from a resume that just completed step 1.
  async _runStepTwo(trimmed, epoch) {
    const link = await this._findFirstOutboundLink();
    // Another await, another point stopTask() could have landed in the
    // meantime -- check again before deciding whether there's a link to
    // follow or the task is simply done. No _taskCursor is set for this
    // particular await: there's no gated action in flight yet to resume
    // into, just a plain page read.
    if (this._stopHappenedSince(epoch)) {
      return this.getSnapshot();
    }
    if (link && typeof link.href === "string") {
      this._taskCursor = { step: "step2", trimmed, epoch };
      const followOutcome = await this.performGatedAction(
        {
          requestId: randomUUID(),
          action: "navigate",
          origin: this._page.url || trimmed,
          summary: `Agent noticed a link on the page ("${link.text || link.href}") and proposes following it to ${link.href}`,
          selfProvenance: "untrusted",
          source: "page_content",
          targetScope: "external",
          originTabId: this._activeTabId,
        },
        () => this.navigate(link.href),
      );
      return this._afterStepOutcome("step2", followOutcome, trimmed, epoch);
    }
    this._pushTimeline("task", "No outbound link found on the page; task complete.", "info");
    this._markTaskCompleted();
    this._emit();
    return this.getSnapshot();
  }

  async pauseTask() {
    if (["running", "awaiting_approval"].includes(this._task.state)) {
      this._task = { ...this._task, state: "paused", pauseReason: "user" };
      this._pushTimeline("task", "Task paused", "info");
      this._emit();
    }
    return this.getSnapshot();
  }

  // Ownership handoff for the visible, legacy browser task. Unlike a plain
  // pause this invalidates outstanding approver replies, drops queued and
  // deferred agent intent, and drains actions that already crossed the
  // allow boundary before the renderer is told the page is available to the
  // person. Navigation remains bounded by _loadWithTimeout().
  async takeOverTask() {
    let takeoverEpoch = this._stopEpoch;
    if (["running", "awaiting_approval"].includes(this._task.state)) {
      this._stopEpoch += 1;
      takeoverEpoch = this._stopEpoch;
      for (const wakeEarly of this._pendingPaceWaiters) wakeEarly();
      this._pendingPaceWaiters.clear();
      this._deferredDecision = null;
      this._taskCursor = null;
      this._approvalQueue = [];
      this._task = { ...this._task, state: "paused", pauseReason: "user_takeover_pending" };
      this._pushTimeline("task", "Takeover requested; waiting for the active browser action to settle.", "info");
      this._emit();
    }
    await Promise.allSettled([...this._inFlightAgentActions]);
    // stopTask() may supersede takeover while an action drains. Never turn a
    // stopped task back into a paused/user-owned task when that happens.
    if (this._stopEpoch === takeoverEpoch && this._task.pauseReason === "user_takeover_pending") {
      this._task = { ...this._task, state: "paused", pauseReason: "user_takeover" };
      this._pushTimeline("task", "Automation paused; browser control returned to the person.", "info");
      this._emit();
    }
    return this.getSnapshot();
  }

  async resumeTask() {
    if (this._task.state !== "paused") return this.getSnapshot();
    // A CAPTCHA-triggered pause needs its own safety re-check (has the
    // challenge actually been solved?) before resuming -- route it through
    // resumeAfterCaptcha() instead of silently resuming here.
    if (this._task.pauseReason === "captcha") {
      this._pushTimeline(
        "task",
        "Task is paused for a suspected CAPTCHA; call resumeAfterCaptcha() once it's solved, not the generic resume.",
        "info",
      );
      this._emit();
      return this.getSnapshot();
    }
    this._task = { ...this._task, state: "running", pauseReason: null };
    this._pushTimeline("task", "Task resumed", "info");
    this._emit();

    const cursor = this._taskCursor;

    if (this._deferredDecision) {
      // Pre-execute pause: pauseTask() (or a CAPTCHA -- though CAPTCHA
      // detection only ever fires from a page already loaded, so it cannot
      // land here) held the decision before its execute() ran.
      const { descriptor, execute, decision } = this._deferredDecision;
      this._deferredDecision = null;
      const epoch = cursor ? cursor.epoch : this._stopEpoch;
      const outcome = await this._applyDecision(descriptor, execute, decision, epoch);
      if (cursor) {
        // Genuinely continue startTask()'s own sequence from wherever this
        // step now resolves to -- e.g. a resumed step1 "allow" actually
        // proceeds into step 2's link lookup, instead of resuming just
        // reporting "running" with nothing further happening.
        return this._afterStepOutcome(cursor.step, outcome, cursor.trimmed, epoch);
      }
      // Not part of startTask()'s own step sequence (e.g. a bare
      // performGatedAction() call) -- no further step to chain into.
      if (!this._stopHappenedSince(epoch) && outcome !== "review" && outcome !== "paused") {
        this._markTaskCompleted();
        this._emit();
      }
      return this.getSnapshot();
    }

    if (cursor) {
      // Post-execute pause: the gated action already ran for real (e.g. a
      // CAPTCHA detected mid-navigate, or a manual pauseTask() landing in
      // that same window -- see _applyDecision's post-execute check, which
      // only returns "paused" from its "allow" branch). Continue
      // startTask()'s sequence as if that step had just resolved "allow".
      return this._afterStepOutcome(cursor.step, "allow", cursor.trimmed, cursor.epoch);
    }
    return this.getSnapshot();
  }

  // Dedicated resume path for a CAPTCHA-triggered pause. Never solves,
  // clicks through, or routes around anything -- it only re-checks the
  // SAME read-only heuristic against the page's current state and refuses
  // to resume (staying paused, no retry loop) if it still looks unresolved.
  // The actual solving happens only through the human directly interacting
  // with the already-visible, already-interactive browser surface.
  async resumeAfterCaptcha() {
    if (this._task.state !== "paused" || this._task.pauseReason !== "captcha") {
      return this.getSnapshot();
    }
    if (looksLikeCaptcha(this._page.url, this._page.title)) {
      this._pushTimeline(
        "task",
        "Still looks like an unresolved CAPTCHA/challenge; staying paused. Solve it in the browser, then try again.",
        "info",
      );
      this._emit();
      return this.getSnapshot();
    }
    this._task = { ...this._task, pauseReason: null };
    return this.resumeTask();
  }

  async stopTask() {
    this._stopEpoch += 1;
    for (const wakeEarly of this._pendingPaceWaiters) wakeEarly();
    this._pendingPaceWaiters.clear();
    this._deferredDecision = null;
    this._taskCursor = null;
    this._approvalQueue = [];
    this._task = { ...this._task, state: "stopped", pauseReason: null };
    this._recordTaskTotal("stopped");
    this._pushTimeline("task", "Task stopped", "info");
    this._emit();
    return this.getSnapshot();
  }

  async approve(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    this._recordMetric("queue_wait", this._now() - item._createdAtMs, { action: item.action, outcome: "approved" });
    this._pushTimeline(item.action, `${item.summary} (approved by reviewer)`, "allow");
    const epoch = this._stopEpoch;
    let pausedBeforeDispatch = false;
    await this._executeAgentAction(item._execute, epoch, () => {
      if (this._task.state === "paused") {
        pausedBeforeDispatch = true;
        return false;
      }
      if (item._originTabId != null && item._originTabId !== this._activeTabId) {
        this._pushTimeline(item.action, `${item.summary} (cancelled: the target tab changed before this action ran)`, "info");
        return false;
      }
      return true;
    });
    if (this._stopHappenedSince(epoch) || pausedBeforeDispatch) return this.getSnapshot();
    // Same class of race as startTask()/resumeTask(): stopTask() can run
    // while this execute() is in flight, and this execute() can itself
    // trigger a CAPTCHA-detection auto-pause. stopTask() already cleared
    // _approvalQueue, so the length-zero check below would otherwise still
    // be true and overwrite "stopped"/"paused" with "completed".
    if (!this._stopHappenedSince(epoch) && this._task.state !== "paused" && this._approvalQueue.length === 0) {
      this._markTaskCompleted();
    }
    this._emit();
    return this.getSnapshot();
  }

  async deny(requestId) {
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    this._recordMetric("queue_wait", this._now() - item._createdAtMs, { action: item.action, outcome: "denied" });
    this._pushTimeline(item.action, `${item.summary} (denied by reviewer)`, "deny");
    if (this._approvalQueue.length === 0) this._markTaskCompleted();
    this._emit();
    return this.getSnapshot();
  }
}

module.exports = { ControlApi };
