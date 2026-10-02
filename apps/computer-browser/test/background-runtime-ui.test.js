"use strict";

// The renderer's BackgroundRuntimeApi (frontend/src/session/background-
// runtime.ts) for one window. A window either runs tasks in its own local
// TaskHost or is attached to the background service through a
// BackgroundRuntimeClient; it never switches between the two at runtime.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const { BackgroundRuntimeUi } = require("../main/harness/background-runtime-ui");

function localHost(policy = "budgeted") {
  const settings = { memoryPolicy: policy };
  return {
    patches: [],
    getHostSettings: async () => ({ ...settings }),
    updateHostSettings: async function (patch) { this.patches.push(patch); Object.assign(settings, patch); return { ...settings }; },
  };
}

function runtimeClient(policy = "budgeted") {
  const host = localHost(policy);
  const stopping = new Set();
  return Object.assign(host, {
    stops: [],
    detach: async () => {},
    stopService: async function (reason) { this.stops.push(reason); for (const listener of stopping) listener({ reason }); },
    onServiceStopping: (listener) => { stopping.add(listener); return () => stopping.delete(listener); },
  });
}

test("a local window reports no background service and cannot stop one", async () => {
  const ui = new BackgroundRuntimeUi({ host: localHost() });
  const expected = { connection: "disconnected", service: "stopped", memoryPolicy: "budgeted" };
  assert.deepEqual(await ui.getSnapshot(), expected);
  assert.deepEqual(await ui.attach(), expected);
  await assert.rejects(ui.stopService(), { code: "no_background_service" });
  await assert.rejects(ui.detach(), { code: "detach_unsupported" });
});

test("an attached window reports the running service and stops it explicitly", async () => {
  const host = runtimeClient("user_override");
  const ui = new BackgroundRuntimeUi({ host });
  const events = [];
  ui.onChange((snapshot) => events.push(snapshot));
  assert.deepEqual(await ui.attach(), { connection: "connected", service: "running", memoryPolicy: "user_override" });
  const stopped = await ui.stopService();
  assert.deepEqual(host.stops, ["user_stop"]);
  assert.deepEqual(stopped, { connection: "disconnected", service: "stopped", memoryPolicy: "user_override" });
  assert.deepEqual(events.at(-1), stopped);
  // The service is gone: no further call reaches the closed client.
  assert.deepEqual(await ui.getSnapshot(), stopped);
  await assert.rejects(ui.stopService(), { code: "no_background_service" });
});

test("a service stopping on its own is pushed to the window", async () => {
  const host = runtimeClient();
  const ui = new BackgroundRuntimeUi({ host });
  const events = [];
  ui.onChange((snapshot) => events.push(snapshot));
  await host.stopService("service_quit");
  assert.deepEqual(events, [{ connection: "disconnected", service: "stopped", memoryPolicy: "budgeted" }]);
});

test("setMemoryPolicy validates the mode and goes through host settings", async () => {
  const host = localHost();
  const ui = new BackgroundRuntimeUi({ host });
  const events = [];
  ui.onChange((snapshot) => events.push(snapshot));
  for (const bad of ["unbounded", "", null, 1]) {
    await assert.rejects(ui.setMemoryPolicy(bad), { code: "invalid_memory_policy" });
  }
  assert.deepEqual(host.patches, []);
  const snapshot = await ui.setMemoryPolicy("user_override");
  assert.deepEqual(host.patches, [{ memoryPolicy: "user_override" }]);
  assert.equal(snapshot.memoryPolicy, "user_override");
  assert.deepEqual(events, [snapshot]);
});

test("the runtime methods are exposed through ipc and preload", async () => {
  const ipcSource = await fs.readFile(path.join(__dirname, "..", "main", "ipc.js"), "utf8");
  const preloadSource = await fs.readFile(path.join(__dirname, "..", "preload", "index.js"), "utf8");
  for (const method of ["getBackgroundRuntimeSnapshot", "attachBackgroundRuntime", "detachBackgroundRuntime", "setMemoryPolicy", "stopBackgroundService"]) {
    assert.match(ipcSource, new RegExp(`"halo:${method}"`), method);
    assert.match(preloadSource, new RegExp(`"${method}"`), method);
  }
  assert.match(preloadSource, /onBackgroundRuntimeEvent/);
  assert.match(ipcSource, /halo:backgroundRuntimeEvent/);
});

test("ipc routes runtime channels to the calling window and pushes changes", async () => {
  const registerIpc = require("../main/ipc");
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const sent = [];
  const mainFrame = { url: "file:///app/renderer/index.html" };
  const win = { isDestroyed: () => false, on: () => {}, webContents: { mainFrame, send: (channel, payload) => sent.push({ channel, payload }) } };
  const host = Object.assign(localHost(), { onEvent: () => () => {} });
  registerIpc(win, { onChange: () => () => {} }, { ipcMain, taskHost: host });
  await assert.rejects(
    () => Promise.resolve(handlers.get("halo:setMemoryPolicy")({ senderFrame: { url: "https://attacker.example/" } }, "user_override")),
    /untrusted sender/,
  );
  assert.deepEqual(host.patches, []);
  const snapshot = await handlers.get("halo:setMemoryPolicy")({ senderFrame: mainFrame }, "user_override");
  assert.equal(snapshot.memoryPolicy, "user_override");
  assert.deepEqual(sent.filter((item) => item.channel === "halo:backgroundRuntimeEvent").map((item) => item.payload), [snapshot]);
});

test("the snapshot reports whether the LaunchAgent is installed, and omits it when unknown", async () => {
  const installed = new BackgroundRuntimeUi({ host: localHost(), launchAgentInstalled: async () => true });
  assert.equal((await installed.getSnapshot()).launchAgentInstalled, true);
  const failing = new BackgroundRuntimeUi({ host: localHost(), launchAgentInstalled: async () => { throw new Error("lstat"); } });
  assert.equal(Object.hasOwn(await failing.getSnapshot(), "launchAgentInstalled"), false);
  const none = new BackgroundRuntimeUi({ host: localHost() });
  assert.equal(Object.hasOwn(await none.getSnapshot(), "launchAgentInstalled"), false);
});

test("LaunchAgentManager.isInstalled trusts only a regular plist file", async () => {
  const os = require("node:os");
  const { LaunchAgentManager } = require("../main/harness/launch-agent-manager");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-launchagents-"));
  const manager = new LaunchAgentManager({ launchAgentsDir: dir, runLaunchctl: async () => "", uid: 501 });
  const label = "com.halo.computerbrowser.background.tester";
  assert.equal(await manager.isInstalled({ label }), false);
  await fs.writeFile(path.join(dir, `${label}.plist`), "<plist/>");
  assert.equal(await manager.isInstalled({ label }), true);
  await fs.rm(path.join(dir, `${label}.plist`));
  await fs.writeFile(path.join(dir, "elsewhere.plist"), "<plist/>");
  await fs.symlink(path.join(dir, "elsewhere.plist"), path.join(dir, `${label}.plist`));
  assert.equal(await manager.isInstalled({ label }), false);
});

test("a memory policy change reaches every window with that window's own snapshot", async () => {
  const registerIpc = require("../main/ipc");
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const windows = [0, 1].map(() => {
    const sent = [];
    const mainFrame = { url: "file:///app/renderer/index.html" };
    return { sent, mainFrame, win: { isDestroyed: () => false, on: () => {}, webContents: { mainFrame, send: (channel, payload) => sent.push({ channel, payload }) } } };
  });
  const settings = { memoryPolicy: "budgeted" };
  const shared = () => ({
    onEvent: () => () => {},
    getHostSettings: async () => ({ ...settings }),
    updateHostSettings: async (patch) => { Object.assign(settings, patch); return { ...settings }; },
  });
  registerIpc(windows[0].win, { onChange: () => () => {} }, { ipcMain, taskHost: shared() });
  registerIpc(windows[1].win, { onChange: () => () => {} }, { ipcMain, taskHost: Object.assign(runtimeClient(), shared()) });
  await handlers.get("halo:setMemoryPolicy")({ senderFrame: windows[0].mainFrame }, "user_override");
  await new Promise((resolve) => setImmediate(resolve));
  const pushed = (index) => windows[index].sent.filter((item) => item.channel === "halo:backgroundRuntimeEvent").map((item) => item.payload);
  assert.deepEqual(pushed(0), [{ connection: "disconnected", service: "stopped", memoryPolicy: "user_override" }]);
  assert.deepEqual(pushed(1), [{ connection: "connected", service: "running", memoryPolicy: "user_override" }]);
});

// ---- start at login: the background service's per-user LaunchAgent ----

const { launchAgentUserId, createBackgroundLaunchAgent } = require("../main/harness/background-launch-agent");

test("the LaunchAgent label comes from a sanitized account name, or the uid", () => {
  assert.equal(launchAgentUserId({ username: "songjiun", uid: 501 }), "songjiun");
  assert.equal(launchAgentUserId({ username: "Jane Doe@corp", uid: 502 }), "Jane-Doe-corp");
  assert.equal(launchAgentUserId({ username: "..", uid: 503 }), "uid-503");
  assert.equal(launchAgentUserId({ username: "", uid: 504 }), "uid-504");
  assert.equal(launchAgentUserId({ username: "x".repeat(300), uid: 505 }).length, 128);
});

test("enable installs and loads the service's LaunchAgent; disable boots it out and removes it", async () => {
  const os = require("node:os");
  const { LaunchAgentManager } = require("../main/harness/launch-agent-manager");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-launchagents-"));
  const calls = [];
  const manager = new LaunchAgentManager({ launchAgentsDir: dir, runLaunchctl: async (args) => { calls.push(args); return ""; }, uid: 501 });
  const agent = createBackgroundLaunchAgent({ manager, executablePath: "/Applications/Halo.app/Contents/MacOS/Halo", appPath: null, userId: "tester", logPath: "/tmp/halo-bg.log" });
  assert.equal(agent.label, "com.halo.computerbrowser.background.tester");
  assert.equal(await agent.isInstalled(), false);
  await agent.enable();
  assert.equal(await agent.isInstalled(), true);
  const plist = await fs.readFile(path.join(dir, `${agent.label}.plist`), "utf8");
  assert.match(plist, /<string>\/Applications\/Halo\.app\/Contents\/MacOS\/Halo<\/string>\s*<string>--halo-background-service<\/string>/);
  assert.match(plist, /StandardErrorPath/);
  assert.deepEqual(calls.at(-1), ["bootstrap", "gui/501", path.join(dir, `${agent.label}.plist`)]);
  await agent.disable();
  assert.equal(await agent.isInstalled(), false);
  assert.ok(calls.some((args) => args[0] === "bootout"));
});

test("setLaunchAtLogin toggles the LaunchAgent and pushes the new snapshot", async () => {
  let installed = false;
  const launchAgent = { isInstalled: async () => installed, enable: async () => { installed = true; }, disable: async () => { installed = false; } };
  const ui = new BackgroundRuntimeUi({ host: localHost(), launchAgent });
  const events = [];
  ui.onChange((snapshot) => events.push(snapshot));
  assert.equal((await ui.getSnapshot()).launchAgentInstalled, false);
  for (const bad of ["yes", 1, null, undefined]) await assert.rejects(ui.setLaunchAtLogin(bad), { code: "invalid_launch_at_login" });
  const on = await ui.setLaunchAtLogin(true);
  assert.equal(on.launchAgentInstalled, true);
  assert.deepEqual(events, [on]);
  assert.equal((await ui.setLaunchAtLogin(false)).launchAgentInstalled, false);
  const unavailable = new BackgroundRuntimeUi({ host: localHost() });
  await assert.rejects(unavailable.setLaunchAtLogin(true), { code: "launch_agent_unavailable" });
});

test("setBackgroundLaunchAtLogin is an ipc/preload channel that refreshes every window", async () => {
  const ipcSource = await fs.readFile(path.join(__dirname, "..", "main", "ipc.js"), "utf8");
  const preloadSource = await fs.readFile(path.join(__dirname, "..", "preload", "index.js"), "utf8");
  assert.match(ipcSource, /"halo:setBackgroundLaunchAtLogin"/);
  assert.match(preloadSource, /"setBackgroundLaunchAtLogin"/);
  const registerIpc = require("../main/ipc");
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  let installed = false;
  const launchAgent = { isInstalled: async () => installed, enable: async () => { installed = true; }, disable: async () => { installed = false; } };
  const windows = [0, 1].map(() => {
    const sent = [];
    const mainFrame = { url: "file:///app/renderer/index.html" };
    return { sent, mainFrame, win: { isDestroyed: () => false, on: () => {}, webContents: { mainFrame, send: (channel, payload) => sent.push({ channel, payload }) } } };
  });
  for (const w of windows) registerIpc(w.win, { onChange: () => () => {} }, { ipcMain, taskHost: Object.assign(localHost(), { onEvent: () => () => {} }), launchAgent });
  const snapshot = await handlers.get("halo:setBackgroundLaunchAtLogin")({ senderFrame: windows[0].mainFrame }, true);
  assert.equal(snapshot.launchAgentInstalled, true);
  await new Promise((resolve) => setImmediate(resolve));
  const last = windows[1].sent.filter((item) => item.channel === "halo:backgroundRuntimeEvent").at(-1);
  assert.equal(last?.payload.launchAgentInstalled, true);
});
