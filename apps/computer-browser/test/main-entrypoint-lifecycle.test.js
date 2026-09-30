"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const ENTRY = path.resolve(__dirname, "../main/index.js");

function loadEntrypoint({ serviceMode = false, userData, dialogResponse = 0 } = {}) {
  const calls = { windows: [], hosts: [], services: [], clients: [], ipc: [], errors: [], dockHide: 0, quit: 0 };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.contentView = { addChildView() {}, removeChildView() {} };
      this.webContents = { setWindowOpenHandler() {}, on() {}, loadFile() {}, send() {} };
      this.webContents.loadFile = () => {};
      calls.windows.push(this);
    }
    loadFile() {}
    isDestroyed() { return false; }
    getContentSize() { return [1280, 800]; }
    destroy() { this.emit("closed"); }
  }
  FakeWindow.getAllWindows = () => calls.windows.filter((win) => !win.destroyed);
  class FakeTaskHost {
    constructor(options) { this.options = options; this.closed = 0; calls.hosts.push(this); }
    onEvent() { return () => {}; }
    close() { this.closed++; return Promise.resolve(); }
    onMemorySample() { return Promise.resolve(); }
    canUseTaskBrowser() { return false; }
  }
  class FakeService {
    constructor(options) { this.options = options; this.stopped = 0; calls.services.push(this); }
    async start() { return { socketPath: this.options.socketPath, capability: "a".repeat(64) }; }
    async stopService() { this.stopped++; }
    onEvent(listener) { this.listener = listener; return () => {}; }
  }
  class FakeClient {
    constructor(options) { this.options = options; this.connected = 0; this.detached = 0; this.stopped = 0; calls.clients.push(this); }
    async connect() { this.connected++; }
    async detach() { this.detached++; }
    async stopService() { this.stopped++; }
    onEvent() { return () => {}; }
  }
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve();
  app.getPath = () => userData;
  app.dock = { hide: () => calls.dockHide++ };
  app.getAppMetrics = () => [];
  app.quit = () => calls.quit++;
  const approver = () => {
    const child = new EventEmitter();
    child.pid = 123456;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  const map = {
    electron: { app, BrowserWindow: FakeWindow, WebContentsView: class {}, safeStorage: {}, dialog: { showMessageBox: async () => ({ response: dialogResponse }) } },
    child_process: { spawn: approver, execFile: (_cmd, _args, done) => done(null, "") },
    "./control-api": { ControlApi: class { onChange() { return () => {}; } } },
    "./ipc": (...args) => calls.ipc.push(args),
    "../shared/layout-constants": { HEADER_HEIGHT: 1, FOOTER_HEIGHT: 1, SIDE_PANEL_WIDTH: 1, MOBILE_BREAKPOINT: 1 },
    "./approver-client": { requestDecision() {} },
    "./harness/task-host": { TaskHost: FakeTaskHost },
    "./harness/browser-adapter": { BrowserAdapter: class {} },
    "./harness/browser-surfaces": { BrowserSurfaces: class { register() {} setViewport() {} } },
    "./harness/planner-stdio": { PlannerStdioAdapter: class { constructor(options) { calls.plannerOptions = options; } } },
    "./harness/memory-monitor": { MemoryMonitor: class { registerExternalProcess() {} unregister() {} sample() { return Promise.resolve(); } } },
    "./harness/agent-viewport-host": { AgentViewportHost: class {
      constructor() { this.disposedChildren = []; calls.agentViewportHost = this; }
      ensure() { return {}; }
      ensureChild(...args) {
        this.childArgs = args;
        return { dispose() { throw new Error("child adapter disposed without its host window"); } };
      }
      disposeChild(childId) { this.disposedChildren.push(childId); return Promise.resolve(); }
      disposeAll() { return Promise.resolve(); }
    }, makeDualSurfaceBrowser: () => ({}) },
    "./harness/planner-command": { resolvePlannerCommand: () => ({ command: null, env: {} }) },
    "./harness/host-settings": { HostSettingsStore: class { load() { return Promise.resolve({}); } } },
    "./harness/local-memory-store": { LocalMemoryStore: class {} },
    "./harness/local-credential-vault": { LocalCredentialVault: class {} },
    "./harness/profile-import/session-vault": { SessionVault: class {} },
    "./harness/profile-import/profile-importer": { ProfileImporter: class {}, SessionConfigStore: class {} },
    "./harness/profile-import/chrome-cookie-reader": { readChromeCookies: async () => ({ status: "not_found", cookies: [] }) },
    "./harness/process-tree-memory": { sumProcessTreeRssBytes: () => null },
    "./harness/background-runtime-service": { BackgroundRuntimeService: FakeService },
    "./harness/background-runtime-client": { BackgroundRuntimeClient: FakeClient },
    "./harness/background-runtime-ipc": { prepareSocketDir: async (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; } },
  };
  const realRequire = require;
  const context = {
    require: (name) => Object.hasOwn(map, name) ? map[name] : realRequire(name),
    __dirname: path.dirname(ENTRY),
    module: { exports: {} },
    process: { argv: serviceMode ? ["electron", ".", "--halo-background-service"] : ["electron", "."], env: {}, platform: "darwin", stdout: process.stdout, stderr: process.stderr, getuid: process.getuid },
    console: { ...console, error: (...args) => calls.errors.push(args) },
    setInterval: () => 1, clearInterval() {}, URL,
  };
  vm.runInNewContext(fs.readFileSync(ENTRY, "utf8"), context, { filename: ENTRY });
  return { app, calls };
}

async function flushStartup() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("background service mode owns TaskHost without creating a visible UI window", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-service-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { calls } = loadEntrypoint({ serviceMode: true, userData });
  await flushStartup();
  assert.equal(calls.services.length, 1);
  assert.equal(calls.services[0].options.taskHost, calls.hosts[0]);
  assert.equal(calls.services[0].options.socketRoot, path.join(userData, "background-runtime"));
  assert.equal(calls.services[0].options.socketPath, path.join(userData, "background-runtime", "ipc", "runtime.sock"));
  assert.equal(calls.dockHide, 1);
  assert.equal(calls.ipc.length, 0);
  assert.ok(calls.windows.every((win) => win.options.show === false));
  const capabilityPath = path.join(userData, "background-runtime", "capability");
  assert.match(fs.readFileSync(capabilityPath, "utf8"), /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(capabilityPath).mode & 0o777, 0o600);
});

test("a child browser disposal also releases its service-owned hidden window", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-child-view-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { calls } = loadEntrypoint({ serviceMode: true, userData });
  await flushStartup();
  const browser = calls.hosts[0].options.makeChildBrowser("parent-1", "child-1", "https://example.test");
  assert.equal(calls.agentViewportHost.childArgs[0], "parent-1");
  assert.equal(calls.agentViewportHost.childArgs[1], "child-1");
  assert.equal(calls.agentViewportHost.childArgs[2].assignedOrigin, "https://example.test");
  calls.hosts[0].options.makePlanner("child-1", { role: "child" });
  assert.equal(calls.plannerOptions.role, "child");
  await browser.dispose();
  assert.deepEqual(calls.agentViewportHost.disposedChildren, ["child-1"]);
});

test("UI attaches to a running service and closing its window detaches without closing the service host", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-client-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const runtimeDir = path.join(userData, "background-runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, "capability"), "a".repeat(64), { mode: 0o600 });
  const { calls } = loadEntrypoint({ userData });
  await flushStartup();
  assert.equal(calls.clients.length, 1);
  assert.equal(calls.clients[0].connected, 1);
  assert.equal(calls.hosts.length, 0, "a connected UI must not create another TaskHost");
  assert.equal(calls.ipc[0][2].taskHost, calls.clients[0]);
  calls.windows[0].emit("closed");
  await flushStartup();
  assert.equal(calls.clients[0].detached, 1);
  assert.equal(calls.services.length, 0);
});

test("an explicit service stop exits the headless Electron process after the service drained", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-stop-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { calls } = loadEntrypoint({ serviceMode: true, userData });
  await flushStartup();
  calls.services[0].listener("serviceStopped", { reason: "user_stop" });
  await flushStartup();
  assert.equal(calls.quit, 1);
});

test("a symlinked capability never connects or creates a competing local TaskHost", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-symlink-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const runtimeDir = path.join(userData, "background-runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const other = path.join(userData, "other");
  fs.writeFileSync(other, "a".repeat(64), { mode: 0o600 });
  fs.symlinkSync(other, path.join(runtimeDir, "capability"));
  const { calls } = loadEntrypoint({ userData });
  await flushStartup();
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.hosts.length, 0);
  assert.equal(calls.ipc[0][2].taskHost, null);
});

test("a socket appearing before its capability does not start a competing local TaskHost", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-start-race-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const ipcDir = path.join(userData, "background-runtime", "ipc");
  fs.mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ipcDir, "runtime.sock"), "starting", { mode: 0o600 });
  const { calls } = loadEntrypoint({ userData });
  await flushStartup();
  assert.equal(calls.hosts.length, 0);
  assert.equal(calls.ipc[0][2].taskHost, null);
});

test("a prepared runtime directory without a capability keeps UI out of local task ownership", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-prepared-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.mkdirSync(path.join(userData, "background-runtime"), { mode: 0o700 });
  const { calls } = loadEntrypoint({ userData });
  await flushStartup();
  assert.equal(calls.hosts.length, 0);
  assert.equal(calls.ipc[0][2].taskHost, null);
});

for (const [choice, expectedStop, expectedDetach, expectedQuit] of [
  [0, 0, 1, 1],
  [1, 1, 1, 1],
  [2, 0, 0, 0],
]) {
  test(`Quit choice ${choice} keeps detach and explicit service stop distinct`, async (t) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-quit-"));
    t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
    const runtimeDir = path.join(userData, "background-runtime");
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    fs.writeFileSync(path.join(runtimeDir, "capability"), "a".repeat(64), { mode: 0o600 });
    const { app, calls } = loadEntrypoint({ userData, dialogResponse: choice });
    await flushStartup();
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    await flushStartup();
    assert.equal(prevented, true);
    assert.equal(calls.clients[0].stopped, expectedStop);
    assert.equal(calls.clients[0].detached, expectedDetach);
    assert.equal(calls.quit, expectedQuit);
  });
}

test("two overlapping Quit requests show one decision and detach once", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "halo-entry-quit-race-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const runtimeDir = path.join(userData, "background-runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.writeFileSync(path.join(runtimeDir, "capability"), "a".repeat(64), { mode: 0o600 });
  const { app, calls } = loadEntrypoint({ userData, dialogResponse: 1 });
  await flushStartup();
  const event = { preventDefault() {} };
  app.emit("before-quit", event);
  app.emit("before-quit", event);
  await flushStartup();
  assert.equal(calls.clients[0].stopped, 1);
  assert.equal(calls.clients[0].detached, 1);
  assert.equal(calls.quit, 1);
});
