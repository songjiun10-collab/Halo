"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  AgentViewportHost,
  makeDualSurfaceBrowser,
  applyBrowserHardening,
  AGENT_WIDTH,
  AGENT_HEIGHT,
} = require("../main/harness/agent-viewport-host");

// Fakes follow test/browser-surfaces.test.js's existing conventions
// (EventEmitter-based webContents, plain object view with setBounds/
// setVisible) so a real BrowserAdapter can be constructed against them
// exactly as it would against a real Electron WebContentsView.
function fakeCreateView() {
  const created = [];
  const createView = (opts) => {
    const webContents = new EventEmitter();
    webContents.isDestroyed = () => false;
    webContents.getURL = () => "";
    webContents.setWindowOpenHandler = function (fn) { this._windowOpenHandler = fn; };
    webContents.session = new EventEmitter();
    webContents.session.setPermissionRequestHandler = function (fn) { this._permissionRequestHandler = fn; };
    webContents.session.setPermissionCheckHandler = function (fn) { this._permissionCheckHandler = fn; };
    const view = {
      opts,
      webContents,
      bounds: null,
      visible: false,
      setBounds(b) { this.bounds = b; },
      setVisible(v) { this.visible = v; },
    };
    created.push(view);
    return view;
  };
  return { createView, created };
}

function fakeCreateWindow() {
  const created = [];
  const createWindow = (opts) => {
    const children = [];
    const win = {
      opts,
      destroyed: false,
      contentView: { addChildView: (v) => children.push(v) },
      children,
      destroy() { this.destroyed = true; },
    };
    created.push(win);
    return win;
  };
  return { createWindow, created };
}

function setup() {
  const { createView, created: views } = fakeCreateView();
  const { createWindow, created: windows } = fakeCreateWindow();
  const host = new AgentViewportHost({ createWindow, createView });
  return { host, views, windows };
}

test("ensure() creates a hidden, fixed 1440x900, never-shown host + view with the task's session partition", () => {
  const { host, views, windows } = setup();
  host.ensure("task-1");
  assert.equal(windows.length, 1);
  assert.equal(views.length, 1);
  const [win] = windows;
  const [view] = views;
  assert.equal(win.opts.show, false);
  assert.equal(win.opts.width, AGENT_WIDTH);
  assert.equal(win.opts.height, AGENT_HEIGHT);
  assert.equal(win.opts.webPreferences.partition, "halo-task-task-1");
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.equal(view.opts.webPreferences.partition, "halo-task-task-1", "agent view must share the task's existing session/cookie partition");
  assert.equal(view.opts.webPreferences.offscreen, true, "the hidden agent surface must use compositor-independent screenshot rendering");
  assert.deepEqual(win.children, [view]);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
  assert.equal(view.visible, true, "the view is visible WITHIN the hidden host, the host itself is never shown");
});

test("ensure() applies the same fail-closed hardening as the visible view (deny popup/permission/download, block non-http(s) navigation)", () => {
  const { host, views } = setup();
  host.ensure("task-1");
  const [view] = views;
  const popupResult = view.webContents._windowOpenHandler({ url: "https://example.com/popup" });
  assert.deepEqual(popupResult, { action: "deny" });

  let permissionAllowed = true;
  view.webContents.session._permissionRequestHandler(null, "camera", (result) => { permissionAllowed = result; });
  assert.equal(permissionAllowed, false);
  assert.equal(view.webContents.session._permissionCheckHandler(), false);

  let blockedNonHttp = false;
  view.webContents.emit("will-navigate", { preventDefault: () => { blockedNonHttp = true; } }, "file:///etc/passwd");
  assert.equal(blockedNonHttp, true);
  let blockedHttp = false;
  view.webContents.emit("will-navigate", { preventDefault: () => { blockedHttp = true; } }, "https://example.com");
  assert.equal(blockedHttp, false);

  let downloadPrevented = false;
  view.webContents.session.emit("will-download", { preventDefault: () => { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true);
});

test("ensure() reuses the same adapter and never creates a second renderer for the same task", () => {
  const { host, views, windows } = setup();
  const first = host.ensure("task-1");
  const second = host.ensure("task-1");
  assert.equal(first, second);
  assert.equal(windows.length, 1);
  assert.equal(views.length, 1);
});

test("computer-use screenshot identity comes from the host-owned task and Agent binding", async () => {
  const { host, views } = setup();
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const agentId = "11111111-1111-4111-8111-111111111111";
  const adapter = host.ensure(taskId, { agentId });
  const view = views[0];
  const inputEvents = [];
  view.getBounds = () => ({ x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
  view.webContents.getURL = () => "https://example.com/";
  view.webContents.executeJavaScript = async () => ({ url: "https://example.com/", title: "Fixture", text: "", elements: [] });
  view.webContents.capturePage = async () => ({ toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), getSize: () => ({ width: AGENT_WIDTH, height: AGENT_HEIGHT }) });
  view.webContents.sendInputEvent = (event) => inputEvents.push(event);
  view.webContents.insertText = (text) => inputEvents.push({ type: "insertText", text });
  adapter.setPermissionMode("interact");
  const observation = await adapter.observe();

  const visual = await host.captureComputerUseObservation(taskId, {
    ...observation,
    taskId: "forged-task",
    agentId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(visual.binding.taskId, taskId);
  assert.equal(visual.binding.agentId, agentId);
  assert.equal(visual.binding.observationId, observation.id);
  await assert.rejects(host.captureComputerUseObservation(taskId, observation), { code: "invalid_visual_binding" }, "one unspent screenshot may not be replaced for the same observation");
  await visual.attachment.dispose();
  const action = { type: "type_at", observationId: observation.id, x: 0.5, y: 0.25, text: "query" };
  assert.deepEqual(await adapter.execute(action, { documentEpoch: observation.documentEpoch }), { status: "ok" });
  assert.deepEqual(inputEvents, [
    { type: "mouseDown", x: 720, y: 225, button: "left", clickCount: 1 },
    { type: "mouseUp", x: 720, y: 225, button: "left", clickCount: 1 },
    { type: "insertText", text: "query" },
  ]);
  const otherTaskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const otherAdapter = host.ensure(otherTaskId);
  const otherView = views[1];
  otherView.getBounds = () => ({ x: 0, y: 0, width: AGENT_WIDTH, height: AGENT_HEIGHT });
  otherView.webContents.getURL = () => "https://example.com/";
  otherView.webContents.executeJavaScript = async () => ({ url: "https://example.com/", title: "Fixture", text: "", elements: [] });
  otherView.webContents.capturePage = async () => ({ toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), getSize: () => ({ width: AGENT_WIDTH, height: AGENT_HEIGHT }) });
  await otherAdapter.observe();
  await assert.rejects(host.captureComputerUseObservation(otherTaskId, observation), { code: "stale_visual_observation" });
  await assert.rejects(host.captureComputerUseObservation("missing-task", observation), { code: "visual_view_unavailable" });
});

test("different tasks get isolated hidden views with distinct session partitions", () => {
  const { host, views, windows } = setup();
  host.ensure("task-a");
  host.ensure("task-b");
  assert.equal(windows.length, 2);
  assert.equal(views.length, 2);
  assert.notEqual(views[0].opts.webPreferences.partition, views[1].opts.webPreferences.partition);
});

test("an opted-in Agent uses its stable HALO persistent partition, while ordinary tasks remain ephemeral", () => {
  const { host, views } = setup();
  const agentId = "11111111-1111-4111-8111-111111111111";
  host.ensure("task-a", { agentId });
  host.ensure("task-b", { agentId });
  host.ensure("task-c");
  assert.equal(views[0].opts.webPreferences.partition, `persist:halo-agent-${agentId}`);
  assert.equal(views[1].opts.webPreferences.partition, `persist:halo-agent-${agentId}`);
  assert.equal(views[2].opts.webPreferences.partition, "halo-task-task-c");
});

test("ensure() rejects malformed owner IDs and rebinding an existing task to another Agent", () => {
  const { host } = setup();
  assert.throws(() => host.ensure("task-invalid", { agentId: "../escape" }), { code: "invalid_agent_profile" });
  host.ensure("task-1", { agentId: "11111111-1111-4111-8111-111111111111" });
  assert.throws(() => host.ensure("task-1", { agentId: "22222222-2222-4222-8222-222222222222" }), { code: "agent_profile_binding_changed" });
});

test("hasView reflects ensure()/dispose() state", async () => {
  const { host } = setup();
  assert.equal(host.hasView("task-1"), false);
  host.ensure("task-1");
  assert.equal(host.hasView("task-1"), true);
  await host.dispose("task-1");
  assert.equal(host.hasView("task-1"), false);
});

test("dispose() tears down the adapter and destroys the hidden host window", async () => {
  const { host, windows } = setup();
  host.ensure("task-1");
  await host.dispose("task-1");
  assert.equal(windows[0].destroyed, true);
});

test("dispose() for an unknown task is a no-op, never throws", async () => {
  const { host } = setup();
  await assert.doesNotReject(host.dispose("never-existed"));
});

test("dispose() still destroys the host window even if the adapter's own teardown fails", async () => {
  const { host, views, windows } = setup();
  host.ensure("task-1");
  const [view] = views;
  // Force BrowserAdapter.dispose()'s internal wc.removeListener() call to
  // throw, simulating a broken/crashed webContents during teardown.
  view.webContents.removeListener = () => { throw new Error("boom"); };
  await assert.rejects(host.dispose("task-1"));
  assert.equal(windows[0].destroyed, true, "host window must be destroyed even when adapter teardown itself throws");
});

test("disposeAll() tears down every tracked task", async () => {
  const { host, windows } = setup();
  host.ensure("task-a");
  host.ensure("task-b");
  await host.disposeAll();
  assert.equal(windows.every((w) => w.destroyed), true);
  assert.equal(host.hasView("task-a"), false);
  assert.equal(host.hasView("task-b"), false);
});

// --- Task 4 (multi-agent background runtime plan): per-child hidden views ---

test("host-executed ensureChild() preserves the parent's session partition", () => {
  const { host, views, windows } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  assert.equal(windows.length, 1);
  assert.equal(views.length, 1);
  const [win] = windows;
  const [view] = views;
  assert.equal(win.opts.webPreferences.partition, "halo-task-parent-1");
  assert.equal(view.opts.webPreferences.partition, "halo-task-parent-1");
  assert.equal(win.opts.show, false);
  assert.equal(win.opts.width, AGENT_WIDTH);
  assert.equal(win.opts.height, AGENT_HEIGHT);
});

test("ensureChild() constructs its adapter at permissionMode observe, not overridable by the caller", async () => {
  const { host } = setup();
  const adapter = host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  assert.deepEqual(await adapter.execute({ type: "navigate", url: "https://example.com" }), { status: "failed", errorCode: "permission_mode_denied" });
});

test("ensureChild() applies the child's assignedOrigin as a real redirect/navigate lock", () => {
  const { host, views } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  const [view] = views;
  let prevented = false;
  view.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://elsewhere.example/");
  assert.equal(prevented, true);
});

test("ensureChild() reuses the same adapter for the same childId and never creates a second renderer for it", () => {
  const { host, views, windows } = setup();
  const first = host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  const second = host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  assert.equal(first, second);
  assert.equal(windows.length, 1);
  assert.equal(views.length, 1);
});

test("host-executed sibling children get distinct views while retaining the parent's shared session", () => {
  const { host, views, windows } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://a.example" });
  host.ensureChild("parent-1", "child-2", { assignedOrigin: "https://b.example" });
  assert.equal(windows.length, 2);
  assert.equal(views.length, 2);
  assert.equal(views[0].opts.webPreferences.partition, views[1].opts.webPreferences.partition);
  assert.notEqual(windows[0], windows[1], "each child still gets its own distinct hidden view/window");
});

test("Docker-selected ensureChild() uses an isolated in-memory partition per child", () => {
  const { host, views } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://a.example", execution: "docker" });
  host.ensureChild("parent-1", "child-2", { assignedOrigin: "https://b.example", execution: "docker" });
  assert.match(views[0].opts.webPreferences.partition, /^halo-child-[0-9a-f]{64}$/);
  assert.notEqual(views[0].opts.webPreferences.partition, views[1].opts.webPreferences.partition);
  assert.notEqual(views[0].opts.webPreferences.partition, "halo-task-parent-1");
});

test("ensureChild() rejects rebinding a live child's execution mode or origin", () => {
  const { host } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://a.example", execution: "host" });
  assert.throws(
    () => host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://a.example", execution: "docker" }),
    { code: "child_profile_binding_changed" },
  );
  assert.throws(
    () => host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://b.example", execution: "host" }),
    { code: "child_profile_binding_changed" },
  );
});

test("a child's view is never registered in the parent's own top-level _hosts (hasView stays false for a childId)", () => {
  const { host } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  assert.equal(host.hasChildView("child-1"), true);
  assert.equal(host.hasView("child-1"), false);
});

test("disposeChild() tears down the child's adapter and destroys its hidden host window", async () => {
  const { host, windows } = setup();
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  await host.disposeChild("child-1");
  assert.equal(windows[0].destroyed, true);
  assert.equal(host.hasChildView("child-1"), false);
});

test("disposeChild() for an unknown childId is a no-op, never throws", async () => {
  const { host } = setup();
  await assert.doesNotReject(host.disposeChild("never-existed"));
});

test("disposeAll() also tears down every tracked child, alongside top-level tasks", async () => {
  const { host, windows } = setup();
  host.ensure("task-a");
  host.ensureChild("parent-1", "child-1", { assignedOrigin: "https://example.com" });
  await host.disposeAll();
  assert.equal(windows.every((w) => w.destroyed), true);
  assert.equal(host.hasView("task-a"), false);
  assert.equal(host.hasChildView("child-1"), false);
});

test("applyBrowserHardening is exported standalone and applies the full policy to a bare webContents", () => {
  const { createView } = fakeCreateView();
  const view = createView({});
  applyBrowserHardening(view.webContents);
  assert.equal(typeof view.webContents._windowOpenHandler, "function");
  assert.equal(typeof view.webContents.session._permissionRequestHandler, "function");
});

// --- makeDualSurfaceBrowser: routing/fail-closed contract ---

function fakeAdapter(name, methods = {}) {
  const calls = [];
  const forbidden = (method) => () => {
    throw new Error(`${name}.${method} must never be called through this route`);
  };
  return {
    calls,
    observe: methods.observe || forbidden("observe"),
    execute: methods.execute || forbidden("execute"),
    userNavigate: methods.userNavigate || forbidden("userNavigate"),
    getBrowserSnapshot: methods.getBrowserSnapshot || forbidden("getBrowserSnapshot"),
    onChange: methods.onChange || forbidden("onChange"),
    dispose: methods.dispose || (async () => { calls.push("dispose"); }),
  };
}

test("observe()/execute() route only to the agent adapter, never to the visible adapter", async () => {
  const agentAdapter = fakeAdapter("agent", {
    observe: async (...args) => ({ via: "agent", args }),
    execute: async (...args) => ({ via: "agent", args }),
  });
  const visibleAdapter = fakeAdapter("visible");
  const browser = makeDualSurfaceBrowser({ agentAdapter, visibleAdapter });
  assert.deepEqual(await browser.observe({ initial: true }), { via: "agent", args: [{ initial: true }] });
  assert.deepEqual(await browser.execute({ type: "scroll" }, { signal: undefined }), { via: "agent", args: [{ type: "scroll" }, { signal: undefined }] });
});

test("userNavigate()/getBrowserSnapshot()/onChange() route only to the visible adapter, never to the agent adapter", async () => {
  const agentAdapter = fakeAdapter("agent");
  const visibleAdapter = fakeAdapter("visible", {
    userNavigate: async (action) => ({ via: "visible", action }),
    getBrowserSnapshot: () => ({ via: "visible" }),
    onChange: (listener) => { listener; return () => {}; },
  });
  const browser = makeDualSurfaceBrowser({ agentAdapter, visibleAdapter });
  assert.deepEqual(await browser.userNavigate({ type: "back" }), { via: "visible", action: { type: "back" } });
  assert.deepEqual(browser.getBrowserSnapshot(), { via: "visible" });
  assert.equal(typeof browser.onChange(() => {}), "function");
});

test("dispose() tears down both surfaces via disposeAgent, even when one side fails", async () => {
  const disposeCalls = [];
  const agentAdapter = fakeAdapter("agent");
  const visibleAdapter = fakeAdapter("visible", {
    dispose: async () => { disposeCalls.push("visible"); throw new Error("visible teardown failed"); },
  });
  const browser = makeDualSurfaceBrowser({
    agentAdapter,
    visibleAdapter,
    disposeAgent: async () => { disposeCalls.push("agent"); },
  });
  await assert.rejects(browser.dispose());
  assert.deepEqual(disposeCalls.sort(), ["agent", "visible"], "both sides must be attempted even though visible's dispose rejected");
});

test("dispose() falls back to agentAdapter.dispose() when no disposeAgent callback is given", async () => {
  const agentAdapter = fakeAdapter("agent");
  const visibleAdapter = fakeAdapter("visible");
  const browser = makeDualSurfaceBrowser({ agentAdapter, visibleAdapter });
  await browser.dispose();
  assert.deepEqual(agentAdapter.calls, ["dispose"]);
  assert.deepEqual(visibleAdapter.calls, ["dispose"]);
});

test("makeDualSurfaceBrowser requires both adapters", () => {
  assert.throws(() => makeDualSurfaceBrowser({ agentAdapter: fakeAdapter("agent") }), TypeError);
  assert.throws(() => makeDualSurfaceBrowser({ visibleAdapter: fakeAdapter("visible") }), TypeError);
});

test("makeDualSurfaceBrowser forwards visual capture only through the supplied host callback", async () => {
  const observation = { id: "obs-1", documentEpoch: 0, url: "https://example.test/" };
  const expected = { binding: { observationId: "obs-1" }, attachment: { path: "/private/screenshot.png" } };
  let received;
  const browser = makeDualSurfaceBrowser({
    agentAdapter: fakeAdapter("agent"),
    visibleAdapter: fakeAdapter("visible"),
    captureComputerUseObservation: async (value) => { received = value; return expected; },
  });
  assert.equal(await browser.captureComputerUseObservation(observation), expected);
  assert.equal(received, observation);
});
