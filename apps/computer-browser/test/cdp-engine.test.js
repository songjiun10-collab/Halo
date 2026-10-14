"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { AgentViewportHost } = require("../main/harness/agent-viewport-host");
const { HostSettingsStore } = require("../main/harness/host-settings");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

test("the engine is inert until Settings selects chromium", () => {
  const engine = new CdpEngine();
  assert.equal(engine.isActive(), false);
  assert.equal(engine.createPage("halo-task-1"), null);
  engine.configure({ browserEngine: "electron" });
  assert.equal(engine.createPage("halo-task-1"), null);
});

test("host settings accept the engine fields and reject malformed ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-settings-"));
  try {
    const store = new HostSettingsStore({ storageRoot: dir });
    const saved = await store.update({ browserEngine: "chromium", chromiumPath: "/Applications/Chromium.app/Contents/MacOS/Chromium", chromiumEndpoint: "http://127.0.0.1:9222" });
    assert.equal(saved.browserEngine, "chromium");
    assert.equal((await store.load()).chromiumEndpoint, "http://127.0.0.1:9222");
    await assert.rejects(store.update({ browserEngine: "firefox" }), /browserEngine/);
    await assert.rejects(store.update({ chromiumPath: "relative/chrome" }), /chromiumPath/);
    await assert.rejects(store.update({ chromiumEndpoint: "file:///etc/passwd" }), /chromiumEndpoint/);
    await assert.rejects(store.update({ chromiumContextPolicy: "everything" }), /chromiumContextPolicy/);
    assert.equal((await store.load()).browserEngine, "chromium", "a rejected patch leaves the stored value alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AgentViewportHost builds Chromium pages when the engine is on and Electron ones when it is off", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end(`<title>t</title><h1>hi ${request.url}</h1>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });

  // No Electron constructors may be touched while the engine is on.
  const forbidden = () => { throw new Error("electron constructor used"); };
  const host = new AgentViewportHost({ createWindow: forbidden, createView: forbidden, createPage: (partition) => engine.createPage(partition) });
  const first = host.ensure("task-a");
  const second = host.ensure("task-b");
  // Agent pages stay out of private addresses unless the person named one; this test server is one.
  for (const adapter of [first, second]) adapter.setPrivateNetworkAllowance([base]);
  const results = await Promise.all([first.execute({ type: "navigate", url: `${base}/a` }), second.execute({ type: "navigate", url: `${base}/b` })]);
  assert.deepEqual(results.map((r) => r.status), ["ok", "ok"]);
  assert.match((await first.observe()).url, /\/a$/);
  assert.match((await second.observe()).url, /\/b$/);
  const frame = await host.captureFrame("task-a");
  assert.match(frame, /^data:image\/jpeg;base64,/);
  assert.equal(await host.captureFrame("task-a"), frame, "an unchanged page returns the cached frame");

  // Same partition => same browser context, so cookies carry across tasks of one Agent.
  await first._view.webContents.executeJavaScript("document.cookie = 'k=1; path=/'");
  await host.dispose("task-a");
  const again = host.ensure("task-a");
  again.setPrivateNetworkAllowance([base]);
  await again.execute({ type: "navigate", url: `${base}/a` });
  assert.equal(await again._view.webContents.executeJavaScript("document.cookie"), "k=1");
  assert.equal(await second._view.webContents.executeJavaScript("document.cookie"), "", "a different partition is isolated");
  await host.disposeAll();
});

test("shared context policy pools task pages but keeps agent and child profiles isolated", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>t</title><h1>hi</h1>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM, chromiumContextPolicy: "shared" });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const cookieOf = async (partition, write) => {
    const view = engine.createPage(partition);
    await view.webContents.loadURL(`${base}/`);
    if (write) await view.webContents.executeJavaScript("document.cookie = 'k=1; path=/'");
    return view.webContents.executeJavaScript("document.cookie");
  };
  assert.equal(await cookieOf("halo-task-1", true), "k=1");
  assert.equal(await cookieOf("halo-task-2"), "k=1", "task pages share one context");
  assert.equal(await cookieOf("persist:halo-agent-x"), "", "an agent profile keeps its own context");
  assert.equal(await cookieOf("halo-child-abc"), "", "an isolated child keeps its own context");
});

test("shared policy launches with process-per-site so same-site task pages share one renderer", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>t</title><h1>hi</h1>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const renderersFor = async (policy) => {
    const engine = new CdpEngine();
    engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM, chromiumContextPolicy: policy });
    try {
      const views = [1, 2, 3, 4].map((i) => engine.createPage(`halo-task-${i}`));
      for (const view of views) await view.webContents.loadURL(`${base}/`);
      const { transport } = await engine.connect();
      const info = await transport.send("SystemInfo.getProcessInfo");
      return info.processInfo.filter((p) => p.type === "renderer").length;
    } finally { await engine.release(); }
  };
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const isolated = await renderersFor("isolated");
  const shared = await renderersFor("shared");
  assert.ok(shared < isolated, `shared ${shared} renderers should be fewer than isolated ${isolated}`);
});

test("a real Chromium page survives policy changes and its session stays on the old context", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>Survivor</title><h1>still running</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = new CdpEngine();
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM, chromiumContextPolicy: "isolated" });
  const old = engine.createPage("halo-task-survivor");
  await old.webContents.loadURL(base);
  await old.webContents.executeJavaScript("document.cookie = 'generation=old; path=/'");
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM, chromiumContextPolicy: "shared" });
  assert.equal(await old.webContents.executeJavaScript("document.title"), "Survivor");
  const next = engine.createPage("halo-task-survivor");
  await next.webContents.loadURL(base);
  assert.equal(await next.webContents.executeJavaScript("document.cookie"), "", "new settings must not inherit the old context");
  assert.equal((await old.webContents.session.cookies.get({ name: "generation" }))[0].value, "old");
  old.webContents.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await next.webContents.executeJavaScript("document.title"), "Survivor", "reclaiming the retired browser must not affect the new one");
});
