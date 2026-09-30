(() => {
  "use strict";

  const bridge = window.haloBrowser;
  const $ = (id) => document.getElementById(id);
  const els = {
    connection: $("connection"), connectionLabel: $("connection-label"), emptyStatus: $("empty-status-text"),
    addressForm: $("address-form"), address: $("address"), originLabel: $("origin-label"),
    title: $("page-title"), tabs: $("tab-list"), pageMeta: $("page-meta"), origin: $("security-origin"), loadState: $("page-load-state"),
    prompt: $("task-prompt"), charCount: $("char-count"), taskState: $("task-state"), run: $("run-button"),
    takeOver: $("take-over-button"), controlState: $("control-state"),
    pause: $("pause-button"), stop: $("stop-button"), back: $("back-button"), forward: $("forward-button"),
    reload: $("reload-button"), newTab: $("new-tab-button"), queue: $("queue-list"), queueCount: $("queue-count"),
    timeline: $("timeline"), surface: $("web-surface"), empty: $("empty-state"), toast: $("toast"),
  };
  const hasLayoutContract = Boolean(bridge && bridge.layout && typeof bridge.layout === "object" &&
    ["headerHeight", "footerHeight", "sidePanelWidth", "mobileBreakpoint"].every((key) =>
      Number.isSafeInteger(bridge.layout[key]) && bridge.layout[key] > 0 && bridge.layout[key] <= 4096));
  const layout = hasLayoutContract ? bridge.layout : {
    headerHeight: 124, footerHeight: 25, sidePanelWidth: 342, mobileBreakpoint: 680,
  };
  const cssPixels = (value, fallback) => Number.isFinite(value) && value >= 0 && value <= 4096 ? Math.round(value) : fallback;
  const headerHeight = cssPixels(layout.headerHeight, 124);
  const footerHeight = cssPixels(layout.footerHeight, 25);
  const panelWidth = cssPixels(layout.sidePanelWidth, 342);
  const breakpoint = cssPixels(layout.mobileBreakpoint, 680);
  document.documentElement.style.setProperty("--browser-header-height", `${headerHeight}px`);
  document.documentElement.style.setProperty("--browser-footer-height", `${footerHeight}px`);
  document.documentElement.style.setProperty("--supervisor-width", `${panelWidth}px`);
  const applyResponsiveLayout = () => { $("shell").dataset.mobile = String(window.innerWidth <= breakpoint); };
  applyResponsiveLayout();
  let snapshot = null;
  let bridgeReady = false;
  let toastTimer;
  let unsubscribe = null;
  let lastBounds = "";
  let takeOverPending = false;

  const safeText = (value, fallback = "") => typeof value === "string" ? value : fallback;
  const escapeOrigin = (value) => {
    try { return new URL(value).origin; } catch { return "—"; }
  };
  const formatTime = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--:--:--" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  };

  function notify(message) {
    els.toast.textContent = message;
    els.toast.dataset.visible = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.dataset.visible = "false"; }, 3200);
  }

  function setConnection(state, message) {
    els.connection.dataset.state = state;
    els.connectionLabel.textContent = message;
    els.emptyStatus.textContent = state === "connected" ? "NATIVE RUNTIME CONNECTED" : state === "error" ? "SECURE BRIDGE UNAVAILABLE" : "WAITING FOR SECURE BRIDGE";
  }

  function disableBridgeControls() {
    for (const control of [els.run, els.pause, els.stop, els.takeOver, els.back, els.forward, els.reload, els.newTab]) {
      control.disabled = true;
    }
  }

  function renderTask(task = {}) {
    const state = safeText(task.state, "idle").toLowerCase();
    const handoffPending = takeOverPending || task.pauseReason === "user_takeover_pending";
    const userOwnsPage = state === "paused" && task.pauseReason === "user_takeover";
    const label = handoffPending ? "HANDOFF IN PROGRESS" : userOwnsPage ? "USER CONTROL" : ({ idle: "IDLE", running: "RUNNING", awaiting_approval: "NEEDS REVIEW", paused: "PAUSED", stopped: "STOPPED", completed: "COMPLETE", error: "ERROR" })[state] || state.toUpperCase();
    els.taskState.textContent = label;
    els.taskState.dataset.state = state;
    els.controlState.textContent = handoffPending ? "WAITING FOR ACTIVE ACTION TO SETTLE" : userOwnsPage ? "AUTOMATION PAUSED · PAGE IS YOURS" : "AUTOMATION CONTROL";
    els.controlState.dataset.state = handoffPending ? "pending" : userOwnsPage ? "user" : "automation";
    els.prompt.disabled = handoffPending;
    els.address.disabled = handoffPending;
    const page = snapshot?.page || {};
    els.back.disabled = handoffPending || !bridgeReady || !page.canGoBack;
    els.forward.disabled = handoffPending || !bridgeReady || !page.canGoForward;
    els.reload.disabled = handoffPending || !bridgeReady || !page.url;
    els.newTab.disabled = handoffPending || !bridgeReady;
    els.run.disabled = handoffPending || !bridgeReady || (state !== "paused" && !els.prompt.value.trim()) || state === "running" || state === "awaiting_approval";
    els.run.querySelector("span").textContent = state === "paused" ? "RESUME TASK" : "START TASK";
    els.pause.disabled = handoffPending || !bridgeReady || !["running", "paused"].includes(state);
    els.pause.setAttribute("aria-label", state === "paused" ? "Resume task" : "Pause task");
    els.pause.title = state === "paused" ? "Resume task" : "Pause task";
    els.pause.innerHTML = state === "paused"
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5z" /></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" /></svg>';
    els.stop.disabled = !bridgeReady || !["running", "paused", "awaiting_approval"].includes(state);
    els.takeOver.disabled = !bridgeReady || takeOverPending || typeof bridge?.takeOverTask !== "function" || !["running", "awaiting_approval"].includes(state);
  }

  function renderQueue(items = []) {
    const pending = Array.isArray(items) ? items.slice(0, 50) : [];
    els.queueCount.textContent = String(pending.length).padStart(2, "0");
    els.queue.replaceChildren();
    if (!pending.length) {
      const empty = document.createElement("div");
      empty.className = "empty-row";
      empty.textContent = "No actions awaiting review.";
      els.queue.append(empty);
      return;
    }
    for (const item of pending) {
      if (!item || typeof item.id !== "string") continue;
      const article = document.createElement("article");
      article.className = "approval-item";
      const top = document.createElement("div"); top.className = "approval-top";
      const verb = document.createElement("span"); verb.textContent = safeText(item.action, "ACTION").toUpperCase();
      const origin = document.createElement("span"); origin.className = "approval-origin"; origin.textContent = safeText(item.origin, "UNKNOWN ORIGIN");
      top.append(verb, origin);
      const summary = document.createElement("div"); summary.className = "approval-action"; summary.textContent = safeText(item.summary, "Action details unavailable");
      article.append(top, summary);
      if (item.reason) { const reason = document.createElement("div"); reason.className = "approval-reason"; reason.textContent = safeText(item.reason); article.append(reason); }
      const actions = document.createElement("div"); actions.className = "approval-buttons";
      const approve = document.createElement("button"); approve.type = "button"; approve.textContent = "ALLOW ONCE"; approve.addEventListener("click", () => invoke("approve", item.id));
      const deny = document.createElement("button"); deny.type = "button"; deny.textContent = "DENY"; deny.addEventListener("click", () => invoke("deny", item.id));
      actions.append(approve, deny); article.append(actions); els.queue.append(article);
    }
  }

  function renderTimeline(items = []) {
    const events = Array.isArray(items) ? items.slice(-100).reverse() : [];
    els.timeline.replaceChildren();
    if (!events.length) {
      const empty = document.createElement("li"); empty.className = "empty-row"; empty.textContent = "Session events will be recorded here."; els.timeline.append(empty); return;
    }
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const row = document.createElement("li"); row.className = "timeline-item";
      const status = safeText(event.status, "info").toLowerCase();
      if (["allow", "deny", "review", "error"].includes(status)) row.dataset.status = status;
      const head = document.createElement("div"); head.className = "timeline-head";
      const time = document.createElement("time"); time.className = "timeline-time"; time.dateTime = safeText(event.at); time.textContent = formatTime(event.at);
      const kind = document.createElement("span"); kind.textContent = safeText(event.kind, "EVENT").toUpperCase();
      const badge = document.createElement("span"); badge.className = "timeline-status"; badge.textContent = status.toUpperCase();
      head.append(time, kind, badge);
      const message = document.createElement("div"); message.className = "timeline-message"; message.textContent = safeText(event.message, "Event details unavailable");
      row.append(head, message); els.timeline.append(row);
    }
  }

  function renderTabs(tabs = [], activeTabId = "") {
    els.tabs.replaceChildren();
    for (const tab of tabs.slice(0, 30)) {
      if (!tab || typeof tab.id !== "string") continue;
      const item = document.createElement("div");
      item.className = "browser-tab";
      item.setAttribute("role", "presentation");
      const select = document.createElement("button");
      select.type = "button";
      select.className = "tab-select";
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === activeTabId));
      select.textContent = safeText(tab.title, tab.url ? escapeOrigin(tab.url) : "New tab");
      select.title = safeText(tab.url, "New tab");
      select.addEventListener("click", () => invoke("selectTab", tab.id));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.setAttribute("aria-label", `Close ${safeText(tab.title, "tab")}`);
      close.textContent = "×";
      close.addEventListener("click", () => invoke("closeTab", tab.id));
      item.append(select, close);
      els.tabs.append(item);
    }
  }

  function render(next) {
    if (!next || typeof next !== "object" || !next.page || typeof next.page !== "object" ||
        !next.task || typeof next.task !== "object" || !Array.isArray(next.approvalQueue) ||
        !Array.isArray(next.timeline)) return false;
    snapshot = next;
    bridgeReady = true;
    const handoffPending = takeOverPending || next.task.pauseReason === "user_takeover_pending";
    setConnection("connected", "RUNTIME CONNECTED");
    const page = next.page && typeof next.page === "object" ? next.page : next;
    const url = safeText(page.url);
    renderTabs(Array.isArray(next.tabs) ? next.tabs : [], safeText(next.activeTabId));
    els.address.value = url;
    els.title.textContent = safeText(page.title, url ? escapeOrigin(url) : "New tab");
    els.originLabel.textContent = url ? escapeOrigin(url).replace(/^https?:\/\//, "") : "NO PAGE";
    els.origin.textContent = `ORIGIN: ${escapeOrigin(url)}`;
    els.addressForm.dataset.secure = url.startsWith("https:") ? "true" : "false";
    const load = safeText(page.loadState, url ? "READY" : "IDLE").toUpperCase();
    els.loadState.textContent = load;
    els.pageMeta.textContent = safeText(page.title, "RENDERER READY").toUpperCase().slice(0, 42);
    els.back.disabled = handoffPending || !bridgeReady || !page.canGoBack;
    els.forward.disabled = handoffPending || !bridgeReady || !page.canGoForward;
    els.reload.disabled = handoffPending || !bridgeReady || !url;
    els.newTab.disabled = handoffPending || !bridgeReady;
    els.empty.hidden = Boolean(page.hasPage ?? Boolean(url));
    renderTask(next.task || {});
    renderQueue(next.approvalQueue);
    renderTimeline(next.timeline);
    return true;
  }

  async function refresh() {
    if (!bridge || typeof bridge.getSnapshot !== "function") return false;
    try {
      const next = await bridge.getSnapshot();
      if (!render(next)) throw new TypeError("Native bridge returned an invalid session snapshot.");
      return true;
    } catch (error) {
      bridgeReady = false;
      setConnection("error", "BRIDGE ERROR");
      renderTask(snapshot?.task || {});
      disableBridgeControls();
      notify(`Could not read session state: ${safeText(error?.message, "bridge error")}`);
      return false;
    }
  }

  async function invoke(method, ...args) {
    if (!bridgeReady || !bridge || typeof bridge[method] !== "function") { notify("Secure browser bridge is not available."); return; }
    try {
      const result = await bridge[method](...args);
      if (result && typeof result === "object") {
        if (!render(result.snapshot || result)) {
          bridgeReady = false;
          setConnection("error", "BRIDGE ERROR");
          renderTask(snapshot?.task || {});
          disableBridgeControls();
          notify("Native bridge returned an invalid session snapshot.");
        }
      }
      else await refresh();
    } catch (error) {
      notify(safeText(error?.message, "Action failed; no browser action was confirmed."));
      await refresh();
    }
  }

  async function takeOver() {
    if (takeOverPending || els.takeOver.disabled) return;
    takeOverPending = true;
    renderTask(snapshot?.task || {});
    try {
      await invoke("takeOverTask");
    } finally {
      takeOverPending = false;
      renderTask(snapshot?.task || {});
    }
  }

  function sendBounds() {
    if (!bridge || typeof bridge.setBrowserBounds !== "function") return;
    const rect = els.surface.getBoundingClientRect();
    const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
    const key = JSON.stringify(bounds);
    if (key === lastBounds) return;
    lastBounds = key;
    bridge.setBrowserBounds(bounds).catch((error) => notify(safeText(error?.message, "Could not resize browser surface.")));
  }

  $("address-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.address.value.trim();
    if (!value) return;
    invoke("navigate", value);
  });
  els.prompt.addEventListener("input", () => {
    els.charCount.textContent = `${els.prompt.value.length} / 2000`;
    renderTask(snapshot?.task || {});
  });
  els.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !els.run.disabled) invoke("startTask", els.prompt.value.trim());
  });
  els.run.addEventListener("click", () => {
    if (snapshot?.task?.state === "paused") invoke("resumeTask");
    else invoke("startTask", els.prompt.value.trim());
  });
  els.pause.addEventListener("click", () => invoke(snapshot?.task?.state === "paused" ? "resumeTask" : "pauseTask"));
  els.stop.addEventListener("click", () => invoke("stopTask"));
  els.takeOver.addEventListener("click", takeOver);
  els.back.addEventListener("click", () => invoke("goBack"));
  els.forward.addEventListener("click", () => invoke("goForward"));
  els.reload.addEventListener("click", () => invoke("reload"));
  els.newTab.addEventListener("click", () => invoke("newTab"));
  window.addEventListener("keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    const key = safeText(event.key).toLowerCase();
    if (command && key === "l") {
      event.preventDefault();
      els.address.focus();
    } else if (command && key === "t") {
      event.preventDefault();
      invoke("newTab");
    } else if (command && key === "w") {
      event.preventDefault();
      if (snapshot?.activeTabId) invoke("closeTab", snapshot.activeTabId);
    } else if (command && key === "r") {
      event.preventDefault();
      invoke("reload");
    } else if (event.altKey && key === "arrowleft") {
      event.preventDefault();
      invoke("goBack");
    } else if (event.altKey && key === "arrowright") {
      event.preventDefault();
      invoke("goForward");
    }
  });

  if (!bridge) {
    setConnection("error", "BRIDGE UNAVAILABLE");
    renderTask();
    disableBridgeControls();
  } else if (!hasLayoutContract) {
    setConnection("error", "BRIDGE ERROR");
    renderTask();
    disableBridgeControls();
  } else {
    setConnection("checking", "CONNECTING");
    if (typeof bridge.onEvent === "function") {
      unsubscribe = bridge.onEvent((event) => {
        if (event?.snapshot) { if (!render(event.snapshot)) refresh(); }
        else if (event && typeof event === "object" && ("approvalQueue" in event || "timeline" in event || "task" in event)) { if (!render(event)) refresh(); }
        else refresh();
      });
    }
    refresh().then((ok) => setConnection(ok ? "connected" : "error", ok ? "RUNTIME CONNECTED" : "BRIDGE ERROR"));
    const observer = new ResizeObserver(sendBounds);
    observer.observe(els.surface);
    window.addEventListener("resize", () => { applyResponsiveLayout(); sendBounds(); }, { passive: true });
    sendBounds();
  }

  window.addEventListener("beforeunload", () => { if (typeof unsubscribe === "function") unsubscribe(); });
})();
